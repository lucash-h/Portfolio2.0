/**
 * Racer physics conformance against shared/fixtures/racer_trace.json.
 *
 * The fixture is the cross-language source of truth (CONTRACTS §2): both
 * this TS engine and the eventual Python port (P5-A) are graded against it,
 * neither owns the truth. This engine was written from CONTRACTS §4 and the
 * fixture was generated from it afterward, so "trace conformance" below is
 * really a change-detector: it fails the moment `step()` drifts from the
 * committed trace, which is the whole point.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
	BRAKE_FORCE,
	DRAG_COEFF,
	DT,
	ENGINE_FORCE,
	MASS,
	MAX_REVERSE_SPEED,
	MAX_SPEED,
	MAX_STEER_ANGLE,
	RAY_ANGLES,
	RAY_MAX_RANGE,
	ROLLING_RESISTANCE,
	WHEELBASE,
	castRays,
	step,
	wrapPi
} from './physics';
import { crossingDirection, initRaceState, isOnTrack, updateRaceState } from './track';
import type { CarState, ControlInput, Track } from './types';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../../../../shared/fixtures/racer_trace.json');

interface FixtureTick {
	tick: number;
	input: ControlInput;
	state: CarState;
	onTrack: boolean;
}

interface FixtureRayCheckpoint {
	tick: number;
	label: string;
	state: CarState;
	rays: number[];
}

interface Fixture {
	schemaVersion: number;
	description: string;
	track: Track;
	initialCar: CarState;
	ticks: FixtureTick[];
	rayCheckpoints: FixtureRayCheckpoint[];
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Fixture;

/**
 * JSON round-trips -0 to +0 (`JSON.stringify(-0) === "0"`), so a car field
 * that lands on exactly zero can differ only in the sign of zero between a
 * fresh computation and the committed fixture. That sign carries no physical
 * meaning here (it is not e.g. distinguishing forward/backward), so
 * comparisons below canonicalise -0 -> 0 on both sides rather than either
 * loosening the comparison generally or teaching the fixture to preserve a
 * sign JSON cannot carry anyway.
 */
function zz(n: number): number {
	return n === 0 ? 0 : n;
}

function canonCar(c: CarState): CarState {
	return {
		x: zz(c.x),
		y: zz(c.y),
		heading: zz(c.heading),
		vx: zz(c.vx),
		vy: zz(c.vy),
		angularVelocity: zz(c.angularVelocity)
	};
}

function replay(
	initial: CarState,
	inputs: ControlInput[],
	track: Track,
	stepFn: (car: CarState, input: ControlInput, track: Track) => CarState
): CarState[] {
	const out: CarState[] = [];
	let car = initial;
	for (const input of inputs) {
		car = stepFn(car, input, track);
		out.push(car);
	}
	return out;
}

describe('constants match CONTRACTS §4', () => {
	it('has the exact literal values', () => {
		expect(DT).toBe(1 / 60);
		expect(WHEELBASE).toBe(2.5);
		expect(MASS).toBe(1100.0);
		expect(MAX_SPEED).toBe(55.0);
		expect(MAX_REVERSE_SPEED).toBe(18.0);
		expect(MAX_STEER_ANGLE).toBe(0.52);
		expect(ENGINE_FORCE).toBe(9000.0);
		expect(BRAKE_FORCE).toBe(14000.0);
		expect(DRAG_COEFF).toBe(0.42);
		expect(ROLLING_RESISTANCE).toBe(12.0);
		expect(RAY_MAX_RANGE).toBe(50.0);
		expect(RAY_ANGLES).toEqual([-1.2, -0.8, -0.4, 0.0, 0.4, 0.8, 1.2]);
	});
});

describe('wrapPi', () => {
	it('matches the exact contract formula at named boundary values', () => {
		// Hardcoded against `wrapPi` itself computed once and pinned, so a
		// change to the formula (not just a reordering elsewhere) is caught.
		expect(wrapPi(Math.PI)).toBe(-3.141592653589793);
		expect(wrapPi(-Math.PI)).toBe(-3.141592653589793);
		expect(wrapPi(2 * Math.PI)).toBe(0);
		expect(wrapPi(-2 * Math.PI)).toBe(0);
		expect(wrapPi(5 * Math.PI)).toBe(-3.141592653589793);
		expect(wrapPi(-5 * Math.PI)).toBe(-3.141592653589793);
		expect(wrapPi(100 * Math.PI)).toBe(0);
		expect(wrapPi(0)).toBe(0);
		expect(wrapPi(0.0001)).toBe(0.0001);
	});

	it('never returns a value outside (-PI - eps, PI + eps]', () => {
		for (let k = -20; k <= 20; k++) {
			for (const h of [0.1, 1.5, 3.0, -0.7, -2.9]) {
				const wrapped = wrapPi(h + k * 2 * Math.PI);
				expect(wrapped).toBeGreaterThan(-Math.PI - 1e-9);
				expect(wrapped).toBeLessThanOrEqual(Math.PI + 1e-9);
			}
		}
	});

	it('is periodic: wrapPi(h) equals wrapPi(h + 2*PI*k) up to floating point', () => {
		const h = 1.23456789;
		for (const k of [1, -1, 2, -2, 1000, -1000]) {
			expect(wrapPi(h + k * 2 * Math.PI)).toBeCloseTo(wrapPi(h), 6);
		}
	});
});

