/**
 * Connect 4 rules engine — implements docs/CONTRACTS.md §3.
 *
 * Pure functions only: no I/O, no randomness, no mutation of inputs, no Svelte
 * imports. Must stay runnable in a plain Node test and inside a Web Worker.
 *
 * Geometry reminder: row 0 is the BOTTOM row, index = row * COLS + col.
 */

import {
	COLS,
	ROWS,
	CELL_COUNT,
	WIN_LENGTH,
	idx,
	isColumn,
	opponent,
	type Board,
	type Cell,
	type Column,
	type GameState,
	type Player
} from './types';

/** Direction vectors as [rowStep, colStep]. Working in row/col space rather than
 *  flat indices avoids the classic bug where a horizontal run wraps the row edge. */
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
	[0, 1], // horizontal
	[1, 0], // vertical
	[1, 1], // diagonal up-right
	[1, -1] // diagonal up-left
];

export function createGame(): GameState {
	return {
		board: new Array<Cell>(CELL_COUNT).fill(0),
		toMove: 1,
		moves: [],
		winner: null,
		isDraw: false,
		winningCells: null
	};
}

/** Columns that still have room. Independent of whether the game is already won. */
export function legalMoves(s: GameState): Column[] {
	const out: Column[] = [];
	for (let col = 0; col < COLS; col++) {
		if (s.board[idx(ROWS - 1, col)] === 0) out.push(col as Column);
	}
	return out;
}

export function isTerminal(s: GameState): boolean {
	return s.winner !== null || s.isDraw;
}

/** Lowest empty row in a column, or -1 when the column is full. */
function landingRow(board: Board, col: number): number {
	for (let row = 0; row < ROWS; row++) {
		if (board[idx(row, col)] === 0) return row;
	}
	return -1;
}

/**
 * The four cells of a win through (row, col), or null. Only lines through the
 * just-placed disc can be new, so this is all applyMove needs to check.
 */
function findWinThrough(board: Board, row: number, col: number, player: Player): number[] | null {
	for (const [dr, dc] of DIRECTIONS) {
		const cells: number[] = [idx(row, col)];

		for (const sign of [1, -1] as const) {
			let r = row + dr * sign;
			let c = col + dc * sign;
			while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[idx(r, c)] === player) {
				cells.push(idx(r, c));
				r += dr * sign;
				c += dc * sign;
			}
		}

		if (cells.length >= WIN_LENGTH) {
			// Collinear, so ascending index order is also spatial order.
			cells.sort((a, b) => a - b);
			return cells.slice(0, WIN_LENGTH);
		}
	}
	return null;
}

/**
 * Apply a move, returning a NEW state. Throws on an illegal column.
 *
 * `toMove` always advances, including on the winning move, so a finished game
 * still reports whose turn it would have been.
 */
export function applyMove(s: GameState, col: Column): GameState {
	if (!isColumn(col)) {
		throw new Error(`Illegal column ${col}: must be an integer in 0..${COLS - 1}`);
	}

	const row = landingRow(s.board, col);
	if (row === -1) {
		throw new Error(`Illegal move: column ${col} is full`);
	}

	const board = s.board.slice();
	board[idx(row, col)] = s.toMove;

	const winningCells = findWinThrough(board, row, col, s.toMove);
	const winner = winningCells ? s.toMove : null;

	const boardFull = board.every((cell) => cell !== 0);
	const isDraw = winner === null && boardFull;

	return {
		board,
		toMove: opponent(s.toMove),
		moves: [...s.moves, col],
		winner,
		isDraw,
		winningCells
	};
}

/** Replay a move sequence from an empty board. Convenience for tests and fixtures. */
export function fromMoves(moves: readonly Column[]): GameState {
	let s = createGame();
	for (const m of moves) s = applyMove(s, m);
	return s;
}
