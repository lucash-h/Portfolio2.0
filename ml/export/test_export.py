"""Tests for ml/export: torch -> ONNX conversion and manifest generation.

Covers (see docs/CONTRACTS.md §3 / §5 and docs/PACKAGES.md P2-C):
  1. Round-trip numerical agreement between torch and onnxruntime.
  2. Exact ONNX signature (names + shapes).
  3. Policy output is raw logits, not softmaxed.
  4. Export uses eval-mode BatchNorm stats, not training-mode.
  5. Manifest shape, ordering, and racer-array preservation.
  6. Missing channels/blocks in checkpoint config fails loudly.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import pytest
import torch

from ml.connect4.net import Connect4Net
from ml.export.manifest import (
    build_connect4_entry,
    format_games_label,
    read_manifest,
    write_connect4_manifest,
)
from ml.export.to_onnx import (
    CheckpointFormatError,
    export_checkpoint_to_onnx,
    export_net_to_onnx,
    load_checkpoint,
)

BOARD_SHAPE = (1, 2, 6, 7)
POLICY_SHAPE = (1, 7)
VALUE_SHAPE = (1, 1)


def _save_checkpoint(
    path: Path,
    net: Connect4Net,
    *,
    channels: int,
    blocks: int,
    games_trained: int = 1000,
    config_overrides: dict | None = None,
    omit_config: bool = False,
    omit_channels: bool = False,
    omit_blocks: bool = False,
) -> Path:
    config: dict = {}
    if not omit_config:
        config = {"channels": channels, "blocks": blocks, "simulations": 64}
        if omit_channels:
            del config["channels"]
        if omit_blocks:
            del config["blocks"]
        if config_overrides:
            config.update(config_overrides)

    payload: dict = {
        "model_state_dict": net.state_dict(),
        "optimizer_state_dict": {},
        "games_trained": games_trained,
        "timestamp": "2026-01-01T00:00:00+00:00",
    }
    if not omit_config:
        payload["config"] = config
    torch.save(payload, path)
    return path


def _random_boards(n: int, rng: np.random.Generator) -> np.ndarray:
    """`n` random (not necessarily legal) [2,6,7] board encodings, for pure
    numerical agreement checks -- validity of the position does not matter
    here, only that torch and onnxruntime compute the same function."""
    return rng.random((n, 2, 6, 7)).astype(np.float32)


# ---------------------------------------------------------------------------
# 1. Round-trip numerical agreement
# ---------------------------------------------------------------------------


def test_round_trip_numerical_agreement(tmp_path: Path) -> None:
    torch.manual_seed(42)
    channels, blocks = 8, 2
    net = Connect4Net(channels=channels, num_blocks=blocks)
    net.eval()

    ckpt_path = _save_checkpoint(tmp_path / "c4-0001000.pt", net, channels=channels, blocks=blocks)
    onnx_path = tmp_path / "c4-0001000.onnx"
    export_checkpoint_to_onnx(ckpt_path, onnx_path)

    session = ort.InferenceSession(str(onnx_path))
    rng = np.random.default_rng(7)
    boards = _random_boards(50, rng)

    with torch.no_grad():
        for i in range(50):
            x = boards[i : i + 1]
            torch_policy, torch_value = net(torch.from_numpy(x))
            ort_policy, ort_value = session.run(None, {"board": x})

            np.testing.assert_allclose(torch_policy.numpy(), ort_policy, atol=1e-5, rtol=1e-5)
            np.testing.assert_allclose(torch_value.numpy(), ort_value, atol=1e-5, rtol=1e-5)


# ---------------------------------------------------------------------------
# 2. Signature
# ---------------------------------------------------------------------------


def test_exported_signature_matches_contract(tmp_path: Path) -> None:
    net = Connect4Net(channels=4, num_blocks=1)
    ckpt_path = _save_checkpoint(tmp_path / "c4-0000500.pt", net, channels=4, blocks=1)
    onnx_path = tmp_path / "c4-0000500.onnx"
    export_checkpoint_to_onnx(ckpt_path, onnx_path)

    model = onnx.load(str(onnx_path))
    onnx.checker.check_model(model)

    inputs = {
        i.name: tuple(d.dim_value for d in i.type.tensor_type.shape.dim) for i in model.graph.input
    }
    outputs = {
        o.name: tuple(d.dim_value for d in o.type.tensor_type.shape.dim) for o in model.graph.output
    }

    assert inputs == {"board": BOARD_SHAPE}
    assert outputs == {"policy": POLICY_SHAPE, "value": VALUE_SHAPE}

    # Names must appear in this exact order too -- browser code may look up
    # outputs positionally as well as by name.
    assert [o.name for o in model.graph.output] == ["policy", "value"]


def test_exported_dtypes_are_float32(tmp_path: Path) -> None:
    net = Connect4Net(channels=4, num_blocks=1)
    ckpt_path = _save_checkpoint(tmp_path / "c4-0000500.pt", net, channels=4, blocks=1)
    onnx_path = tmp_path / "c4-0000500.onnx"
    export_checkpoint_to_onnx(ckpt_path, onnx_path)

    session = ort.InferenceSession(str(onnx_path))
    x = np.zeros(BOARD_SHAPE, dtype=np.float32)
    policy, value = session.run(None, {"board": x})
    assert policy.dtype == np.float32
    assert value.dtype == np.float32
    assert policy.shape == POLICY_SHAPE
    assert value.shape == VALUE_SHAPE
    assert -1.0 <= float(value[0, 0]) <= 1.0


# ---------------------------------------------------------------------------
# 3. Logits, not probabilities
# ---------------------------------------------------------------------------


def test_policy_output_is_logits_not_softmaxed(tmp_path: Path) -> None:
    torch.manual_seed(3)
    net = Connect4Net(channels=8, num_blocks=2)
    ckpt_path = _save_checkpoint(tmp_path / "c4-0002000.pt", net, channels=8, blocks=2)
    onnx_path = tmp_path / "c4-0002000.onnx"
    export_checkpoint_to_onnx(ckpt_path, onnx_path)

    session = ort.InferenceSession(str(onnx_path))
    rng = np.random.default_rng(11)
    x = _random_boards(1, rng)
    policy, _value = session.run(None, {"board": x})

    total = float(policy.sum())
    assert abs(total - 1.0) > 1e-3, (
        "policy output sums to ~1 -- looks like a softmax was accidentally "
        "baked into the export (contract requires raw logits)"
    )
    # Logits should include values outside [0,1], which a softmax output
    # could never produce.
    assert (policy < 0).any() or (policy > 1).any()


# ---------------------------------------------------------------------------
# 4. Eval mode, not training mode
# ---------------------------------------------------------------------------


def test_export_uses_eval_mode_batchnorm_stats(tmp_path: Path) -> None:
    torch.manual_seed(5)
    channels, blocks = 4, 1
    net = Connect4Net(channels=channels, num_blocks=blocks)

    # Drive the net through several training-mode forward passes on inputs
    # far from zero, so BatchNorm running stats end up non-trivial (not the
    # freshly-initialised mean=0/var=1).
    net.train()
    with torch.no_grad():
        for _ in range(20):
            batch = torch.rand(16, 2, 6, 7) * 5.0 + 3.0
            net(batch)

    # Sanity: running stats actually moved.
    assert not torch.allclose(net.stem[1].running_mean, torch.zeros(channels))

    dummy = torch.zeros(*BOARD_SHAPE)

    net.eval()
    with torch.no_grad():
        eval_policy, eval_value = net(dummy)

    # Sanity check on a *copy* of the net, so this comparison's forward pass
    # (which itself is a BatchNorm side effect in train mode: it updates
    # running_mean/running_var from the batch it's given, even under
    # no_grad) does not mutate the buffers we're about to checkpoint.
    train_mode_net = copy.deepcopy(net)
    train_mode_net.train()
    with torch.no_grad():
        train_policy, _train_value = train_mode_net(dummy)

    # Prove the test has teeth: train-mode and eval-mode outputs actually
    # differ for this net (batch stats of a single all-zero input differ
    # wildly from the accumulated running stats).
    assert not torch.allclose(eval_policy, train_policy, atol=1e-4)

    # Checkpoint the *original* net (still holding the stats that produced
    # eval_policy) while leaving it in train() mode, to prove export forces
    # eval() itself rather than trusting the caller's mode.
    net.train()
    ckpt_path = _save_checkpoint(tmp_path / "c4-0003000.pt", net, channels=channels, blocks=blocks)
    onnx_path = tmp_path / "c4-0003000.onnx"
    export_checkpoint_to_onnx(ckpt_path, onnx_path)

    session = ort.InferenceSession(str(onnx_path))
    ort_policy, ort_value = session.run(None, {"board": dummy.numpy()})

    np.testing.assert_allclose(eval_policy.numpy(), ort_policy, atol=1e-5, rtol=1e-5)
    np.testing.assert_allclose(eval_value.numpy(), ort_value, atol=1e-5, rtol=1e-5)


def test_export_net_to_onnx_restores_caller_training_mode(tmp_path: Path) -> None:
    """export_net_to_onnx flips to eval() to trace, but should not leave a
    net that was mid-training permanently stuck in eval mode behind the
    caller's back."""
    net = Connect4Net(channels=4, num_blocks=1)
    net.train()
    export_net_to_onnx(net, tmp_path / "out.onnx")
    assert net.training is True


