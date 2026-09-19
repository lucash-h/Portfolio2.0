import { describe, expect, it, beforeEach } from 'vitest';
import {
	__clearSaltForTests,
	RATE_LIMIT_PER_HOUR,
	countRecentGamesForHash,
	emptyStats,
	getStats,
	hashClientIp,
	insertGameLog,
	isOverRateLimit,
	shapeStats,
	type QueryFn
} from './queries';

describe('hashClientIp', () => {
	beforeEach(() => {
		__clearSaltForTests();
	});

	it('is deterministic for the same ip + salt', () => {
		const a = hashClientIp('203.0.113.5', 'salt-a');
		const b = hashClientIp('203.0.113.5', 'salt-a');
		expect(a).toBe(b);
	});

	it('differs when the salt differs', () => {
		const a = hashClientIp('203.0.113.5', 'salt-a');
		const b = hashClientIp('203.0.113.5', 'salt-b');
		expect(a).not.toBe(b);
	});

	it('differs when the ip differs, same salt', () => {
		const a = hashClientIp('203.0.113.5', 'salt-a');
		const b = hashClientIp('198.51.100.9', 'salt-a');
		expect(a).not.toBe(b);
	});

	it('is exactly 16 lowercase hex chars', () => {
		const h = hashClientIp('203.0.113.5', 'salt-a');
		expect(h).toMatch(/^[0-9a-f]{16}$/);
	});

	it('never includes the raw ip as a substring of the output', () => {
		const ip = '203.0.113.5';
		const h = hashClientIp(ip, 'some-salt');
		expect(h.includes(ip)).toBe(false);
		expect(h.includes(Buffer.from(ip).toString('hex'))).toBe(false);
	});

	it('uses the same generated daily salt for the same UTC day, and a different one the next day', () => {
		const morning = new Date('2026-01-01T00:00:01Z');
		const evening = new Date('2026-01-01T23:59:00Z');
		const nextDay = new Date('2026-01-02T00:00:01Z');

		const day1 = hashClientIp('203.0.113.5', undefined, morning);
		const day1Again = hashClientIp('203.0.113.5', undefined, evening);
		expect(day1).toBe(day1Again);

		const day2 = hashClientIp('203.0.113.5', undefined, nextDay);
		expect(day2).not.toBe(day1);
	});
});

describe('rate limiting', () => {
	it('allows up to RATE_LIMIT_PER_HOUR, rejects at RATE_LIMIT_PER_HOUR', () => {
		expect(isOverRateLimit(RATE_LIMIT_PER_HOUR - 1)).toBe(false);
		expect(isOverRateLimit(RATE_LIMIT_PER_HOUR)).toBe(true);
		expect(isOverRateLimit(RATE_LIMIT_PER_HOUR + 1)).toBe(true);
	});

	it('counts via a parameterised query scoped to the given hash', async () => {
		const calls: Array<{ text: string; params: unknown[] }> = [];
		const fakeQuery: QueryFn = async (text, params = []) => {
			calls.push({ text, params });
			const hash = params[0];
			const counts: Record<string, string> = { 'hash-a': '60', 'hash-b': '3' };
			return [{ count: counts[hash as string] ?? '0' }] as never;
		};

		const countA = await countRecentGamesForHash('hash-a', { query: fakeQuery });
		const countB = await countRecentGamesForHash('hash-b', { query: fakeQuery });

		expect(countA).toBe(60);
		expect(countB).toBe(3);
		expect(isOverRateLimit(countA)).toBe(true);
		expect(isOverRateLimit(countB)).toBe(false);

		// Each call is parameterised — the hash travels as a bound parameter, not
		// interpolated into the SQL text.
		for (const call of calls) {
			expect(call.text).not.toContain('hash-a');
			expect(call.text).not.toContain('hash-b');
			expect(call.text.toLowerCase()).toContain('$1');
		}
	});

	it('returns 0 when the query returns no rows', async () => {
		const fakeQuery: QueryFn = async () => [];
		const count = await countRecentGamesForHash('hash-x', { query: fakeQuery });
		expect(count).toBe(0);
	});
});

