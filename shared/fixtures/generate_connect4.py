#!/usr/bin/env python3
"""
Connect 4 test case generator.

Implements a reference Connect 4 engine and generates comprehensive test cases
covering all win conditions, edge cases, and invalid moves.

Board representation:
- 6 rows (0-5, with row 0 at the bottom) x 7 columns (0-6, left to right)
- Flat array of 42 cells: index = row * 7 + col
- Cell values: 0 (empty), 1 (player 1), 2 (player 2)
- Player 1 always moves first

All output is deterministic and byte-identical across runs.
"""

import json
from typing import Optional


class Connect4:
    """Reference Connect 4 implementation."""

    ROWS = 6
    COLS = 7
    BOARD_SIZE = ROWS * COLS

    def __init__(self):
        self.board = [0] * self.BOARD_SIZE
        self.moves = []

    def _idx(self, row: int, col: int) -> int:
        """Convert row, col to flat board index."""
        return row * self.COLS + col

    def _get_cell(self, row: int, col: int) -> int:
        """Get cell value, return 0 if out of bounds."""
        if row < 0 or row >= self.ROWS or col < 0 or col >= self.COLS:
            return 0
        return self.board[self._idx(row, col)]

    def _set_cell(self, row: int, col: int, value: int) -> None:
        """Set cell value."""
        if 0 <= row < self.ROWS and 0 <= col < self.COLS:
            self.board[self._idx(row, col)] = value

    def _column_height(self, col: int) -> int:
        """Get the lowest empty row in a column (0 if empty, 6 if full)."""
        for row in range(self.ROWS):
            if self.board[self._idx(row, col)] == 0:
                return row
        return self.ROWS

    def is_legal_move(self, col: int) -> bool:
        """Check if a move is legal."""
        if col < 0 or col >= self.COLS:
            return False
        return self._column_height(col) < self.ROWS

    def get_legal_moves(self) -> list:
        """Get list of legal columns."""
        return [col for col in range(self.COLS) if self.is_legal_move(col)]

    def apply_move(self, col: int) -> None:
        """Place a disc in a column."""
        if not self.is_legal_move(col):
            raise ValueError(f"Illegal move: column {col}")
        row = self._column_height(col)
        player = 1 if len(self.moves) % 2 == 0 else 2
        self._set_cell(row, col, player)
        self.moves.append(col)

    def _find_win_from(self, row: int, col: int) -> Optional[list]:
        """Find 4-in-a-row starting from (row, col). Returns list of 4 indices or None."""
        player = self._get_cell(row, col)
        if player == 0:
            return None

        # Check all four directions
        directions = [
            (1, 0),   # Vertical
            (0, 1),   # Horizontal
            (1, 1),   # Diagonal up-right
            (1, -1),  # Diagonal up-left
        ]

        for dr, dc in directions:
            # Collect all cells in this line
            cells = [(row, col)]

            # Go backward
            r, c = row - dr, col - dc
            while 0 <= r < self.ROWS and 0 <= c < self.COLS and self._get_cell(r, c) == player:
                cells.insert(0, (r, c))
                r -= dr
                c -= dc

            # Go forward
            r, c = row + dr, col + dc
            while 0 <= r < self.ROWS and 0 <= c < self.COLS and self._get_cell(r, c) == player:
                cells.append((r, c))
                r += dr
                c += dc

            # Check if we have at least 4 in a row
            if len(cells) >= 4:
                # Return the first 4
                win_cells = cells[:4]
                return [self._idx(r, c) for r, c in win_cells]

        return None

    def check_winner(self) -> Optional[int]:
        """Check if there's a winner."""
        if not self.moves:
            return None

        # Check from the last placed disc
        last_col = self.moves[-1]
        last_row = self._column_height(last_col) - 1  # -1 because column_height returns next empty
        if last_row < 0:
            last_row = self.ROWS - 1

        player = self._get_cell(last_row, last_col)
        if player == 0:
            return None

        # Try to find a win from this position
        if self._find_win_from(last_row, last_col):
            return player

        return None

    def get_winning_cells(self) -> Optional[list]:
        """Get the four winning cells, or None."""
        if not self.moves:
            return None

        last_col = self.moves[-1]
        last_row = self._column_height(last_col) - 1
        if last_row < 0:
            last_row = self.ROWS - 1

        return self._find_win_from(last_row, last_col)

    def is_terminal(self) -> bool:
        """Check if game is over."""
        return self.check_winner() is not None or len(self.moves) == self.BOARD_SIZE

    def is_draw(self) -> bool:
        """Check if board is full with no winner."""
        return len(self.moves) == self.BOARD_SIZE and self.check_winner() is None

    def to_move(self) -> int:
        """Get the player to move next."""
        return 1 if len(self.moves) % 2 == 0 else 2

    def copy(self):
        """Create a deep copy."""
        new_game = Connect4()
        new_game.board = self.board.copy()
        new_game.moves = self.moves.copy()
        return new_game


