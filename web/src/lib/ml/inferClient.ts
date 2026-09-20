/**
 * Main-thread client for the Connect 4 inference Web Worker (`infer.worker.ts`).
 *
 * Today, `Connect4Figure.svelte` called `session.chooseMove` directly, which
 * means every bot move — including the very first one, which compiles and
 * instantiates a multi-megabyte WASM module — ran on the UI thread and
 * visibly blocked it. This file owns a single `Worker` instance and moves
 * that work off-thread, while keeping the exact same typed result shape
 * `session.chooseMove` returns, so callers don't need to know which path ran.
 *
 * Two things this handles that the raw worker protocol does not:
 *
 *  1. **Request/response pairing.** `mlTypes.ts`'s `InferRequestMessage` /
 *     `InferResponseMessage` already carry a caller-assigned numeric `id`
 *     (echoed back by `infer.worker.ts`), so concurrent in-flight requests
 *     resolve the correct caller's promise even if the worker replies out of
 *     order.
 *
 *  2. **Fallback.** Workers are unavailable during SSR and can fail to
 *     construct under strict CSP. If a Worker can't be built, or a
 *     previously-working one crashes, this degrades to running
 *     `session.chooseMove` on the caller's own thread — never throws, and
 *     the caller sees the same `ChooseMoveResult` either way, so the
 *     existing "fall back to minimax on failure" logic in `Connect4Figure`
 *     needs no changes.
 */

import type {
	ChooseMoveOptions,
	ChooseMoveResult,
	Column,
	Connect4CheckpointEntry,
	GameState,
	InferRequestMessage,
	InferResponseMessage
} from './mlTypes';

let worker: Worker | null = null;
let workerUnavailable = false;
let nextId = 1;
const pending = new Map<number, (result: ChooseMoveResult) => void>();

function onMessage(event: MessageEvent<InferResponseMessage>): void {
	const data = event.data;
	if (!data || data.type !== 'infer-result') return;
	const resolve = pending.get(data.id);
	if (!resolve) return;
	pending.delete(data.id);
	resolve(data.result);
}

/**
 * The worker process itself died (threw during module init, or crashed
 * outright) rather than a single inference failing. Every request still
 * in flight on it can never get a reply, so fail them all the same typed
 * way `session.chooseMove` would, and drop the worker so the next call
 * builds a fresh one.
 */
function onWorkerError(): void {
	const failure: ChooseMoveResult = {
		ok: false,
		reason: 'load-failed',
		detail: 'inference worker crashed'
	};
	for (const resolve of pending.values()) resolve(failure);
	pending.clear();
	teardownWorker();
}

function teardownWorker(): void {
	if (worker) {
		worker.removeEventListener('message', onMessage);
		worker.removeEventListener('error', onWorkerError);
		worker.terminate();
		worker = null;
	}
}

function getWorker(): Worker | null {
	if (workerUnavailable) return null;
	if (worker) return worker;
	if (typeof Worker === 'undefined') {
		workerUnavailable = true;
		return null;
	}
	try {
		const w = new Worker(new URL('./infer.worker.ts', import.meta.url), { type: 'module' });
		w.addEventListener('message', onMessage);
		w.addEventListener('error', onWorkerError);
		worker = w;
		return w;
	} catch {
		workerUnavailable = true;
		return null;
	}
}

function runInWorker(
	w: Worker,
	checkpoint: Connect4CheckpointEntry,
	state: GameState,
	legalColumns: readonly Column[],
	options: ChooseMoveOptions,
	baseUrl: string | undefined
): Promise<ChooseMoveResult> {
	const id = nextId++;
	return new Promise<ChooseMoveResult>((resolve) => {
		pending.set(id, resolve);
		const message: InferRequestMessage = {
			type: 'infer',
			id,
			checkpoint,
			state,
			legalColumns: [...legalColumns],
			options,
			baseUrl
		};
		w.postMessage(message);
	});
}

/**
 * Chooses a move off the main thread when a Worker is available, falling
 * back to `session.chooseMove` on the caller's own thread otherwise (SSR,
 * strict CSP, or a worker that has already failed once this session). Same
 * typed `ChooseMoveResult` either way. Never throws — a failed worker,
 * failed load, or failed inference all come back as `{ ok: false, ... }` so
 * the caller can fall back to minimax exactly as before.
 */
export async function chooseMoveOffThread(
	checkpoint: Connect4CheckpointEntry,
	state: GameState,
	legalColumns: readonly Column[],
	options: ChooseMoveOptions,
	baseUrl?: string
): Promise<ChooseMoveResult> {
	const w = getWorker();
	if (w) {
		try {
			return await runInWorker(w, checkpoint, state, legalColumns, options, baseUrl);
		} catch {
			// postMessage itself threw (e.g. unstructured-cloneable failure).
			// Fall through to the main-thread path below.
		}
	}
	const { chooseMove } = await import('./session');
	return chooseMove(checkpoint, state, legalColumns, options, baseUrl ? { baseUrl } : {});
}

/**
 * Terminates the worker, if one exists, and resolves every in-flight request
 * with a typed failure rather than leaving it hanging. Call from component
 * teardown so a torn-down panel doesn't keep a worker (and its WASM module)
 * alive.
 */
export function disposeInferWorker(): void {
	const failure: ChooseMoveResult = {
		ok: false,
		reason: 'load-failed',
		detail: 'inference worker disposed'
	};
	for (const resolve of pending.values()) resolve(failure);
	pending.clear();
	teardownWorker();
}

/** Test hook: reset all module-level state so tests don't leak into each other. */
export function resetInferClientForTest(): void {
	disposeInferWorker();
	workerUnavailable = false;
	nextId = 1;
}
