/**
 * Query + logic layer for `game_log` (P3-A).
 *
 * SQL is kept in this file but every function takes its DB access as an
 * injectable dependency (`QueryFn`), defaulting to the real pooled client from
 * `./client`. That split is what lets `*.test.ts` exercise the validation,
 * hashing, rate-limit accounting, and row-shaping logic without a live
 * Postgres — tests pass a fake `QueryFn` that returns canned rows.
 *
 * Privacy (CONTRACTS §6, hard requirement): raw IP addresses must never reach
 * disk or logs. `hashClientIp` is the only place an IP is touched, and it never
 * logs its input; the daily salt lives only in process memory and is never
 * persisted or logged.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { query as defaultQuery } from './client';
import type { Column } from '$lib/games/connect4/types';

export type Game = 'connect4' | 'racer';
export type Outcome = 'human_win' | 'ai_win' | 'draw' | 'dnf';

/** Injectable DB access. The real implementation is `query` from `./client`. */
export type QueryFn = <T extends QueryResultRow = QueryResultRow>(
	text: string,
	params?: unknown[]
) => Promise<T[]>;

const defaultDeps = { query: defaultQuery as QueryFn };

// ---------------------------------------------------------------------------
// client_hash — CONTRACTS §6, the hard privacy requirement.
//
// client_hash = sha256(ip + daily_rotating_salt), truncated to 16 hex chars.
// The salt rotates once per UTC day and lives only in this module's memory —
// it is never written to disk, the database, or any log line. A process
// restart mid-day generates a *new* random salt (acceptable: the contract
// only promises the salt is not persisted and rotates at least daily, not
// that it survives restarts — see report for the tradeoff this implies for
// rate-limit continuity across deploys).
// ---------------------------------------------------------------------------

let cachedSalt: { day: string; salt: string } | null = null;

