/**
 * Racer physics — implements CONTRACTS §4 "Physics model — exact specification".
 *
 * A kinematic bicycle model, deliberately slip-free. `step()` applies its
 * twelve updates in EXACTLY the order given in the contract — floating point
 * is not associative, and a reordered update breaks parity with the Python
 * port trained against `shared/fixtures/racer_trace.json`. Do not "clean up"
 * this function without re-checking every step against CONTRACTS §4.
 *
 * Pure functions only. No I/O, no randomness, no Svelte imports. Must stay
 * runnable in a plain Node test and inside a Web Worker. All state is
 * float64 (a plain TS `number`) — never `Math.fround` or `Float32Array` here.
 */

import { isOnTrack } from './track';
import type { CarState, ControlInput, Track } from './types';

// ---------------------------------------------------------------------------
// Constants — CONTRACTS §4. Named exports so the Python port can assert
// against these exact values (see ml/conformance/test_racer_parity.py).
// ---------------------------------------------------------------------------

export const DT = 1.0 / 60.0; // s
export const WHEELBASE = 2.5; // m
export const MASS = 1100.0; // kg
export const MAX_SPEED = 55.0; // m/s
export const MAX_REVERSE_SPEED = 18.0; // m/s
export const MAX_STEER_ANGLE = 0.52; // rad
export const ENGINE_FORCE = 9000.0; // N
export const BRAKE_FORCE = 14000.0; // N
export const DRAG_COEFF = 0.42; // N per (m/s)^2
export const ROLLING_RESISTANCE = 12.0; // N per (m/s)
export const MAX_ANGULAR = 3.0; // rad/s (normalisation only, not a physical limit)
export const RAY_MAX_RANGE = 50.0; // m

/** Derived, but named so both languages compute `wrapPi` from the same
 *  literal constant rather than re-deriving `2 * PI` inline. */
export const TWO_PI = 2.0 * Math.PI;

/** Ray angles relative to heading, in this exact order (CONTRACTS §4). */
export const RAY_ANGLES: readonly number[] = [-1.2, -0.8, -0.4, 0.0, 0.4, 0.8, 1.2];

/**
 * Ray-casting resolution. NOT part of CONTRACTS §4 — the contract specifies
 * the ray angles, max range, and normalisation, but not how a ray finds the
 * track boundary (the boundary is only implicitly defined, as the isocontour
 * of `distanceToNearestCentrelineSegment(x,y) == halfWidth`, which has no
 * closed form for an arbitrary polyline). This package's choice: march in
 * fixed steps of `RAY_MARCH_STEP` from the car, then refine the last on/off
 * bracket with `RAY_BISECTION_ITERATIONS` bisection steps. Both constants are
 * named exports specifically so a Python port reproduces the identical
 * arithmetic (same step size, same iteration count) rather than a different
 * root-finder that would agree only approximately.
 */
export const RAY_MARCH_STEP = 0.1; // m
export const RAY_BISECTION_ITERATIONS = 32;

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Wrap a heading into (-PI, PI]. Must be exactly this formula in both
 * languages — CONTRACTS §4 explicitly forbids `fmod`, `%`, or
 * `atan2(sin, cos)` substitutes, which differ from this at the boundaries.
 */
export function wrapPi(h: number): number {
	return h - TWO_PI * Math.floor((h + Math.PI) / TWO_PI);
}

/**
 * Advance the car one fixed tick (`DT` seconds) per CONTRACTS §4's twelve
 * numbered steps, applied in exactly that order. `track` is accepted to
 * match the contract's declared signature but is not consulted by the
 * update itself — none of the twelve steps reference it. Leaving the track
 * is a dnf handled by callers via `track.ts`'s `isOnTrack`/`updateRaceState`,
 * not a physics event this function reacts to (the car is never bounced).
 */
export function step(car: CarState, input: ControlInput, _track: Track): CarState {
	// 1
	const steer = clamp(input.steer, -1, 1);
	const throttle = clamp(input.throttle, -1, 1);
	// 2
	const steerAngle = steer * MAX_STEER_ANGLE;
	// 3
	let speed = car.vx * Math.cos(car.heading) + car.vy * Math.sin(car.heading);
	// 4
	const fLong = throttle >= 0 ? throttle * ENGINE_FORCE : throttle * BRAKE_FORCE;
	// 5
	const fDrag = -DRAG_COEFF * speed * Math.abs(speed);
	// 6
	const fRoll = -ROLLING_RESISTANCE * speed;
	// 7
	const accel = (fLong + fDrag + fRoll) / MASS;
	// 8
	speed = clamp(speed + accel * DT, -MAX_REVERSE_SPEED, MAX_SPEED);
	// 9
	const angularVelocity = (speed * Math.tan(steerAngle)) / WHEELBASE;
	// 10
	const heading = wrapPi(car.heading + angularVelocity * DT);
	// 11
	const vx = speed * Math.cos(heading);
	const vy = speed * Math.sin(heading);
	// 12
	const x = car.x + vx * DT;
	const y = car.y + vy * DT;

	return { x, y, heading, vx, vy, angularVelocity };
}

/** March outward from `origin` along `(dirX,dirY)` and bisect the last
 *  on/off-track bracket. Returns the raw (unnormalised) hit distance, or
 *  `RAY_MAX_RANGE` if nothing was hit within range. */
function castSingleRay(
	track: Track,
	originX: number,
	originY: number,
	dirX: number,
	dirY: number
): number {
	if (!isOnTrack(track, originX, originY)) return 0;

	let prevT = 0;
	let t = 0;
	while (t <= RAY_MAX_RANGE) {
		const px = originX + dirX * t;
		const py = originY + dirY * t;
		if (!isOnTrack(track, px, py)) {
			let lo = prevT;
			let hi = t;
			for (let i = 0; i < RAY_BISECTION_ITERATIONS; i++) {
				const mid = (lo + hi) / 2;
				const mx = originX + dirX * mid;
				const my = originY + dirY * mid;
				if (isOnTrack(track, mx, my)) lo = mid;
				else hi = mid;
			}
			return lo;
		}
		prevT = t;
		t += RAY_MARCH_STEP;
	}
	return RAY_MAX_RANGE;
}

/**
 * Cast the 7 rays of CONTRACTS §4 from the car centre, at `RAY_ANGLES`
 * relative to `car.heading`, clipped to `RAY_MAX_RANGE` and normalised to
 * `distance / RAY_MAX_RANGE`. A ray hitting nothing in range reports exactly
 * `1.0`.
 */
export function castRays(car: CarState, track: Track): number[] {
	return RAY_ANGLES.map((offset) => {
		const angle = car.heading + offset;
		const dist = castSingleRay(track, car.x, car.y, Math.cos(angle), Math.sin(angle));
		return dist / RAY_MAX_RANGE;
	});
}
