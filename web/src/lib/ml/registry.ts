/**
 * Checkpoint manifest loading (P2-D).
 *
 * Loads `/models/manifest.json` (served from `web/static/models/`, which does
 * not exist yet in this environment) and validates it against the contract
 * shape in docs/CONTRACTS.md §5 — the JSON is never trusted blindly.
 *
 * A missing manifest is the normal state today: it is not an error, just an
 * `ok: false` result with reason `'missing'`. The caller decides what to do
 * (typically: no ML opponents available yet, fall back to minimax).
 */

import type {
	Connect4CheckpointEntry,
	Manifest,
	ManifestResult,
	RacerCheckpointEntry
} from './mlTypes';

export const DEFAULT_MANIFEST_URL = '/models/manifest.json';

type FetchLike = (input: string) => Promise<{
	ok: boolean;
	status: number;
	text(): Promise<string>;
}>;

// ---------------------------------------------------------------------------
// Shape validation — CONTRACTS §5. Every field is checked; nothing is assumed.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
	return typeof v === 'string';
}

function isFiniteNumber(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v);
}

function isFiniteNumberOrNull(v: unknown): v is number | null {
	return v === null || isFiniteNumber(v);
}

function validateConnect4Entry(v: unknown): Connect4CheckpointEntry | null {
	if (!isRecord(v)) return null;
	if (!isString(v.id)) return null;
	if (!isString(v.label)) return null;
	if (!isString(v.file)) return null;
	if (!isFiniteNumber(v.gamesTrained)) return null;
	if (!isFiniteNumberOrNull(v.elo)) return null;
	if (!isFiniteNumber(v.mctsSims)) return null;
	if (!isFiniteNumber(v.sizeKb)) return null;
	return {
		id: v.id,
		label: v.label,
		file: v.file,
		gamesTrained: v.gamesTrained,
		elo: v.elo,
		mctsSims: v.mctsSims,
		sizeKb: v.sizeKb
	};
}

function validateRacerEntry(v: unknown): RacerCheckpointEntry | null {
	if (!isRecord(v)) return null;
	if (!isString(v.id)) return null;
	if (!isString(v.label)) return null;
	if (!isString(v.file)) return null;
	if (!isFiniteNumber(v.generation)) return null;
	if (!isFiniteNumberOrNull(v.bestLapMs)) return null;
	if (!isFiniteNumber(v.sizeKb)) return null;
	return {
		id: v.id,
		label: v.label,
		file: v.file,
		generation: v.generation,
		bestLapMs: v.bestLapMs,
		sizeKb: v.sizeKb
	};
}

/**
 * Validates an arbitrary parsed JSON value against the manifest contract.
 * Returns null (rather than throwing) on any shape mismatch, including a
 * single malformed entry anywhere in either array — a manifest is trusted
 * only as a whole.
 */
export function validateManifestShape(json: unknown): Manifest | null {
	if (!isRecord(json)) return null;
	if (!isFiniteNumber(json.version)) return null;
	if (!Array.isArray(json.connect4)) return null;
	if (!Array.isArray(json.racer)) return null;

	const connect4: Connect4CheckpointEntry[] = [];
	for (const raw of json.connect4) {
		const entry = validateConnect4Entry(raw);
		if (!entry) return null;
		connect4.push(entry);
	}

	const racer: RacerCheckpointEntry[] = [];
	for (const raw of json.racer) {
		const entry = validateRacerEntry(raw);
		if (!entry) return null;
		racer.push(entry);
	}

	return { version: json.version, connect4, racer };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Loads and validates the checkpoint manifest. Never throws: any failure
 * (network error, 404, malformed JSON, wrong shape) becomes a typed
 * `ManifestResult` with `ok: false`.
 *
 * `fetchImpl` is injectable so tests do not depend on a real network/server.
 * Defaults to the ambient `fetch` (available in both the browser and workers).
 */
export async function loadManifest(
	url: string = DEFAULT_MANIFEST_URL,
	fetchImpl: FetchLike = fetch
): Promise<ManifestResult> {
	let response: { ok: boolean; status: number; text(): Promise<string> };
	try {
		response = await fetchImpl(url);
	} catch (err) {
		return { ok: false, reason: 'missing', detail: `fetch failed: ${describeError(err)}` };
	}

	if (!response.ok) {
		return { ok: false, reason: 'missing', detail: `HTTP ${response.status} for ${url}` };
	}

	let text: string;
	try {
		text = await response.text();
	} catch (err) {
		return { ok: false, reason: 'missing', detail: `body read failed: ${describeError(err)}` };
	}

	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (err) {
		return { ok: false, reason: 'invalid-json', detail: describeError(err) };
	}

	const manifest = validateManifestShape(json);
	if (!manifest) {
		return {
			ok: false,
			reason: 'invalid-shape',
			detail: 'manifest JSON did not match the CONTRACTS.md §5 shape'
		};
	}

	return { ok: true, manifest };
}

/** Connect 4 checkpoints in manifest order (weakest first), per CONTRACTS §5. */
export function getConnect4Checkpoints(manifest: Manifest): Connect4CheckpointEntry[] {
	return manifest.connect4;
}

/** Racer checkpoints in manifest order (weakest first), per CONTRACTS §5. */
export function getRacerCheckpoints(manifest: Manifest): RacerCheckpointEntry[] {
	return manifest.racer;
}

export function findConnect4Checkpoint(
	manifest: Manifest,
	id: string
): Connect4CheckpointEntry | undefined {
	return manifest.connect4.find((entry) => entry.id === id);
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
