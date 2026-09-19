/**
 * Alpha-beta negamax opponent for Connect 4.
 *
 * Uses iterative deepening to respect a time budget, move ordering for pruning,
 * and terminal scoring that prefers faster wins.
 */

import type { GameState, Column } from './types';
import { COLS, WIN_LENGTH, opponent } from './types';
import { legalMoves, applyMove, isTerminal } from './engine';

export interface MinimaxOptions {
	maxDepth?: number;
	timeBudgetMs?: number;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_TIME_BUDGET_MS = 500;

// Large score for wins; higher depth means sooner, which is good
const WIN_BONUS = 100_000;

/** Column order for move ordering: center columns first. */
const MOVE_ORDER: Column[] = [3, 2, 4, 1, 5, 0, 6];

interface SearchResult {
	score: number;
	bestMove: Column | null;
}

/**
 * Chooses the best move for the current player using alpha-beta negamax.
 * Iteratively deepens with a time budget to ensure timely response.
 *
 * Guardrails: never returns an illegal column.
 */
export function chooseMove(state: GameState, opts?: MinimaxOptions): Column {
	const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
	const timeBudgetMs = opts?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;

	const deadline = Date.now() + timeBudgetMs;
	let bestMove: Column | null = null;

	// Iterative deepening: try increasing depths, bailing out if time runs out
	for (let depth = 1; depth <= maxDepth; depth++) {
		if (Date.now() >= deadline) break;

		const result = searchWithDepth(state, depth, deadline);
		if (result.bestMove !== null) {
			bestMove = result.bestMove;
		}

		// Stop if we've searched all possible moves
		if (Date.now() >= deadline) break;
	}

	// If iterative deepening found nothing, fall back to first legal move
	const finalMove = (() => {
		if (bestMove !== null) {
			return bestMove;
		}

		const legal = legalMoves(state);
		const move = legal[0];
		if (move === undefined) {
			throw new Error('No legal moves available');
		}
		return move;
	})();

	// Final guard: verify the move is legal
	const legal = legalMoves(state);
	if (!legal.includes(finalMove)) {
		// This should never happen; throw for debugging
		throw new Error(
			`Minimax returned illegal column ${finalMove}. ` +
			`Legal: ${legal.join(', ')}`
		);
	}

	return finalMove;
}

/**
 * Search to a fixed depth, returning the best move found at the root.
 */
function searchWithDepth(
	state: GameState,
	depth: number,
	deadline: number
): SearchResult {
	let bestScore = -Infinity;
	let bestMove: Column | null = null;

	const legal = legalMoves(state);

	// Order moves: center columns first
	const orderedMoves = legal.sort(
		(a: Column, b: Column) => MOVE_ORDER.indexOf(a) - MOVE_ORDER.indexOf(b)
	);

	for (const col of orderedMoves) {
		if (Date.now() >= deadline) break;

		const nextState = applyMove(state, col);
		const score = -negamax(nextState, depth - 1, -Infinity, Infinity, deadline);

		if (score > bestScore) {
			bestScore = score;
			bestMove = col;
		}
	}

	return { score: bestScore, bestMove };
}

/**
 * Negamax with alpha-beta pruning.
 * Scores from the perspective of the player to move.
 */
function negamax(
	state: GameState,
	depth: number,
	alpha: number,
	beta: number,
	deadline: number
): number {
	if (Date.now() >= deadline) {
		// Soft timeout: evaluate and return
		return evaluate(state, depth);
	}

	if (isTerminal(state)) {
		return scoreTerminal(state, depth);
	}

	if (depth === 0) {
		return evaluate(state, depth);
	}

	const legal = legalMoves(state);

	// Order moves: center first
	const orderedMoves = legal.sort(
		(a: Column, b: Column) => MOVE_ORDER.indexOf(a) - MOVE_ORDER.indexOf(b)
	);

	let maxScore = -Infinity;

	for (const col of orderedMoves) {
		const nextState = applyMove(state, col);
		const score = -negamax(nextState, depth - 1, -beta, -alpha, deadline);

		maxScore = Math.max(maxScore, score);
		alpha = Math.max(alpha, score);

		if (alpha >= beta) {
			break; // Beta cutoff
		}
	}

	return maxScore;
}

/**
 * Score a terminal position (win/draw).
 * Wins scored as WIN_BONUS - depth, so sooner wins are preferred.
 */
function scoreTerminal(state: GameState, depth: number): number {
	if (state.winner === state.toMove) {
		// The player to move has already won (shouldn't happen in negamax),
		// but if we reach a terminal state, check perspective
		// Actually, in negamax we evaluate from the current player's view BEFORE applying a move
		// So if we reach here, the previous player won
		// Return negative (loss from current player's view)
		return -(WIN_BONUS - depth);
	} else if (state.winner !== null) {
		// The other player won
		return -(WIN_BONUS - depth);
	} else if (state.isDraw) {
		return 0;
	}

	// Should not reach here
	return 0;
}

/**
 * Heuristic evaluation for non-terminal positions.
 * Counts open 2s and 3s, weights center occupancy.
 */
function evaluate(state: GameState, depth: number): number {
	let score = 0;

	const player = state.toMove;
	const opp = opponent(player);

	// Count threats and opportunities
	score += countThreats(state, player) * 10;
	score -= countThreats(state, opp) * 10;

	// Weight center column (more control is good)
	const centerCol = 3;
	for (let row = 0; row < 6; row++) {
		const idx = row * COLS + centerCol;
		if (state.board[idx] === player) {
			score += 2;
		} else if (state.board[idx] === opp) {
			score -= 2;
		}
	}

	return score;
}

/**
 * Count 2s and 3s in a line for a player.
 * A 2 is a sequence of 2 pieces with an open end.
 * A 3 is a sequence of 3 pieces with an open end.
 */
function countThreats(state: GameState, player: number): number {
	let count = 0;
	const board = state.board;

	// Check horizontal
	for (let row = 0; row < 6; row++) {
		for (let col = 0; col < 7; col++) {
			count += countLineThreatsAt(board, row, col, 0, 1, player);
		}
	}

	// Check vertical
	for (let row = 0; row < 6; row++) {
		for (let col = 0; col < 7; col++) {
			count += countLineThreatsAt(board, row, col, 1, 0, player);
		}
	}

	// Check diagonal \
	for (let row = 0; row < 6; row++) {
		for (let col = 0; col < 7; col++) {
			count += countLineThreatsAt(board, row, col, 1, 1, player);
		}
	}

	// Check diagonal /
	for (let row = 0; row < 6; row++) {
		for (let col = 0; col < 7; col++) {
			count += countLineThreatsAt(board, row, col, 1, -1, player);
		}
	}

	return count;
}

/**
 * Count the threat value starting at (row, col) in direction (dr, dc).
 * Returns extra points for 3-in-a-rows and 2-in-a-rows.
 */
function countLineThreatsAt(
	board: (0 | 1 | 2)[],
	row: number,
	col: number,
	dr: number,
	dc: number,
	player: number
): number {
	let consecutive = 0;
	let openEnds = 0;

	// Check backwards
	let r = row - dr;
	let c = col - dc;
	if (r >= 0 && r < 6 && c >= 0 && c < 7) {
		if (board[r * COLS + c] === 0) {
			openEnds++;
		} else if (board[r * COLS + c] !== player) {
			openEnds = -1; // Blocked
		}
	}

	// Count forward
	let r2 = row;
	let c2 = col;
	while (r2 >= 0 && r2 < 6 && c2 >= 0 && c2 < 7 && board[r2 * COLS + c2] === player) {
		consecutive++;
		r2 += dr;
		c2 += dc;
	}

	// Check if forward is open
	if (r2 >= 0 && r2 < 6 && c2 >= 0 && c2 < 7) {
		if (board[r2 * COLS + c2] === 0) {
			openEnds++;
		}
	} else if (r2 < 0 || r2 >= 6 || c2 < 0 || c2 >= 7) {
		// Hit board edge
		openEnds = Math.max(0, openEnds - 1);
	}

	// Only count threats that haven't been counted yet (avoid 4x counting)
	// Score: only count the start of a sequence to avoid duplication
	if (consecutive === 2 && openEnds === 2) {
		return 1;
	} else if (consecutive === 3 && openEnds >= 1) {
		return 10;
	}

	return 0;
}
