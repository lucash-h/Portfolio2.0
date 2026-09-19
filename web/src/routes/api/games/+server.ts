/**
 * POST /api/games — CONTRACTS §7.
 *
 * Fire-and-forget from the client's perspective: the game UI never blocks on
 * this call and never surfaces an error from it. So a database outage, a rate
 * limit, or a malformed body all still resolve quickly and quietly — the only
 * meaningful distinction the client can observe is the HTTP status, which it
 * is not required to check.
 *
 * Hard privacy requirement (CONTRACTS §6): the raw client IP must never reach
 * disk or logs. It is read once via `event.getClientAddress()`, passed straight
 * into `hashClientIp` (which never logs it), and the local variable holding it
 * is not touched again — in particular it never appears in a `console.*` call,
 * including on the catch/error paths below.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isColumn, CELL_COUNT } from '$lib/games/connect4/types';
import type { Column } from '$lib/games/connect4/types';
import {
	countRecentGamesForHash,
	hashClientIp,
	insertGameLog,
	isOverRateLimit,
	type Game,
	type GameLogInput,
	type Outcome
} from '$lib/db/queries';
import { isDbAvailable } from '$lib/db/client';

const GAMES: readonly Game[] = ['connect4', 'racer'];
const OUTCOMES: readonly Outcome[] = ['human_win', 'ai_win', 'draw', 'dnf'];

// Sanity bounds beyond the schema's own constraints — reject absurd inputs
// without pretending to know an exact legal maximum for every future game mode.
const MAX_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_LAP_MS = 60 * 60 * 1000; // 1 hour
const MAX_MOVES = CELL_COUNT; // connect4 board has 42 cells; no game has more moves than that

export type ValidatedGameLog = Omit<GameLogInput, 'clientHash'>;

export type ValidationResult =
	| { ok: true; value: ValidatedGameLog }
	| { ok: false; error: string };

function isFiniteInt(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);
}

/**
 * Validates an untrusted parsed JSON body against the CONTRACTS §7 request
 * shape. Never throws; returns a typed result. Exported for direct unit
 * testing without going through the HTTP layer.
 */
export function _validateGameLogRequest(body: unknown): ValidationResult {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return { ok: false, error: 'body must be a JSON object' };
	}
	const b = body as Record<string, unknown>;

	if (typeof b.game !== 'string' || !GAMES.includes(b.game as Game)) {
		return { ok: false, error: 'game must be one of "connect4", "racer"' };
	}
	const game = b.game as Game;

	if (typeof b.checkpointId !== 'string' || b.checkpointId.length === 0) {
		return { ok: false, error: 'checkpointId must be a non-empty string' };
	}
	const checkpointId = b.checkpointId;

	if (typeof b.outcome !== 'string' || !OUTCOMES.includes(b.outcome as Outcome)) {
		return {
			ok: false,
			error: 'outcome must be one of "human_win", "ai_win", "draw", "dnf"'
		};
	}
	const outcome = b.outcome as Outcome;

	if (!isFiniteInt(b.durationMs) || b.durationMs < 0) {
		return { ok: false, error: 'durationMs must be a non-negative integer' };
	}
	if (b.durationMs > MAX_DURATION_MS) {
		return { ok: false, error: 'durationMs exceeds sane maximum' };
	}
	const durationMs = b.durationMs as number;

	let moves: Column[] | null = null;
	if (game === 'connect4') {
		if (!Array.isArray(b.moves)) {
			return { ok: false, error: 'moves is required and must be an array for connect4' };
		}
		if (b.moves.length > MAX_MOVES) {
			return { ok: false, error: 'moves exceeds the maximum possible for connect4' };
		}
		for (const m of b.moves) {
			if (!isFiniteInt(m) || !isColumn(m)) {
				return { ok: false, error: 'every move must be an integer column 0-6' };
			}
		}
		moves = b.moves as Column[];
	} else {
		if (b.moves !== undefined && b.moves !== null) {
			return { ok: false, error: 'moves must be absent or null for racer' };
		}
	}

	let lapMs: number | null = null;
	if (game === 'racer') {
		if (b.lapMs !== undefined && b.lapMs !== null) {
			if (!isFiniteInt(b.lapMs) || (b.lapMs as number) < 0) {
				return { ok: false, error: 'lapMs must be a non-negative integer or null for racer' };
			}
			if ((b.lapMs as number) > MAX_LAP_MS) {
				return { ok: false, error: 'lapMs exceeds sane maximum' };
			}
			lapMs = b.lapMs as number;
		}
	} else {
		if (b.lapMs !== undefined && b.lapMs !== null) {
			return { ok: false, error: 'lapMs must be absent or null for connect4' };
		}
	}

	return {
		ok: true,
		value: { game, checkpointId, outcome, moves, lapMs, durationMs }
	};
}

export const POST: RequestHandler = async (event) => {
	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
	}

	const validated = _validateGameLogRequest(body);
	if (!validated.ok) {
		return json({ ok: false, error: validated.error }, { status: 400 });
	}

	// Read once; never logged, never stored, never passed anywhere except into
	// the one-way hash below.
	const ip = event.getClientAddress();
	const clientHash = hashClientIp(ip);

	if (!isDbAvailable()) {
		// No database configured (normal in local dev). Nothing to rate-limit or
		// insert against; per the fire-and-forget contract this is a quiet no-op,
		// not an error.
		return json({ ok: true }, { status: 202 });
	}

	try {
		const recentCount = await countRecentGamesForHash(clientHash);
		if (isOverRateLimit(recentCount)) {
			return json({ ok: false, error: 'rate limit exceeded' }, { status: 429 });
		}

		await insertGameLog({ ...validated.value, clientHash });
	} catch (err) {
		// A dropped log must not degrade gameplay or produce a 500 storm. Log a
		// generic, non-identifying message only — never the IP, the hash's input,
		// or anything derived from the request beyond the error message itself.
		console.error('[api/games] insert failed:', err instanceof Error ? err.message : err);
	}

	return json({ ok: true }, { status: 202 });
};
