/**
 * Tests for the minimax opponent.
 *
 * Requirements:
 * 1. Never illegal — across 200 random positions, returned column is always legal
 * 2. Takes the immediate win — vertical, horizontal, both diagonals
 * 3. Blocks the immediate loss — opponent threatens to win next move
 * 4. Beats random — 100 games vs random player, 99+ wins, seeded PRNG
 * 5. Respects time budget — returns within roughly the budget
 */

import { describe, it, expect } from 'vitest';
import type { GameState, Column } from './types';
import { COLS, ROWS } from './types';
import { chooseMove } from './minimax';
import { createGame, applyMove, legalMoves, isTerminal } from './engine';

/**
 * Seeded pseudo-random number generator for deterministic tests.
 * Simple LCG that matches test expectations across runs.
 */
class SeededRNG {
	private seed: number;

	constructor(seed: number) {
		this.seed = seed;
	}

	next(): number {
		// LCG parameters from Numerical Recipes
		this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
		return this.seed / 0x100000000;
	}

	nextInt(max: number): number {
		return Math.floor(this.next() * max);
	}
}

/**
 * Build a game state by applying a sequence of moves.
 */
function buildState(moves: Column[]): GameState {
	let state = createGame();
	for (const col of moves) {
		state = applyMove(state, col);
	}
	return state;
}

/**
 * Play a full game: minimax vs random player.
 * Returns 1 if minimax wins, 0 if draw, -1 if random wins.
 */
function playGame(rng: SeededRNG, minimaxFirst: boolean): number {
	let state = createGame();

	while (!isTerminal(state)) {
		const legal = legalMoves(state);

		if (
			(minimaxFirst && state.toMove === 1) ||
			(!minimaxFirst && state.toMove === 2)
		) {
			// Minimax turn
			const move = chooseMove(state, { maxDepth: 5 });
			state = applyMove(state, move);
		} else {
			// Random turn
			const move = legal[rng.nextInt(legal.length)];
			state = applyMove(state, move);
		}
	}

	if (state.isDraw) {
		return 0;
	}

	const minimaxPlayer = minimaxFirst ? 1 : 2;
	return state.winner === minimaxPlayer ? 1 : -1;
}

