/**
 * Pooled Postgres client (P3-A).
 *
 * `DATABASE_URL` is absent in local dev today — that is the normal state, not an
 * error. This module must not throw at import time in that case; the rest of the
 * site (and every route that does not touch the database) has to keep serving.
 *
 * We only ever construct a `Pool` lazily, on first real use, and only when a
 * connection string is configured. `isDbAvailable()` lets callers check first so
 * they can degrade quietly instead of triggering a connection attempt that will
 * only fail.
 */

import { Pool, type QueryResultRow } from 'pg';

/** Thrown by `query()` when no `DATABASE_URL` is configured. Callers that want a
 *  quiet failure (per CONTRACTS §7 — a dropped log must not degrade gameplay)
 *  should check `isDbAvailable()` first, or catch this specifically. */
export class DbUnavailableError extends Error {
	constructor() {
		super('DATABASE_URL is not configured; database is unavailable');
		this.name = 'DbUnavailableError';
	}
}

let pool: Pool | null = null;
let poolInitAttempted = false;

/**
 * Lazily creates the pool from `process.env.DATABASE_URL`. Reads the env var at
 * call time (not module load time) so tests can toggle it without re-importing.
 */
function getPool(): Pool | null {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		pool = null;
		poolInitAttempted = false;
		return null;
	}
	if (pool && poolInitAttempted) {
		return pool;
	}
	pool = new Pool({ connectionString, max: 10 });
	poolInitAttempted = true;
	// A pool-level error (e.g. a connection dropped while idle) must not crash the
	// process, and must never include request-identifying data. `err.message` from
	// `pg` is a driver/network message; it does not contain client IPs or salts.
	pool.on('error', (err) => {
		console.error('[db] pool error:', err.message);
	});
	return pool;
}

/** True when a `DATABASE_URL` is configured. Does not verify connectivity. */
export function isDbAvailable(): boolean {
	return getPool() !== null;
}

/**
 * Typed query helper. Always parameterised — callers must never string-interpolate
 * user input into `text`. Throws `DbUnavailableError` when there is no database
 * configured; callers on the fire-and-forget path should catch this and stay quiet.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
	text: string,
	params: unknown[] = []
): Promise<T[]> {
	const p = getPool();
	if (!p) {
		throw new DbUnavailableError();
	}
	const result = await p.query<T>(text, params);
	return result.rows;
}

/** Test-only: forces the next `getPool()`/`query()` call to re-read the env var. */
export function __resetForTests(): void {
	pool = null;
	poolInitAttempted = false;
}