# ---------------------------------------------------------------------------
# 5. Manifest
# ---------------------------------------------------------------------------


def test_manifest_entry_shape_matches_contract() -> None:
    entry = build_connect4_entry(
        checkpoint_id="c4-0001000",
        games_trained=1000,
        onnx_file="connect4/c4-0001000.onnx",
        mcts_sims=64,
        size_kb=180,
    )
    assert set(entry.keys()) == {"id", "label", "file", "gamesTrained", "elo", "mctsSims", "sizeKb"}
    assert entry["id"] == "c4-0001000"
    assert entry["file"] == "connect4/c4-0001000.onnx"
    assert entry["gamesTrained"] == 1000
    assert entry["elo"] is None
    assert entry["mctsSims"] == 64
    assert entry["sizeKb"] == 180
    assert entry["label"] == "1,000 games"


def test_format_games_label() -> None:
    assert format_games_label(1000) == "1,000 games"
    assert format_games_label(500_000) == "500,000 games"


def test_write_connect4_manifest_orders_weakest_first(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    entries = [
        build_connect4_entry(
            checkpoint_id="c4-0100000",
            games_trained=100_000,
            onnx_file="x",
            mcts_sims=64,
            size_kb=1,
        ),
        build_connect4_entry(
            checkpoint_id="c4-0001000", games_trained=1_000, onnx_file="x", mcts_sims=64, size_kb=1
        ),
        build_connect4_entry(
            checkpoint_id="c4-0010000", games_trained=10_000, onnx_file="x", mcts_sims=64, size_kb=1
        ),
    ]
    manifest = write_connect4_manifest(manifest_path, entries)

    games = [e["gamesTrained"] for e in manifest["connect4"]]
    assert games == sorted(games)
    assert games == [1_000, 10_000, 100_000]

    # Round-trips through disk identically.
    on_disk = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert [e["gamesTrained"] for e in on_disk["connect4"]] == [1_000, 10_000, 100_000]
    assert on_disk["version"] == 1
    assert on_disk["racer"] == []


def test_existing_racer_array_survives_connect4_reexport(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    initial = {
        "version": 1,
        "connect4": [
            build_connect4_entry(
                checkpoint_id="c4-old", games_trained=1, onnx_file="x", mcts_sims=1, size_kb=1
            )
        ],
        "racer": [
            {
                "id": "rc-gen0005",
                "label": "Generation 5",
                "file": "racer/rc-gen0005.onnx",
                "generation": 5,
                "bestLapMs": 48210,
                "sizeKb": 6,
            }
        ],
    }
    manifest_path.write_text(json.dumps(initial), encoding="utf-8")

    new_entries = [
        build_connect4_entry(
            checkpoint_id="c4-0001000", games_trained=1000, onnx_file="y", mcts_sims=64, size_kb=180
        )
    ]
    manifest = write_connect4_manifest(manifest_path, new_entries)

    assert manifest["racer"] == initial["racer"]
    assert [e["id"] for e in manifest["connect4"]] == ["c4-0001000"]

    on_disk = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert on_disk["racer"] == initial["racer"]


def test_read_manifest_missing_file_returns_default(tmp_path: Path) -> None:
    manifest = read_manifest(tmp_path / "does-not-exist.json")
    assert manifest == {"version": 1, "connect4": [], "racer": []}


# ---------------------------------------------------------------------------
# 6. Missing channels/blocks fails loudly
# ---------------------------------------------------------------------------


def test_missing_channels_fails_with_clear_error(tmp_path: Path) -> None:
    net = Connect4Net(channels=4, num_blocks=1)
    ckpt_path = _save_checkpoint(
        tmp_path / "c4-bad.pt", net, channels=4, blocks=1, omit_channels=True
    )
    with pytest.raises(CheckpointFormatError, match="channels"):
        load_checkpoint(ckpt_path)


def test_missing_blocks_fails_with_clear_error(tmp_path: Path) -> None:
    net = Connect4Net(channels=4, num_blocks=1)
    ckpt_path = _save_checkpoint(
        tmp_path / "c4-bad.pt", net, channels=4, blocks=1, omit_blocks=True
    )
    with pytest.raises(CheckpointFormatError, match="blocks"):
        load_checkpoint(ckpt_path)


def test_missing_config_entirely_fails_with_clear_error(tmp_path: Path) -> None:
    net = Connect4Net(channels=4, num_blocks=1)
    ckpt_path = _save_checkpoint(
        tmp_path / "c4-bad.pt", net, channels=4, blocks=1, omit_config=True
    )
    with pytest.raises(CheckpointFormatError, match="config"):
        load_checkpoint(ckpt_path)


def test_missing_games_trained_fails(tmp_path: Path) -> None:
    net = Connect4Net(channels=4, num_blocks=1)
    path = tmp_path / "c4-bad.pt"
    torch.save(
        {
            "model_state_dict": net.state_dict(),
            "optimizer_state_dict": {},
            "config": {"channels": 4, "blocks": 1},
            "timestamp": "2026-01-01T00:00:00+00:00",
        },
        path,
    )
    with pytest.raises(CheckpointFormatError, match="games_trained"):
        load_checkpoint(path)