describe('determinism', () => {
	const track = fixture.track;
	const initial = fixture.initialCar;
	// A short but varied scripted sequence, independent of the fixture's own
	// script, run many times from cold state each time.
	const inputs: ControlInput[] = [
		{ steer: 0, throttle: 1 },
		{ steer: 0.5, throttle: 1 },
		{ steer: -1, throttle: 1 },
		{ steer: 1, throttle: -1 },
		{ steer: -0.3, throttle: -1 },
		{ steer: 0, throttle: 0 }
	];

	it('1000 runs of the same input sequence produce bit-identical output', () => {
		const first = replay(initial, inputs, track, step);
		for (let run = 1; run < 1000; run++) {
			const result = replay(initial, inputs, track, step);
			expect(result).toHaveLength(first.length);
			for (let i = 0; i < result.length; i++) {
				const a = first[i];
				const b = result[i];
				expect(Object.is(a.x, b.x)).toBe(true);
				expect(Object.is(a.y, b.y)).toBe(true);
				expect(Object.is(a.heading, b.heading)).toBe(true);
				expect(Object.is(a.vx, b.vx)).toBe(true);
				expect(Object.is(a.vy, b.vy)).toBe(true);
				expect(Object.is(a.angularVelocity, b.angularVelocity)).toBe(true);
			}
		}
	});
});

describe('trace conformance (shared/fixtures/racer_trace.json)', () => {
	it('has at least 600 ticks and at least one off-track excursion', () => {
		expect(fixture.ticks.length).toBeGreaterThanOrEqual(600);
		expect(fixture.ticks.some((t) => !t.onTrack)).toBe(true);
	});

	it('replaying the fixture inputs from initialCar reproduces every tick exactly', () => {
		let car = fixture.initialCar;
		for (const tick of fixture.ticks) {
			car = step(car, tick.input, fixture.track);
			expect(canonCar(car)).toEqual(canonCar(tick.state));
			expect(isOnTrack(fixture.track, car.x, car.y)).toBe(tick.onTrack);
		}
	});

	it('ray checkpoints reproduce exactly from their recorded CarState', () => {
		for (const cp of fixture.rayCheckpoints) {
			const rays = castRays(cp.state, fixture.track);
			expect(rays).toEqual(cp.rays);
		}
	});
});

describe('the trace conformance test has teeth (tamper check)', () => {
	/**
	 * A deliberately reordered `step`: it computes `angularVelocity` (step 9)
	 * from the PRE-clamp speed of step 3 instead of the post-clamp speed
	 * produced by step 8, i.e. it swaps step 8 and 9's data dependency. This
	 * is exactly the kind of reordering CONTRACTS §4 warns about ("floating
	 * point is not associative, and a reordered update will break parity").
	 * If this diverges from the golden trace, the real conformance test
	 * above is proven capable of catching a reordering, not just capable of
	 * echoing whatever `step` happens to compute.
	 */
	function reorderedStep(car: CarState, input: ControlInput, _track: Track): CarState {
		const steer = Math.max(-1, Math.min(1, input.steer));
		const throttle = Math.max(-1, Math.min(1, input.throttle));
		const steerAngle = steer * MAX_STEER_ANGLE;
		const rawSpeed = car.vx * Math.cos(car.heading) + car.vy * Math.sin(car.heading);
		const fLong = throttle >= 0 ? throttle * ENGINE_FORCE : throttle * BRAKE_FORCE;
		const fDrag = -DRAG_COEFF * rawSpeed * Math.abs(rawSpeed);
		const fRoll = -ROLLING_RESISTANCE * rawSpeed;
		const accel = (fLong + fDrag + fRoll) / MASS;
		const clampedSpeed = Math.max(
			-MAX_REVERSE_SPEED,
			Math.min(MAX_SPEED, rawSpeed + accel * DT)
		);
		// BUG (intentional): uses the pre-clamp `rawSpeed` here instead of
		// `clampedSpeed`.
		const angularVelocity = (rawSpeed * Math.tan(steerAngle)) / WHEELBASE;
		const heading = wrapPi(car.heading + angularVelocity * DT);
		const vx = clampedSpeed * Math.cos(heading);
		const vy = clampedSpeed * Math.sin(heading);
		const x = car.x + vx * DT;
		const y = car.y + vy * DT;
		return { x, y, heading, vx, vy, angularVelocity };
	}

	it('diverges from the golden trace once speed actually clamps', () => {
		let correct = fixture.initialCar;
		let reordered = fixture.initialCar;
		let sawDivergence = false;
		for (const tick of fixture.ticks) {
			correct = step(correct, tick.input, fixture.track);
			reordered = reorderedStep(reordered, tick.input, fixture.track);
			expect(canonCar(correct)).toEqual(canonCar(tick.state));
			if (!sawDivergence && !Object.is(reordered.angularVelocity, correct.angularVelocity)) {
				sawDivergence = true;
			}
		}
		// The reordering only bites once the speed clamp is actually active
		// (steps 3-8 saturate at MAX_SPEED/MAX_REVERSE_SPEED), which the
		// full-throttle and hard-brake phases of the fixture script exercise.
		expect(sawDivergence).toBe(true);
		expect(reordered).not.toEqual(fixture.ticks[fixture.ticks.length - 1].state);
	});
});

