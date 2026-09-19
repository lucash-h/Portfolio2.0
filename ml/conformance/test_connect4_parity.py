"""Cross-language parity: `ml/connect4/env.py` against
`shared/fixtures/connect4_cases.json` — see docs/CONTRACTS.md §2.

Neither language owns the rules; the fixture file does. This test replays
every case's move sequence through the Python env and checks every field the
fixture specifies, plus the `[2,6,7]` tensor encoding required by CONTRACTS §3.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from ml.connect4.env import (
    COLS,
    ROWS,
    apply_move,
    create_game,
    encode,
    is_terminal,
    legal_moves,
    opponent,
)
from ml.paths import fixture

with open(fixture("connect4_cases.json"), encoding="utf-8") as _f:
    _FIXTURE = json.load(_f)

CASES: list[dict] = _FIXTURE["cases"]
OK_CASES = [c for c in CASES if not c.get("expectError")]
ILLEGAL_CASES = [c for c in CASES if c.get("expectError")]


def _replay(moves: list[int]):
    state = create_game()
    for m in moves:
        state = apply_move(state, m)
    return state


def test_fixture_has_expected_case_count() -> None:
    # Sanity check on the fixture itself: P1-F promises >= 60 cases, and the
    # task briefing pins this repo's fixture at 71.
    assert len(CASES) == 71
    assert len(OK_CASES) + len(ILLEGAL_CASES) == len(CASES)


@pytest.mark.parametrize("case", OK_CASES, ids=[c["id"] for c in OK_CASES])
def test_fixture_case(case: dict) -> None:
    state = _replay(case["moves"])

    assert list(state.board) == case["board"], "board mismatch"
    assert state.to_move == case["toMove"], "toMove mismatch"
    assert state.winner == case["winner"], "winner mismatch"
    assert state.is_draw == case["isDraw"], "isDraw mismatch"
    assert is_terminal(state) == case["isTerminal"], "isTerminal mismatch"
    assert sorted(legal_moves(state)) == sorted(case["legalMoves"]), "legalMoves mismatch"

    expected_winning_cells = case["winningCells"]
    if expected_winning_cells is None:
        assert state.winning_cells is None, "expected no winningCells"
    else:
        assert list(state.winning_cells) == expected_winning_cells, "winningCells mismatch"


@pytest.mark.parametrize("case", ILLEGAL_CASES, ids=[c["id"] for c in ILLEGAL_CASES])
def test_fixture_illegal_move_raises(case: dict) -> None:
    state = _replay(case["moves"])
    assert sorted(legal_moves(state)) == sorted(case["legalMoves"])
    with pytest.raises(ValueError):
        apply_move(state, case["illegalMove"])


def test_encode_shape_and_dtype() -> None:
    tensor = encode(create_game())
    assert tensor.shape == (2, ROWS, COLS)
    assert tensor.dtype == np.float32


def test_encode_plane0_is_mover_plane1_is_opponent() -> None:
    # One disc for player 1 at column 3. It's now player 2's move, so plane 0
    # (the mover, player 2) must be empty everywhere, and plane 1 (the
    # opponent, player 1) must carry that single disc.
    state = apply_move(create_game(), 3)
    assert state.to_move == 2
    tensor = encode(state)
    assert tensor[0].sum() == 0
    assert tensor[1, 0, 3] == 1.0
    assert tensor[1].sum() == 1


def test_encode_planes_flip_when_toMove_is_2() -> None:
    # Same position as above, but proves the flip is about *identity* (mover
    # vs opponent), not about a fixed player number: swap which physical
    # player is "to move" and confirm the planes swap with it.
    state = apply_move(create_game(), 3)
    assert state.to_move == 2
    board2d = np.asarray(state.board, dtype=np.int64).reshape(ROWS, COLS)
    tensor = encode(state)
    assert np.array_equal(tensor[0], (board2d == state.to_move).astype(np.float32))
    assert np.array_equal(tensor[1], (board2d == opponent(state.to_move)).astype(np.float32))


def test_encode_row0_is_bottom_row() -> None:
    # Column 0 gets two discs: player 1 lands first (bottom), player 2 stacks
    # on top. Tensor row 0 must reflect the FIRST disc placed (bottom), not
    # whichever disc is "on top" visually.
    state = apply_move(apply_move(create_game(), 0), 0)
    assert state.to_move == 1  # back to player 1
    tensor = encode(state)
    assert tensor[0, 0, 0] == 1.0  # bottom cell, col 0: player 1 (the mover)
    assert tensor[1, 1, 0] == 1.0  # row 1 (second from bottom), col 0: player 2
    assert tensor[0, 1, 0] == 0.0
    assert tensor[1, 0, 0] == 0.0