function currentUtcDayKey(now: Date): string {
	return now.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/** Exposed for tests only, so each test starts from a clean cache. */
export function __clearSaltForTests(): void {
	cachedSalt = null;
}

/**
 * Returns the salt for `now`'s UTC day, generating and caching a fresh random
 * one the first time a given day is seen. `now` is a parameter (not always
 * `new Date()`) so rotation can be tested deterministically without waiting
 * for a real day boundary.
 */
export function getDailySalt(now: Date = new Date()): string {
	const day = currentUtcDayKey(now);
	if (!cachedSalt || cachedSalt.day !== day) {
		// Randomness source only; never derived from anything request-identifying.
		cachedSalt = { day, salt: randomBytes(32).toString('hex') };
	}
	return cachedSalt.salt;
}

/**
 * Hashes a client IP for same-day rate limiting / de-duplication only.
 * Never logs `ip`. `salt` defaults to the process's current daily salt
 * (computed from `now`, which defaults to the real current time); tests pass
 * an explicit salt, or an explicit `now`, to check behaviour deterministically.
 */
export function hashClientIp(ip: string, salt?: string, now: Date = new Date()): string {
	const effectiveSalt = salt ?? getDailySalt(now);
	return createHash('sha256').update(ip + effectiveSalt, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// insertGameLog
// ---------------------------------------------------------------------------

export interface GameLogInput {
	game: Game;
	checkpointId: string;
	outcome: Outcome;
	/** Connect4 move history. Must be null for racer. */
	moves: Column[] | null;
	/** Racer lap time. Must be null for connect4. */
	lapMs: number | null;
	durationMs: number;
	clientHash: string;
}

export async function insertGameLog(
	input: GameLogInput,
	deps: { query: QueryFn } = defaultDeps
): Promise<void> {
	await deps.query(
		`insert into game_log (game, checkpoint_id, outcome, moves, lap_ms, duration_ms, client_hash)
     values ($1, $2, $3, $4, $5, $6, $7)`,
		[
			input.game,
			input.checkpointId,
			input.outcome,
			input.moves === null ? null : JSON.stringify(input.moves),
			input.lapMs,
			input.durationMs,
			input.clientHash
		]
	);
}

// ---------------------------------------------------------------------------
// Rate limiting — 60 games/hour per client_hash (CONTRACTS §7).
// ---------------------------------------------------------------------------

export const RATE_LIMIT_PER_HOUR = 60;

interface CountRow extends QueryResultRow {
	count: string;
}

/** Number of games logged for this hash in the last hour. */
export async function countRecentGamesForHash(
	clientHash: string,
	deps: { query: QueryFn } = defaultDeps
): Promise<number> {
	const rows = await deps.query<CountRow>(
		`select count(*)::text as count from game_log
     where client_hash = $1 and created_at > now() - interval '1 hour'`,
		[clientHash]
	);
	return rows.length > 0 ? Number(rows[0].count) : 0;
}

/** Pure decision, independent of how the count was obtained — easy to unit test. */
export function isOverRateLimit(recentCount: number): boolean {
	return recentCount >= RATE_LIMIT_PER_HOUR;
}

// ---------------------------------------------------------------------------
// getStats — GET /api/stats shape, CONTRACTS §7.
// ---------------------------------------------------------------------------

export interface Connect4CheckpointStats {
	checkpointId: string;
	humanWins: number;
	aiWins: number;
	draws: number;
	elo: number | null;
}

export interface RacerCheckpointStats {
	checkpointId: string;
	humanBestMs: number | null;
	aiBestMs: number | null;
	races: number;
}

export interface StatsResponse {
	totalGames: number;
	connect4: {
		byCheckpoint: Connect4CheckpointStats[];
		openingHeatmap: number[]; // length 7
	};
	racer: {
		byCheckpoint: RacerCheckpointStats[];
	};
}

/** Valid empty-state response — used when there is no data or no database. */
export function emptyStats(): StatsResponse {
	return {
		totalGames: 0,
		connect4: {
			byCheckpoint: [],
			openingHeatmap: [0, 0, 0, 0, 0, 0, 0]
		},
		racer: {
			byCheckpoint: []
		}
	};
}

interface OutcomeCountRow extends QueryResultRow {
	game: Game;
	checkpoint_id: string;
	outcome: Outcome;
	n: string;
}

interface HeatmapRow extends QueryResultRow {
	col: number;
	n: string;
}

interface RacerLapRow extends QueryResultRow {
	checkpoint_id: string;
	best_lap_ms: number | null;
	races: string;
}

interface TotalRow extends QueryResultRow {
	total: string;
}

/**
 * Shapes rows already fetched by SQL into the contract response. Kept
 * separate from the querying so the row -> response mapping can be unit
 * tested with hand-built rows, independent of any real database.
 */
export function shapeStats(
	total: number,
	outcomeCounts: Array<{ game: Game; checkpointId: string; outcome: Outcome; n: number }>,
	heatmapCounts: Array<{ col: number; n: number }>,
	racerLaps: Array<{ checkpointId: string; bestLapMs: number | null; races: number }>
): StatsResponse {
	const connect4ByCheckpoint = new Map<string, Connect4CheckpointStats>();
	for (const row of outcomeCounts) {
		if (row.game !== 'connect4') continue;
		let entry = connect4ByCheckpoint.get(row.checkpointId);
		if (!entry) {
			entry = { checkpointId: row.checkpointId, humanWins: 0, aiWins: 0, draws: 0, elo: null };
			connect4ByCheckpoint.set(row.checkpointId, entry);
		}
		if (row.outcome === 'human_win') entry.humanWins += row.n;
		else if (row.outcome === 'ai_win') entry.aiWins += row.n;
		else if (row.outcome === 'draw') entry.draws += row.n;
		// 'dnf' does not apply to connect4 but is tolerated rather than thrown on.
	}

	const openingHeatmap = [0, 0, 0, 0, 0, 0, 0];
	for (const { col, n } of heatmapCounts) {
		if (Number.isInteger(col) && col >= 0 && col < 7) {
			openingHeatmap[col] += n;
		}
	}

	const racerByCheckpoint = new Map<string, RacerCheckpointStats>();
	for (const row of outcomeCounts) {
		if (row.game !== 'racer') continue;
		if (!racerByCheckpoint.has(row.checkpointId)) {
			racerByCheckpoint.set(row.checkpointId, {
				checkpointId: row.checkpointId,
				humanBestMs: null,
				aiBestMs: null,
				races: 0
			});
		}
	}
	for (const { checkpointId, bestLapMs, races } of racerLaps) {
		let entry = racerByCheckpoint.get(checkpointId);
		if (!entry) {
			entry = { checkpointId, humanBestMs: null, aiBestMs: null, races: 0 };
			racerByCheckpoint.set(checkpointId, entry);
		}
		entry.humanBestMs = bestLapMs;
		entry.races = races;
	}

	// CONTRACTS §7 guarantees both byCheckpoint arrays are ordered weakest-first,
	// matching manifest order, and the dashboard renders them as given without
	// re-sorting. Checkpoint ids are zero-padded ("c4-000001k", "rc-gen0005"), so
	// a lexicographic sort is also the numeric training order.
	//
	// Map insertion order is row arrival order, and a Postgres `group by` gives no
	// ordering guarantee at all, so without this the Elo curve's x-axis would be
	// arbitrary. Sorted here rather than only in SQL so it is testable without a
	// live database.
	const byCheckpointId = (a: { checkpointId: string }, b: { checkpointId: string }) =>
		a.checkpointId.localeCompare(b.checkpointId);

	return {
		totalGames: total,
		connect4: {
			byCheckpoint: Array.from(connect4ByCheckpoint.values()).sort(byCheckpointId),
			openingHeatmap
		},
		racer: {
			byCheckpoint: Array.from(racerByCheckpoint.values()).sort(byCheckpointId)
		}
	};
}

/**
 * Fetches and shapes the full `/api/stats` payload.
 *
 * `aiBestMs` and `elo` are not derivable from `game_log` alone — per CONTRACTS
 * §5 they live on checkpoint entries in `web/static/models/manifest.json`,
 * which this package does not own and does not read. They are left `null`
 * here; a later integration step (or the dashboard package) is expected to
 * merge in manifest data if that cross-reference is wanted. See the report
 * for why this is flagged as ambiguous rather than guessed at.
 */
export async function getStats(deps: { query: QueryFn } = defaultDeps): Promise<StatsResponse> {
	const totalRows = await deps.query<TotalRow>(`select count(*)::text as total from game_log`, []);
	const total = totalRows.length > 0 ? Number(totalRows[0].total) : 0;
	if (total === 0) {
		return emptyStats();
	}

	const outcomeRows = await deps.query<OutcomeCountRow>(
		`select game, checkpoint_id, outcome, count(*)::text as n
     from game_log
     group by game, checkpoint_id, outcome
     order by checkpoint_id`,
		[]
	);

	const heatmapRows = await deps.query<HeatmapRow>(
		`select (moves->>0)::int as col, count(*)::text as n
     from game_log
     where game = 'connect4' and moves is not null and jsonb_array_length(moves) > 0
     group by col`,
		[]
	);

	const racerRows = await deps.query<RacerLapRow>(
		`select checkpoint_id, min(lap_ms) as best_lap_ms, count(*)::text as races
     from game_log
     where game = 'racer'
     group by checkpoint_id
     order by checkpoint_id`,
		[]
	);

	return shapeStats(
		total,
		outcomeRows.map((r) => ({
			game: r.game,
			checkpointId: r.checkpoint_id,
			outcome: r.outcome,
			n: Number(r.n)
		})),
		heatmapRows.map((r) => ({ col: Number(r.col), n: Number(r.n) })),
		racerRows.map((r) => ({
			checkpointId: r.checkpoint_id,
			bestLapMs: r.best_lap_ms === null || r.best_lap_ms === undefined ? null : Number(r.best_lap_ms),
			races: Number(r.races)
		}))
	);
}
