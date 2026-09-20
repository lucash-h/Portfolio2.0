"""Tests for batched leaf evaluation (docs/TRAINING-PLAN.md §1-2).

The property under test is not "batching is fast" -- it is "batching changes
nothing but timing". Every test here either proves bit-identical equivalence
between the sequential and batched paths, or checks a structural property
(terminal leaves never occupy a batch slot; an uneven cohort still completes)
that equivalence alone doesn't cover.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np
import torch

from ml.connect4 import env
from ml.connect4.mcts import Node, search, search_gen, select_move
from ml.connect4.net import Connect4Net, make_batch_eval_fn, make_eval_fn
from ml.connect4.selfplay import play_games_batched, play_one_game

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fixed_net() -> Connect4Net:
    """A small, deterministically-initialised network. Real (non-uniform,
    non-tactical-stub) priors so the tree actually branches under PUCT --
    an all-uniform stub would tie every sibling and mask a reordering bug."""
    torch.manual_seed(1234)
    return Connect4Net(channels=8, num_blocks=2)


def _stub_priors_value(encoded: np.ndarray) -> tuple[np.ndarray, float]:
    """Deterministic, non-uniform, per-row-independent stand-in for a real
    network. `encoded` may be a single `[2,6,7]` position or a stacked
    `[N,2,6,7]` batch -- the arithmetic below only ever reduces over each
    row's own axes, never across rows, so it is exactly (bit-for-bit)
    reproducible whether called once per position or once for a whole batch.
    A real torch network is not guaranteed that: batched GEMM kernels are not
    required to be bit-identical to their batch-size-1 equivalent (see the
    module docstring note on this in the test bodies below), which is why
    this stub -- not `Connect4Net` -- is what proves the *scheduler* is
    exact."""
    single = encoded.ndim == 3
    batch = encoded[np.newaxis] if single else encoded
    col_mover = batch[:, 0].sum(axis=1)  # [N,7]
    col_opp = batch[:, 1].sum(axis=1)  # [N,7]
    logits = col_mover * 1.3 - col_opp * 1.7 + np.arange(7) * 0.05
    exp = np.exp(logits - logits.max(axis=1, keepdims=True))
    priors = exp / exp.sum(axis=1, keepdims=True)
    value = np.tanh((col_mover.sum(axis=1) - col_opp.sum(axis=1)) * 0.2)
    if single:
        return priors[0], float(value[0])
    return priors, value


def _stub_eval_fn(encoded: np.ndarray) -> tuple[list[float], float]:
    priors, value = _stub_priors_value(encoded)
    return priors.tolist(), value


def _stub_batch_eval_fn(encoded_batch: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    return _stub_priors_value(encoded_batch)


def _run_batched_searches(
    states: Sequence[env.GameState | Node],
    num_simulations: int,
    batch_eval_fn,
    *,
    dirichlet_epsilon: float = 0.0,
    dirichlet_alpha: float = 0.3,
    seeds: Sequence[int] | None = None,
) -> list[Node]:
    """Drive several independent `search_gen` trees concurrently, batching
    every round's pending leaf positions into one `batch_eval_fn` call --
    the same round-robin shape `play_games_batched` uses, but at the MCTS
    layer directly (no whole-game loop), so a branching mid-game position can
    be exercised without playing an entire game to reach it."""
    seeds = seeds if seeds is not None else [None] * len(states)
    rngs = [np.random.default_rng(s) if s is not None else None for s in seeds]

    gens = {
        i: search_gen(
            states[i],
            num_simulations,
            dirichlet_epsilon=dirichlet_epsilon,
            dirichlet_alpha=dirichlet_alpha,
            rng=rngs[i],
        )
        for i in range(len(states))
    }
    to_send: dict[int, tuple | None] = dict.fromkeys(gens, None)
    results: dict[int, Node] = {}

    while gens:
        pending_pos, pending_idx = [], []
        for i in list(gens.keys()):
            gen = gens[i]
            try:
                encoded = gen.send(to_send.pop(i))
            except StopIteration as stop:
                results[i] = stop.value
                del gens[i]
                continue
            pending_pos.append(encoded)
            pending_idx.append(i)

        if pending_pos:
            batch = np.stack(pending_pos, axis=0)
            priors, values = batch_eval_fn(batch)
            for j, i in enumerate(pending_idx):
                to_send[i] = (priors[j], float(values[j]))

    return [results[i] for i in range(len(states))]


def _assert_trees_identical(a: Node, b: Node) -> int:
    """Recursively assert two trees have identical N/W/P/state everywhere,
    returning the number of nodes compared (so a test can assert the tree
    was deep enough to be a meaningful check)."""
    assert a.state == b.state
    assert a.N == b.N
    assert a.W == b.W
    assert a.P == b.P
    assert set(a.children.keys()) == set(b.children.keys())
    count = 1
    for col in a.children:
        count += _assert_trees_identical(a.children[col], b.children[col])
    return count


def _branching_state() -> env.GameState:
    """A few plies in, several columns are still live -- unlike an empty
    board this exercises PUCT actually discriminating between siblings."""
    return env.from_moves([3, 2, 4])


# ---------------------------------------------------------------------------
# 1. Equivalence -- the test that proves the whole change is safe.
# ---------------------------------------------------------------------------


def test_batched_and_sequential_mcts_trees_are_identical():
    """Same evaluator, same starting states, same per-tree rng seed, same
    simulation budget: whether each tree's leaves are evaluated one at a time
    (sequential `search`) or interleaved with other trees in shared batches
    (`search_gen` driven by `_run_batched_searches`), the resulting trees must
    be identical node for node -- not just the final move.

    Uses the deterministic `_stub_eval_fn`/`_stub_batch_eval_fn` pair, not a
    real `Connect4Net`, deliberately: they are constructed to be exactly
    (bit-for-bit) reproducible regardless of batch shape, which isolates what
    this test is actually about -- the *scheduler's* selection/backup/subtree
    logic -- from a separate, genuine floating-point wrinkle in real batched
    neural-net inference. See the module-level note near the bottom of this
    file for that wrinkle and why it doesn't undermine the scheduler."""
    eval_fn = _stub_eval_fn
    batch_eval_fn = _stub_batch_eval_fn

    states = [env.create_game(), _branching_state(), _branching_state()]
    seeds = [10, 11, 12]
    num_simulations = 60

    sequential_roots = [
        search(states[i], eval_fn, num_simulations, rng=np.random.default_rng(seeds[i]))
        for i in range(len(states))
    ]

    batched_roots = _run_batched_searches(states, num_simulations, batch_eval_fn, seeds=seeds)

    total_compared = 0
    for seq_root, batch_root in zip(sequential_roots, batched_roots, strict=True):
        total_compared += _assert_trees_identical(seq_root, batch_root)
        assert seq_root.visit_counts() == batch_root.visit_counts()
        assert select_move(seq_root, temperature=0) == select_move(batch_root, temperature=0)

    # Guards against a vacuous pass (e.g. every tree collapsing to just the
    # root) -- with 60 sims across branching positions this should be large.
    assert total_compared > 100


