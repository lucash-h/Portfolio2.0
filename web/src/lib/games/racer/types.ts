/**
 * Racer shared types — transcribed verbatim from docs/CONTRACTS.md §4, plus a
 * small amount of state (`RaceState`) needed for lap validation that the
 * contract describes in prose ("crossing the start segment forward counts,
 * backward invalidates") but does not give a concrete shape for. That part is
 * this package's own design — see the note in track.ts.
 *
 * No I/O, no randomness, no Svelte imports. Must stay runnable in a plain
 * Node test and inside a Web Worker.
 */

/** World-frame car state. Position in metres, heading in radians (0 = +x
 *  axis, increases counter-clockwise), velocities in m/s, all float64. */
export interface CarState {
	x: number;
	y: number;
	heading: number;
	vx: number;
	vy: number;
	angularVelocity: number;
}

/** Raw control input for one tick. Steer/throttle are clamped to [-1, 1]
 *  inside `step()`; callers do not need to pre-clamp. */
export interface ControlInput {
	steer: number; // positive = left
	throttle: number; // negative = brake/reverse
}

/** A closed centreline polyline plus a constant half-width. Everything else
 *  (on-track test, ray casting, lap crossing) is derived from this. */
export interface Track {
	name: string;
	/** Closed loop; the last point implicitly joins the first. At least 3
	 *  points. */
	centreline: [number, number][];
	/** Metres, applied uniformly around the whole centreline. */
	halfWidth: number;
	/** Index into `centreline`; the segment (this point -> the next point,
	 *  wrapping) is the start/finish line's gate. */
	startIndex: number;
}

/**
 * Lap-validity bookkeeping across ticks. This is NOT part of CONTRACTS §4 —
 * the contract only specifies the rule in prose. `track.ts` implements that
 * rule against this shape; callers thread the returned value from one tick
 * to the next.
 */
export interface RaceState {
	/** Number of laps completed by a forward crossing of the start gate while
	 *  the in-progress lap was still valid. */
	lapCount: number;
	/** False once the car has left the track (dnf) or crossed the start gate
	 *  backwards during the current lap. Reset to true on the next forward
	 *  crossing, which starts a new lap. */
	lapValid: boolean;
}
