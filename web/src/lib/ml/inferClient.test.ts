import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGame, legalMoves } from '../games/connect4/engine';
import type { ChooseMoveResult, Connect4CheckpointEntry, InferRequestMessage } from './mlTypes';

/**
 * `inferClient.ts` is exercised against a fake `Worker` rather than a real
 * one — jsdom has no Worker implementation, and a real worker would need a
 * real module loader. The fake lets tests control exactly when and in what
 * order responses arrive, which is what the pairing test below needs.
 */

class FakeWorker implements Partial<Worker> {
	static instances: FakeWorker[] = [];
	posted: InferRequestMessage[] = [];
	private listeners: Record<string, ((event: unknown) => void)[]> = {};

	constructor() {
		FakeWorker.instances.push(this);
	}

	postMessage(message: InferRequestMessage): void {
		this.posted.push(message);
	}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		(this.listeners[type] ??= []).push(listener);
	}

	removeEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
	}

	terminate(): void {
		/* no-op */
	}

	/** Test helper: deliver a response for request `id`. */
	respond(id: number, result: ChooseMoveResult): void {
		for (const l of this.listeners.message ?? []) {
			l({ data: { type: 'infer-result', id, result } });
		}
	}

	fireError(): void {
		for (const l of this.listeners.error ?? []) {
			l({});
		}
	}
}

function fixtureCheckpoint(): Connect4CheckpointEntry {
	return {
		id: 'c4-test',
		label: 'test',
		file: 'connect4/whatever.onnx',
		gamesTrained: 0,
		elo: null,
		mctsSims: 1,
		sizeKb: 3
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
	FakeWorker.instances = [];
});

describe('inferClient — Worker unavailable', () => {
	beforeEach(() => {
		vi.stubGlobal('Worker', undefined);
	});

	it('falls back to the main-thread session path when Worker cannot be constructed', async () => {
		const sessionResult: ChooseMoveResult = {
			ok: true,
			column: 3,
			prediction: { policy: new Float32Array(7), value: 0 }
		};
		vi.doMock('./session', () => ({
			chooseMove: vi.fn(async () => sessionResult)
		}));

		const { chooseMoveOffThread } = await import('./inferClient');
		const state = createGame();
		const result = await chooseMoveOffThread(fixtureCheckpoint(), state, legalMoves(state), {
			mode: 'greedy'
		});

		expect(result).toEqual(sessionResult);
	});

	it('never throws even when Worker is undefined and falls back cleanly', async () => {
		vi.doMock('./session', () => ({
			chooseMove: vi.fn(async () => ({ ok: false, reason: 'load-failed', detail: 'nope' }))
		}));
		const { chooseMoveOffThread } = await import('./inferClient');
		const state = createGame();
		await expect(
			chooseMoveOffThread(fixtureCheckpoint(), state, legalMoves(state), { mode: 'greedy' })
		).resolves.toEqual({ ok: false, reason: 'load-failed', detail: 'nope' });
	});
});

describe('inferClient — request/response pairing', () => {
	beforeEach(() => {
		vi.stubGlobal('Worker', FakeWorker);
	});

	it('resolves each concurrent call with its own response, even when replies arrive out of order', async () => {
		const { chooseMoveOffThread } = await import('./inferClient');
		const state = createGame();
		const legal = legalMoves(state);

		const resultA: ChooseMoveResult = {
			ok: true,
			column: legal[0],
			prediction: { policy: new Float32Array(7), value: 1 }
		};
		const resultB: ChooseMoveResult = {
			ok: true,
			column: legal[1] ?? legal[0],
			prediction: { policy: new Float32Array(7), value: -1 }
		};

		const promiseA = chooseMoveOffThread(fixtureCheckpoint(), state, legal, { mode: 'greedy' });
		const promiseB = chooseMoveOffThread(fixtureCheckpoint(), state, legal, { mode: 'greedy' });

		const w = FakeWorker.instances[0];
		expect(w.posted).toHaveLength(2);
		const idA = w.posted[0].id;
		const idB = w.posted[1].id;
        expect(idA).not.toBe(idB);

		// Respond out of order: B's reply arrives before A's.
		w.respond(idB, resultB);
		w.respond(idA, resultA);

		await expect(promiseA).resolves.toEqual(resultA);
		await expect(promiseB).resolves.toEqual(resultB);
	});

	it('reuses a single worker across multiple calls', async () => {
		const { chooseMoveOffThread } = await import('./inferClient');
		const state = createGame();
		const legal = legalMoves(state);

		const p1 = chooseMoveOffThread(fixtureCheckpoint(), state, legal, { mode: 'greedy' });
		FakeWorker.instances[0].respond(FakeWorker.instances[0].posted[0].id, {
			ok: true,
			column: legal[0],
			prediction: { policy: new Float32Array(7), value: 0 }
		});
		await p1;

		const p2 = chooseMoveOffThread(fixtureCheckpoint(), state, legal, { mode: 'greedy' });
		FakeWorker.instances[0].respond(FakeWorker.instances[0].posted[1].id, {
			ok: true,
			column: legal[0],
			prediction: { policy: new Float32Array(7), value: 0 }
		});
		await p2;

		expect(FakeWorker.instances).toHaveLength(1);
	});

	it('fails all in-flight requests and disposes the worker on a worker error', async () => {
		const { chooseMoveOffThread, disposeInferWorker } = await import('./inferClient');
		const state = createGame();
		const legal = legalMoves(state);

		const promise = chooseMoveOffThread(fixtureCheckpoint(), state, legal, { mode: 'greedy' });
		FakeWorker.instances[0].fireError();

		const result = await promise;
		expect(result.ok).toBe(false);

		disposeInferWorker();
	});
});
