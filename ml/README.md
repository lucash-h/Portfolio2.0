# ML Training Pipeline

This directory contains the Python training code for game AI models. **Nothing in this package is deployed.** Training runs locally or on a build VPS, producing ONNX checkpoint files that are exported to `web/static/models/` for use in the browser.

## Setup

Create and activate a virtual environment:

```bash
python -m venv .venv
```

On Linux/macOS:
```bash
source .venv/bin/activate
```

On Windows:
```bash
.venv\Scripts\activate
```

Install dev dependencies (pytest and ruff):

```bash
pip install -e ".[dev]"
```

Note: This installs only the dev dependencies. The heavy dependencies (torch, numpy, onnx, onnxruntime) are declared in `pyproject.toml` but not installed here. They will be installed when you run actual training code.

## Testing

Run all tests from the repository root:

```bash
pytest ml/
```

Or from within the ml directory:

```bash
cd ml
pytest
```

## Linting and Code Quality

Check code with ruff:

```bash
ruff check ml/
```

Auto-format code:

```bash
ruff format ml/
```

Check that formatting is correct (useful in CI):

```bash
ruff format --check ml/
```

## Project Structure

- `connect4/` — Connect 4 self-play training and MCTS
- `racer/` — Neuroevolution training for the racing game
- `export/` — ONNX export and checkpoint manifest generation
- `tournament/` — Elo rating computation
- `conformance/` — Cross-language parity tests against shared fixtures

## Outputs

Training produces:
- `.onnx` checkpoint files saved to `ml/checkpoints/` (gitignored)
- `manifest.json` written to `web/static/models/` describing available checkpoints

Note: `web/static/models/` may not exist yet; the export module creates it as needed.

## Dependencies

### Core (declared, installed when training)
- `torch` ≥ 2.0.0 — PyTorch for training
- `numpy` ≥ 1.24.0 — Numerical computing
- `onnx` ≥ 1.14.0 — ONNX model format
- `onnxruntime` ≥ 1.16.0 — ONNX inference

### Dev (installed immediately)
- `pytest` — Test framework
- `ruff` — Linting and formatting

## Conventions

- Python 3.12 or later
- All public functions have type hints (CONTRACTS §8)
- Code must pass `ruff check` (pycodestyle, pyflakes, isort, bugbear enabled)
- Line length: 100 characters
