"""Torch -> ONNX export for Connect4Net checkpoints.

Converts a single `.pt` checkpoint (as written by `ml/connect4/train.py`) to
an ONNX graph matching `docs/CONTRACTS.md` §3 exactly:

    board  (input)  float32 [1,2,6,7]
    policy (output) float32 [1,7]   raw logits, NOT softmaxed
    value  (output) float32 [1,1]   in [-1,1]

Batch size is fixed at 1 (no dynamic axes) per the contract's batch-dimension
table: the ONNX graph is the inference boundary, and `[1,...]` is what the
browser session feeds it.

Channel width and residual block count are read from the checkpoint's
`config` dict, never hardcoded, because `Connect4Net`'s architecture is not
fixed by the module -- different training runs may use different widths. A
checkpoint missing those keys fails loudly rather than silently falling back
to `net.py`'s defaults, which would silently reconstruct the wrong
architecture.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch

from ml.connect4.net import Connect4Net

ONNX_OPSET = 18
INPUT_NAME = "board"
POLICY_OUTPUT_NAME = "policy"
VALUE_OUTPUT_NAME = "value"
BOARD_SHAPE = (1, 2, 6, 7)


class CheckpointFormatError(ValueError):
    """Raised when a checkpoint is missing data required to export it.

    Deliberately a `ValueError` subclass (not a bare assertion) so callers
    can catch it specifically and print a clear message instead of a
    `KeyError`/`AttributeError` traceback pointing at the wrong line.
    """


@dataclass(frozen=True, slots=True)
class LoadedCheckpoint:
    """A checkpoint reconstructed into a ready-to-export `Connect4Net`."""

    net: Connect4Net
    games_trained: int
    channels: int
    blocks: int
    config: dict[str, Any]
    timestamp: str | None
    source_path: Path


def load_checkpoint(path: Path) -> LoadedCheckpoint:
    """Loads a `.pt` checkpoint and reconstructs the `Connect4Net` it holds.

    Raises `CheckpointFormatError` with a clear message if `games_trained`,
    `config`, or `config["channels"]`/`config["blocks"]` are absent -- these
    are required to reconstruct the exact architecture that was trained;
    silently guessing at defaults would produce a network that loads without
    error but plays with the wrong weights laid out over the wrong shapes.
    """
    path = Path(path)
    data = torch.load(path, map_location="cpu", weights_only=False)

    if not isinstance(data, dict) or "model_state_dict" not in data:
        raise CheckpointFormatError(
            f"{path}: not a recognised checkpoint (expected a dict with 'model_state_dict')"
        )

    config = data.get("config")
    if not isinstance(config, dict):
        raise CheckpointFormatError(
            f"{path}: checkpoint has no 'config' dict. Cannot determine "
            "'channels'/'blocks' to reconstruct Connect4Net."
        )
    missing = [key for key in ("channels", "blocks") if key not in config]
    if missing:
        raise CheckpointFormatError(
            f"{path}: checkpoint config is missing required key(s) "
            f"{missing} (config keys present: {sorted(config.keys())}). "
            "channels/blocks are not fixed by ml/connect4/net.py -- they "
            "must come from the checkpoint. Refusing to fall back to "
            "net.py defaults, which could silently reconstruct the wrong "
            "architecture."
        )

    channels = int(config["channels"])
    blocks = int(config["blocks"])

    if "games_trained" not in data:
        raise CheckpointFormatError(f"{path}: checkpoint is missing 'games_trained'")

    net = Connect4Net(channels=channels, num_blocks=blocks)
    net.load_state_dict(data["model_state_dict"])
    net.eval()

    return LoadedCheckpoint(
        net=net,
        games_trained=int(data["games_trained"]),
        channels=channels,
        blocks=blocks,
        config=config,
        timestamp=data.get("timestamp"),
        source_path=path,
    )


def export_net_to_onnx(net: Connect4Net, output_path: Path, *, opset: int = ONNX_OPSET) -> None:
    """Exports `net` to ONNX at `output_path` with the CONTRACTS §3 signature.

    Forces `eval()` before tracing regardless of the mode the caller passed
    the net in -- a model exported in training mode carries live BatchNorm
    batch statistics instead of the accumulated running stats, and plays
    differently (and non-deterministically across export runs) in the
    browser than it did during training. This is the one thing this
    function is not willing to trust the caller to have already done.
    """
    was_training = net.training
    net.eval()
    try:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        dummy = torch.zeros(*BOARD_SHAPE, dtype=torch.float32)
        with torch.no_grad():
            torch.onnx.export(
                net,
                (dummy,),
                str(output_path),
                input_names=[INPUT_NAME],
                output_names=[POLICY_OUTPUT_NAME, VALUE_OUTPUT_NAME],
                opset_version=opset,
                do_constant_folding=True,
                dynamic_axes=None,
                dynamo=False,
            )
    finally:
        if was_training:
            net.train()


def export_checkpoint_to_onnx(checkpoint_path: Path, output_path: Path) -> LoadedCheckpoint:
    """Loads a checkpoint and exports it to ONNX in one step. Returns the
    loaded checkpoint metadata (games_trained, config, ...) for the caller
    (typically the manifest writer) to use."""
    loaded = load_checkpoint(checkpoint_path)
    export_net_to_onnx(loaded.net, output_path)
    return loaded
