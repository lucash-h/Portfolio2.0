"""Tests for the replay buffer and self-play game generation.

Replay buffer tests live here (rather than a separate test file) because the
ownership boundary for this package lists only `test_net.py` and
`test_selfplay.py`. The full self-play -> training loop smoke test lives here
too, for the same reason (no `test_train.py` on the ownership list).
"""

from __future__ import annotations

import copy

import numpy as np
import pytest
import torch

from ml.connect4.env import COLS, ROWS
from ml.connect4.net import Connect4Net, make_eval_fn
from ml.connect4.replay import ReplayBuffer
from ml.connect4.selfplay import generate_games, play_one_game
from ml.connect4.train import run_training_step

# ---------------------------------------------------------------------------
# Replay buffer
# ---------------------------------------------------------------------------


def _dummy_example(seed: int) -> tuple[np.ndarray, np.ndarray, float]:
    rng = np.random.default_rng(seed)
    position = rng.random((2, ROWS, COLS)).astype(np.float32)
    policy = rng.random(COLS).astype(np.float32)
    policy /= policy.sum()
    value = float(rng.uniform(-1, 1))
    return position, policy, value


def test_replay_buffer_capacity_enforced():
    buf = ReplayBuffer(capacity=5)
    for i in range(5):
        buf.add(*_dummy_example(i))
    assert len(buf) == 5
    buf.add(*_dummy_example(99))
    assert len(buf) == 5  # capacity never exceeded


def test_replay_buffer_fifo_eviction():
    capacity = 4
    buf = ReplayBuffer(capacity=capacity)
    examples = [_dummy_example(i) for i in range(capacity)]
    for ex in examples:
        buf.add(*ex)

    # Buffer full. Adding one more must evict the oldest (index 0's position).
    new_example = _dummy_example(1000)
    buf.add(*new_example)

    stored_positions = buf._positions  # noqa: SLF001 -- test inspects internals directly
    # The new example's position is present somewhere in the buffer.
    assert any(np.allclose(stored_positions[i], new_example[0]) for i in range(capacity))
    # And the very first inserted example (the oldest) is gone -- FIFO, not LRU.
    assert not any(np.allclose(stored_positions[i], examples[0][0]) for i in range(capacity))
    # The second-oldest example is still present (only one eviction happened).
    assert any(np.allclose(stored_positions[i], examples[1][0]) for i in range(capacity))


def test_replay_buffer_save_load_round_trip(tmp_path):
    buf = ReplayBuffer(capacity=10)
    for i in range(7):
        buf.add(*_dummy_example(i))

    path = tmp_path / "buffer.npz"
    buf.save(path)
    loaded = ReplayBuffer.load(path)

    assert loaded.capacity == buf.capacity
    assert len(loaded) == len(buf)
    assert np.array_equal(loaded._positions, buf._positions)  # noqa: SLF001
    assert np.array_equal(loaded._policies, buf._policies)  # noqa: SLF001
    assert np.array_equal(loaded._values, buf._values)  # noqa: SLF001
    assert loaded._write_index == buf._write_index  # noqa: SLF001


def test_replay_buffer_sample_shapes():
    buf = ReplayBuffer(capacity=20)
    for i in range(20):
        buf.add(*_dummy_example(i))
    positions, policies, values = buf.sample(8, rng=np.random.default_rng(1))
    assert positions.shape == (8, 2, ROWS, COLS)
    assert policies.shape == (8, COLS)
    assert values.shape == (8,)


def test_replay_buffer_rejects_bad_shapes():
    buf = ReplayBuffer(capacity=5)
    with pytest.raises(ValueError):
        buf.add(np.zeros((3, ROWS, COLS)), np.zeros(COLS), 0.0)
    with pytest.raises(ValueError):
        buf.add(np.zeros((2, ROWS, COLS)), np.zeros(COLS + 1), 0.0)


# ---------------------------------------------------------------------------
# Self-play: value-target sign -- the single most important test here.
# ---------------------------------------------------------------------------


class _ScriptedEvalFn:
    """A deterministic evaluator that always prefers column 0, so the game
    outcome is predictable regardless of the search itself. Used to build a
    short, known-winner game to check value-target signs precisely."""

    def __call__(self, encoded: np.ndarray) -> tuple[list[float], float]:
        priors = [1.0] + [0.0] * 6
        return priors, 0.0


