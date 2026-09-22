"""CLI: export every Connect 4 ladder checkpoint in `CHECKPOINTS_DIR` to ONNX
and (re)write `web/static/models/manifest.json` in one command.

Usage (from the repo root, with the ml venv active or via its python.exe):

    .ml_venv/Scripts/python.exe -m ml.export
    .ml_venv/Scripts/python.exe -m ml.export \
        --checkpoints-dir ml/checkpoints --models-dir web/static/models

Only files matching the ladder naming convention `c4-<7 digits>.pt` are
exported -- `latest.pt`, `latest_buffer.npz`, and `_selfplay_weights.pt` are
resume/scratch files and are never picked up by the pattern, so there is no
need to special-case excluding them.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from ml.export.manifest import build_connect4_entry, write_connect4_manifest
from ml.export.to_onnx import export_checkpoint_to_onnx
from ml.export.training_stats import build_training_stats, write_training_stats
from ml.paths import CHECKPOINTS_DIR, MODELS_DIR

LADDER_PATTERN = re.compile(r"^c4-(\d{7})\.pt$")


def find_ladder_checkpoints(checkpoints_dir: Path) -> list[Path]:
    """Ladder checkpoint files in `checkpoints_dir`, sorted weakest-first."""
    checkpoints_dir = Path(checkpoints_dir)
    if not checkpoints_dir.exists():
        return []
    matches = [p for p in checkpoints_dir.iterdir() if p.is_file() and LADDER_PATTERN.match(p.name)]
    return sorted(matches, key=lambda p: int(LADDER_PATTERN.match(p.name).group(1)))  # type: ignore[union-attr]


def export_ladder(
    checkpoints_dir: Path = CHECKPOINTS_DIR,
    models_dir: Path = MODELS_DIR,
) -> list[dict]:
    """Exports every ladder checkpoint found and writes the manifest.

    Returns the list of manifest entries written (empty if none found).
    """
    checkpoints_dir = Path(checkpoints_dir)
    models_dir = Path(models_dir)

    checkpoint_paths = find_ladder_checkpoints(checkpoints_dir)
    if not checkpoint_paths:
        print(f"No ladder checkpoints found in {checkpoints_dir}")
        return []

    onnx_dir = models_dir / "connect4"
    entries: list[dict] = []
    for ckpt_path in checkpoint_paths:
        checkpoint_id = ckpt_path.stem  # e.g. "c4-0001000"
        onnx_filename = f"{checkpoint_id}.onnx"
        onnx_path = onnx_dir / onnx_filename

        loaded = export_checkpoint_to_onnx(ckpt_path, onnx_path)
        size_kb = max(1, round(onnx_path.stat().st_size / 1024))
        mcts_sims = int(loaded.config.get("simulations", 0))

        entry = build_connect4_entry(
            checkpoint_id=checkpoint_id,
            games_trained=loaded.games_trained,
            onnx_file=f"connect4/{onnx_filename}",
            mcts_sims=mcts_sims,
            size_kb=size_kb,
        )
        entries.append(entry)
        print(
            f"Exported {ckpt_path.name} -> {onnx_path} "
            f"(games_trained={loaded.games_trained}, channels={loaded.channels}, "
            f"blocks={loaded.blocks})"
        )

    manifest_path = models_dir / "manifest.json"
    write_connect4_manifest(manifest_path, entries)
    print(f"Wrote manifest: {manifest_path}")

    # Written from the same checkpoints in the same pass, so the dashboard's
    # training stats cannot drift from the weights that were just exported.
    stats_path = models_dir / "training.json"
    write_training_stats(stats_path, build_training_stats(checkpoint_paths, onnx_dir))
    print(f"Wrote training stats: {stats_path}")
    return entries


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Export Connect 4 ladder checkpoints to ONNX and write manifest.json and training.json."
        )
    )
    parser.add_argument(
        "--checkpoints-dir",
        type=Path,
        default=CHECKPOINTS_DIR,
        help="Directory to scan for c4-<games>.pt ladder checkpoints (default: %(default)s).",
    )
    parser.add_argument(
        "--models-dir",
        type=Path,
        default=MODELS_DIR,
        help=(
            "Directory to write connect4/*.onnx, manifest.json and training.json "
            "into (default: %(default)s)."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    export_ladder(args.checkpoints_dir, args.models_dir)


if __name__ == "__main__":
    main(sys.argv[1:])
