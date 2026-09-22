"""Writes `web/static/models/training.json`: how the checkpoints were made.

Deliberately a separate file from `manifest.json`. The manifest is
contract-fixed (CONTRACTS §5) and answers one question — which opponents
exist — and the browser's exhibit depends on that shape. This answers a
different question, for the dashboard: what the network is, what it was
trained with, and how long it took. Nothing here is required to play a game,
so a missing or stale `training.json` degrades to "no training stats" rather
than breaking the exhibit.

Everything is read back out of the checkpoint files themselves, never
hand-written, so it cannot drift from the weights that shipped.

What is NOT in here, and why:

- **Loss curves.** `train.py` prints per-cycle policy and value loss to stdout
  and saves neither. The existing checkpoints therefore have no recoverable
  history, and inventing one is not an option. Persisting it is a change to
  the training loop, and it would only cover future runs.
- **Elo.** `ml/tournament/` is an `__init__.py` advertising two modules that
  were never written (P3-C), so every rating is `null` and the dashboard says
  "not yet rated" rather than showing a number nobody computed.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

import torch

TRAINING_STATS_VERSION = 1

#: Config keys worth showing, in the order they should be read. Anything else
#: in the checkpoint's config is training-harness detail (paths, worker counts)
#: that tells a reader nothing about the model.
HYPERPARAMETER_KEYS = (
    "simulations",
    "batch_size",
    "learning_rate",
    "games_per_cycle",
    "train_steps_per_cycle",
    "buffer_capacity",
    "dirichlet_epsilon",
    "dirichlet_alpha",
    "temperature_threshold",
    "seed",
)


def _camel(key: str) -> str:
    head, *rest = key.split("_")
    return head + "".join(word.capitalize() for word in rest)


def read_checkpoint_stats(path: Path) -> dict[str, Any]:
    """Architecture, size and provenance for one checkpoint file."""
    path = Path(path)
    data = torch.load(path, map_location="cpu", weights_only=False)
    state = data["model_state_dict"]
    return {
        "id": path.stem,
        "gamesTrained": int(data["games_trained"]),
        "parameters": int(sum(v.numel() for v in state.values())),
        "savedAt": data["timestamp"],
        "checkpointKb": round(path.stat().st_size / 1024),
        "config": dict(data["config"]),
    }


def _wall_clock_seconds(timestamps: list[str]) -> float | None:
    """Seconds between the first and last checkpoint.

    NOT the run's total duration: the first checkpoint is written once its
    games are already played, so whatever happened before it is not visible
    here. Labelled accordingly wherever it is shown.
    """
    if len(timestamps) < 2:
        return None
    parsed = sorted(datetime.fromisoformat(t) for t in timestamps)
    return (parsed[-1] - parsed[0]).total_seconds()


def build_training_stats(
    checkpoint_paths: list[Path], onnx_dir: Path | None = None
) -> dict[str, Any]:
    """Builds the `training.json` payload from ladder checkpoints."""
    rows = [read_checkpoint_stats(p) for p in checkpoint_paths]
    rows.sort(key=lambda r: r["gamesTrained"])

    if not rows:
        return {"version": TRAINING_STATS_VERSION, "connect4": None}

    config = rows[-1]["config"]
    checkpoints = []
    for row in rows:
        entry = {
            "id": row["id"],
            "gamesTrained": row["gamesTrained"],
            "parameters": row["parameters"],
            "savedAt": row["savedAt"],
            "checkpointKb": row["checkpointKb"],
        }
        if onnx_dir is not None:
            onnx_path = Path(onnx_dir) / f"{row['id']}.onnx"
            if onnx_path.exists():
                entry["onnxKb"] = round(onnx_path.stat().st_size / 1024)
        checkpoints.append(entry)

    return {
        "version": TRAINING_STATS_VERSION,
        "connect4": {
            "architecture": {
                "channels": config.get("channels"),
                "blocks": config.get("blocks"),
                "parameters": rows[-1]["parameters"],
            },
            "hyperparameters": {_camel(k): config[k] for k in HYPERPARAMETER_KEYS if k in config},
            "run": {
                "gamesTrained": rows[-1]["gamesTrained"],
                "firstCheckpointAt": rows[0]["savedAt"],
                "lastCheckpointAt": rows[-1]["savedAt"],
                "spanSeconds": _wall_clock_seconds([r["savedAt"] for r in rows]),
            },
            "checkpoints": checkpoints,
            # Stated, not implied by absence: a reader should be told these are
            # missing on purpose rather than left to wonder.
            "missing": {
                "lossHistory": "train.py prints per-cycle loss and does not persist it",
                "elo": "no tournament has run (ml/tournament is unimplemented)",
            },
        },
    }


def write_training_stats(path: Path, stats: dict[str, Any]) -> dict[str, Any]:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2)
        f.write("\n")
    return stats
