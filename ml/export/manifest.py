"""Writes `web/static/models/manifest.json` per `docs/CONTRACTS.md` §5.

The manifest is the single source of truth for which opponents exist; the
browser UI reads it and hardcodes nothing. This module only builds and
merges the `connect4` array -- it never touches `racer`, which belongs to a
different package's export step and must survive untouched across a
connect4 re-export.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

MANIFEST_VERSION = 1


def default_manifest() -> dict[str, Any]:
    """An empty manifest matching the CONTRACTS §5 shape."""
    return {"version": MANIFEST_VERSION, "connect4": [], "racer": []}


def read_manifest(path: Path) -> dict[str, Any]:
    """Reads an existing manifest, or an empty one if `path` does not exist.

    Missing top-level keys are filled in with empty arrays rather than
    raising, since a manifest written by an earlier, less complete export
    step (or hand-authored) should still merge cleanly.
    """
    path = Path(path)
    if not path.exists():
        return default_manifest()
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: manifest JSON is not an object")
    data.setdefault("version", MANIFEST_VERSION)
    data.setdefault("connect4", [])
    data.setdefault("racer", [])
    return data


def format_games_label(games_trained: int) -> str:
    """Human-readable label, e.g. `1,000 games`."""
    return f"{games_trained:,} games"


def build_connect4_entry(
    *,
    checkpoint_id: str,
    games_trained: int,
    onnx_file: str,
    mcts_sims: int,
    size_kb: int,
    elo: float | None = None,
    label: str | None = None,
) -> dict[str, Any]:
    """Builds one entry for the `connect4` array.

    `elo` defaults to `None` (-> JSON `null`) -- it is not invented here.
    Only `ml/tournament` writes a real Elo rating back into the manifest,
    after a tournament has actually run.
    """
    return {
        "id": checkpoint_id,
        "label": label if label is not None else format_games_label(games_trained),
        "file": onnx_file,
        "gamesTrained": games_trained,
        "elo": elo,
        "mctsSims": mcts_sims,
        "sizeKb": size_kb,
    }


def write_connect4_manifest(manifest_path: Path, entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Writes `entries` into `manifest_path`'s `connect4` array, ordered
    weakest-first by `gamesTrained`, preserving any existing `racer` array
    (and any other top-level key) untouched. Returns the full manifest dict
    that was written.
    """
    manifest_path = Path(manifest_path)
    manifest = read_manifest(manifest_path)
    manifest["connect4"] = sorted(entries, key=lambda e: e["gamesTrained"])
    manifest["version"] = MANIFEST_VERSION

    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    return manifest
