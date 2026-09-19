"""Fixed-capacity ring buffer of self-play training examples.

Each example is `(encoded_position, policy_target, value_target)`:
- `encoded_position`: `[2,6,7]` float32, as produced by `env.encode()`.
- `policy_target`: `[7]` float32, normalised MCTS root visit counts (NOT the
  network's own priors — see `selfplay.py`).
- `value_target`: scalar float in `[-1, 1]`, the game outcome from that
  position's player-to-move perspective.

Sampling is uniform over whatever is currently stored. The buffer is saveable
and loadable (as a single `.npz`) so training can resume without losing
history.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from ml.connect4.env import COLS, ROWS


class ReplayBuffer:
    """A ring buffer: once full, new examples overwrite the oldest (FIFO
    eviction) via a circular write cursor."""

    def __init__(self, capacity: int) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self.capacity = capacity
        self._positions = np.zeros((capacity, 2, ROWS, COLS), dtype=np.float32)
        self._policies = np.zeros((capacity, COLS), dtype=np.float32)
        self._values = np.zeros((capacity,), dtype=np.float32)
        self._size = 0
        self._write_index = 0

    def __len__(self) -> int:
        return self._size

    def add(self, position: np.ndarray, policy: np.ndarray, value: float) -> None:
        """Append one example, evicting the oldest if the buffer is full."""
        position = np.asarray(position, dtype=np.float32)
        policy = np.asarray(policy, dtype=np.float32)
        if position.shape != (2, ROWS, COLS):
            raise ValueError(f"position shape must be (2,{ROWS},{COLS}), got {position.shape}")
        if policy.shape != (COLS,):
            raise ValueError(f"policy shape must be ({COLS},), got {policy.shape}")

        i = self._write_index
        self._positions[i] = position
        self._policies[i] = policy
        self._values[i] = float(value)

        self._write_index = (self._write_index + 1) % self.capacity
        self._size = min(self._size + 1, self.capacity)

    def add_many(
        self,
        positions: list[np.ndarray] | np.ndarray,
        policies: list[np.ndarray] | np.ndarray,
        values: list[float] | np.ndarray,
    ) -> None:
        for pos, pol, val in zip(positions, policies, values, strict=True):
            self.add(pos, pol, val)

    def sample(
        self, batch_size: int, rng: np.random.Generator | None = None
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Uniformly sample `batch_size` examples (with replacement) from
        whatever is currently stored. Returns `(positions, policies, values)`
        each stacked along a new leading batch axis."""
        if self._size == 0:
            raise ValueError("cannot sample from an empty replay buffer")
        rng = rng if rng is not None else np.random.default_rng()
        indices = rng.integers(0, self._size, size=batch_size)
        return (
            self._positions[indices].copy(),
            self._policies[indices].copy(),
            self._values[indices].copy(),
        )

    def save(self, path: str | Path) -> None:
        """Persist the buffer's full state (including capacity, size, and
        write cursor) so `load` round-trips exactly."""
        path = Path(path)
        np.savez(
            path,
            positions=self._positions,
            policies=self._policies,
            values=self._values,
            capacity=np.array(self.capacity),
            size=np.array(self._size),
            write_index=np.array(self._write_index),
        )

    @classmethod
    def load(cls, path: str | Path) -> ReplayBuffer:
        path = Path(path)
        # np.savez appends .npz if the path lacks it; np.load needs the exact name.
        load_path = path if path.exists() else path.with_suffix(".npz")
        with np.load(load_path) as data:
            capacity = int(data["capacity"])
            buf = cls(capacity)
            buf._positions[:] = data["positions"]
            buf._policies[:] = data["policies"]
            buf._values[:] = data["values"]
            buf._size = int(data["size"])
            buf._write_index = int(data["write_index"])
        return buf
