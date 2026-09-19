"""Self-play game generation via MCTS.

Policy targets are the normalised root visit counts from MCTS, not the raw
network priors — the whole point of self-play is to distill search into the
network. Value targets are the eventual game outcome, recorded from each
stored position's own player-to-move perspective: the classic bug is writing
the outcome from a single fixed player's perspective everywhere, which trains
the value head to be wrong exactly half the time. Here every stored value is
assigned by walking the finished game and comparing that position's mover to
the winner, so this cannot happen.

Root Dirichlet noise is used during self-play only (never at evaluation/play
time). Move selection follows `mcts.temperature_schedule`: high temperature
(exploratory) early in the game, then greedy.

Generation is parallelised across worker processes. The worker count defaults
to something modest (2), not `os.cpu_count()` — this box runs other things.
"""

from __future__ import annotations

import multiprocessing as mp
from dataclasses import dataclass, field

import numpy as np

from ml.connect4.env import COLS, GameState, apply_move, create_game, encode, is_terminal
from ml.connect4.mcts import (
    EvalFn,
    Node,
    advance_root,
    search,
    select_move,
    temperature_schedule,
)

DEFAULT_WORKERS = 2
DEFAULT_DIRICHLET_EPSILON = 0.25
DEFAULT_DIRICHLET_ALPHA = 0.3


@dataclass
class GameExample:
    """One training example produced by self-play, before the outcome (value
    target) is known."""

    encoded_position: np.ndarray  # [2,6,7]
    policy_target: np.ndarray  # [7], normalised visit counts
    mover: int  # 1 or 2 — whose turn it was at this position


@dataclass
class SelfPlayResult:
    positions: list[np.ndarray] = field(default_factory=list)
    policies: list[np.ndarray] = field(default_factory=list)
    values: list[float] = field(default_factory=list)
    num_moves: int = 0


def _root_policy_target(root: Node, num_cols: int) -> np.ndarray:
    """Normalised visit-count distribution over all `num_cols` columns (zero
    for columns that were never legal/expanded)."""
    counts = root.visit_counts()
    target = np.zeros(num_cols, dtype=np.float32)
    for col, n in counts.items():
        target[col] = n
    total = target.sum()
    if total > 0:
        target /= total
    return target


def play_one_game(
    eval_fn: EvalFn,
    num_simulations: int,
    *,
    c_puct: float = 1.5,
    dirichlet_epsilon: float = DEFAULT_DIRICHLET_EPSILON,
    dirichlet_alpha: float = DEFAULT_DIRICHLET_ALPHA,
    temperature_threshold: int = 10,
    rng: np.random.Generator | None = None,
) -> SelfPlayResult:
    """Play one self-play game to completion, returning training examples with
    value targets already assigned from each position's own mover perspective.
    """
    rng = rng if rng is not None else np.random.default_rng()

    state: GameState = create_game()
    root: Node | None = None

    examples: list[GameExample] = []
    move_number = 0

    while not is_terminal(state):
        if root is None:
            root = Node(state)
        root = search(
            root,
            eval_fn,
            num_simulations,
            c_puct=c_puct,
            dirichlet_epsilon=dirichlet_epsilon,
            dirichlet_alpha=dirichlet_alpha,
            rng=rng,
        )

        policy_target = _root_policy_target(root, COLS)
        examples.append(
            GameExample(
                encoded_position=encode(state),
                policy_target=policy_target,
                mover=state.to_move,
            )
        )

        temperature = temperature_schedule(move_number, threshold=temperature_threshold)
        move = select_move(root, temperature=temperature, rng=rng)

        # Subtree reuse: advance to the chosen child, discard the rest.
        root = advance_root(root, move)
        state = apply_move(state, move)
        move_number += 1

    result = SelfPlayResult(num_moves=move_number)
    winner = state.winner  # None on a draw
    for ex in examples:
        if winner is None:
            value = 0.0
        elif ex.mover == winner:
            value = 1.0
        else:
            value = -1.0
        result.positions.append(ex.encoded_position)
        result.policies.append(ex.policy_target)
        result.values.append(value)

    return result


def _worker_play_games(
    weights_path: str | None,
    net_channels: int,
    net_blocks: int,
    num_games: int,
    num_simulations: int,
    seed: int,
    dirichlet_epsilon: float,
    dirichlet_alpha: float,
    temperature_threshold: int,
) -> list[SelfPlayResult]:
    """Runs in a worker process: builds its own network/eval_fn (torch state is
    not picklable/shareable across `spawn`-started processes on Windows) and
    plays `num_games` games."""
    import torch

    from ml.connect4.net import Connect4Net, make_eval_fn

    net = Connect4Net(channels=net_channels, num_blocks=net_blocks)
    if weights_path is not None:
        state_dict = torch.load(weights_path, map_location="cpu")
        net.load_state_dict(state_dict)
    eval_fn = make_eval_fn(net, device="cpu")

    rng = np.random.default_rng(seed)
    results = []
    for _ in range(num_games):
        results.append(
            play_one_game(
                eval_fn,
                num_simulations,
                dirichlet_epsilon=dirichlet_epsilon,
                dirichlet_alpha=dirichlet_alpha,
                temperature_threshold=temperature_threshold,
                rng=rng,
            )
        )
    return results


def generate_games(
    weights_path: str | None,
    net_channels: int,
    net_blocks: int,
    total_games: int,
    num_simulations: int,
    *,
    workers: int = DEFAULT_WORKERS,
    seed: int = 0,
    dirichlet_epsilon: float = DEFAULT_DIRICHLET_EPSILON,
    dirichlet_alpha: float = DEFAULT_DIRICHLET_ALPHA,
    temperature_threshold: int = 10,
) -> list[SelfPlayResult]:
    """Generate `total_games` self-play games, split across `workers`
    processes (default modest, never `os.cpu_count()`).

    Each worker loads the network from `weights_path` (or a fresh random
    network when `None`) independently, since torch modules are not safely
    shared across processes. `workers=1` runs in-process with no
    multiprocessing overhead, which is also what tests should use.
    """
    if workers < 1:
        raise ValueError("workers must be >= 1")

    # Distribute games as evenly as possible across workers.
    base = total_games // workers
    remainder = total_games % workers
    per_worker = [base + (1 if i < remainder else 0) for i in range(workers)]
    per_worker = [n for n in per_worker if n > 0]

    if workers == 1 or len(per_worker) == 1:
        return _worker_play_games(
            weights_path,
            net_channels,
            net_blocks,
            per_worker[0] if per_worker else 0,
            num_simulations,
            seed,
            dirichlet_epsilon,
            dirichlet_alpha,
            temperature_threshold,
        )

    ctx = mp.get_context("spawn")
    with ctx.Pool(processes=len(per_worker)) as pool:
        args = [
            (
                weights_path,
                net_channels,
                net_blocks,
                n,
                num_simulations,
                seed + i,
                dirichlet_epsilon,
                dirichlet_alpha,
                temperature_threshold,
            )
            for i, n in enumerate(per_worker)
        ]
        per_worker_results = pool.starmap(_worker_play_games, args)

    all_results: list[SelfPlayResult] = []
    for r in per_worker_results:
        all_results.extend(r)
    return all_results
