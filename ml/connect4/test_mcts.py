"""Unit tests for ml/connect4/mcts.py using a deterministic tactical stub
evaluator — no torch, no neural net. See docs/PACKAGES.md P2-A acceptance:
'MCTS with a perfect-play stub never loses a won position.'
"""

from __future__ import annotations

import numpy as np
import pytest

from ml.connect4 import env
from ml.connect4.mcts import Node, advance_root, search, select_move


def _relative_board(tensor: np.ndarray) -> tuple[int, ...]:
    """Rebuild a flat env-style board (mover=1, opponent=2) from an encoded
    tensor. The tensor is already relative by construction, so this recovers
    exactly enough information to reuse env's win-checking logic without ever
    learning which absolute player is on move."""
    mover = tensor[0]
    opp = tensor[1]
    rel = np.zeros((env.ROWS, env.COLS), dtype=np.int64)
    rel[mover == 1] = 1
    rel[opp == 1] = 2
    return tuple(int(v) for v in rel.reshape(-1))


def _column_heights(board: tuple[int, ...]) -> list[int]:
    heights = []
    for col in range(env.COLS):
        h = 0
        while h < env.ROWS and board[env.idx(h, col)] != 0:
            h += 1
        heights.append(h)
    return heights


def tactical_eval(tensor: np.ndarray) -> tuple[list[float], float]:
    """Stub policy/value function: uniform prior over legal columns; value is
    +1.0 if the player to move has an immediate (one-move) winning column,
    else 0.0.

    Deliberately shallow -- this is not a solver. It exists to prove MCTS's own
    mechanics (selection, backup, subtree reuse) correctly propagate a tactical
    signal through the tree, not to play well by itself.
    """
    board = _relative_board(tensor)
    heights = _column_heights(board)
    legal = [c for c in range(env.COLS) if heights[c] < env.ROWS]

    has_win = False
    for col in legal:
        row = heights[col]
        trial = list(board)
        trial[env.idx(row, col)] = 1
        if env._find_win_through(tuple(trial), row, col, 1) is not None:
            has_win = True
            break

    policy = [1.0 / len(legal) if c in legal else 0.0 for c in range(env.COLS)]
    value = 1.0 if has_win else 0.0
    return policy, value


def _forced_win_state() -> env.GameState:
    """P1 to move. Row 0: cols 0-2 are P1, cols 4-6 are P2, col 3 is empty.
    Column 3 is a double threat -- whoever plays it completes four in a row.
    P1 must take it now or P2 wins on the very next move."""
    return env.from_moves([0, 4, 1, 5, 2, 6])


def test_finds_mate_in_one() -> None:
    state = _forced_win_state()
    root = search(state, tactical_eval, num_simulations=100, rng=np.random.default_rng(0))
    assert select_move(root, temperature=0) == 3


@pytest.mark.parametrize("num_simulations", [15, 30, 100, 400])
def test_more_simulations_never_pick_a_losing_move(num_simulations: int) -> None:
    # Budgets start at 15: with fewer simulations than there are columns, the
    # tree hasn't yet visited every sibling once, so visit counts can tie and
    # temperature-0 tie-breaking (lowest column index) is not a meaningful
    # signal -- that is a property of *any* visit-count-based tie-break, not a
    # bug in search. From the point every column has been sampled at least
    # once onward, the tactical signal must win out, and stay winning as the
    # budget grows.
    state = _forced_win_state()
    root = search(
        state, tactical_eval, num_simulations=num_simulations, rng=np.random.default_rng(0)
    )
    # Every column other than 3 hands P2 an immediate win on the very next
    # move, so at every simulation budget the pick must still be the win.
    assert select_move(root, temperature=0) == 3


def test_dirichlet_noise_root_only_not_inner_nodes() -> None:
    state = env.create_game()

    root_noisy = search(
        state,
        tactical_eval,
        num_simulations=300,
        dirichlet_epsilon=0.5,
        dirichlet_alpha=0.3,
        rng=np.random.default_rng(1),
    )
    root_clean = search(state, tactical_eval, num_simulations=300)

    noisy_root_priors = {c: ch.P for c, ch in root_noisy.children.items()}
    clean_root_priors = {c: ch.P for c, ch in root_clean.children.items()}
    assert noisy_root_priors != clean_root_priors, "root priors should be perturbed by noise"

    compared_any = False
    for col, clean_child in root_clean.children.items():
        noisy_child = root_noisy.children[col]
        for gcol, clean_grandchild in clean_child.children.items():
            if gcol in noisy_child.children:
                compared_any = True
                assert noisy_child.children[gcol].P == pytest.approx(clean_grandchild.P), (
                    "noise leaked past the root into an inner node's priors"
                )
    assert compared_any, "test needs simulations deep enough to expand some grandchildren"


def test_temperature_zero_is_argmax() -> None:
    root = Node(env.create_game())
    root.is_expanded = True
    visit_counts = [3, 1, 9, 2, 0, 4, 5]
    for col, n in zip(range(env.COLS), visit_counts, strict=True):
        child = Node(env.apply_move(env.create_game(), col), parent=root, move=col, prior=1 / 7)
        child.N = n
        root.children[col] = child

    assert select_move(root, temperature=0) == 2  # column with N=9, the max


def test_subtree_reuse_preserves_statistics() -> None:
    state = env.create_game()
    root = search(state, tactical_eval, num_simulations=200, rng=np.random.default_rng(2))

    counts = root.visit_counts()
    move = max(counts, key=counts.get)
    child_before = root.children[move]
    n_before = child_before.N
    w_before = child_before.W
    grandchild_counts_before = {c: gc.N for c, gc in child_before.children.items()}
    assert n_before > 0
    assert child_before.parent is root

    reused_root = advance_root(root, move)
    assert reused_root is child_before
    assert reused_root.parent is None
    assert reused_root.N == n_before
    assert reused_root.W == w_before

    final_root = search(
        reused_root, tactical_eval, num_simulations=50, rng=np.random.default_rng(3)
    )

    assert final_root is reused_root
    assert final_root.N == n_before + 50
    for col, gc in final_root.children.items():
        if col in grandchild_counts_before:
            assert gc.N >= grandchild_counts_before[col]


def test_advance_root_creates_fresh_node_for_unexplored_move() -> None:
    root = Node(env.create_game())
    root.is_expanded = True  # no children populated -- simulate an unexplored move
    new_root = advance_root(root, 0)
    assert new_root.parent is None
    assert new_root.state == env.apply_move(env.create_game(), 0)
    assert new_root.N == 0