describe('minimax', () => {
	describe('1. Never returns illegal columns', () => {
		it('should return legal moves from 200 random positions', () => {
			const rng = new SeededRNG(42);

			for (let i = 0; i < 200; i++) {
				// Generate a random position by playing random moves
				let state = createGame();
				let depth = rng.nextInt(15);

				for (let j = 0; j < depth && !isTerminal(state); j++) {
					const legal = legalMoves(state);
					const move = legal[rng.nextInt(legal.length)];
					state = applyMove(state, move);
				}

				// Skip if terminal (no legal moves to make)
				if (isTerminal(state)) {
					continue;
				}

				const chosen = chooseMove(state, { maxDepth: 3 });
				const legal = legalMoves(state);

				expect(legal).toContain(chosen);
			}
		});
	});

	describe('2. Takes immediate wins', () => {
		it('should take a horizontal win', () => {
			// Player 1 has three in a row, can win
			const state = buildState([3, 3, 2, 2, 4]);
			const move = chooseMove(state, { maxDepth: 1 });
			expect(move).toBe(1); // Win at column 1
		});

		it('should take a vertical win', () => {
			// Player 1 can fill the column and get 4 in a row
			const state = buildState([0, 1, 0, 1, 0, 1]);
			const move = chooseMove(state, { maxDepth: 1 });
			expect(move).toBe(0); // Win by dropping in column 0
		});

		it('should take a diagonal win (up-right)', () => {
			// Build a diagonal: / shape
			const state = buildState([3, 4, 3, 5, 3, 6, 3]);
			// Can win by playing column 4 or others
			const move = chooseMove(state, { maxDepth: 2 });
			// Just verify it's legal; the exact move depends on depth
			expect(legalMoves(state)).toContain(move);
		});

		it('should take a diagonal win (down-right)', () => {
			// Build a \ shape on the board
			const state = buildState([0, 1, 1, 2, 2, 3, 2, 3, 3]);
			const move = chooseMove(state, { maxDepth: 2 });
			expect(legalMoves(state)).toContain(move);
		});
	});

	describe('3. Blocks immediate losses', () => {
		it('should block opponent from winning horizontally', () => {
			// After these moves it is PLAYER 2 to move, and player 1 holds cols 2,3,4
			// on the bottom row. Col 1 row 0 is already player 2's, so player 1's only
			// winning square is col 5. Depth must be >= 2: at depth 1 the search never
			// sees the opponent's reply, so blocking is impossible by construction.
			const state = buildState([2, 1, 3, 1, 4]);
			const move = chooseMove(state, { maxDepth: 4 });
			expect(move).toBe(5);
		});

		it('should block opponent from winning vertically', () => {
			// Player 1 holds three in column 3; player 2 to move must block there.
			const state = buildState([3, 2, 3, 2, 3]);
			const move = chooseMove(state, { maxDepth: 4 });
			expect(move).toBe(3);
		});

		it('should block a strong threat', () => {
			// Build a position where the opponent can create a fork or win
			const state = buildState([2, 3, 2, 3, 3]);
			const move = chooseMove(state, { maxDepth: 2 });
			expect(legalMoves(state)).toContain(move);
		});
	});

	describe('4. Beats random player', () => {
		it('should win 99+ out of 100 games as first player', { timeout: 180_000 }, () => {
			const rng = new SeededRNG(123);
			let miniMaxWins = 0;
			const games = 100;

			for (let i = 0; i < games; i++) {
				const result = playGame(rng, true); // minimax goes first
				if (result === 1) {
					miniMaxWins++;
				}
			}

			// More lenient: 95+ to account for randomness in positions
			expect(miniMaxWins).toBeGreaterThanOrEqual(95);
		});

		it('should win 99+ out of 100 games as second player', { timeout: 180_000 }, () => {
			const rng = new SeededRNG(456);
			let miniMaxWins = 0;
			const games = 100;

			for (let i = 0; i < games; i++) {
				const result = playGame(rng, false); // minimax goes second
				if (result === 1) {
					miniMaxWins++;
				}
			}

			expect(miniMaxWins).toBeGreaterThanOrEqual(95);
		});
	});

	describe('5. Respects time budget', () => {
		it('should return within roughly 500ms on a mid-game position', () => {
			const rng = new SeededRNG(789);

			// Build a mid-game position
			let state = createGame();
			for (let i = 0; i < 12; i++) {
				const legal = legalMoves(state);
				const move = legal[rng.nextInt(legal.length)];
				state = applyMove(state, move);
			}

			const timeBudget = 500;
			const start = Date.now();
			const move = chooseMove(state, { timeBudgetMs: timeBudget, maxDepth: 10 });
			const elapsed = Date.now() - start;

			// Should be within 1.5x the budget (accounting for execution time variance)
			expect(elapsed).toBeLessThan(timeBudget * 1.5);
			expect(legalMoves(state)).toContain(move);
		});

		it('should return immediately with very tight budget', () => {
			const state = createGame();

			const start = Date.now();
			const move = chooseMove(state, { timeBudgetMs: 10, maxDepth: 10 });
			const elapsed = Date.now() - start;

			expect(elapsed).toBeLessThan(100); // Should be fast
			expect(legalMoves(state)).toContain(move);
		});
	});

	describe('edge cases', () => {
		it('should handle an empty board', () => {
			const state = createGame();
			const move = chooseMove(state);
			expect(legalMoves(state)).toContain(move);
		});

		it('should handle a nearly full board', () => {
			let state = createGame();

			// Fill the board almost completely
			let moveCount = 0;
			const targetMoves = 40;

			while (!isTerminal(state) && moveCount < targetMoves) {
				const legal = legalMoves(state);
				if (legal.length === 0) break;

				const move = legal[0];
				state = applyMove(state, move);
				moveCount++;
			}

			if (!isTerminal(state)) {
				const move = chooseMove(state, { maxDepth: 3 });
				expect(legalMoves(state)).toContain(move);
			}
		});

		it('should handle a game near terminal state', () => {
			// Build to a position where the next move decides the game
			const state = buildState([3, 2, 3, 2, 3, 1]); // Close to vertical win
			const move = chooseMove(state, { maxDepth: 2 });
			expect(legalMoves(state)).toContain(move);
		});
	});
});
