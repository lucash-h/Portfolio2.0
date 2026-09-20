"""PUCT Monte Carlo Tree Search for Connect 4, AlphaZero style.

- Selection: `Q + c_puct * P * sqrt(sum(N)) / (1 + N)`.
- Expansion: driven by a supplied policy/value evaluator (a plain callable), so
  this module never imports torch. P2-B supplies a real network later; tests
  supply a deterministic stub.
- Backup: value negated at each level going up the tree, since a node's value
  is always from the perspective of the player to move *at that node*.
- Root Dirichlet noise, temperature-based move selection, and subtree reuse
  across moves.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Generator, Sequence

import numpy as np

from ml.connect4.env import GameState, apply_move, encode, is_terminal, legal_moves

# Given the encoded [2,6,7] tensor of a position, returns (policy priors over
# the 7 columns, value in [-1, 1] from the perspective of the player to move).
# Priors for illegal columns are ignored by `_expand` (masked and renormalised),
# so an evaluator may return an unmasked distribution.
EvalFn = Callable[[np.ndarray], tuple[Sequence[float], float]]

DEFAULT_C_PUCT = 1.5


class Node:
    """One position in the search tree.

    `N`, `W`, `P` describe the edge from the parent that leads to this node.
    `Q = W / N` is always from the perspective of this node's own
    `state.to_move` (not the parent's) — selection at the parent negates it.
    """

    __slots__ = ("state", "parent", "move", "children", "P", "N", "W", "is_expanded")

    def __init__(
        self,
        state: GameState,
        parent: Node | None = None,
        move: int | None = None,
        prior: float = 0.0,
    ) -> None:
        self.state = state
        self.parent = parent
        self.move = move
        self.children: dict[int, Node] = {}
        self.P = prior
        self.N = 0
        self.W = 0.0
        self.is_expanded = False

    @property
    def Q(self) -> float:
        return self.W / self.N if self.N > 0 else 0.0

    def visit_counts(self) -> dict[int, int]:
        return {col: child.N for col, child in self.children.items()}


def _terminal_value(state: GameState) -> float:
    """Outcome from the perspective of `state.to_move`. `to_move` has already
    advanced past the player who just won, so a decided game is always -1
    here; a draw is 0."""
    if state.winner is not None:
        return -1.0
    return 0.0


def _finish_expand(node: Node, raw_priors: Sequence[float], value: float) -> float:
    """Shared tail of expansion, used by both the direct (`eval_fn`-calling)
    and generator (batched-evaluator) paths: mask/renormalise priors over
    legal columns, create children, mark expanded, and return the value as a
    plain float. Assumes `node.state` is not terminal."""
    raw_priors = np.asarray(raw_priors, dtype=np.float64)

    legal = legal_moves(node.state)
    masked = np.zeros(len(raw_priors), dtype=np.float64)
    for col in legal:
        masked[col] = max(0.0, float(raw_priors[col]))
    total = masked.sum()
    if total > 0:
        masked = masked / total
    else:
        # Degenerate policy (e.g. an all-zero stub): fall back to uniform.
        for col in legal:
            masked[col] = 1.0 / len(legal)

    for col in legal:
        child_state = apply_move(node.state, col)
        node.children[col] = Node(child_state, parent=node, move=col, prior=float(masked[col]))

    node.is_expanded = True
    return float(value)


def _expand(node: Node, eval_fn: EvalFn) -> float:
    """Evaluate `node` with `eval_fn`, create its children, and return the
    value from the perspective of `node.state.to_move`. Assumes `node.state` is
    not terminal."""
    raw_priors, value = eval_fn(encode(node.state))
    return _finish_expand(node, raw_priors, value)


def _backup(node: Node, value: float) -> None:
    """Propagate a leaf value up to the root, negating at each level so every
    node's `W` stays in its own `state.to_move` perspective."""
    v = value
    n: Node | None = node
    while n is not None:
        n.N += 1
        n.W += v
        v = -v
        n = n.parent


def _select_child(node: Node, c_puct: float) -> Node:
    """PUCT selection among `node`'s children."""
    sqrt_total = math.sqrt(node.N)
    best_score = -math.inf
    best_child: Node | None = None
    for child in node.children.values():
        q = -child.Q  # child.Q is from the opponent's perspective
        u = c_puct * child.P * sqrt_total / (1 + child.N)
        score = q + u
        if score > best_score:
            best_score = score
            best_child = child
    assert best_child is not None  # node.children is non-empty whenever expanded
    return best_child


def _simulate(root: Node, eval_fn: EvalFn, c_puct: float) -> None:
    """One selection -> expansion -> backup pass, starting at `root`."""
    node = root
    while node.is_expanded and not is_terminal(node.state):
        node = _select_child(node, c_puct)

    value = _terminal_value(node.state) if is_terminal(node.state) else _expand(node, eval_fn)
    _backup(node, value)


# `(priors, value)` sent back into a suspended `_simulate_gen`/`search_gen`
# generator to resume it after a batched evaluation.
EvalResult = tuple[Sequence[float], float]


def _simulate_gen(root: Node, c_puct: float) -> Generator[np.ndarray, EvalResult, None]:
    """Generator twin of `_simulate`, for batched leaf evaluation.

    Identical selection/backup logic to `_simulate` — same helper functions,
    called in the same order — so driving this generator to completion with
    `(priors, value)` from an evaluator produces exactly the same tree
    mutation as calling `_simulate` with the per-position `EvalFn` that would
    have returned that same `(priors, value)`. The only difference is that a
    non-terminal leaf `yield`s its encoded `[2,6,7]` position instead of
    calling `eval_fn` directly, so a caller can suspend here, batch this
    position with others, and `.send()` the result back in. A terminal leaf
    resolves immediately and never yields, so terminal positions never occupy
    a batch slot.
    """
    node = root
    while node.is_expanded and not is_terminal(node.state):
        node = _select_child(node, c_puct)

    if is_terminal(node.state):
        value = _terminal_value(node.state)
    else:
        raw_priors, value = yield encode(node.state)
        value = _finish_expand(node, raw_priors, value)
    _backup(node, value)


def search_gen(
    root: Node | GameState,
    num_simulations: int,
    *,
    c_puct: float = DEFAULT_C_PUCT,
    dirichlet_epsilon: float = 0.0,
    dirichlet_alpha: float = 0.3,
    rng: np.random.Generator | None = None,
) -> Generator[np.ndarray, EvalResult, Node]:
    """Generator twin of `search`, for batched leaf evaluation.

    Mirrors `search`'s control flow line for line (same helpers, same order),
    delegating each simulation to `_simulate_gen` via `yield from`. Driven to
    completion — resumed with `(priors, value)` for every position it yields,
    in the order it yields them — this produces the identical `Node` tree
    `search` would have produced by calling an `EvalFn` that returned those
    same `(priors, value)` pairs. Returns the (possibly newly created) root
    node, available as the generator's `StopIteration.value` (or via
    `yield from search_gen(...)` in a caller that is itself a generator).
    """
    node = root if isinstance(root, Node) else Node(root)

    if num_simulations <= 0 or is_terminal(node.state):
        return node

    remaining = num_simulations
    if not node.is_expanded:
        yield from _simulate_gen(node, c_puct)
        remaining -= 1
        if dirichlet_epsilon > 0:
            add_dirichlet_noise(node, dirichlet_epsilon, dirichlet_alpha, rng)

    for _ in range(remaining):
        yield from _simulate_gen(node, c_puct)

    return node


def add_dirichlet_noise(
    root: Node, epsilon: float, alpha: float, rng: np.random.Generator | None = None
) -> None:
    """Mix Dirichlet noise into the root's edge priors. Root only: this touches
    `root.children`'s `P` and nothing deeper, so exploration noise never leaks
    into inner nodes."""
    if not root.children:
        return
    rng = rng if rng is not None else np.random.default_rng()
    cols = list(root.children.keys())
    noise = rng.dirichlet([alpha] * len(cols))
    for col, n in zip(cols, noise, strict=True):
        child = root.children[col]
        child.P = (1 - epsilon) * child.P + epsilon * float(n)


def search(
    root: Node | GameState,
    eval_fn: EvalFn,
    num_simulations: int,
    *,
    c_puct: float = DEFAULT_C_PUCT,
    dirichlet_epsilon: float = 0.0,
    dirichlet_alpha: float = 0.3,
    rng: np.random.Generator | None = None,
) -> Node:
    """Run PUCT search for `num_simulations` new simulations and return the
    (possibly newly created) root node.

    `root` may be a fresh `GameState` or a `Node` retained from a previous move
    via `advance_root` (subtree reuse) — either way, this call performs exactly
    `num_simulations` additional simulate-and-backup passes on top of whatever
    statistics the node already carries; existing counts are never reset.

    Root Dirichlet noise (when `dirichlet_epsilon > 0`) is mixed in once, right
    after the root's first expansion, so it shapes every subsequent selection
    without touching `eval_fn`'s output at any other node.
    """
    node = root if isinstance(root, Node) else Node(root)

    if num_simulations <= 0 or is_terminal(node.state):
        return node

    remaining = num_simulations
    if not node.is_expanded:
        _simulate(node, eval_fn, c_puct)
        remaining -= 1
        if dirichlet_epsilon > 0:
            add_dirichlet_noise(node, dirichlet_epsilon, dirichlet_alpha, rng)

    for _ in range(remaining):
        _simulate(node, eval_fn, c_puct)

    return node


def temperature_schedule(
    move_number: int, *, high: float = 1.0, low: float = 0.0, threshold: int = 10
) -> float:
    """Standard AlphaZero-style schedule: explore at `high` temperature for the
    first `threshold` moves of the game, then play sharply at `low`."""
    return high if move_number < threshold else low


def select_move(
    root: Node, temperature: float = 1.0, rng: np.random.Generator | None = None
) -> int:
    """Pick a move from the root's visit-count distribution.

    Temperature 0 is argmax (ties broken by lowest column index). Temperature 1
    samples proportional to visit counts; other temperatures sample
    proportional to `N ** (1 / temperature)`.
    """
    counts = root.visit_counts()
    if not counts:
        raise ValueError("cannot select a move from a root with no children")

    cols = list(counts.keys())
    visits = np.array([counts[c] for c in cols], dtype=np.float64)

    if temperature == 0:
        return cols[int(np.argmax(visits))]

    if temperature != 1.0:
        visits = visits ** (1.0 / temperature)

    total = visits.sum()
    probs = visits / total if total > 0 else np.full(len(cols), 1.0 / len(cols))

    rng = rng if rng is not None else np.random.default_rng()
    choice = rng.choice(len(cols), p=probs)
    return cols[int(choice)]


def advance_root(root: Node, move: int) -> Node:
    """Reuse the subtree under `move` as the new root, preserving its stats. If
    `move` was never explored (rare with enough simulations), a fresh
    unvisited node is created instead."""
    child = root.children.get(move)
    if child is None:
        child = Node(apply_move(root.state, move))
    child.parent = None
    return child
