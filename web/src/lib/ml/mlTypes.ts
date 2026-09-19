/**
 * Types for the browser ML runtime (P2-D).
 *
 * Covers:
 *  - the checkpoint manifest shape (docs/CONTRACTS.md §5)
 *  - the Connect 4 ONNX signature (docs/CONTRACTS.md §3)
 *  - inference / move-selection results, and the worker message protocol
 *
 * No `any`. This file has no runtime dependencies of its own.
 */

import type { Column, GameState, Player } from '../games/connect4/types';

// ---------------------------------------------------------------------------
// Checkpoint manifest (CONTRACTS §5)
// ---------------------------------------------------------------------------

export interface Connect4CheckpointEntry {
	id: string;
	label: string;
	/** Relative to web/static/models/, e.g. "connect4/c4-000001k.onnx". */
	file: string;
	gamesTrained: number;
	elo: number | null;
	mctsSims: number;
	sizeKb: number;
}

/**
 * A single Racer checkpoint entry. P2-D never loads racer checkpoints (that's a
 * separate package's job), but the manifest file is shared, so validating it
 * fully means racer entries must also round-trip without being silently dropped
 * or corrupted.
 */
export interface RacerCheckpointEntry {
	id: string;
	label: string;
	file: string;
	generation: number;
	bestLapMs: number | null;
	sizeKb: number;
}

export interface Manifest {
	version: number;
	/** Weakest first, per CONTRACTS §5. */
	connect4: Connect4CheckpointEntry[];
	/** Weakest first, per CONTRACTS §5. */
	racer: RacerCheckpointEntry[];
}

/** Why manifest loading/validation did not produce a usable manifest. */
export type ManifestFailureReason = 'missing' | 'invalid-json' | 'invalid-shape';

export type ManifestResult =
	| { ok: true; manifest: Manifest }
	| { ok: false; reason: ManifestFailureReason; detail: string };

// ---------------------------------------------------------------------------
// ONNX signature (CONTRACTS §3)
// ---------------------------------------------------------------------------

export const CONNECT4_PLANES = 2;
export const CONNECT4_BOARD_SHAPE: readonly [1, 2, 6, 7] = [1, 2, 6, 7];
export const CONNECT4_POLICY_SHAPE: readonly [1, 7] = [1, 7];
export const CONNECT4_VALUE_SHAPE: readonly [1, 1] = [1, 1];

/** Softmaxed, illegal-move-masked, renormalised policy plus the raw value. */
export interface Connect4Prediction {
	/** Probability per column, length 7. Illegal columns are exactly 0. Legal ones sum to 1. */
	policy: Float32Array;
	/** Raw value in [-1, 1]. +1 = player to move is winning. */
	value: number;
}

/** Why a load or inference attempt failed. Surfaced, never thrown, to the caller. */
export type MlFailureReason =
	| 'checkpoint-not-found'
	| 'load-failed'
	| 'run-failed'
	| 'no-legal-moves';

export type InferenceResult =
	| { ok: true; prediction: Connect4Prediction }
	| { ok: false; reason: MlFailureReason; detail: string };

/**
 * Move selection strategy. Sampling requires an injected RNG (returning a value
 * in [0, 1)) so tests are deterministic and library code never calls
 * `Math.random()` itself.
 */
export type ChooseMoveOptions =
	| { mode: 'greedy' }
	| { mode: 'sample'; temperature: number; rng: () => number };

export type ChooseMoveResult =
	| { ok: true; column: Column; prediction: Connect4Prediction }
	| { ok: false; reason: MlFailureReason; detail: string };

// ---------------------------------------------------------------------------
// Worker message protocol
// ---------------------------------------------------------------------------

export interface InferRequestMessage {
	type: 'infer';
	/** Caller-assigned id, echoed back, so multiple in-flight requests can be matched up. */
	id: number;
	checkpoint: Connect4CheckpointEntry;
	state: GameState;
	legalColumns: Column[];
	options: ChooseMoveOptions;
	/** Base URL models are fetched from. Defaults to "/models/" if omitted. */
	baseUrl?: string;
}

export interface InferResponseMessage {
	type: 'infer-result';
	id: number;
	result: ChooseMoveResult;
}

export type WorkerRequestMessage = InferRequestMessage;
export type WorkerResponseMessage = InferResponseMessage;

// Re-exported only so consumers of this module don't need a second import for
// the handful of connect4 types the ML layer's public signatures mention.
export type { Column, GameState, Player };