def test_batched_and_sequential_mcts_equivalence_across_seeds_and_concurrency():
    """Repeats the equivalence check across several seeds and a larger,
    unevenly-sized cohort (concurrency doesn't divide the tree count evenly),
    since a scheduling bug might only show up with an odd cohort shape."""
    eval_fn = _stub_eval_fn
    batch_eval_fn = _stub_batch_eval_fn

    for seed_base in (0, 100, 999):
        states = [
            env.create_game(),
            _branching_state(),
            env.from_moves([0, 0, 0]),
            _branching_state(),
            env.create_game(),
        ]
        seeds = [seed_base + i for i in range(len(states))]
        num_simulations = 24

        sequential_roots = [
            search(states[i], eval_fn, num_simulations, rng=np.random.default_rng(seeds[i]))
            for i in range(len(states))
        ]
        batched_roots = _run_batched_searches(states, num_simulations, batch_eval_fn, seeds=seeds)

        for seq_root, batch_root in zip(sequential_roots, batched_roots, strict=True):
            _assert_trees_identical(seq_root, batch_root)


def test_batched_and_sequential_dirichlet_noise_matches():
    """Root Dirichlet noise draws from the tree's own rng -- confirm batching
    doesn't perturb that draw's timing relative to the rest of the tree's
    construction."""
    eval_fn = _stub_eval_fn
    batch_eval_fn = _stub_batch_eval_fn

    state = env.create_game()
    seq_root = search(
        state,
        eval_fn,
        num_simulations=40,
        dirichlet_epsilon=0.4,
        dirichlet_alpha=0.3,
        rng=np.random.default_rng(5),
    )
    (batch_root,) = _run_batched_searches(
        [state],
        40,
        batch_eval_fn,
        dirichlet_epsilon=0.4,
        dirichlet_alpha=0.3,
        seeds=[5],
    )
    _assert_trees_identical(seq_root, batch_root)