describe('rays', () => {
	const track = fixture.track;

	it('returns exactly 7 readings, all within [0, 1]', () => {
		const rays = castRays(fixture.initialCar, track);
		expect(rays).toHaveLength(7);
		for (const r of rays) {
			expect(r).toBeGreaterThanOrEqual(0);
			expect(r).toBeLessThanOrEqual(1);
		}
	});

	it('reports exactly 1.0 when nothing is hit within range', () => {
		// A car placed on a track wide enough (half-width 500m) that no ray
		// reaches either boundary within RAY_MAX_RANGE (50m).
		const bigTrack: Track = {
			name: 'big-oval',
			centreline: Array.from({ length: 24 }, (_, i) => {
				const th = (2 * Math.PI * i) / 24;
				return [1000 * Math.cos(th), 1000 * Math.sin(th)] as [number, number];
			}),
			halfWidth: 500,
			startIndex: 0
		};
		const carOnBigTrack: CarState = { x: 1000, y: 0, heading: Math.PI, vx: 0, vy: 0, angularVelocity: 0 };
		const rays = castRays(carOnBigTrack, bigTrack);
		for (const r of rays) expect(r).toBe(1.0);
	});

	it('is shorter when a wall is near than when it is far', () => {
		// Straight corridor track: two long parallel-ish segments forming a
		// thin closed loop, half-width 3.
		const corridor: Track = {
			name: 'corridor',
			centreline: [
				[-100, 0],
				[100, 0]
			],
			halfWidth: 3,
			startIndex: 0
		};
		const carCentre: CarState = { x: 0, y: 0, heading: 0, vx: 0, vy: 0, angularVelocity: 0 };
		const carNearWall: CarState = { x: 0, y: 2.5, heading: 0, vx: 0, vy: 0, angularVelocity: 0 };

		// Ray index 0 is the -1.2 rad offset; choose heading so that ray 0
		// points straight toward +y (heading + (-1.2) === PI/2).
		const facingUp: CarState = { ...carCentre, heading: Math.PI / 2 + 1.2 };
		const facingUpNearWall: CarState = { ...carNearWall, heading: Math.PI / 2 + 1.2 };

		const raysCentre = castRays(facingUp, corridor);
		const raysNearWall = castRays(facingUpNearWall, corridor);
		expect(raysNearWall[0]).toBeLessThan(raysCentre[0]);
	});
});

describe('on-track / off-track boundary', () => {
	const track: Track = {
		name: 'unit-square-ish',
		centreline: [
			[0, 0],
			[100, 0]
		],
		halfWidth: 4,
		startIndex: 0
	};

	it('is on track exactly at the half-width boundary and off just beyond it', () => {
		expect(isOnTrack(track, 50, 4)).toBe(true);
		expect(isOnTrack(track, 50, 4 + 1e-9)).toBe(false);
		expect(isOnTrack(track, 50, 0)).toBe(true);
		expect(isOnTrack(track, 50, -4)).toBe(true);
		expect(isOnTrack(track, 50, -4 - 1e-9)).toBe(false);
	});
});

describe('lap validation', () => {
	const track: Track = {
		name: 'lap-test-loop',
		centreline: [
			[0, 0],
			[100, 0],
			[100, 100],
			[0, 100]
		],
		halfWidth: 5,
		startIndex: 0
	};

	// Track tangent at startIndex 0 is centreline[0]->[1] = (0,0)->(100,0),
	// i.e. the +x direction. The gate is perpendicular to that, along x=0.
	// So a "forward" crossing moves in +x: e.g. (-1,0) -> (1,0).

	it('a forward crossing of the start gate counts', () => {
		expect(crossingDirection(track, [-1, 0], [1, 0])).toBe(1);
	});

	it('a backward crossing invalidates rather than decrements', () => {
		let state = initRaceState();
		state = updateRaceState(state, track, [-1, 0], [1, 0], true); // forward: lap 1
		expect(state).toEqual({ lapCount: 1, lapValid: true });

		state = updateRaceState(state, track, [1, 0], [-1, 0], true); // backward
		expect(state.lapCount).toBe(1); // not decremented
		expect(state.lapValid).toBe(false);
	});

	it('leaving the track (dnf) invalidates the in-progress lap without a bounce', () => {
		let state = initRaceState();
		state = updateRaceState(state, track, [10, 5], [10, 20], false); // off track, no crossing
		expect(state).toEqual({ lapCount: 0, lapValid: false });

		// A subsequent forward crossing while still marked invalid does not
		// award a lap; it starts a fresh one.
		state = updateRaceState(state, track, [-1, 0], [1, 0], true);
		expect(state).toEqual({ lapCount: 0, lapValid: true });
	});
});
