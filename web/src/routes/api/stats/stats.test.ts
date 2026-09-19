import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET, __resetCacheForTests } from './+server';

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

describe('GET /api/stats — no database configured', () => {
	beforeEach(() => {
		delete process.env.DATABASE_URL;
		__resetCacheForTests();
	});

	afterEach(() => {
		if (ORIGINAL_DATABASE_URL === undefined) {
			delete process.env.DATABASE_URL;
		} else {
			process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
		}
		__resetCacheForTests();
	});

	it('returns a valid empty-state response, not an error, on a fresh install', async () => {
		const res = await GET({} as unknown as Parameters<typeof GET>[0]);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({
			totalGames: 0,
			connect4: { byCheckpoint: [], openingHeatmap: [0, 0, 0, 0, 0, 0, 0] },
			racer: { byCheckpoint: [] }
		});
	});

	it('sets a 60s cache-control header', async () => {
		const res = await GET({} as unknown as Parameters<typeof GET>[0]);
		expect(res.headers.get('cache-control')).toContain('max-age=60');
	});
});