def test_value_targets_are_from_the_winner_perspective():
    """The single most important test in this package.

    A value target with the wrong sign trains the network to lose: training
    proceeds happily, loss decreases, and the resulting bot plays to throw the
    game. So this test must actually exercise `play_one_game` and must fail if
    the sign is inverted.

    The invariant it leans on: in a decisive Connect 4 game the player who made
    the final move is the winner. Every stored position is encoded from its own
    mover's perspective, so the last position's value must be exactly +1.0, and
    values must alternate backwards from there.

    Two earlier versions of this test did not have teeth. One reimplemented the
    sign logic inside the test and asserted against its own copy, so it passed
    no matter what `selfplay.py` did. The other checked only that values
    alternated in sign, which a full inversion preserves. Both passed while the
    production code was inverted. Do not weaken this back to either shape.
    """
    decisive_games = 0

    for seed in range(12):
        result = play_one_game(
            _ScriptedEvalFn(),
            num_simulations=8,
            dirichlet_epsilon=0.0,
            temperature_threshold=0,
            rng=np.random.default_rng(seed),
        )

        assert len(result.values) == result.num_moves

        if all(v == 0.0 for v in result.values):
            continue  # a draw; covered separately below

        decisive_games += 1

        # Winner made the last move, so the last position is the winner's.
        assert result.values[-1] == 1.0, (
            f"seed {seed}: final value was {result.values[-1]}, expected +1.0. "
            "The last mover in a decisive game is the winner, so an inverted "
            "sign shows up here first."
        )

        # Walking backwards, signs alternate: winner, loser, winner, ...
        for offset, value in enumerate(reversed(result.values)):
            expected = 1.0 if offset % 2 == 0 else -1.0
            assert value == expected, (
                f"seed {seed}: value at offset {offset} from the end was "
                f"{value}, expected {expected}"
            )

    # Without this the whole test could pass vacuously on a run of draws.
    assert decisive_games > 0, "no decisive game was produced; test proved nothing"


# ---------------------------------------------------------------------------
# Self-play: smoke tests
# ---------------------------------------------------------------------------


def test_play_one_game_produces_consistent_examples():
    net = Connect4Net(channels=8, num_blocks=2)
    eval_fn = make_eval_fn(net, device="cpu")
    rng = np.random.default_rng(0)

    result = play_one_game(eval_fn, num_simulations=4, temperature_threshold=2, rng=rng)

    assert result.num_moves > 0
    assert len(result.positions) == result.num_moves
    assert len(result.policies) == result.num_moves
    assert len(result.values) == result.num_moves
    for pos, pol, val in zip(result.positions, result.policies, result.values, strict=True):
        assert pos.shape == (2, ROWS, COLS)
        assert pol.shape == (COLS,)
        assert np.isclose(pol.sum(), 1.0, atol=1e-5)
        assert val in (-1.0, 0.0, 1.0)


def test_generate_games_single_worker_smoke():
    # workers=1 runs in-process (no multiprocessing pool), which is what tests
    # should use to stay fast and deterministic-ish. A fresh random network is
    # built inside the worker itself when weights_path is None.
    results = generate_games(
        None,
        net_channels=8,
        net_blocks=2,
        total_games=2,
        num_simulations=4,
        workers=1,
        seed=7,
    )
    assert len(results) == 2
    for r in results:
        assert r.num_moves > 0
        assert len(r.positions) == r.num_moves


# ---------------------------------------------------------------------------
# End-to-end smoke: self-play games -> replay buffer -> a few training steps.
# ---------------------------------------------------------------------------


def test_end_to_end_selfplay_and_training_smoke():
    """A handful of self-play games at a low simulation count, feeding a few
    training steps. Asserts loss is finite and the network's parameters
    actually changed -- proving the loop is wired correctly, not just that it
    runs without raising."""
    net = Connect4Net(channels=8, num_blocks=2)
    eval_fn = make_eval_fn(net, device="cpu")
    optimizer = torch.optim.Adam(net.parameters(), lr=1e-2)
    buffer = ReplayBuffer(capacity=1000)

    rng = np.random.default_rng(0)
    for _ in range(3):
        result = play_one_game(eval_fn, num_simulations=4, temperature_threshold=2, rng=rng)
        buffer.add_many(result.positions, result.policies, result.values)

    assert len(buffer) > 0

    params_before = copy.deepcopy(list(net.parameters()))

    for _ in range(5):
        p_loss, v_loss = run_training_step(
            net, optimizer, buffer, batch_size=min(8, len(buffer)), rng=rng
        )
        assert np.isfinite(p_loss)
        assert np.isfinite(v_loss)

    params_after = list(net.parameters())
    changed = any(
        not torch.equal(before, after)
        for before, after in zip(params_before, params_after, strict=True)
    )
    assert changed, "training steps ran but no parameter changed"


def test_generate_games_multiprocess_smoke(tmp_path):
    """Exercises the real multiprocess path with a saved weights file, at the
    smallest possible scale, to prove the worker plumbing works end to end."""
    net = Connect4Net(channels=8, num_blocks=2)
    weights_path = tmp_path / "weights.pt"
    torch.save(net.state_dict(), weights_path)

    results = generate_games(
        str(weights_path),
        net_channels=8,
        net_blocks=2,
        total_games=2,
        num_simulations=4,
        workers=2,
        seed=3,
    )
    assert len(results) == 2
    for r in results:
        assert r.num_moves > 0
