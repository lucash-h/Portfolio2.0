import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { applyMove, createGame, fromMoves, legalMoves } from '../games/connect4/engine';
import { CELL_COUNT, COLS } from '../games/connect4/types';
import type { Connect4CheckpointEntry } from './mlTypes';
import {
	chooseMove,
	clearSessionCache,
	encodeBoard,
	getSessionCacheSize,
	predict,
	softmaxMask,
	type SessionDeps
} from './session';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures', 'connect4_synthetic.onnx');

function fixtureCheckpoint(id = 'c4-synthetic'): Connect4CheckpointEntry {
	return {
		id,
		label: 'synthetic test fixture',
		file: 'connect4/does-not-matter.onnx',
		gamesTrained: 0,
		elo: null,
		mctsSims: 1,
		sizeKb: 3
	};
}

/** Fetch stub that always serves the synthetic fixture, regardless of URL. */
function fixtureFetch(): SessionDeps['fetchImpl'] {
	const buffer = readFileSync(FIXTURE_PATH);
	const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
	let calls = 0;
	const fn = async () => {
		calls++;
		return {
			ok: true,
			status: 200,
			arrayBuffer: async () => arrayBuffer
		};
	};
	(fn as unknown as { calls: () => number }).calls = () => calls;
	return fn;
}

function failingFetch(status = 404): SessionDeps['fetchImpl'] {
	return async () => ({
		ok: false,
		status,
		arrayBuffer: async () => {
			throw new Error('should not be called');
		}
	});
}

beforeEach(() => {
	clearSessionCache();
});

describe('encodeBoard', () => {
	it('encodes plane 0 as the discs of the player to move, plane 1 the opponent, with row 0 at the bottom', () => {
		// Moves: col 0 (player 1), col 1 (player 2), col 0 (player 1 again, stacks on row 1).
		const state = fromMoves([0, 1, 0]);
		// Board layout (row 0 = bottom):
		//   row1: [1, 0, 0, 0, 0, 0, 0]
		//   row0: [1, 2, 0, 0, 0, 0, 0]
		// toMove after three plies (1,2,1) is player 2.
		expect(state.toMove).toBe(2);

		const tensor = encodeBoard(state);
		expect(tensor.length).toBe(2 * CELL_COUNT);

		// Plane 1 (opponent = player 1, since player 2 is to move) has discs at
		// bottom-row col 0 (index 0) and row-1 col 0 (index 7).
		const plane0 = tensor.subarray(0, CELL_COUNT);
		const plane1 = tensor.subarray(CELL_COUNT, 2 * CELL_COUNT);

		const expectedPlane1 = new Float32Array(CELL_COUNT);
		expectedPlane1[0] = 1; // row 0, col 0
		expectedPlane1[7] = 1; // row 1, col 0 (row*7+col = 1*7+0)
		expect(plane1).toEqual(expectedPlane1);

		// Plane 0 (player to move = player 2) has a disc at bottom-row col 1 (index 1).
		const expectedPlane0 = new Float32Array(CELL_COUNT);
		expectedPlane0[1] = 1;
		expect(plane0).toEqual(expectedPlane0);
	});

	it('flips which plane is "mine" depending on toMove, not on the fixed player number', () => {
		// After a single move by player 1, player 2 is to move: plane 0 must be
		// empty (player 2 has no discs yet) and plane 1 must hold player 1's disc.
		const afterOneMove = applyMove(createGame(), 3);
		expect(afterOneMove.toMove).toBe(2);
		const tensor = applyMoveTensor(afterOneMove);
		expect(tensor.plane0.some((v) => v !== 0)).toBe(false);
		expect(tensor.plane1[3]).toBe(1); // bottom row, col 3

		// After a second move by player 2, player 1 is to move: plane 0 now
		// holds player 1's original disc.
		const afterTwoMoves = applyMove(afterOneMove, 4);
		expect(afterTwoMoves.toMove).toBe(1);
		const tensor2 = applyMoveTensor(afterTwoMoves);
		expect(tensor2.plane0[3]).toBe(1);
		expect(tensor2.plane1[4]).toBe(1);
	});

	function applyMoveTensor(state: ReturnType<typeof applyMove>) {
		const t = encodeBoard(state);
		return {
			plane0: t.subarray(0, CELL_COUNT),
			plane1: t.subarray(CELL_COUNT, 2 * CELL_COUNT)
		};
	}
});

describe('softmaxMask', () => {
	it('zeroes out full/illegal columns exactly and renormalises the rest to sum to 1', () => {
		const logits = new Float32Array([1, 2, 3, 4, 5, 6, 7]);
		const legal = [0, 2, 4] as const;
		const result = softmaxMask(logits, legal);

		expect(result[1]).toBe(0);
		expect(result[3]).toBe(0);
		expect(result[5]).toBe(0);
		expect(result[6]).toBe(0);

		let sum = 0;
		for (const col of legal) {
			expect(result[col]).toBeGreaterThan(0);
			sum += result[col];
		}
		expect(sum).toBeCloseTo(1, 6);
	});

	it('produces a valid distribution even with extreme logits (numerical stability)', () => {
		const logits = new Float32Array([1000, -1000, 0, 0, 0, 0, 0]);
		const legal = [0, 1, 2] as const;
		const result = softmaxMask(logits, legal);
		expect(Number.isFinite(result[0])).toBe(true);
		expect(result[0]).toBeCloseTo(1, 5);
		let sum = 0;
		for (const col of legal) sum += result[col];
		expect(sum).toBeCloseTo(1, 5);
	});
});

