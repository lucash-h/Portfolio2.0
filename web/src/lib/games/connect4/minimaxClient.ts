/**
 * Main-thread client for the minimax Web Worker.
 *
 * Integration glue owned by the orchestrator: it joins P1-C (the search) to the
 * board component without either side depending on the other.
 *
 * Two things this handles that the raw worker does not:
 *
 *  1. **Serialisation.** The worker protocol carries no request id, so two
 *     in-flight requests would be indistinguishable. Turn order means that
 *     should never happen, but a stray double-call would otherwise resolve the
 *     wrong promise and desync the board. Requests are queued instead.
 *
 *  2. **Fallback.** Workers are unavailable during SSR and can fail to
 *     construct under strict CSP or in older browsers. Rather than breaking the
 *     exhibit, fall back to running the search synchronously on the main
 *     thread. It blocks briefly at higher depths, which is strictly better than
 *     a board that does not respond.
 */

import { chooseMove, type MinimaxOptions } from './minimax';
import { legalMoves } from './engine';
import type { Column, GameState } from './types';

interface WorkerSuccess {
	column: Column;
}
interface WorkerFailure {
	error: string;
}
type WorkerReply = WorkerSuccess | WorkerFailure;

let worker: Worker | null = null;
let workerUnavailable = false;
/** Tail of the request queue; each call chains onto the previous one. */
let queue: Promise<unknown> = Promise.resolve();

function getWorker(): Worker | null {
	if (workerUnavailable) return null;
	if (worker) return worker;
	if (typeof Worker === 'undefined') {
		workerUnavailable = true;
		return null;
	}
	try {
		worker = new Worker(new URL('./minimax.worker.ts', import.meta.url), { type: 'module' });
		return worker;
	} catch {
		workerUnavailable = true;
		return null;
	}
}

function runInWorker(w: Worker, state: GameState, options: MinimaxOptions): Promise<Column> {
	return new Promise<Column>((resolve, reject) => {
		const onMessage = (event: MessageEvent<WorkerReply>) => {
			cleanup();
			const data = event.data;
			if ('error' in data) reject(new Error(data.error));
			else resolve(data.column);
		};
		const onError = (event: ErrorEvent) => {
			cleanup();
			reject(new Error(event.message || 'minimax worker failed'));
		};
		function cleanup() {
			w.removeEventListener('message', onMessage);
			w.removeEventListener('error', onError);
		}
		w.addEventListener('message', onMessage);
		w.addEventListener('error', onError);
		w.postMessage({ state, options });
	});
}

/**
 * Choose a move for the given state, off the main thread when possible.
 *
 * Never rejects: any failure degrades to the synchronous search, and then to a
 * legal move, because a thrown error here would leave the board waiting forever.
 */
export async function chooseMoveAsync(
	state: GameState,
	options: MinimaxOptions = {}
): Promise<Column> {
	const run = async (): Promise<Column> => {
		const w = getWorker();
		if (w) {
			try {
				return await runInWorker(w, state, options);
			} catch {
				// Worker died or errored — stop using it and fall through.
				workerUnavailable = true;
				worker = null;
			}
		}
		try {
			return chooseMove(state, options);
		} catch {
			const legal = legalMoves(state);
			if (legal.length === 0) throw new Error('no legal moves available');
			return legal[0];
		}
	};

	const result = queue.then(run, run);
	// Keep the chain alive regardless of outcome, without unhandled rejections.
	queue = result.catch(() => undefined);
	return result;
}

/** Release the worker. Call on teardown; a new one is created on next use. */
export function disposeMinimaxWorker(): void {
	worker?.terminate();
	worker = null;
	workerUnavailable = false;
}
