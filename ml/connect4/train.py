"""CLI training loop: alternates self-play game generation and SGD steps on
the replay buffer, with resumable checkpoints.

Checkpoint files are saved into `paths.CHECKPOINTS_DIR` at cumulative game
counts 1_000, 10_000, 100_000, 500_000 (the difficulty ladder P2-C will export
to ONNX), plus a `latest.pt` written every training cycle purely for resuming
an interrupted run (not part of the ladder).

A checkpoint file (`torch.save`) contains:
    {
        "model_state_dict": ...,
        "optimizer_state_dict": ...,
        "games_trained": int,       # cumulative self-play games, exact
        "config": {...},            # architecture + training hyperparameters
        "timestamp": "2026-...Z",   # ISO 8601 UTC
    }
The replay buffer is checkpointed separately (`latest_buffer.npz`, alongside
`latest.pt`) since it can be large and P2-C never needs it.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import torch
from torch import nn

from ml.connect4.net import Connect4Net, count_parameters
from ml.connect4.replay import ReplayBuffer
from ml.connect4.selfplay import DEFAULT_CONCURRENCY, generate_games
from ml.paths import CHECKPOINTS_DIR

CHECKPOINT_LADDER = (1_000, 10_000, 100_000, 500_000)


@dataclass
class TrainConfig:
    channels: int = 32
    blocks: int = 4
    workers: int = 2
    concurrency: int = DEFAULT_CONCURRENCY
    simulations: int = 64
    batch_size: int = 128
    learning_rate: float = 1e-3
    games_per_cycle: int = 20
    train_steps_per_cycle: int = 50
    buffer_capacity: int = 200_000
    target_games: int = 1_000
    dirichlet_epsilon: float = 0.25
    dirichlet_alpha: float = 0.3
    temperature_threshold: int = 10
    seed: int = 0


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _checkpoint_path(games_trained: int) -> Path:
    return CHECKPOINTS_DIR / f"c4-{games_trained:07d}.pt"


def save_checkpoint(
    path: Path,
    net: Connect4Net,
    optimizer: torch.optim.Optimizer,
    games_trained: int,
    config: TrainConfig,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "model_state_dict": net.state_dict(),
            "optimizer_state_dict": optimizer.state_dict(),
            "games_trained": games_trained,
            "config": asdict(config),
            "timestamp": _now_iso(),
        },
        path,
    )


def load_checkpoint(path: Path, net: Connect4Net, optimizer: torch.optim.Optimizer) -> int:
    """Loads model + optimizer state in place, returns `games_trained`."""
    data = torch.load(path, map_location="cpu")
    net.load_state_dict(data["model_state_dict"])
    optimizer.load_state_dict(data["optimizer_state_dict"])
    return int(data["games_trained"])


def run_training_step(
    net: Connect4Net,
    optimizer: torch.optim.Optimizer,
    buffer: ReplayBuffer,
    batch_size: int,
    rng: np.random.Generator,
) -> tuple[float, float]:
    """One SGD step. Returns (policy_loss, value_loss) as plain floats."""
    positions, policies, values = buffer.sample(batch_size, rng=rng)

    x = torch.from_numpy(positions)
    policy_targets = torch.from_numpy(policies)
    value_targets = torch.from_numpy(values).unsqueeze(1)

    net.train()
    policy_logits, value_pred = net(x)

    log_probs = torch.log_softmax(policy_logits, dim=-1)
    policy_loss = -(policy_targets * log_probs).sum(dim=-1).mean()
    value_loss = nn.functional.mse_loss(value_pred, value_targets)
    loss = policy_loss + value_loss

    optimizer.zero_grad()
    loss.backward()
    optimizer.step()

    return float(policy_loss.item()), float(value_loss.item())


def train(
    config: TrainConfig,
    *,
    resume_path: Path | None = None,
    ladder: tuple[int, ...] | None = None,
) -> None:
    net = Connect4Net(channels=config.channels, num_blocks=config.blocks)
    optimizer = torch.optim.Adam(net.parameters(), lr=config.learning_rate)
    buffer = ReplayBuffer(config.buffer_capacity)

    games_trained = 0
    latest_pt = CHECKPOINTS_DIR / "latest.pt"
    latest_buffer = CHECKPOINTS_DIR / "latest_buffer.npz"

    if resume_path is not None:
        games_trained = load_checkpoint(resume_path, net, optimizer)
        buf_path = resume_path.with_name(resume_path.stem + "_buffer.npz")
        if not buf_path.exists():
            buf_path = latest_buffer
        if buf_path.exists():
            buffer = ReplayBuffer.load(buf_path)
        print(f"Resumed from {resume_path}: games_trained={games_trained}")

    rng = np.random.default_rng(config.seed)
    ladder = tuple(sorted(ladder)) if ladder else CHECKPOINT_LADDER
    ladder_remaining = [g for g in ladder if g > games_trained]

    weights_tmp_path = CHECKPOINTS_DIR / "_selfplay_weights.pt"
    CHECKPOINTS_DIR.mkdir(parents=True, exist_ok=True)

    while games_trained < config.target_games:
        # Self-play with the current weights.
        torch.save(net.state_dict(), weights_tmp_path)
        games_this_cycle = min(config.games_per_cycle, config.target_games - games_trained)
        results = generate_games(
            str(weights_tmp_path),
            config.channels,
            config.blocks,
            games_this_cycle,
            config.simulations,
            workers=config.workers,
            concurrency=config.concurrency,
            seed=int(rng.integers(0, 2**31 - 1)),
            dirichlet_epsilon=config.dirichlet_epsilon,
            dirichlet_alpha=config.dirichlet_alpha,
            temperature_threshold=config.temperature_threshold,
        )
        for result in results:
            buffer.add_many(result.positions, result.policies, result.values)
        games_trained += len(results)

        # Training steps on the (now larger) buffer.
        policy_losses = []
        value_losses = []
        if len(buffer) >= config.batch_size:
            for _ in range(config.train_steps_per_cycle):
                p_loss, v_loss = run_training_step(net, optimizer, buffer, config.batch_size, rng)
                policy_losses.append(p_loss)
                value_losses.append(v_loss)

        mean_p = float(np.mean(policy_losses)) if policy_losses else float("nan")
        mean_v = float(np.mean(value_losses)) if value_losses else float("nan")
        print(
            f"games_trained={games_trained} buffer_size={len(buffer)} "
            f"policy_loss={mean_p:.4f} value_loss={mean_v:.4f}"
        )

        # Resumable checkpoint every cycle.
        save_checkpoint(latest_pt, net, optimizer, games_trained, config)
        buffer.save(latest_buffer)

        # Ladder checkpoints at exact cumulative game counts.
        while ladder_remaining and games_trained >= ladder_remaining[0]:
            milestone = ladder_remaining.pop(0)
            ladder_path = _checkpoint_path(milestone)
            save_checkpoint(ladder_path, net, optimizer, games_trained, config)
            print(f"Saved ladder checkpoint: {ladder_path} (games_trained={games_trained})")

    if weights_tmp_path.exists():
        weights_tmp_path.unlink()


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Train the Connect 4 self-play network.")
    parser.add_argument(
        "--workers",
        type=int,
        default=TrainConfig.workers,
        help="Self-play worker processes (default: %(default)s; kept modest "
        "on purpose — do not pass os.cpu_count()).",
    )
    parser.add_argument(
        "--simulations",
        type=int,
        default=TrainConfig.simulations,
        help="MCTS simulations per move during self-play.",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=TrainConfig.concurrency,
        help="Games stepped in lockstep per self-play worker process, for "
        "batched leaf evaluation (default: %(default)s). Complements "
        "--workers: workers controls OS processes/cores, concurrency "
        "controls the network's forward-pass batch size within each one.",
    )
    parser.add_argument("--batch-size", type=int, default=TrainConfig.batch_size)
    parser.add_argument("--lr", type=float, default=TrainConfig.learning_rate)
    parser.add_argument(
        "--target-games",
        type=int,
        default=TrainConfig.target_games,
        help="Cumulative self-play games to reach before stopping.",
    )
    parser.add_argument("--games-per-cycle", type=int, default=TrainConfig.games_per_cycle)
    parser.add_argument(
        "--train-steps-per-cycle", type=int, default=TrainConfig.train_steps_per_cycle
    )
    parser.add_argument("--buffer-capacity", type=int, default=TrainConfig.buffer_capacity)
    parser.add_argument("--channels", type=int, default=TrainConfig.channels)
    parser.add_argument("--blocks", type=int, default=TrainConfig.blocks)
    parser.add_argument("--seed", type=int, default=TrainConfig.seed)
    parser.add_argument(
        "--ladder",
        type=str,
        default=None,
        help=(
            "Comma-separated cumulative game counts at which to save ladder "
            "checkpoints, e.g. '50,150,300'. Defaults to "
            f"{','.join(str(g) for g in CHECKPOINT_LADDER)}. Useful for producing "
            "a short but genuine ladder without waiting for a full run."
        ),
    )
    parser.add_argument(
        "--resume",
        type=str,
        default=None,
        help="Path to a checkpoint .pt file to resume from "
        "(expects a sibling *_buffer.npz, or falls "
        "back to latest_buffer.npz).",
    )
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    config = TrainConfig(
        channels=args.channels,
        blocks=args.blocks,
        workers=args.workers,
        concurrency=args.concurrency,
        simulations=args.simulations,
        batch_size=args.batch_size,
        learning_rate=args.lr,
        games_per_cycle=args.games_per_cycle,
        train_steps_per_cycle=args.train_steps_per_cycle,
        buffer_capacity=args.buffer_capacity,
        target_games=args.target_games,
        seed=args.seed,
    )
    print(f"Config: {json.dumps(asdict(config))}")
    print(f"Parameter count: {count_parameters(Connect4Net(config.channels, config.blocks))}")

    resume_path = Path(args.resume) if args.resume else None
    ladder = (
        tuple(int(g.strip()) for g in args.ladder.split(",") if g.strip()) if args.ladder else None
    )
    start = time.time()
    train(config, resume_path=resume_path, ladder=ladder)
    print(f"Done in {time.time() - start:.1f}s")


if __name__ == "__main__":
    main(sys.argv[1:])
