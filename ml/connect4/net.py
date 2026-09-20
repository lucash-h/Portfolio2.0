"""Small residual CNN for Connect 4: policy + value heads.

Input is `[N,2,6,7]` per CONTRACTS §3 / §the batch-dimension table — a single
position from `env.encode()` is `[2,6,7]` with no batch axis; the caller adds
one. The policy head outputs 7 raw logits (NOT softmaxed — the ONNX contract
is explicit that `policy` is logits). The value head outputs one scalar
through `tanh`, in `[-1, 1]`.

Deliberately small: this runs client-side in a browser via ONNX and trains on
CPU. A handful of residual blocks at modest width, not a full ResNet.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

import numpy as np
import torch
from torch import nn

from ml.connect4.env import COLS, ROWS

# Given a stacked [N,2,6,7] float32 array of encoded positions, returns
# (priors[N,7], values[N]) -- the batched twin of `ml.connect4.mcts.EvalFn`.
# Same contract per position: priors are softmaxed (never raw logits, per
# CONTRACTS §3), values are from the perspective of each position's own
# player to move.
BatchEvalFn = Callable[[np.ndarray], tuple[np.ndarray, np.ndarray]]

NUM_PLANES = 2
DEFAULT_CHANNELS = 32
DEFAULT_BLOCKS = 4


class ResidualBlock(nn.Module):
    """A single 3x3 conv residual block, batchnorm + ReLU, no bottleneck."""

    def __init__(self, channels: int) -> None:
        super().__init__()
        self.conv1 = nn.Conv2d(channels, channels, kernel_size=3, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(channels)
        self.conv2 = nn.Conv2d(channels, channels, kernel_size=3, padding=1, bias=False)
        self.bn2 = nn.BatchNorm2d(channels)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x
        out = torch.relu(self.bn1(self.conv1(x)))
        out = self.bn2(self.conv2(out))
        out = out + residual
        return torch.relu(out)


class Connect4Net(nn.Module):
    """Policy + value network.

    forward(x) with x: [N,2,6,7] -> (policy_logits: [N,7], value: [N,1] in [-1,1])
    """

    def __init__(self, channels: int = DEFAULT_CHANNELS, num_blocks: int = DEFAULT_BLOCKS) -> None:
        super().__init__()
        self.stem = nn.Sequential(
            nn.Conv2d(NUM_PLANES, channels, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(channels),
            nn.ReLU(inplace=True),
        )
        self.blocks = nn.Sequential(*[ResidualBlock(channels) for _ in range(num_blocks)])

        # Policy head: reduce channels, flatten, linear to 7 logits.
        policy_channels = 8
        self.policy_conv = nn.Sequential(
            nn.Conv2d(channels, policy_channels, kernel_size=1, bias=False),
            nn.BatchNorm2d(policy_channels),
            nn.ReLU(inplace=True),
        )
        self.policy_fc = nn.Linear(policy_channels * ROWS * COLS, COLS)

        # Value head: reduce channels, flatten, small MLP to one scalar.
        value_channels = 8
        value_hidden = 32
        self.value_conv = nn.Sequential(
            nn.Conv2d(channels, value_channels, kernel_size=1, bias=False),
            nn.BatchNorm2d(value_channels),
            nn.ReLU(inplace=True),
        )
        self.value_fc1 = nn.Linear(value_channels * ROWS * COLS, value_hidden)
        self.value_fc2 = nn.Linear(value_hidden, 1)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        x = self.stem(x)
        x = self.blocks(x)

        p = self.policy_conv(x)
        p = p.flatten(1)
        policy_logits = self.policy_fc(p)

        v = self.value_conv(x)
        v = v.flatten(1)
        v = torch.relu(self.value_fc1(v))
        value = torch.tanh(self.value_fc2(v))

        return policy_logits, value


def count_parameters(net: nn.Module) -> int:
    return sum(p.numel() for p in net.parameters())


def make_eval_fn(net: Connect4Net, device: str | torch.device = "cpu"):
    """Build an `EvalFn` (per `ml.connect4.mcts`) from a trained network.

    Takes an encoded `[2,6,7]` position (no batch axis, as produced by
    `env.encode()`), adds the batch axis, runs the network under
    `torch.no_grad()` in eval mode, applies softmax to the policy logits, and
    returns `(priors_over_7_columns, value)` where priors sum to 1 and value
    is a plain float in [-1, 1]. Torch-free on the MCTS side: this is the only
    place torch and `ml.connect4.mcts` touch.
    """
    net = net.to(device)
    net.eval()

    def eval_fn(encoded: np.ndarray) -> tuple[Sequence[float], float]:
        with torch.no_grad():
            x = torch.from_numpy(encoded).to(device=device, dtype=torch.float32).unsqueeze(0)
            policy_logits, value = net(x)
            priors = torch.softmax(policy_logits, dim=-1)[0].cpu().numpy()
            v = float(value[0, 0].item())
        return priors, v

    return eval_fn


def make_batch_eval_fn(net: Connect4Net, device: str | torch.device = "cpu") -> BatchEvalFn:
    """Build a `BatchEvalFn` (per `ml.connect4.net`) from a trained network.

    Takes a stacked `[N,2,6,7]` array (no missing batch axis, unlike
    `make_eval_fn`'s per-position `[2,6,7]`), runs one forward pass under
    `torch.no_grad()` in eval mode, applies softmax to the policy logits, and
    returns `(priors[N,7], values[N])` as plain numpy arrays. This is the
    batched leaf evaluator used to speed up self-play (see
    `ml.connect4.selfplay.play_games_batched`): for the same weights and the
    same input row, it produces the same numbers as `make_eval_fn` produces
    for that row alone -- see `test_batching.py`.
    """
    net = net.to(device)
    net.eval()

    def batch_eval_fn(encoded_batch: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        with torch.no_grad():
            x = torch.from_numpy(encoded_batch).to(device=device, dtype=torch.float32)
            policy_logits, value = net(x)
            priors = torch.softmax(policy_logits, dim=-1).cpu().numpy()
            values = value[:, 0].cpu().numpy()
        return priors, values

    return batch_eval_fn
