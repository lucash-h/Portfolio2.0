import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { ROWS, COLS, idx, type GameState, type Column } from '$lib/games/connect4/types';

/**
 * The real engine (`$lib/games/connect4/engine`) is owned by a different
 * package and may not exist yet. This test mocks it with a minimal,
 * contract-shaped implementation so Connect4Board's rendering and
 * interaction logic can be verified independently of that package landing.
 * It intentionally does NOT re-implement Connect 4 rules beyond "drop into
 * the lowest empty row" — enough to prove the board orientation and click
 * wiring, nothing more.
 */
function makeEmptyState(): GameState {
	return {
		board: new Array(ROWS * COLS).fill(0),
		toMove: 1,
		moves: [],
		winner: null,
		isDraw: false,
		winningCells: null
	};
}

function fakeApplyMove(state: GameState, col: Column): GameState {
	const board = state.board.slice();
	let landingRow = -1;
	for (let row = 0; row < ROWS; row++) {
		if (board[idx(row, col)] === 0) {
			landingRow = row;
			break;
		}
	}
	if (landingRow === -1) throw new Error('column full');
	board[idx(landingRow, col)] = state.toMove;
	return {
		board,
		toMove: state.toMove === 1 ? 2 : 1,
		moves: [...state.moves, col],
		winner: null,
		isDraw: false,
		winningCells: null
	};
}

vi.mock('$lib/games/connect4/engine', () => ({
	createGame: makeEmptyState,
	legalMoves: (s: GameState) => {
		const cols: Column[] = [];
		for (let c = 0; c < COLS; c++) {
			if (s.board[idx(ROWS - 1, c)] === 0) cols.push(c as Column);
		}
		return cols;
	},
	applyMove: fakeApplyMove,
	isTerminal: (s: GameState) => s.winner !== null || s.isDraw
}));

const { default: Connect4Board } = await import('./Connect4Board.svelte');

describe('Connect4Board', () => {
	let target: HTMLDivElement;

	beforeEach(() => {
		target = document.createElement('div');
		document.body.appendChild(target);
	});

	it('renders a disc dropped in a column at the bottom row visually', async () => {
		const opponentMove = vi.fn(async () => 0 as Column);
		const component = mount(Connect4Board, {
			target,
			props: { opponentMove, humanPlayer: 1 }
		});
		flushSync();

		// Click the column-3 control (index 3, 0-based) to drop a disc there.
		const colButtons = target.querySelectorAll<HTMLButtonElement>('.col-button');
		expect(colButtons.length).toBe(COLS);
		colButtons[3].click();
		flushSync();

		// The rendered table has ROWS <tr> elements, top-to-bottom visually.
		// After one move by player 1 into column 3, the BOTTOM visual row
		// (the last <tr>) must contain the disc, and every row above it in
		// that column must remain empty. This is the orientation check
		// called for in the task: row 0 of the board array is the bottom row.
		const rows = target.querySelectorAll('tbody tr');
		expect(rows.length).toBe(ROWS);

		const bottomRow = rows[rows.length - 1];
		const bottomCellInCol3 = bottomRow.querySelectorAll('td')[3];
		expect(bottomCellInCol3.querySelector('.disc')).not.toBeNull();

		const topRow = rows[0];
		const topCellInCol3 = topRow.querySelectorAll('td')[3];
		expect(topCellInCol3.querySelector('.disc')).toBeNull();

		unmount(component);
	});

	it('renders one control per column for touch input', async () => {
		const opponentMove = vi.fn(async () => 0 as Column);
		const component = mount(Connect4Board, {
			target,
			props: { opponentMove, humanPlayer: 1 }
		});
		flushSync();

		const colButtons = target.querySelectorAll<HTMLButtonElement>('.col-button');
		expect(colButtons).toHaveLength(COLS);

		unmount(component);
	});

	/**
	 * The 44px minimum touch target is asserted against the stylesheet source rather
	 * than computed style. jsdom does not apply a Svelte component's scoped <style>
	 * block, so getComputedStyle returns empty strings for these properties and a
	 * computed-style assertion would pass or fail for reasons unrelated to the CSS.
	 *
	 * This checks the declaration genuinely exists. It does NOT prove the rendered
	 * size, which needs a real browser; that belongs in an end-to-end test.
	 */
	it('declares a 44px minimum touch target for column controls', async () => {
		const source = readFileSync(
			resolve(dirname(fileURLToPath(import.meta.url)), 'Connect4Board.svelte'),
			'utf-8'
		);

		const controlRule = source.match(/\.col-button\s*\{[^}]*\}/);
		expect(controlRule, '.col-button rule not found').not.toBeNull();

		const rule = controlRule![0];
		expect(rule).toMatch(/min-width:/);
		expect(rule).toMatch(/min-height:/);
		expect(source).toMatch(/--c4-control-min:\s*44px/);
	});
});