def test_play_one_game_and_play_games_batched_produce_identical_games():
    """The end-to-end version of the equivalence property: a whole self-play
    game (many moves, each its own MCTS search with subtree reuse) must come
    out bit-identical whether played sequentially or as part of a batched,
    concurrent cohort. Covers several seeds; `play_games_batched` seeds game
    `i` with `seed + i`, so game `i` from a batched cohort must match
    `play_one_game` seeded with exactly that. Uses the deterministic stub
    evaluator for the same reason as the tree-level tests above: it is exact
    across batch shapes by construction, which is what a whole-game
    bit-identical comparison needs (see the note near the bottom of this
    file on real-network batched inference)."""
    eval_fn = _stub_eval_fn
    batch_eval_fn = _stub_batch_eval_fn

    for seed in (0, 1, 2, 3):
        total_games = 4
        num_simulations = 12

        batched_results = play_games_batched(
            batch_eval_fn,
            total_games,
            num_simulations,
            concurrency=3,  # deliberately doesn't divide total_games evenly
            seed=seed,
            temperature_threshold=4,
        )
        assert len(batched_results) == total_games

        for i in range(total_games):
            sequential_result = play_one_game(
                eval_fn,
                num_simulations,
                temperature_threshold=4,
                rng=np.random.default_rng(seed + i),
            )
            batched_result = batched_results[i]

            assert batched_result.num_moves == sequential_result.num_moves
            for pos_a, pos_b in zip(
                batched_result.positions, sequential_result.positions, strict=True
            ):
                assert np.array_equal(pos_a, pos_b)
            for pol_a, pol_b in zip(
                batched_result.policies, sequential_result.policies, strict=True
            ):
                assert np.array_equal(pol_a, pol_b)
            assert batched_result.values == sequential_result.values


# ---------------------------------------------------------------------------
# 2. Existing behaviour preserved (spot checks; full suites are
#    test_mcts.py/test_selfplay.py, run separately as part of the acceptance
#    criteria).
# ---------------------------------------------------------------------------


def test_sequential_search_and_play_one_game_unaffected_by_new_code():
    """`_expand` was refactored to share `_finish_expand` with the new
    generator path -- confirm the sequential API's own behaviour (not just
    its agreement with the batched path) is untouched."""
    state = env.create_game()

    def stub_eval(_: np.ndarray) -> tuple[list[float], float]:
        return [1.0] + [0.0] * 6, 0.0

    root = search(state, stub_eval, num_simulations=50, rng=np.random.default_rng(0))
    assert root.N == 50
    assert select_move(root, temperature=0) == 0  # stub always prefers column 0

    net = Connect4Net(channels=8, num_blocks=2)
    eval_fn = make_eval_fn(net, device="cpu")
    result = play_one_game(eval_fn, num_simulations=4, temperature_threshold=2)
    assert result.num_moves > 0


# ---------------------------------------------------------------------------
# 3. Terminal positions are never sent to the evaluator.
# ---------------------------------------------------------------------------


def test_terminal_root_search_gen_never_yields():
    """A `search_gen` call on an already-terminal root must produce no
    positions at all -- `search()` short-circuits before ever simulating."""

    def _forced_win_state() -> env.GameState:
        return env.from_moves([0, 4, 1, 5, 2, 6, 3])  # column 3 completes P1's win

    state = _forced_win_state()
    assert env.is_terminal(state)

    gen = search_gen(state, num_simulations=10)
    yielded = []
    try:
        while True:
            yielded.append(next(gen))
    except StopIteration as stop:
        root = stop.value

    assert yielded == []
    assert root.state == state


def test_terminal_leaves_within_a_tree_do_not_yield():
    """Deeper in a real tree, some simulations reach an already-decided
    position before `num_simulations` leaf *evaluations* have happened.
    Count actual `batch_eval_fn` invocations against a decisive near-endgame
    state and confirm it's fewer than the simulation budget once terminal
    nodes start getting hit repeatedly."""
    state = env.from_moves([0, 4, 1, 5, 2, 6])  # col 3 is a mate in one for P1
    net = _fixed_net()
    batch_eval_fn = make_batch_eval_fn(net, device="cpu")

    call_count = 0

    def counting_batch_eval(batch: np.ndarray):
        nonlocal call_count
        call_count += 1
        return batch_eval_fn(batch)

    num_simulations = 200
    (root,) = _run_batched_searches([state], num_simulations, counting_batch_eval, seeds=[0])

    # Every batch call in this single-tree drive evaluates exactly one
    # position (no concurrency to pack more in), so call_count == number of
    # *non-terminal* leaves visited. With col 3 available, many simulations
    # after the first expansion immediately hit the won terminal child and
    # never call the evaluator at all.
    assert call_count < num_simulations
    assert root.N == num_simulations


