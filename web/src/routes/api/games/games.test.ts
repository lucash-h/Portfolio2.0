import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST, _validateGameLogRequest } from './+server';

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

function fakeEvent(body: unknown, ip = '203.0.113.5') {
	return {
		request: {
			json: async () => body
		},
		getClientAddress: () => ip
	} as unknown as Parameters<typeof POST>[0];
}

describe('_validateGameLogRequest — valid payloads', () => {
	it('accepts a valid connect4 payload', () => {
		const result = _validateGameLogRequest({
			game: 'connect4',
			checkpointId: 'c4-000001k',
			outcome: 'ai_win',
			moves: [3, 3, 4],
			durationMs: 48120
		});
		expect(result.ok).toBe(true);
	});

	it('accepts a valid racer payload', () => {
		const result = _validateGameLogRequest({
			game: 'racer',
			checkpointId: 'rc-gen0005',
			outcome: 'human_win',
			lapMs: 44100,
			durationMs: 60000
		});
		expect(result.ok).toBe(true);
	});

	it('accepts racer payload without lapMs (dnf)', () => {
		const result = _validateGameLogRequest({
			game: 'racer',
			checkpointId: 'rc-gen0005',
			outcome: 'dnf',
			durationMs: 5000
		});
		expect(result.ok).toBe(true);
	});
});

describe('_validateGameLogRequest — invalid payloads, every field', () => {
	const base = {
		game: 'connect4',
		checkpointId: 'c4-000001k',
		outcome: 'ai_win',
		moves: [3, 3, 4],
		durationMs: 48120
	};

	it('rejects a non-object body', () => {
		expect(_validateGameLogRequest(null).ok).toBe(false);
		expect(_validateGameLogRequest('nope').ok).toBe(false);
		expect(_validateGameLogRequest([1, 2, 3]).ok).toBe(false);
	});

	it('rejects an unknown game', () => {
		expect(_validateGameLogRequest({ ...base, game: 'chess' }).ok).toBe(false);
	});

	it('rejects a missing/invalid checkpointId', () => {
		expect(_validateGameLogRequest({ ...base, checkpointId: '' }).ok).toBe(false);
		expect(_validateGameLogRequest({ ...base, checkpointId: 42 }).ok).toBe(false);
		const { checkpointId, ...rest } = base;
		expect(_validateGameLogRequest(rest).ok).toBe(false);
	});

	it('rejects a bad outcome', () => {
		expect(_validateGameLogRequest({ ...base, outcome: 'human_loss' }).ok).toBe(false);
		expect(_validateGameLogRequest({ ...base, outcome: 'DRAW' }).ok).toBe(false);
	});

	it('rejects non-integer columns in moves', () => {
		expect(_validateGameLogRequest({ ...base, moves: [3, 3.5, 4] }).ok).toBe(false);
		expect(_validateGameLogRequest({ ...base, moves: [3, '4', 4] }).ok).toBe(false);
	});

	it('rejects out-of-range columns in moves', () => {
		expect(_validateGameLogRequest({ ...base, moves: [3, 7, 4] }).ok).toBe(false);
		expect(_validateGameLogRequest({ ...base, moves: [-1, 3, 4] }).ok).toBe(false);
	});

	it('rejects absurd move counts', () => {
		const tooMany = Array.from({ length: 43 }, () => 0);
		expect(_validateGameLogRequest({ ...base, moves: tooMany }).ok).toBe(false);
	});

	it('requires moves for connect4, forbids them for racer', () => {
		const { moves, ...withoutMoves } = base;
		expect(_validateGameLogRequest(withoutMoves).ok).toBe(false);
		expect(
			_validateGameLogRequest({
				game: 'racer',
				checkpointId: 'rc-gen0005',
				outcome: 'human_win',
				moves: [1, 2],
				durationMs: 1000
			}).ok
		).toBe(false);
	});

	it('rejects lapMs on connect4', () => {
		expect(_validateGameLogRequest({ ...base, lapMs: 1000 }).ok).toBe(false);
	});

	it('rejects a non-integer or negative lapMs on racer', () => {
		expect(
			_validateGameLogRequest({
				game: 'racer',
				checkpointId: 'rc-gen0005',
				outcome: 'human_win',
				lapMs: -5,
				durationMs: 1000
			}).ok
		).toBe(false);
		expect(
			_validateGameLogRequest({
				game: 'racer',
				checkpointId: 'rc-gen0005',
				outcome: 'human_win',
				lapMs: 12.3,
				durationMs: 1000
			}).ok
		).toBe(false);
	});

	it('rejects a missing, non-integer, or negative durationMs', () => {
		const { durationMs, ...withoutDuration } = base;
		expect(_validateGameLogRequest(withoutDuration).ok).toBe(false);
		expect(_validateGameLogRequest({ ...base, durationMs: -1 }).ok).toBe(false);
		expect(_validateGameLogRequest({ ...base, durationMs: 12.5 }).ok).toBe(false);
		expect(_validateGameLogRequest({ ...base, durationMs: 'fast' }).ok).toBe(false);
	});

	it('rejects an absurd durationMs', () => {
		expect(_validateGameLogRequest({ ...base, durationMs: 999_999_999_999 }).ok).toBe(false);
	});
});

describe('POST /api/games — HTTP layer, no database configured', () => {
	beforeEach(() => {
		delete process.env.DATABASE_URL;
	});

	afterEach(() => {
		if (ORIGINAL_DATABASE_URL === undefined) {
			delete process.env.DATABASE_URL;
		} else {
			process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
		}
	});

	it('returns 202 { ok: true } for a valid payload even with no database', async () => {
		const res = await POST(
			fakeEvent({
				game: 'connect4',
				checkpointId: 'c4-000001k',
				outcome: 'ai_win',
				moves: [3, 3, 4],
				durationMs: 48120
			})
		);
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ ok: true });
	});

	it('returns 400 for an invalid payload', async () => {
		const res = await POST(fakeEvent({ game: 'chess' }));
		expect(res.status).toBe(400);
	});

	it('returns 400 for unparseable JSON', async () => {
		const res = await POST({
			request: { json: async () => { throw new SyntaxError('bad json'); } },
			getClientAddress: () => '203.0.113.5'
		} as unknown as Parameters<typeof POST>[0]);
		expect(res.status).toBe(400);
	});

	it('never touches getClientAddress result in the response body', async () => {
		const ip = '198.51.100.42';
		const res = await POST(
			fakeEvent(
				{
					game: 'racer',
					checkpointId: 'rc-gen0005',
					outcome: 'dnf',
					durationMs: 1000
				},
				ip
			)
		);
		const text = JSON.stringify(await res.json());
		expect(text.includes(ip)).toBe(false);
	});
});
