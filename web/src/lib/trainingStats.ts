/**
 * `static/models/training.json` — how the Connect 4 checkpoints were made.
 *
 * Written by `ml/export/training_stats.py` in the same pass that exports the
 * ONNX files, straight out of the checkpoints, so it cannot drift from the
 * weights that shipped. Separate from `manifest.json` on purpose: the manifest
 * is contract-fixed (CONTRACTS §5) and the exhibit depends on its shape, while
 * this is dashboard-only and nothing breaks without it.
 *
 * Types mirror the writer. Everything is optional-tolerant on read: a manifest
 * written by an older export step, or no file at all, has to degrade to "no
 * training stats" rather than throw on a page whose whole point is honesty
 * about missing data.
 */

export interface TrainingArchitecture {
	channels: number | null;
	blocks: number | null;
	parameters: number;
}

export interface TrainingRun {
	gamesTrained: number;
	firstCheckpointAt: string;
	lastCheckpointAt: string;
	/** Seconds between the first and last checkpoint — NOT the run's total
	 *  duration, since the first checkpoint is written after its games are
	 *  already played. Labelled as a span wherever it is shown. */
	spanSeconds: number | null;
}

export interface TrainingCheckpoint {
	id: string;
	gamesTrained: number;
	parameters: number;
	savedAt: string;
	checkpointKb: number;
	onnxKb?: number;
}

export interface TrainingStats {
	architecture: TrainingArchitecture;
	hyperparameters: Record<string, number>;
	run: TrainingRun;
	checkpoints: TrainingCheckpoint[];
	/** Metrics the training pipeline does not produce, and why. Rendered as-is:
	 *  a reader is better served by "no tournament has run" than by silence. */
	missing?: Record<string, string>;
}

export interface TrainingStatsFile {
	version: number;
	connect4: TrainingStats | null;
}

/** Narrows the parsed JSON, returning null for anything unusable. */
export function parseTrainingStats(json: unknown): TrainingStats | null {
	if (typeof json !== 'object' || json === null) return null;
	const file = json as Partial<TrainingStatsFile>;
	const c4 = file.connect4;
	if (typeof c4 !== 'object' || c4 === null) return null;
	if (!Array.isArray(c4.checkpoints) || c4.checkpoints.length === 0) return null;
	if (typeof c4.architecture !== 'object' || c4.architecture === null) return null;
	return c4 as TrainingStats;
}

/** `9m 11s`, `1h 04m`, `47s`. Null when there is nothing to report. */
export function formatDuration(seconds: number | null | undefined): string | null {
	if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
		return null;
	}
	const total = Math.round(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
	if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
	return `${secs}s`;
}

/** ISO 8601 to a plain `19 Sep 2026` — no time, since the exact second of a
 *  checkpoint write is noise to a reader. Returns null on anything unparseable. */
export function formatDate(iso: string | null | undefined): string | null {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** `89,219`. */
export function formatNumber(n: number): string {
	return n.toLocaleString('en-US');
}

/** Hyperparameter keys are camelCase in the JSON; show them as words. */
export function humanizeKey(key: string): string {
	return key
		.replace(/([A-Z])/g, ' $1')
		.replace(/^./, (c) => c.toUpperCase())
		.toLowerCase();
}
