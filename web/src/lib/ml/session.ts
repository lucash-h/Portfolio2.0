/**
 * Browser ML runtime core (P2-D).
 *
 * Board encoding, ONNX Runtime Web session caching, policy post-processing
 * (softmax + illegal-move masking), and move selection (greedy / temperature
 * sampling). Every entry point returns a typed result — nothing here throws
 * into the UI. A failed load or a throwing inference is reported as an
 * `ok: false` result so the caller can fall back to minimax.
 *
 * CONTRACTS §3 recap:
 *  - input `board`  [1,2,6,7] float32, plane 0 = discs of the player to move,
 *    plane 1 = opponent discs, row 0 is the bottom row.
 *  - output `policy` [1,7] float32 logits, NOT softmaxed by the network.
 *  - output `value`  [1,1] float32 in [-1, 1].
 *  - illegal columns are masked by the caller after softmax, not by the net.
 */

// Type-only import: erased at build time, so it pulls no runtime code.
import type * as ortTypes from 'onnxruntime-web';

/**
 * onnxruntime-web is ~400 KB of JavaScript and then fetches a multi-megabyte
 * WASM binary on first session creation. The front page is the site's landing
 * page and most visitors will never select a trained checkpoint, so the runtime
 * is loaded on first actual use rather than on import.
 *
 * The promise is cached, so concurrent callers share one module load.
 *
 * Importing the `/wasm` subpath (rather than the package root) selects the
 * plain SIMD WASM build (`ort-wasm-simd-threaded.wasm`, ~13.6 MB) instead of
 * the default JSEP build (`ort-wasm-simd-threaded.jsep.wasm`, ~27 MB), which
 * carries WebGPU support this 88,600-parameter CNN never uses. Verified by
 * grepping the built bundles: `ort.bundle.min.mjs` (the package root's
 * default export) references only the `.jsep.wasm` filename, while
 * `ort.wasm.bundle.min.mjs` (what `/wasm` resolves to) references only the
 * plain `.wasm` filename — confirmed against the actual built output in
 * `build/client` (see the PR/task notes for the before/after sizes observed).
 */
let ortPromise: Promise<typeof ortTypes> | null = null;
function loadOrt(): Promise<typeof ortTypes> {
	ortPromise ??= import('onnxruntime-web/wasm').then((ort) => {
		// Threaded WASM needs cross-origin-isolation (COOP/COEP) headers this
		// site does not send, so onnxruntime-web would silently fall back to
		// a single thread after trying to spin up a thread pool anyway.
		// Pin it explicitly so there's no pointless spin-up attempt.
		ort.env.wasm.numThreads = 1;
		return ort;
	});
	return ortPromise;
}
import { CELL_COUNT, COLS, opponent, type Column, type GameState } from '../games/connect4/types';
import {
	CONNECT4_BOARD_SHAPE,
	type Connect4CheckpointEntry,
	type Connect4Prediction,
	type ChooseMoveOptions,
	type ChooseMoveResult,
	type InferenceResult,
	type MlFailureReason
} from './mlTypes';

export const DEFAULT_MODEL_BASE_URL = '/models/';