describe('insertGameLog', () => {
	it('parameterises all fields; never interpolates values into the SQL text', async () => {
		let capturedText = '';
		let capturedParams: unknown[] = [];
		const fakeQuery: QueryFn = async (text, params = []) => {
			capturedText = text;
			capturedParams = params;
			return [];
		};

		await insertGameLog(
			{
				game: 'connect4',
				checkpointId: 'c4-000001k',
				outcome: 'ai_win',
				moves: [3, 3, 4],
				lapMs: null,
				durationMs: 48120,
				clientHash: 'abcdef0123456789'
			},
			{ query: fakeQuery }
		);

		expect(capturedText.toLowerCase()).toContain('insert into game_log');
		expect(capturedText).not.toContain('c4-000001k');
		expect(capturedText).not.toContain('abcdef0123456789');
		expect(capturedParams).toEqual([
			'connect4',
			'c4-000001k',
			'ai_win',
			JSON.stringify([3, 3, 4]),
			null,
			48120,
			'abcdef0123456789'
		]);
	});

	it('serialises moves as JSON and passes null through for racer', async () => {
		let capturedParams: unknown[] = [];
		const fakeQuery: QueryFn = async (_text, params = []) => {
			capturedParams = params;
			return [];
		};

		await insertGameLog(
			{
				game: 'racer',
				checkpointId: 'rc-gen0005',
				outcome: 'human_win',
				moves: null,
				lapMs: 44100,
				durationMs: 60000,
				clientHash: 'abcdef0123456789'
			},
			{ query: fakeQuery }
		);

		expect(capturedParams[3]).toBeNull();
		expect(capturedParams[4]).toBe(44100);
	});
});

describe('stats shaping', () => {
	it('emptyStats matches the contract empty-state shape', () => {
		expect(emptyStats()).toEqual({
			totalGames: 0,
			connect4: { byCheckpoint: [], openingHeatmap: [0, 0, 0, 0, 0, 0, 0] },
			racer: { byCheckpoint: [] }
		});
	});

	it('shapeStats aggregates outcome counts per checkpoint', () => {
		const result = shapeStats(
			55,
			[
				{ game: 'connect4', checkpointId: 'c4-000001k', outcome: 'human_win', n: 40 },
				{ game: 'connect4', checkpointId: 'c4-000001k', outcome: 'ai_win', n: 12 },
				{ game: 'connect4', checkpointId: 'c4-000001k', outcome: 'draw', n: 3 },
				{ game: 'racer', checkpointId: 'rc-gen0005', outcome: 'human_win', n: 100 },
				{ game: 'racer', checkpointId: 'rc-gen0005', outcome: 'ai_win', n: 112 }
			],
			[
				{ col: 0, n: 1204 },
				{ col: 3, n: 3100 }
			],
			[{ checkpointId: 'rc-gen0005', bestLapMs: 44100, races: 212 }]
		);

		expect(result.totalGames).toBe(55);
		expect(result.connect4.byCheckpoint).toEqual([
			{ checkpointId: 'c4-000001k', humanWins: 40, aiWins: 12, draws: 3, elo: null }
		]);
		expect(result.connect4.openingHeatmap).toEqual([1204, 0, 0, 3100, 0, 0, 0]);
		expect(result.racer.byCheckpoint).toEqual([
			{ checkpointId: 'rc-gen0005', humanBestMs: 44100, aiBestMs: null, races: 212 }
		]);
	});

	it('ignores out-of-range heatmap columns rather than throwing', () => {
		const result = shapeStats(1, [], [{ col: 99, n: 5 }], []);
		expect(result.connect4.openingHeatmap).toEqual([0, 0, 0, 0, 0, 0, 0]);
	});

	it('getStats returns the empty shape when total count is 0, without further queries', async () => {
		let calls = 0;
		const fakeQuery: QueryFn = async (_text, _params) => {
			calls += 1;
			return [{ total: '0' }] as never;
		};
		const result = await getStats({ query: fakeQuery });
		expect(result).toEqual(emptyStats());
		expect(calls).toBe(1);
	});

	it('getStats shapes real-looking rows end to end', async () => {
		const fakeQuery: QueryFn = async (text) => {
			if (text.includes('count(*)::text as total')) {
				return [{ total: '3' }] as never;
			}
			if (text.includes('group by game, checkpoint_id, outcome')) {
				return [
					{ game: 'connect4', checkpoint_id: 'c4-000001k', outcome: 'human_win', n: '3' }
				] as never;
			}
			if (text.includes('jsonb_array_length')) {
				return [{ col: '3', n: '2' }] as never;
			}
			if (text.includes("game = 'racer'")) {
				return [] as never;
			}
			throw new Error(`unexpected query: ${text}`);
		};

		const result = await getStats({ query: fakeQuery });
		expect(result.totalGames).toBe(3);
		expect(result.connect4.byCheckpoint).toEqual([
			{ checkpointId: 'c4-000001k', humanWins: 3, aiWins: 0, draws: 0, elo: null }
		]);
		expect(result.connect4.openingHeatmap).toEqual([0, 0, 0, 2, 0, 0, 0]);
		expect(result.racer.byCheckpoint).toEqual([]);
	});
});
