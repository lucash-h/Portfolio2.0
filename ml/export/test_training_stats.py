"""Tests for `ml/export/training_stats.py`.

The payload this builds is read by the dashboard and by nothing else, so the
things worth pinning down are the ones a reader would be misled by: that the
numbers come out of the checkpoints rather than being assumed, that the
duration is a span between checkpoints and not a claim about the whole run,
and that a single checkpoint reports no duration at all instead of zero.
"""

from __future__ import annotations

import json
from pathlib import Path

import torch

from ml.connect4.net import Connect4Net
from ml.export.training_stats import (
    build_training_stats,
    read_checkpoint_stats,
    write_training_stats,
)


def _save_checkpoint(
    path: Path,
    *,
    games_trained: int,
    timestamp: str,
    channels: int = 4,
    blocks: int = 1,
) -> Path:
    net = Connect4Net(channels=channels, num_blocks=blocks)
    torch.save(
        {
            "model_state_dict": net.state_dict(),
            "optimizer_state_dict": {},
            "games_trained": games_trained,
            "timestamp": timestamp,
            "config": {
                "channels": channels,
                "blocks": blocks,
                "simulations": 48,
                "batch_size": 128,
                "learning_rate": 0.001,
                "seed": 0,
                # Harness detail that should NOT reach the dashboard.
                "workers": 4,
                "target_games": 300,
            },
        },
        path,
    )
    return path


def test_reads_parameters_and_provenance_from_the_file(tmp_path: Path) -> None:
    path = _save_checkpoint(
        tmp_path / "c4-0000050.pt", games_trained=50, timestamp="2026-09-19T17:56:14+00:00"
    )
    stats = read_checkpoint_stats(path)

    assert stats["id"] == "c4-0000050"
    assert stats["gamesTrained"] == 50
    assert stats["savedAt"] == "2026-09-19T17:56:14+00:00"
    # Counted from the weights, not taken from the config.
    expected = sum(
        v.numel() for v in torch.load(path, weights_only=False)["model_state_dict"].values()
    )
    assert stats["parameters"] == expected
    assert stats["checkpointKb"] > 0


def test_span_is_between_first_and_last_checkpoint(tmp_path: Path) -> None:
    paths = [
        _save_checkpoint(
            tmp_path / "c4-0000050.pt", games_trained=50, timestamp="2026-09-19T17:56:14+00:00"
        ),
        _save_checkpoint(
            tmp_path / "c4-0000300.pt", games_trained=300, timestamp="2026-09-19T18:05:26+00:00"
        ),
    ]
    run = build_training_stats(paths)["connect4"]["run"]

    assert run["gamesTrained"] == 300
    assert run["spanSeconds"] == 552.0
    assert run["firstCheckpointAt"] == "2026-09-19T17:56:14+00:00"
    assert run["lastCheckpointAt"] == "2026-09-19T18:05:26+00:00"


def test_single_checkpoint_reports_no_span_rather_than_zero(tmp_path: Path) -> None:
    # Zero would read as "trained instantly"; null reads as "not known", which
    # is the truth when there is only one timestamp.
    paths = [
        _save_checkpoint(
            tmp_path / "c4-0000050.pt", games_trained=50, timestamp="2026-09-19T17:56:14+00:00"
        )
    ]
    assert build_training_stats(paths)["connect4"]["run"]["spanSeconds"] is None


def test_orders_checkpoints_weakest_first_regardless_of_input_order(tmp_path: Path) -> None:
    strong = _save_checkpoint(
        tmp_path / "c4-0000300.pt", games_trained=300, timestamp="2026-09-19T18:05:26+00:00"
    )
    weak = _save_checkpoint(
        tmp_path / "c4-0000050.pt", games_trained=50, timestamp="2026-09-19T17:56:14+00:00"
    )
    rows = build_training_stats([strong, weak])["connect4"]["checkpoints"]
    assert [r["gamesTrained"] for r in rows] == [50, 300]


def test_exposes_model_hyperparameters_and_drops_harness_detail(tmp_path: Path) -> None:
    paths = [
        _save_checkpoint(
            tmp_path / "c4-0000050.pt", games_trained=50, timestamp="2026-09-19T17:56:14+00:00"
        )
    ]
    params = build_training_stats(paths)["connect4"]["hyperparameters"]

    assert params["simulations"] == 48
    assert params["batchSize"] == 128  # snake_case in the checkpoint, camel in the JSON
    assert params["learningRate"] == 0.001
    assert "workers" not in params
    assert "targetGames" not in params


def test_states_what_is_missing_instead_of_omitting_it(tmp_path: Path) -> None:
    paths = [
        _save_checkpoint(
            tmp_path / "c4-0000050.pt", games_trained=50, timestamp="2026-09-19T17:56:14+00:00"
        )
    ]
    missing = build_training_stats(paths)["connect4"]["missing"]
    assert "lossHistory" in missing
    assert "elo" in missing


def test_no_checkpoints_is_a_valid_payload_with_no_data(tmp_path: Path) -> None:
    stats = build_training_stats([])
    assert stats["connect4"] is None

    out = write_training_stats(tmp_path / "training.json", stats)
    assert out == stats
    assert json.loads((tmp_path / "training.json").read_text(encoding="utf-8")) == stats


def test_onnx_size_is_included_only_when_the_file_is_there(tmp_path: Path) -> None:
    paths = [
        _save_checkpoint(
            tmp_path / "c4-0000050.pt", games_trained=50, timestamp="2026-09-19T17:56:14+00:00"
        )
    ]
    onnx_dir = tmp_path / "connect4"
    onnx_dir.mkdir()

    without = build_training_stats(paths, onnx_dir)["connect4"]["checkpoints"][0]
    assert "onnxKb" not in without

    (onnx_dir / "c4-0000050.onnx").write_bytes(b"x" * 2048)
    with_onnx = build_training_stats(paths, onnx_dir)["connect4"]["checkpoints"][0]
    assert with_onnx["onnxKb"] == 2
