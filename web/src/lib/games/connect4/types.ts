/**
 * Connect 4 shared types — transcribed verbatim from docs/CONTRACTS.md §3.
 *
 * Owned by the orchestrator. Multiple packages import from this file; no package
 * may edit it. If a change is needed, the contract changes first.
 *
 * Board geometry: 6 rows x 7 columns. Row 0 is the BOTTOM row.
 * Flat array of length 42, index = row * 7 + col.
 */

export const ROWS = 6;
export const COLS = 7;
export const CELL_COUNT = ROWS * COLS;
export const WIN_LENGTH = 4;

export type Player = 1 | 2;
export type Cell = 0 | Player;
export type Board = Cell[];
export type Column = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface GameState {
	board: Board;
	toMove: Player;
	/** Full move history, in order. */
	moves: Column[];
	winner: Player | null;
	isDraw: boolean;
	/** Exactly 4 board indices when there is a winner, otherwise null. */
	winningCells: number[] | null;
}

/** Board index from row/column. Row 0 is the bottom row. */
export function idx(row: number, col: number): number {
	return row * COLS + col;
}

export function isColumn(n: number): n is Column {
	return Number.isInteger(n) && n >= 0 && n < COLS;
}

export function opponent(p: Player): Player {
	return p === 1 ? 2 : 1;
}
