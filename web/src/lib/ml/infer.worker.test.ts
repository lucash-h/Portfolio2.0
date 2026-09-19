import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGame, legalMoves } from '../games/connect4/engine';
import type { Connect4CheckpointEntry, InferRequestMessage, InferResponseMessage } from './mlTypes';
import { clearSessionCache } from './session';

/**
 * infer.worker.ts registers `self.onmessage` at module load time, exactly as
 * a real Vite module worker does. There is no separate "handler" export to
 * import (that would mean inventing an API the worker file doesn't have), so
 * this test drives it the way the real worker runtime would: it stubs
 * `self.fetch`/`self.postMessage`, imports the module (which wires
 * `onmessage`), then dispatches a message the way the browser's worker
 * messaging does.
 *
 * Environment note: jsdom's `self` is the `window` object, not a real
 * `DedicatedWorkerGlobalScope`, so this exercises the worker's message
 * handling logic faithfully but not actual thread isolation — that part is
 * standard Vite/browser plumbing outside this package's code.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures', 'connect4_synthetic.onnx');

function fixtureCheckpoint(id: string): Connect4CheckpointEntry {
	return {
		id,
		label: 'synthetic',
		file: 'connect4/whatever.onnx',
		gamesTrained: 0,
		elo: null,
		mctsSims: 1,
		sizeKb: 3
	};
}

beforeEach(() => {
	clearSessionCache();
	const buffer = readFileSync(FIXTURE_PATH);
	const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({
			ok: true,
			status: 200,
			arrayBuffer: async () => arrayBuffer
		}))
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe('infer.worker', () => {
	it('handles an infer request and posts back a typed infer-result message', async () => {
		const postMessage = vi.fn();
		vi.stubGlobal('postMessage', postMessage);

		await import('./infer.worker');

		const state = createGame();
		const request: InferRequestMessage = {
			type: 'infer',
			id: 42,
			checkpoint: fixtureCheckpoint('worker-test'),
			state,
			legalColumns: legalMoves(state),
			options: { mode: 'greedy' }
		};

		const handler = (self as unknown as { onmessage: (e: MessageEvent<InferRequestMessage>) => Promise<void> })
			.onmessage;
		expect(handler).toBeTypeOf('function');
		await handler(new MessageEvent('message', { data: request }));

		expect(postMessage).toHaveBeenCalledTimes(1);
		const response = postMessage.mock.calls[0][0] as InferResponseMessage;
		expect(response.type).toBe('infer-result');
		expect(response.id).toBe(42);
		expect(response.result.ok).toBe(true);
	});

	it('ignores messages that are not infer requests', async () => {
		const postMessage = vi.fn();
		vi.stubGlobal('postMessage', postMessage);

		await import('./infer.worker');

		const handler = (self as unknown as { onmessage: (e: MessageEvent<unknown>) => Promise<void> }).onmessage;
		await handler(new MessageEvent('message', { data: { type: 'not-infer' } }));

		expect(postMessage).not.toHaveBeenCalled();
	});
});
