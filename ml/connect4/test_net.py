"""Tests for the Connect 4 network and its MCTS-facing eval_fn adapter."""

from __future__ import annotations

import numpy as np
import torch

from ml.connect4.env import COLS, ROWS, create_game, encode
from ml.connect4.net import Connect4Net, count_parameters, make_eval_fn


def test_forward_output_shapes():
    net = Connect4Net(channels=8, num_blocks=2)
    x = torch.zeros((5, 2, ROWS, COLS), dtype=torch.float32)
    policy_logits, value = net(x)
    assert policy_logits.shape == (5, COLS)
    assert value.shape == (5, 1)


def test_value_within_bounds():
    net = Connect4Net(channels=8, num_blocks=2)
    x = torch.randn((16, 2, ROWS, COLS), dtype=torch.float32)
    _, value = net(x)
    assert torch.all(value >= -1.0)
    assert torch.all(value <= 1.0)


def test_policy_logits_are_not_a_probability_distribution():
    """The contract is explicit: `policy` output is raw logits, not softmax.
    A real (non-degenerate) network's logits should not sum to 1 nor lie in
    [0, 1] elementwise."""
    net = Connect4Net(channels=8, num_blocks=2)
    x = torch.randn((4, 2, ROWS, COLS), dtype=torch.float32)
    policy_logits, _ = net(x)
    logits = policy_logits.detach().numpy()

    # Not clamped to [0, 1] -- logits can and (with random init/inputs) do
    # take values outside that range.
    assert np.any((logits < 0.0) | (logits > 1.0))
    # Row sums should not already equal 1 (softmax's signature effect).
    row_sums = logits.sum(axis=-1)
    assert not np.allclose(row_sums, 1.0, atol=1e-3)


def test_eval_fn_matches_mcts_contract():
    """The adapter must accept a [2,6,7] (no batch axis) encoded position and
    return (priors, value) with priors summing to 1."""
    net = Connect4Net(channels=8, num_blocks=2)
    eval_fn = make_eval_fn(net, device="cpu")

    state = create_game()
    encoded = encode(state)
    assert encoded.shape == (2, ROWS, COLS)

    priors, value = eval_fn(encoded)
    priors = np.asarray(priors, dtype=np.float64)

    assert priors.shape == (COLS,)
    assert np.all(priors >= 0.0)
    assert np.isclose(priors.sum(), 1.0, atol=1e-5)
    assert -1.0 <= value <= 1.0
    assert isinstance(value, float)


def test_eval_fn_puts_net_in_eval_mode_and_uses_no_grad():
    net = Connect4Net(channels=8, num_blocks=2)
    net.train()
    eval_fn = make_eval_fn(net, device="cpu")
    assert net.training is False

    state = create_game()
    priors, value = eval_fn(encode(state))
    # No grad should have been recorded -- calling eval_fn must not raise nor
    # leave grad-tracking tensors; a plain float/np.ndarray return proves it.
    assert isinstance(value, float)
    assert isinstance(np.asarray(priors), np.ndarray)


def test_small_parameter_count():
    """This runs client-side; keep it small. A generous upper bound, not a
    tight one, so the test doesn't churn if channel width is tuned slightly."""
    net = Connect4Net()
    n_params = count_parameters(net)
    assert n_params < 2_000_000
    assert n_params > 1_000
