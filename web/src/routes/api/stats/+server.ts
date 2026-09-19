/**
 * GET /api/stats — CONTRACTS §7. Cached 60s; must return a valid empty-state
 * response when there is no data or no database at all, so the dashboard
 * renders on a fresh install.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { emptyStats, getStats, type StatsResponse } from '$lib/db/queries';
import { isDbAvailable } from '$lib/db/client';

const CACHE_MS = 60_000;

let cache: { value: StatsResponse; fetchedAt: number } | null = null;

/** Exposed for tests only, so each test starts from a clean cache. */
export function __resetCacheForTests(): void {
	cache = null;
}

async function getCachedStats(): Promise<StatsResponse> {
	const now = Date.now();
	if (cache && now - cache.fetchedAt < CACHE_MS) {
		return cache.value;
	}

	if (!isDbAvailable()) {
		const value = emptyStats();
		cache = { value, fetchedAt: now };
		return value;
	}

	try {
		const value = await getStats();
		cache = { value, fetchedAt: now };
		return value;
	} catch (err) {
		// A stats read failing must not 500 the dashboard; fall back to the
		// empty-state shape. Log a generic message only.
		console.error('[api/stats] query failed:', err instanceof Error ? err.message : err);
		const value = emptyStats();
		cache = { value, fetchedAt: now };
		return value;
	}
}

export const GET: RequestHandler = async () => {
	const stats = await getCachedStats();
	return json(stats, {
		headers: { 'cache-control': 'public, max-age=60' }
	});
};
