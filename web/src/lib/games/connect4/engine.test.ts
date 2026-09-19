/**
 * Engine conformance against shared/fixtures/connect4_cases.json.
 *
 * The fixture file is the cross-language source of truth (CONTRACTS §2). This
 * engine was written from the contract, independently of the generator that
 * produced the fixtures, so agreement between them is real evidence rather
 * than a tautology.
 *
 * The structural-invariant tests below deliberately check the fixture data
 * itself, not just the engine: a bad fixture would otherwise teach both the TS
 * engine and the Python trainer the same wrong rule.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { applyMove, createGame, fromMoves, isTerminal, legalMoves } from './engine';
import { COLS, ROWS, idx, type Column } from './types';

interface FixtureCase {
	id: string;
	description: string;
	moves: number[];
	board: number[];
	toMove: number;
	legalMoves: number[];
	winner: number | null;
	isDraw: boolean;
	isTerminal: boolean;
	winningCells: number[] | null;
	illegalMove?: number;
	expectError?: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../../../../shared/fixtures/connect4_cases.json');
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
	schemaVersion: number;
	cases: FixtureCase[];
};

const cases = fixtures.cases;
const playable = cases.filter((c) => !c.expectError);

describe('fixture corpus integrity', () => {
	it('has a usable number of cases and unique ids', () => {
		expect(cases.length).toBeGreaterThanOrEqual(60);
		expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
	});

	it.each(playable.map((c) => [c.id, c] as const))(
		'%s: board is well formed',
		(_id, c: FixtureCase) => {
			expect(c.board).toHaveLength(ROWS * COLS);
			for (const cell of c.board) expect([0, 1, 2]).toContain(cell);
		}
	);

	it.each(playable.map((c) => [c.id, c] as const))(
		'%s: disc counts are reachable (player 1 moves first)',
		(_id, c: FixtureCase) => {
			const ones = c.board.filter((v) => v === 1).length;
			const twos = c.board.filter((v) => v === 2).length;
			const diff = ones - twos;
			expect(diff === 0 || diff === 1).toBe(true);
		}
	);

	it.each(playable.map((c) => [c.id, c] as const))(
		'%s: gravity holds, no floating discs',
		(_id, c: FixtureCase) => {
			for (let col = 0; col < COLS; col++) {
				let sawEmpty = false;
				for (let row = 0; row < ROWS; row++) {
					const filled = c.board[idx(row, col)] !== 0;
					if (!filled) sawEmpty = true;
					else if (sawEmpty) {
						throw new Error(`floating disc at row ${row} col ${col} in ${c.id}`);
					}
				}
			}
		}
	);

	it.each(playable.filter((c) => c.winningCells).map((c) => [c.id, c] as const))(
		'%s: winningCells are four collinear cells of one player',
		(_id, c: FixtureCase) => {
			const cells = c.winningCells as number[];
			expect(cells).toHaveLength(4);

			const owners = new Set(cells.map((i) => c.board[i]));
			expect(owners.size).toBe(1);
			expect([...owners][0]).toBe(c.winner);

			const sorted = [...cells].sort((a, b) => a - b);
			const step = sorted[1] - sorted[0];
			// +1 horizontal, +7 vertical, +8 diagonal up-right, +6 diagonal up-left
			expect([1, 6, 7, 8]).toContain(step);
			for (let i = 1; i < sorted.length; i++) {
				expect(sorted[i] - sorted[i - 1]).toBe(step);
			}
			// A horizontal run must not wrap across the row edge.
			if (step === 1) {
				const rows = sorted.map((i) => Math.floor(i / COLS));
				expect(new Set(rows).size).toBe(1);
			}
		}
	);
});

describe('engine matches the fixtures', () => {
	it.each(playable.map((c) => [c.id, c] as const))(
		'%s: replaying moves reproduces the expected state',
		(_id, c: FixtureCase) => {
			const s = fromMoves(c.moves as Column[]);
			expect(s.board).toEqual(c.board);
			expect(s.toMove).toBe(c.toMove);
			expect(s.winner).toBe(c.winner);
			expect(s.isDraw).toBe(c.isDraw);
			expect(isTerminal(s)).toBe(c.isTerminal);
			expect(legalMoves(s)).toEqual(c.legalMoves);
			if (c.winningCells === null) {
				expect(s.winningCells).toBeNull();
			} else {
				expect([...(s.winningCells as number[])].sort((a, b) => a - b)).toEqual(
					[...c.winningCells].sort((a, b) => a - b)
				);
			}
		}
	);

	const errorCases = cases.filter((c) => c.expectError);

	it('covers illegal moves', () => {
		expect(errorCases.length).toBeGreaterThan(0);
	});

	it.each(errorCases.map((c) => [c.id, c] as const))(
		'%s: illegal move throws',
		(_id, c: FixtureCase) => {
			const s = fromMoves(c.moves as Column[]);
			expect(() => applyMove(s, c.illegalMove as Column)).toThrow();
		}
	);
});

describe('engine basics', () => {
	it('starts empty with player 1 to move', () => {
		const s = createGame();
		expect(s.board.every((c) => c === 0)).toBe(true);
		expect(s.toMove).toBe(1);
		expect(legalMoves(s)).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(isTerminal(s)).toBe(false);
	});

	it('does not mutate the input state', () => {
		const s = createGame();
		const before = structuredClone(s);
		applyMove(s, 3);
		expect(s).toEqual(before);
	});

	it('drops to the bottom row first', () => {
		const s = applyMove(createGame(), 3);
		expect(s.board[idx(0, 3)]).toBe(1);
		expect(s.board[idx(1, 3)]).toBe(0);
	});
});