/** Minimal surface of `fetch` this module needs, so tests can inject a stub. */
type FetchLike = (input: string) => Promise<{
	ok: boolean;
	status: number;
	arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface SessionDeps {
	/** Defaults to the ambient `fetch`. Injectable for tests / non-browser hosts. */
	fetchImpl?: FetchLike;
	/** Defaults to `/models/`. */
	baseUrl?: string;
}

type LoadFailure = { ok: false; reason: MlFailureReason; detail: string };
type LoadResult = { ok: true; session: ortTypes.InferenceSession } | LoadFailure;

// ---------------------------------------------------------------------------
// Session cache — one InferenceSession per checkpoint id.
// ---------------------------------------------------------------------------

const sessionCache = new Map<string, ortTypes.InferenceSession>();

/** Test/debug hook: forces every checkpoint to be reloaded from scratch. */
export function clearSessionCache(): void {
	sessionCache.clear();
}

/** Test/debug hook: how many distinct checkpoints currently have a live session. */
export function getSessionCacheSize(): number {
	return sessionCache.size;
}

async function loadCheckpointSession(
	checkpoint: Connect4CheckpointEntry,
	deps: SessionDeps = {}
): Promise<LoadResult> {
	const cached = sessionCache.get(checkpoint.id);
	if (cached) return { ok: true, session: cached };

	const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
	const baseUrl = deps.baseUrl ?? DEFAULT_MODEL_BASE_URL;
	const url = `${baseUrl}${checkpoint.file}`;

	let buffer: ArrayBuffer;
	try {
		const response = await fetchImpl(url);
		if (!response.ok) {
			return {
				ok: false,
				reason: 'load-failed',
				detail: `HTTP ${response.status} fetching ${url}`
			};
		}
		buffer = await response.arrayBuffer();
	} catch (err) {
		return { ok: false, reason: 'load-failed', detail: `fetch failed: ${describeError(err)}` };
	}

	try {
		const ort = await loadOrt();
		const session = await ort.InferenceSession.create(new Uint8Array(buffer));
		sessionCache.set(checkpoint.id, session);
		return { ok: true, session };
	} catch (err) {
		return {
			ok: false,
			reason: 'load-failed',
			detail: `InferenceSession.create failed: ${describeError(err)}`
		};
	}
}

// ---------------------------------------------------------------------------
// Board encoding — CONTRACTS §3.
// ---------------------------------------------------------------------------

/**
 * Encodes a GameState into the exact `[1,2,6,7]` float32 tensor layout the
 * network expects: plane 0 is the discs of the player TO MOVE (never a fixed
 * player number), plane 1 the opponent's. `board`'s existing `index = row *
 * COLS + col` layout already matches the tensor's row-major H*W layout with
 * row 0 as the bottom row, so no row-flipping is needed — only plane
 * selection by perspective.
 */
export function encodeBoard(state: GameState): Float32Array {
	const tensor = new Float32Array(2 * CELL_COUNT);
	const toMove = state.toMove;
	const opp = opponent(toMove);

	for (let i = 0; i < state.board.length; i++) {
		const cell = state.board[i];
		if (cell === toMove) {
			tensor[i] = 1;
		} else if (cell === opp) {
			tensor[CELL_COUNT + i] = 1;
		}
	}

	return tensor;
}

// ---------------------------------------------------------------------------
// Policy post-processing — softmax, illegal-move mask, renormalise.
// ---------------------------------------------------------------------------

/**
 * Softmaxes raw policy logits, zeroes out illegal columns exactly, and
 * renormalises the remaining probabilities to sum to 1. If no columns are
 * legal, returns an all-zero array (callers must check for no-legal-moves
 * before this point; CONTRACTS has no defined behaviour for that case here).
 */
export function softmaxMask(
	logits: ArrayLike<number>,
	legalColumns: readonly Column[]
): Float32Array {
	const out = new Float32Array(COLS);
	if (legalColumns.length === 0) return out;

	let max = -Infinity;
	for (let i = 0; i < logits.length; i++) {
		if (logits[i] > max) max = logits[i];
	}

	const exp = new Float64Array(COLS);
	let sum = 0;
	for (let i = 0; i < COLS; i++) {
		exp[i] = Math.exp(logits[i] - max);
		sum += exp[i];
	}

	const legalSet = new Set<number>(legalColumns);
	let legalSum = 0;
	for (let i = 0; i < COLS; i++) {
		if (legalSet.has(i)) {
			const p = exp[i] / sum;
			out[i] = p;
			legalSum += p;
		}
	}

	if (legalSum > 0) {
		for (let i = 0; i < COLS; i++) {
			if (legalSet.has(i)) out[i] = out[i] / legalSum;
		}
	}

	return out;
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

async function runRaw(
	checkpoint: Connect4CheckpointEntry,
	state: GameState,
	deps: SessionDeps
): Promise<{ ok: true; policyLogits: Float32Array; value: number } | LoadFailure> {
	const loaded = await loadCheckpointSession(checkpoint, deps);
	if (!loaded.ok) return loaded;

	const board = encodeBoard(state);
	const ort = await loadOrt();
	const inputTensor = new ort.Tensor('float32', board, CONNECT4_BOARD_SHAPE as readonly number[]);

	let outputs: ortTypes.InferenceSession.OnnxValueMapType;
	try {
		outputs = await loaded.session.run({ board: inputTensor });
	} catch (err) {
		return { ok: false, reason: 'run-failed', detail: `session.run failed: ${describeError(err)}` };
	}

	const policy = outputs.policy;
	const value = outputs.value;
	if (!policy || !value) {
		return {
			ok: false,
			reason: 'run-failed',
			detail: `missing expected output(s); got [${Object.keys(outputs).join(', ')}]`
		};
	}

	const policyData = policy.data as Float32Array | number[];
	const valueData = value.data as Float32Array | number[];
	if (policyData.length !== COLS || valueData.length !== 1) {
		return {
			ok: false,
			reason: 'run-failed',
			detail: `unexpected output shape: policy len=${policyData.length}, value len=${valueData.length}`
		};
	}

	return {
		ok: true,
		policyLogits: Float32Array.from(policyData),
		value: Number(valueData[0])
	};
}

/**
 * Runs inference and returns the fully post-processed prediction (softmaxed,
 * illegal columns masked to exactly 0, legal columns renormalised to sum to
 * 1). Never throws; a failed load or a throwing run is an `ok: false` result.
 */
export async function predict(
	checkpoint: Connect4CheckpointEntry,
	state: GameState,
	legalColumns: readonly Column[],
	deps: SessionDeps = {}
): Promise<InferenceResult> {
	if (legalColumns.length === 0) {
		return { ok: false, reason: 'no-legal-moves', detail: 'no legal columns to predict over' };
	}

	const raw = await runRaw(checkpoint, state, deps);
	if (!raw.ok) return raw;

	const policy = softmaxMask(raw.policyLogits, legalColumns);
	const prediction: Connect4Prediction = { policy, value: raw.value };
	return { ok: true, prediction };
}

// ---------------------------------------------------------------------------
// Move selection
// ---------------------------------------------------------------------------

function argmaxColumn(policy: Float32Array, legalColumns: readonly Column[]): Column {
	let best: Column = legalColumns[0];
	let bestP = -Infinity;
	for (const col of legalColumns) {
		if (policy[col] > bestP) {
			bestP = policy[col];
			best = col;
		}
	}
	return best;
}

/**
 * Samples a column from `policy` restricted to `legalColumns`, using the
 * injected `rng` (must return a value in [0, 1)). Falls back to the last
 * legal column on floating-point edge cases so it always returns a legal
 * move rather than undefined.
 */
function sampleColumn(policy: Float32Array, legalColumns: readonly Column[], rng: () => number): Column {
	const r = rng();
	let acc = 0;
	for (const col of legalColumns) {
		acc += policy[col];
		if (r < acc) return col;
	}
	return legalColumns[legalColumns.length - 1];
}

/**
 * Applies temperature to logits before softmax+mask: `logits / temperature`.
 * temperature -> 0 sharpens toward argmax; temperature = 1 leaves logits
 * unchanged; temperature > 1 flattens the distribution.
 */
function applyTemperature(logits: Float32Array, temperature: number): Float32Array {
	if (temperature === 1) return logits;
	const t = Math.max(temperature, 1e-6);
	const out = new Float32Array(logits.length);
	for (let i = 0; i < logits.length; i++) out[i] = logits[i] / t;
	return out;
}

/**
 * Full move-selection pipeline: load (or reuse) the checkpoint's session,
 * run inference, post-process the policy, and pick a column. Never throws.
 * `legalColumns` is supplied by the caller (mirrors the worker message
 * protocol in mlTypes.ts) rather than recomputed here.
 */
export async function chooseMove(
	checkpoint: Connect4CheckpointEntry,
	state: GameState,
	legalColumns: readonly Column[],
	options: ChooseMoveOptions,
	deps: SessionDeps = {}
): Promise<ChooseMoveResult> {
	if (legalColumns.length === 0) {
		return { ok: false, reason: 'no-legal-moves', detail: 'no legal columns to choose from' };
	}

	const raw = await runRaw(checkpoint, state, deps);
	if (!raw.ok) return raw;

	const logits =
		options.mode === 'sample' ? applyTemperature(raw.policyLogits, options.temperature) : raw.policyLogits;
	const policy = softmaxMask(logits, legalColumns);
	const prediction: Connect4Prediction = { policy, value: raw.value };

	const column =
		options.mode === 'greedy'
			? argmaxColumn(policy, legalColumns)
			: sampleColumn(policy, legalColumns, options.rng);

	return { ok: true, column, prediction };
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