# ---------------------------------------------------------------------------
# 4. An uneven cohort (games finish at different times) still completes.
# ---------------------------------------------------------------------------


def test_uneven_cohort_completes_with_correct_game_count():
    """Concurrency smaller than the game count, and a temperature threshold
    of 0 (sharp play throughout) so game lengths vary game-to-game -- the
    scheduler must top up from the queue and still return every game."""
    net = _fixed_net()
    batch_eval_fn = make_batch_eval_fn(net, device="cpu")

    total_games = 7
    results = play_games_batched(
        batch_eval_fn,
        total_games,
        num_simulations=6,
        concurrency=3,
        seed=42,
        temperature_threshold=0,
    )
    assert len(results) == total_games
    for r in results:
        assert r.num_moves > 0
        assert len(r.positions) == r.num_moves
        assert len(r.policies) == r.num_moves
        assert len(r.values) == r.num_moves


def test_concurrency_larger_than_total_games_is_clamped():
    net = _fixed_net()
    batch_eval_fn = make_batch_eval_fn(net, device="cpu")
    results = play_games_batched(
        batch_eval_fn, total_games=2, num_simulations=4, concurrency=128, seed=0
    )
    assert len(results) == 2


# ---------------------------------------------------------------------------
# A note on the one place exact equivalence is genuinely out of reach: a real
# torch network's batched GEMM/BatchNorm kernels are not specified to be
# bit-identical to the same row run through a batch-size-1 forward pass --
# only mathematically equal in exact arithmetic. In float32, evaluating the
# same position alone versus as part of a larger batch can differ in the last
# 1-2 ULPs (observed directly below, and initially surfaced as a ~1e-8
# difference in accumulated node `W` that failed the tree-identity tests
# above before they were switched to `_stub_eval_fn`). This is a property of
# floating-point matrix multiplication on real hardware, not a defect in
# `search_gen`/`play_games_batched`'s scheduling: every line of Python they
# add (selection, masking, backup) is itself exact and order-independent
# given whatever `(priors, value)` the evaluator returns. The test below
# pins down the actual, measured size of that gap for this network so it
# stays a known, tiny, and monitored quantity rather than an assumption.
# ---------------------------------------------------------------------------


def test_real_network_batch_size_1_vs_batch_size_n_gap_is_tiny_not_zero():
    """Documents the one genuine equivalence gap (see note above): a real
    network's output for a given row is not bit-identical between a
    batch-size-1 call and a call that also evaluates other rows, only close.
    Pins the gap at a tolerance far tighter than anything that could plausibly
    flip a PUCT argmax, so this is a monitored numerical detail, not a
    correctness bug."""
    net = _fixed_net()
    eval_fn = make_eval_fn(net, device="cpu")
    batch_eval_fn = make_batch_eval_fn(net, device="cpu")

    state = _branching_state()
    encoded = env.encode(state)
    single_priors, single_value = eval_fn(encoded)

    batch = np.stack([encoded, env.encode(env.create_game()), env.encode(env.from_moves([0, 1]))])
    batch_priors, batch_values = batch_eval_fn(batch)

    # Equal to a very tight tolerance (float32 ULP-scale), but -- this is the
    # point -- not necessarily via `==`.
    assert np.allclose(np.asarray(single_priors), batch_priors[0], atol=1e-5)
    assert np.isclose(single_value, batch_values[0], atol=1e-5)


# ---------------------------------------------------------------------------
# 5. Batched evaluator's softmax/perspective handling matches the
#    single-position evaluator for the same inputs.
# ---------------------------------------------------------------------------


def test_batch_eval_fn_matches_single_eval_fn():
    net = _fixed_net()
    eval_fn = make_eval_fn(net, device="cpu")
    batch_eval_fn = make_batch_eval_fn(net, device="cpu")

    states = [
        env.create_game(),
        _branching_state(),
        env.from_moves([0, 1, 2, 3, 4]),
    ]
    encoded = [env.encode(s) for s in states]

    batch_priors, batch_values = batch_eval_fn(np.stack(encoded, axis=0))

    for i, enc in enumerate(encoded):
        single_priors, single_value = eval_fn(enc)
        assert np.allclose(np.asarray(single_priors), batch_priors[i], atol=1e-6)
        assert np.isclose(single_value, batch_values[i], atol=1e-6)
        # Priors are softmaxed (sum to 1), not raw logits, per CONTRACTS §3.
        assert np.isclose(batch_priors[i].sum(), 1.0, atol=1e-5)
        assert -1.0 <= batch_values[i] <= 1.0