describe('session cache', () => {
	it('loading the same checkpoint id twice creates only one session (one fetch)', async () => {
		const fetchImpl = fixtureFetch();
		const checkpoint = fixtureCheckpoint('cache-test');
		const state = createGame();
		const legal = legalMoves(state);

		expect(getSessionCacheSize()).toBe(0);

		const r1 = await predict(checkpoint, state, legal, { fetchImpl });
		const r2 = await predict(checkpoint, state, legal, { fetchImpl });

		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
		expect(getSessionCacheSize()).toBe(1);
		expect((fetchImpl as unknown as { calls: () => number }).calls()).toBe(1);
	});

	it('different checkpoint ids get distinct cache entries', async () => {
		const fetchImpl = fixtureFetch();
		const state = createGame();
		const legal = legalMoves(state);

		await predict(fixtureCheckpoint('a'), state, legal, { fetchImpl });
		await predict(fixtureCheckpoint('b'), state, legal, { fetchImpl });

		expect(getSessionCacheSize()).toBe(2);
	});
});

describe('failed load / run — graceful degradation', () => {
	it('a failed fetch (404) returns a typed failure result, never throws', async () => {
		const checkpoint = fixtureCheckpoint('missing-model');
		const state = createGame();
		const legal = legalMoves(state);

		const result = await predict(checkpoint, state, legal, { fetchImpl: failingFetch(404) });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('load-failed');
			expect(result.detail).toContain('404');
		}
	});

	it('a fetch that throws returns a typed failure result, never throws', async () => {
		const checkpoint = fixtureCheckpoint('network-error');
		const state = createGame();
		const legal = legalMoves(state);
		const throwingFetch: SessionDeps['fetchImpl'] = async () => {
			throw new Error('network down');
		};

		await expect(
			predict(checkpoint, state, legal, { fetchImpl: throwingFetch })
		).resolves.toMatchObject({ ok: false, reason: 'load-failed' });
	});

	it('malformed model bytes fail session creation with a typed result, not a throw', async () => {
		const checkpoint = fixtureCheckpoint('corrupt-model');
		const state = createGame();
		const legal = legalMoves(state);
		const corruptFetch: SessionDeps['fetchImpl'] = async () => ({
			ok: true,
			status: 200,
			arrayBuffer: async () => new TextEncoder().encode('not an onnx file').buffer
		});

		const result = await predict(checkpoint, state, legal, { fetchImpl: corruptFetch });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('load-failed');
	});

	it('no legal moves returns a typed failure without attempting inference', async () => {
		const checkpoint = fixtureCheckpoint('no-legal');
		const state = createGame();
		const result = await predict(checkpoint, state, [], {});
		expect(result).toEqual({ ok: false, reason: 'no-legal-moves', detail: expect.any(String) });
	});
});

describe('real inference against connect4_synthetic.onnx', () => {
	it('runs end to end and returns valid output shapes and a valid probability distribution', async () => {
		const fetchImpl = fixtureFetch();
		const checkpoint = fixtureCheckpoint('real-inference');
		const state = createGame();
		const legal = legalMoves(state);

		const result = await predict(checkpoint, state, legal, { fetchImpl });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.prediction.policy.length).toBe(COLS);
		expect(typeof result.prediction.value).toBe('number');
		expect(result.prediction.value).toBeGreaterThanOrEqual(-1);
		expect(result.prediction.value).toBeLessThanOrEqual(1);

		let sum = 0;
		for (let col = 0; col < COLS; col++) {
			const p = result.prediction.policy[col];
			expect(p).toBeGreaterThanOrEqual(0);
			if (!legal.includes(col as (typeof legal)[number])) {
				expect(p).toBe(0);
			}
			sum += p;
		}
		expect(sum).toBeCloseTo(1, 5);
	});

	it('greedy chooseMove returns a legal column backed by the same prediction', async () => {
		const fetchImpl = fixtureFetch();
		const checkpoint = fixtureCheckpoint('real-inference-greedy');
		const state = createGame();
		const legal = legalMoves(state);

		const result = await chooseMove(checkpoint, state, legal, { mode: 'greedy' }, { fetchImpl });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(legal).toContain(result.column);
	});

	it('temperature sampling uses the injected RNG deterministically, never Math.random', async () => {
		const fetchImpl = fixtureFetch();
		const checkpoint = fixtureCheckpoint('real-inference-sample');
		const state = createGame();
		const legal = legalMoves(state);

		// A synthetic all-zero-logit model produces a uniform distribution over
		// legal columns, so an rng fixed at 0 must deterministically pick the
		// first legal column both times.
		const rng = () => 0;
		const r1 = await chooseMove(
			checkpoint,
			state,
			legal,
			{ mode: 'sample', temperature: 1, rng },
			{ fetchImpl }
		);
		const r2 = await chooseMove(
			checkpoint,
			state,
			legal,
			{ mode: 'sample', temperature: 1, rng },
			{ fetchImpl }
		);
		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
		if (r1.ok && r2.ok) {
			expect(r1.column).toBe(legal[0]);
			expect(r1.column).toBe(r2.column);
		}
	});
});
