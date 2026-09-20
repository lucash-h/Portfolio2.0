/**
 * Track geometry — implements CONTRACTS §4 "Track representation".
 *
 * A track is a closed centreline polyline plus a constant half-width;
 * everything else (on-track test, ray boundary, lap crossing) is derived
 * from that, which is what keeps a Python port trivial: it only needs to
 * port these few geometric primitives, not a stored boundary mesh.
 *
 * Pure functions only. No I/O, no randomness, no Svelte imports.
 */

import type { RaceState, Track } from './types';

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

/** Squared distance from (px,py) to the segment a->b. Squared to avoid an
 *  unnecessary sqrt while scanning every segment for the minimum. */
function distanceToSegmentSquared(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number
): number {
	const abx = bx - ax;
	const aby = by - ay;
	const abLenSq = abx * abx + aby * aby;
	const apx = px - ax;
	const apy = py - ay;
	const t = abLenSq > 0 ? clamp((apx * abx + apy * aby) / abLenSq, 0, 1) : 0;
	const cx = ax + abx * t;
	const cy = ay + aby * t;
	const dx = px - cx;
	const dy = py - cy;
	return dx * dx + dy * dy;
}

/**
 * Minimum distance from (x, y) to the closed centreline polyline, per
 * CONTRACTS §4: `distanceToNearestCentrelineSegment(x, y)`. The loop closes
 * implicitly (segment from the last point back to the first).
 */
export function distanceToNearestCentrelineSegment(track: Track, x: number, y: number): number {
	const pts = track.centreline;
	const n = pts.length;
	let minDistSq = Infinity;
	for (let i = 0; i < n; i++) {
		const a = pts[i];
		const b = pts[(i + 1) % n];
		const d = distanceToSegmentSquared(x, y, a[0], a[1], b[0], b[1]);
		if (d < minDistSq) minDistSq = d;
	}
	return Math.sqrt(minDistSq);
}

/** "On track" per CONTRACTS §4: distance to the nearest centreline segment is
 *  at most the half-width. Leaving the track is a dnf for the lap, not a
 *  physics event — callers do not bounce the car off this boundary. */
export function isOnTrack(track: Track, x: number, y: number): boolean {
	return distanceToNearestCentrelineSegment(track, x, y) <= track.halfWidth;
}

// ---------------------------------------------------------------------------
// Lap crossing. NOT specified structurally by CONTRACTS §4 (the contract only
// gives the rule in prose: forward crossing of the start segment counts,
// backward invalidates rather than decrements). The design below is this
// package's own and should be treated as provisional by P4-B/P5-A.
// ---------------------------------------------------------------------------

/** Signed 2D cross product of (ax,ay) and (bx,by). */
function cross2(ax: number, ay: number, bx: number, by: number): number {
	return ax * by - ay * bx;
}

/** Standard segment-segment intersection test (proper crossing, including
 *  endpoints) via the parametric line intersection. Returns false for
 *  parallel (including collinear) segments — a car travelling exactly along
 *  the gate line is not a meaningful case for this track model. */
function segmentsIntersect(
	p1: readonly [number, number],
	p2: readonly [number, number],
	p3: readonly [number, number],
	p4: readonly [number, number]
): boolean {
	const d1x = p2[0] - p1[0];
	const d1y = p2[1] - p1[1];
	const d2x = p4[0] - p3[0];
	const d2y = p4[1] - p3[1];
	const denom = cross2(d1x, d1y, d2x, d2y);
	if (denom === 0) return false;
	const rx = p3[0] - p1[0];
	const ry = p3[1] - p1[1];
	const t = cross2(rx, ry, d2x, d2y) / denom;
	const u = cross2(rx, ry, d1x, d1y) / denom;
	return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * The start/finish gate: a segment perpendicular to the centreline direction
 * at `track.centreline[track.startIndex]`, spanning wider than the track
 * (1.5x the half-width on each side) so a car anywhere across the track
 * width still crosses it.
 */
export function startLineGate(track: Track): {
	a: readonly [number, number];
	b: readonly [number, number];
} {
	const pts = track.centreline;
	const n = pts.length;
	const p = pts[track.startIndex];
	const q = pts[(track.startIndex + 1) % n];
	const dx = q[0] - p[0];
	const dy = q[1] - p[1];
	const len = Math.hypot(dx, dy);
	const nx = -dy / len;
	const ny = dx / len;
	const half = track.halfWidth * 1.5;
	return {
		a: [p[0] + nx * half, p[1] + ny * half],
		b: [p[0] - nx * half, p[1] - ny * half]
	};
}

/**
 * Whether the car's movement from `prev` to `curr` crossed the start gate,
 * and in which direction. Direction is the sign of the dot product between
 * the movement vector and the centreline's forward tangent at the start
 * point: positive (1) means "with the track direction" (forward), negative
 * (-1) means against it (backward). Returns 0 when the gate was not crossed.
 */
export function crossingDirection(
	track: Track,
	prev: readonly [number, number],
	curr: readonly [number, number]
): 1 | -1 | 0 {
	const gate = startLineGate(track);
	if (!segmentsIntersect(prev, curr, gate.a, gate.b)) return 0;

	const pts = track.centreline;
	const n = pts.length;
	const p = pts[track.startIndex];
	const q = pts[(track.startIndex + 1) % n];
	const tangentX = q[0] - p[0];
	const tangentY = q[1] - p[1];
	const moveX = curr[0] - prev[0];
	const moveY = curr[1] - prev[1];
	const dot = tangentX * moveX + tangentY * moveY;
	if (dot > 0) return 1;
	if (dot < 0) return -1;
	return 0;
}

export function initRaceState(): RaceState {
	return { lapCount: 0, lapValid: true };
}

/**
 * Advance lap bookkeeping by one tick. `onTrack` is the caller's own
 * `isOnTrack` check for the *current* position (leaving the track invalidates
 * the in-progress lap; the car is not moved or bounced). A forward gate
 * crossing completes the in-progress lap (if it was still valid) and starts
 * a fresh, valid one. A backward crossing invalidates the current lap
 * without decrementing `lapCount`.
 */
export function updateRaceState(
	state: RaceState,
	track: Track,
	prev: readonly [number, number],
	curr: readonly [number, number],
	onTrack: boolean
): RaceState {
	let { lapCount, lapValid } = state;
	if (!onTrack) lapValid = false;

	const crossing = crossingDirection(track, prev, curr);
	if (crossing === 1) {
		if (lapValid) lapCount += 1;
		lapValid = true;
	} else if (crossing === -1) {
		lapValid = false;
	}

	return { lapCount, lapValid };
}
