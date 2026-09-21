/**
 * Shared types and small numeric helpers for the dashboard charts
 * (EloCurve, WinRateBars, OpeningHeatmap). No Svelte imports here — these
 * are pure functions, easy to unit-test in isolation if that's ever needed,
 * and kept out of the components so each chart file stays focused on markup.
 *
 * Types mirror docs/CONTRACTS.md §7 (`GET /api/stats`) exactly. This file
 * does not fetch anything — the page that owns the network call constructs
 * these shapes and passes them down as props.
 */

export interface CheckpointOutcomeRow {
	checkpointId: string;
	humanWins: number;
	aiWins: number;
	draws: number;
	/** null until the Elo tournament has run for this checkpoint. */
	elo: number | null;
}

export interface RacerCheckpointRow {
	checkpointId: string;
	/** Null until a human has set a time on this checkpoint — a lap nobody has
	 *  driven is not the same as a lap of 0ms, and the API models it that way
	 *  (`RacerCheckpointStats` in `$lib/db/queries`). This type said `number`
	 *  and quietly disagreed with the endpoint it claims to mirror. */
	humanBestMs: number | null;
	aiBestMs: number | null;
	races: number;
}

export interface StatsResponse {
	totalGames: number;
	connect4: {
		byCheckpoint: CheckpointOutcomeRow[];
		/** length-7 first-move frequency, column 0..6 left to right. */
		openingHeatmap: number[];
	};
	racer: {
		byCheckpoint: RacerCheckpointRow[];
	};
}

/** An empty-but-valid stats shape — used as the fallback when /api/stats is
 * missing, failing, or simply reports nothing yet. Never fabricate numbers
 * to fill this in; leave it empty and let each chart's own empty state say so. */
export const EMPTY_STATS: StatsResponse = {
	totalGames: 0,
	connect4: { byCheckpoint: [], openingHeatmap: [] },
	racer: { byCheckpoint: [] }
};

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Linear interpolation of `value` from [domainMin, domainMax] into [rangeMin, rangeMax]. */
export function scaleLinear(
	value: number,
	domainMin: number,
	domainMax: number,
	rangeMin: number,
	rangeMax: number
): number {
	if (domainMax === domainMin) return (rangeMin + rangeMax) / 2;
	const t = (value - domainMin) / (domainMax - domainMin);
	return rangeMin + t * (rangeMax - rangeMin);
}

/** Rounds a domain maximum up to a "clean" tick value (…10, 20, 25, 50, 100, 200…). */
export function niceMax(max: number): number {
	if (max <= 0) return 1;
	const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
	const normalized = max / magnitude;
	let niceNormalized: number;
	if (normalized <= 1) niceNormalized = 1;
	else if (normalized <= 2) niceNormalized = 2;
	else if (normalized <= 5) niceNormalized = 5;
	else niceNormalized = 10;
	return niceNormalized * magnitude;
}

/**
 * Evenly spaced tick values from 0 to `max` inclusive (`count` intervals).
 * Rounds to whole numbers but de-duplicates afterward — a small `max`
 * (e.g. 1) would otherwise round several steps to the same integer, which
 * breaks anything that keys a rendered list by tick value.
 */
export function ticks(max: number, count = 4): number[] {
	const step = max / count;
	const raw = Array.from({ length: count + 1 }, (_, i) => Math.round(i * step));
	return [...new Set(raw)];
}

export function formatCount(n: number): string {
	return n.toLocaleString('en-US');
}

/**
 * A lap time in `m:ss.mmm`, or an em dash when nobody has set one. Kept here
 * rather than imported from `RacerCanvas.svelte` so the dashboard does not
 * depend on a game component just to format a number.
 */
export function formatLapMs(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms)) return '—';
	const total = Math.max(0, Math.round(ms));
	const minutes = Math.floor(total / 60000);
	const seconds = Math.floor((total % 60000) / 1000);
	const millis = total % 1000;
	return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