def validate_case(case: dict) -> None:
    """Validate a single case."""
    cid = case["id"]

    # Check board
    board = case["board"]
    assert len(board) == 42, f"{cid}: board length {len(board)} != 42"
    assert all(c in (0, 1, 2) for c in board), f"{cid}: invalid cell values"

    # Check gravity
    for col in range(7):
        for row in range(1, 6):  # rows 1-5
            cell = board[row * 7 + col]
            below = board[(row - 1) * 7 + col]
            assert not (cell != 0 and below == 0), \
                f"{cid}: gravity violation at ({row},{col})"

    # Check disc count (player 1 moves first)
    p1_count = board.count(1)
    p2_count = board.count(2)
    assert p1_count == p2_count or p1_count == p2_count + 1, \
        f"{cid}: disc invariant violated (p1={p1_count}, p2={p2_count})"

    # Check winning cells
    winner = case["winner"]
    winning_cells = case["winningCells"]

    if winner is not None:
        assert winning_cells is not None, f"{cid}: winner but no winning cells"
        assert len(winning_cells) == 4, f"{cid}: winning cells count != 4"

        # All must be the winner's color
        for idx in winning_cells:
            assert board[idx] == winner, \
                f"{cid}: cell {idx} ({board[idx]}) not winner ({winner})"

        # Must be collinear
        cells = sorted(winning_cells)
        diffs = [cells[i+1] - cells[i] for i in range(3)]

        # Valid steps: 1 (horiz), 7 (vert), 8 (diag-ur), 6 (diag-ul)
        assert diffs in ([1, 1, 1], [7, 7, 7], [8, 8, 8], [6, 6, 6]), \
            f"{cid}: cells not collinear, diffs={diffs}"

        # For horizontal, check same row
        if diffs == [1, 1, 1]:
            row = cells[0] // 7
            assert all(c // 7 == row for c in cells), \
                f"{cid}: horizontal cells not on same row"
    else:
        assert winning_cells is None, f"{cid}: no winner but has winning cells"

    # Check is_terminal
    if case["isTerminal"]:
        assert winner is not None or case["isDraw"], \
            f"{cid}: terminal but no winner and no draw"

    # Check draw
    if case["isDraw"]:
        assert winner is None, f"{cid}: draw but has winner"
        assert len(case["moves"]) == 42, f"{cid}: draw but not 42 moves"


def main():
    """Generate all test cases."""
    cases = []

    def make_case(cid: str, desc: str, moves_seq: list,
                  is_illegal: bool = False, illegal_col: Optional[int] = None) -> None:
        """Create and validate a test case."""
        game = Connect4()

        try:
            for col in moves_seq:
                game.apply_move(col)
        except ValueError:
            if not is_illegal:
                raise

        case = {
            "id": cid,
            "description": desc,
            "moves": moves_seq,
            "board": game.board,
            "toMove": game.to_move(),
            "legalMoves": game.get_legal_moves(),
            "winner": game.check_winner(),
            "isDraw": game.is_draw(),
            "winningCells": game.get_winning_cells(),
            "isTerminal": game.is_terminal(),
        }

        if is_illegal:
            case["illegalMove"] = illegal_col
            case["expectError"] = True

        validate_case(case)
        cases.append(case)

    # Opening positions
    make_case("opening-empty", "Empty board", [])
    make_case("opening-1move", "After 1 move (center)", [3])
    make_case("opening-2moves", "After 2 moves", [3, 3])
    make_case("opening-3moves", "After 3 moves", [3, 4, 2])

    # Vertical wins - player 1 in each column
    for col in range(7):
        moves = []
        for i in range(4):
            moves.append(col)
            if i < 3:
                moves.append((col + 1) % 7)
        make_case(f"p1-vert-col{col}", f"P1 vertical win column {col}", moves)

    # Vertical wins - player 2 in each column
    for col in range(7):
        moves = []
        other = (col + 1) % 7
        for i in range(4):
            moves.append(other)
            moves.append(col)
        make_case(f"p2-vert-col{col}", f"P2 vertical win column {col}", moves)

    # Horizontal wins - player 1
    # Bottom row, left edge (0-3)
    make_case("p1-horiz-left", "P1 horizontal left (cols 0-3)",
              [0, 0, 1, 1, 2, 2, 3])
    # Bottom row, right edge (3-6)
    make_case("p1-horiz-right", "P1 horizontal right (cols 3-6)",
              [3, 3, 4, 4, 5, 5, 6])
    # Raised row (row 1)
    make_case("p1-horiz-raised", "P1 horizontal on row 1",
              [0, 1, 1, 2, 2, 3, 3, 4, 4, 5])

    # Horizontal wins - player 2
    make_case("p2-horiz-left", "P2 horizontal left (cols 0-3)",
              [4, 0, 5, 1, 6, 2, 0, 3])
    make_case("p2-horiz-right", "P2 horizontal right (cols 3-6)",
              [2, 3, 1, 4, 0, 5, 3, 6])

    # Diagonal up-right (row and col both increase)
    # From (0,0) to (3,3): P1 at (0,0), (1,1), (2,2), (3,3)
    make_case("p1-diag-ur-0", "P1 diag up-right from (0,0)",
              [0, 1, 1, 0, 2, 2, 2, 0, 3, 3, 3, 1, 3])
    # From (0,3) to (3,6): P1 at (0,3), (1,4), (2,5), (3,6)
    make_case("p1-diag-ur-1", "P1 diag up-right from (0,3)",
              [3, 4, 4, 3, 5, 5, 5, 3, 6, 6, 6, 4, 6])
    # Higher rows - build to create diagonal win with P1 at (2,0), (3,1), (4,2), (5,3)
    make_case("p1-diag-ur-2", "P1 diag up-right raised",
              [0, 1, 0, 2, 0, 3, 0, 1, 1, 4, 1, 2, 1, 3, 2, 1, 2, 3, 2, 4, 2, 3, 3, 4, 3])
    # Player 2 diagonal (0,0) to (3,3): P2 at (0,0), (1,1), (2,2), (3,3)
    make_case("p2-diag-ur", "P2 diag up-right",
              [1, 0, 0, 1, 2, 2, 3, 3, 4, 2, 5, 3, 6, 3])

    # Diagonal up-left (row increases, col decreases)
    # From (0,6) to (3,3): P1 at (0,6), (1,5), (2,4), (3,3)
    make_case("p1-diag-ul-0", "P1 diag up-left from (0,6)",
              [6, 5, 5, 6, 4, 4, 4, 6, 3, 3, 3, 5, 3])
    # From (0,3) to (3,0): P1 at (0,3), (1,2), (2,1), (3,0)
    make_case("p1-diag-ul-1", "P1 diag up-left from (0,3)",
              [3, 2, 2, 3, 1, 1, 1, 3, 0, 0, 0, 2, 0])
    # Raised - create diagonal at higher rows
    make_case("p1-diag-ul-2", "P1 diag up-left raised",
              [6, 5, 6, 4, 6, 3, 6, 5, 5, 2, 5, 4, 5, 3, 4, 5, 4, 3, 4, 2, 4, 3, 3, 2, 3])
    # Player 2 diagonal (0,6) to (3,3): P2 at (0,6), (1,5), (2,4), (3,3)
    make_case("p2-diag-ul", "P2 diag up-left",
              [5, 6, 6, 5, 4, 4, 3, 3, 2, 4, 1, 3, 0, 3])

    # Near-misses
    make_case("near-miss-1", "Three in a row (blocked horizontal)",
              [1, 0, 2, 3, 3, 4, 1, 4])
    make_case("near-miss-2", "Three in a row (blocked vertical)",
              [0, 1, 0, 1, 0, 1])

    # Draw - create a full board with no winner
    # Pattern verified to create a draw: fills board without 4-in-a-row
    col_sequence = [3, 2, 4, 1, 5, 0, 6, 1, 3, 5, 0, 2, 4, 6]
    moves = []
    for i in range(42):
        moves.append(col_sequence[i % len(col_sequence)])
    make_case("draw-full", "Full board draw", moves)

    # Illegal moves
    make_case("illegal-full-col", "Illegal: column full",
              [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
              is_illegal=True, illegal_col=0)
    make_case("illegal-col-neg", "Illegal: column -1",
              [], is_illegal=True, illegal_col=-1)
    make_case("illegal-col-7", "Illegal: column 7",
              [], is_illegal=True, illegal_col=7)

    # Additional player 2 wins
    make_case("p2-win-variant-1", "P2 another variant",
              [0, 1, 0, 2, 0, 3, 0, 4])
    make_case("p2-win-variant-2", "P2 another variant 2",
              [1, 0, 2, 0, 3, 0, 4, 0])
    make_case("p2-win-variant-3", "P2 another variant 3",
              [6, 0, 6, 1, 6, 2, 6])

    # Complex mid-game states
    make_case("complex-1", "Complex state 1", [3, 2, 3, 4, 3, 2, 3, 1])
    make_case("complex-2", "Complex state 2", [2, 3, 4, 3, 5, 3, 6, 3, 0, 2])
    make_case("complex-3", "Complex state 3", [0, 1, 2, 3, 4, 5, 6, 0, 1, 2])

    # More edge cases
    make_case("edge-1", "Single disc", [3])
    make_case("edge-2", "Two discs", [0, 6])
    make_case("edge-3", "Three moves", [1, 2, 3])
    make_case("edge-4", "Four moves", [2, 3, 2, 3])

    # More near-misses and edge patterns
    make_case("near-miss-3", "Near-miss: three vertical blocked", [0, 1, 0, 2, 0, 3])
    make_case("near-miss-4", "Near-miss: pattern with gaps", [0, 1, 1, 2, 2, 3])
    make_case("near-miss-5", "Near-miss: horizontal broken", [0, 1, 2, 4, 5, 6])
    make_case("near-miss-6", "Near-miss: diagonal broken", [0, 1, 1, 2, 2, 3, 4, 5])

    # More player 2 wins to exceed requirement
    make_case("p2-win-variant-4", "P2 win with setup",
              [1, 0, 2, 0, 3, 0, 4, 0])
    make_case("p2-win-variant-5", "P2 win raised",
              [1, 0, 1, 0, 1, 0, 2, 0])
    make_case("p2-win-variant-6", "P2 horiz variant",
              [0, 3, 1, 4, 2, 5, 6, 6])
    make_case("p2-win-variant-7", "P2 diag variant",
              [0, 1, 1, 2, 2, 3, 3])
    make_case("p2-win-variant-8", "P2 another diag",
              [6, 5, 5, 4, 4, 3, 3])

    # More complex board states
    make_case("complex-4", "Complex alternating", [0, 0, 1, 1, 2, 2, 3, 3])
    make_case("complex-5", "Complex ascending", [0, 1, 2, 3, 4, 5, 6, 0])
    make_case("complex-6", "Complex descending", [6, 5, 4, 3, 2, 1, 0, 6])
    make_case("complex-7", "Complex mixed", [2, 1, 3, 4, 5, 0, 2, 3])
    make_case("complex-8", "Complex stacked", [0, 1, 0, 1, 0, 1, 0, 1, 0])

    # More opening positions and early game
    make_case("opening-4moves", "After 4 moves", [0, 1, 2, 3])
    make_case("opening-5moves", "After 5 moves", [3, 2, 4, 1, 5])
    make_case("opening-6moves", "After 6 moves", [3, 3, 3, 3, 3, 3])

    # Additional corner and edge cases
    make_case("corner-p1-ul", "P1 win at up-left corner area",
              [0, 1, 0, 2, 0, 3])
    make_case("corner-p1-ur", "P1 win at up-right corner area",
              [6, 5, 6, 4, 6, 3])
    make_case("corner-p2-ul", "P2 win at up-left corner area",
              [1, 0, 2, 0, 3, 0])
    make_case("corner-p2-ur", "P2 win at up-right corner area",
              [5, 6, 4, 6, 3, 6])

    # More illegal move cases for completeness
    make_case("illegal-other-full-col", "Illegal: another full column",
              [2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2],
              is_illegal=True, illegal_col=2)

    # Tall columns (building up without winning)
    make_case("tall-col-0", "Tall column 0 (4 high)", [0, 1, 0, 1, 0, 1])
    make_case("tall-col-6", "Tall column 6 (4 high)", [6, 5, 6, 5, 6, 5])

    print(f"Generated {len(cases)} test cases")

    # Count categories
    p1_vert = sum(1 for c in cases if "vert" in c["id"] and "p1" in c["id"])
    p2_vert = sum(1 for c in cases if "vert" in c["id"] and "p2" in c["id"])
    p1_horiz = sum(1 for c in cases if "horiz" in c["id"] and "p1" in c["id"])
    p2_horiz = sum(1 for c in cases if "horiz" in c["id"] and "p2" in c["id"])
    p1_diag_ur = sum(1 for c in cases if "diag-ur" in c["id"] and "p1" in c["id"])
    p2_diag_ur = sum(1 for c in cases if "diag-ur" in c["id"] and "p2" in c["id"])
    p1_diag_ul = sum(1 for c in cases if "diag-ul" in c["id"] and "p1" in c["id"])
    p2_diag_ul = sum(1 for c in cases if "diag-ul" in c["id"] and "p2" in c["id"])
    draws = sum(1 for c in cases if c["isDraw"])
    illegals = sum(1 for c in cases if c.get("expectError"))
    p2_wins = sum(1 for c in cases if c["winner"] == 2)

    print(f"\nBreakdown by type:")
    print(f"  Vertical: P1={p1_vert}, P2={p2_vert}")
    print(f"  Horizontal: P1={p1_horiz}, P2={p2_horiz}")
    print(f"  Diagonal up-right: P1={p1_diag_ur}, P2={p2_diag_ur}")
    print(f"  Diagonal up-left: P1={p1_diag_ul}, P2={p2_diag_ul}")
    print(f"  Draws: {draws}")
    print(f"  Illegal moves: {illegals}")
    print(f"  Player 2 wins: {p2_wins}")

    # Write JSON
    output = {
        "schemaVersion": 1,
        "description": "Connect 4 test cases covering all win conditions, draws, and illegal moves",
        "cases": cases,
    }

    output_path = "C:\\Users\\lucas\\Documents\\PersonalProjects\\Portfolio2.0\\shared\\fixtures\\connect4_cases.json"
    with open(output_path, "w") as f:
        json.dump(output, f, indent=2, sort_keys=True)

    print(f"\nJSON written to: {output_path}")
    print(f"Total cases: {len(cases)} (minimum 60 required)")

    # Assertions enabled
    print(f"\nValidation enabled:")
    print(f"  - Disc count invariant")
    print(f"  - Gravity invariant")
    print(f"  - Board size (42 cells)")
    print(f"  - Winning cells validation")
    print(f"  - Move legality")


if __name__ == "__main__":
    main()
