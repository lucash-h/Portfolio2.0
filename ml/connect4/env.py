"""Connect 4 environment — Python port of web/src/lib/games/connect4/engine.ts.

Mirrors docs/CONTRACTS.md §3 exactly. Pure functions, immutable state, no I/O,
no randomness, no mutation of inputs. Board geometry: 6 rows x 7 columns, row 0
is the BOTTOM row, flat index = row * COLS + col. Player 1 moves first.

State is a flat tuple rather than a board-of-objects: self-play will call
`apply_move` millions of times, and tuples are cheap to build, hash, and compare.
Win checks only scan the four lines through the just-placed disc, never the
whole board, for the same reason.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

ROWS = 6
COLS = 7
CELL_COUNT = ROWS * COLS
WIN_LENGTH = 4

# Direction vectors as (row_step, col_step). Working in row/col space avoids the
# classic bug where a horizontal run wraps the row edge. Matches engine.ts.
_DIRECTIONS: tuple[tuple[int, int], ...] = (
    (0, 1),  # horizontal
    (1, 0),  # vertical
    (1, 1),  # diagonal up-right
    (1, -1),  # diagonal up-left
)


def idx(row: int, col: int) -> int:
    """Board index from row/column. Row 0 is the bottom row."""
    return row * COLS + col


def is_column(n: int) -> bool:
    """True when `n` is a valid column index (an integer in 0..COLS-1)."""
    return isinstance(n, int) and not isinstance(n, bool) and 0 <= n < COLS


def opponent(player: int) -> int:
    return 2 if player == 1 else 1


@dataclass(frozen=True, slots=True)
class GameState:
    """Immutable Connect 4 position. Mirrors the TS `GameState` interface."""

    board: tuple[int, ...]  # length 42, values 0/1/2
    to_move: int  # 1 or 2
    moves: tuple[int, ...]  # full history, in order
    winner: int | None
    is_draw: bool
    winning_cells: tuple[int, ...] | None  # exactly 4 board indices, or None


def create_game() -> GameState:
    return GameState(
        board=(0,) * CELL_COUNT,
        to_move=1,
        moves=(),
        winner=None,
        is_draw=False,
        winning_cells=None,
    )


def legal_moves(state: GameState) -> list[int]:
    """Columns that still have room. Independent of whether the game is already
    won — matches engine.ts `legalMoves`."""
    board = state.board
    return [col for col in range(COLS) if board[idx(ROWS - 1, col)] == 0]


def is_terminal(state: GameState) -> bool:
    return state.winner is not None or state.is_draw


def _landing_row(board: tuple[int, ...], col: int) -> int:
    """Lowest empty row in a column, or -1 when the column is full."""
    for row in range(ROWS):
        if board[idx(row, col)] == 0:
            return row
    return -1


def _find_win_through(board: tuple[int, ...], row: int, col: int, player: int) -> list[int] | None:
    """The four cells of a win through (row, col), or None. Only lines through
    the just-placed disc can be new, so this is all `apply_move` needs to check."""
    for dr, dc in _DIRECTIONS:
        cells = [idx(row, col)]
        for sign in (1, -1):
            r, c = row + dr * sign, col + dc * sign
            while 0 <= r < ROWS and 0 <= c < COLS and board[idx(r, c)] == player:
                cells.append(idx(r, c))
                r += dr * sign
                c += dc * sign
        if len(cells) >= WIN_LENGTH:
            # Collinear, so ascending index order is also spatial order.
            cells.sort()
            return cells[:WIN_LENGTH]
    return None


def apply_move(state: GameState, col: int) -> GameState:
    """Apply a move, returning a NEW state. Raises ValueError on an illegal
    column (full or out of range). Does not mutate `state`.

    `to_move` always advances, including on the winning move, so a finished
    game still reports whose turn it would have been.
    """
    if not is_column(col):
        raise ValueError(f"Illegal column {col}: must be an integer in 0..{COLS - 1}")

    row = _landing_row(state.board, col)
    if row == -1:
        raise ValueError(f"Illegal move: column {col} is full")

    board = list(state.board)
    board[idx(row, col)] = state.to_move
    board_t = tuple(board)

    winning_cells = _find_win_through(board_t, row, col, state.to_move)
    winner = state.to_move if winning_cells is not None else None

    board_full = all(cell != 0 for cell in board_t)
    is_draw = winner is None and board_full

    return GameState(
        board=board_t,
        to_move=opponent(state.to_move),
        moves=(*state.moves, col),
        winner=winner,
        is_draw=is_draw,
        winning_cells=tuple(winning_cells) if winning_cells is not None else None,
    )


def from_moves(moves: list[int] | tuple[int, ...]) -> GameState:
    """Replay a move sequence from an empty board. Convenience for tests and
    fixtures."""
    state = create_game()
    for m in moves:
        state = apply_move(state, m)
    return state


def encode(state: GameState) -> np.ndarray:
    """Encode a state as a `[2,6,7]` float32 tensor, per CONTRACTS §3.

    Plane 0 = discs of the player to move, plane 1 = opponent discs, always from
    the perspective of the player to move (the network learns "me vs them", not
    "red vs yellow"). Row 0 is the bottom row: reshaping the flat board
    row-major preserves that directly, since flat index is already row * COLS +
    col.
    """
    board_arr = np.asarray(state.board, dtype=np.int8).reshape(ROWS, COLS)
    mover = state.to_move
    opp = opponent(mover)
    tensor = np.zeros((2, ROWS, COLS), dtype=np.float32)
    tensor[0] = board_arr == mover
    tensor[1] = board_arr == opp
    return tensor
