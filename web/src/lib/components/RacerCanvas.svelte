<script module lang="ts">
	/**
	 * Pure, canvas-free helpers exported so tests can exercise them without a
	 * real `CanvasRenderingContext2D` (jsdom has none).
	 */

	/** Steering authority is halved at this speed (m/s) and keeps falling.
	 *  A kinematic bicycle model has no grip limit, so without this the car
	 *  turns as sharply at 190 km/h as it does at walking pace. */
	export const STEER_SPEED_REF = 14;
	/** Floor, so the car never becomes uncontrollable at the top end. */
	export const STEER_MIN_AUTHORITY = 0.32;
	/** Per-tick ramp toward what the keys are asking for, and back to centre
	 *  when they are released (release is faster — a car that will not
	 *  straighten feels broken in a way a slow turn-in does not). */
	export const STEER_RATE = 0.055;
	export const STEER_RETURN_RATE = 0.11;

	function clampTo(lo: number, hi: number, v: number): number {
		return v < lo ? lo : v > hi ? hi : v;
	}

	/** How much of full lock the keys can ask for at this speed. */
	export function steerAuthority(speed: number): number {
		return clampTo(STEER_MIN_AUTHORITY, 1, STEER_SPEED_REF / (Math.abs(speed) + STEER_SPEED_REF));
	}

	/**
	 * One tick of player steering: where the smoothed steering position moves
	 * to, given which arrows are held, how fast the car is going, and where it
	 * was last tick.
	 *
	 * SIGN, because this has been wrong twice: a positive `steer` increases
	 * `heading` (physics.ts step 9-10), and increasing heading is clockwise on
	 * a y-down canvas — a RIGHT turn. Left is therefore negative.
	 *
	 * Pure, and exported, so `RacerCanvas.test.ts` can pin the direction and
	 * the feel down without a canvas.
	 */
	export function steerFromKeys(
		keys: { left?: boolean; right?: boolean },
		speed: number,
		previous: number
	): number {
		let target = 0;
		if (keys.left) target -= 1;
		if (keys.right) target += 1;
		target *= steerAuthority(speed);
		const rate = target === 0 ? STEER_RETURN_RATE : STEER_RATE;
		return previous + clampTo(-rate, rate, target - previous);
	}

	/** Format a lap time in `m:ss.mmm`, or `--.---` for `null`/non-finite. */
	export function formatLapTime(ms: number | null): string {
		if (ms === null || !Number.isFinite(ms)) return '--.---';
		const totalMs = Math.max(0, Math.round(ms));
		const minutes = Math.floor(totalMs / 60000);
		const seconds = Math.floor((totalMs % 60000) / 1000);
		const millis = totalMs % 1000;
		return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
	}
</script>

<script lang="ts">
	/**
	 * Fig. 2 — NEAT racer canvas + HUD.
	 *
	 * Physics is the real, tested implementation in `$lib/games/racer/physics`
	 * (CONTRACTS §4), stepped on a fixed 1/60s timestep via a time accumulator
	 * — never a raw frame delta. See `runFrame` below.
	 *
	 * Honesty constraint (see task/README): Phase 5 (neuroevolution) has not
	 * been run. There are no evolved ghosts and no generation checkpoints, so
	 * the two non-player cars are driven by `ghostPolicy`, a hand-written
	 * centreline-follower heuristic using the same ray readings the player's
	 * sensor beams visualise, and are labelled "pace car (…)" rather than
	 * "gen-00NN". `ghostPolicy` is the single seam a real exported MLP
	 * replaces once P5-B (a browser-runnable evolved checkpoint) lands —
	 * nothing else in this file should need to change.
	 */
	import {
		step,
		castRays,
		RAY_ANGLES,
		RAY_MAX_RANGE,
		DT
	} from '$lib/games/racer/physics';
	import {
		isOnTrack,
		initRaceState,
		updateRaceState,
		crossingDirection,
		startLineGate
	} from '$lib/games/racer/track';
	import { parseTrack } from '$lib/games/racer/validateTrack';
	import type { CarState, ControlInput, RaceState, Track } from '$lib/games/racer/types';
	import { observeVisibility, type VisibilityHandle } from '$lib/util/visibility';
	import { THEME_CHANGE_EVENT, type ThemeChangeDetail } from '$lib/components/ThemeToggle.svelte';

	interface Props {
		/** Path under `static/` to the track JSON. Defaults to the Grand Circuit. */
		trackPath?: string;
	}

	let { trackPath = '/tracks/grand.json' }: Props = $props();

	// ---------------------------------------------------------------------
	// P5-B seam
	// ---------------------------------------------------------------------

	/**
	 * P5-B seam. This is the ONLY function a real evolved ghost replaces.
	 *
	 * Today: a hand-written heuristic. It reads the same 7 normalised ray
	 * distances (`$lib/games/racer/physics`'s `castRays`, CONTRACTS §4) the
	 * player's sensor beams draw, steers toward the side with more clearance,
	 * and eases off the throttle when the road ahead is short.
	 *
	 * Tomorrow: swap the body for `session.run(obs)` against an exported
	 * generation checkpoint (once Phase 5 neuroevolution produces one) and
	 * keep the signature `(obs: number[]) => { steer, throttle }` — every
	 * caller below passes exactly this shape and expects exactly this shape
	 * back.
	 */
	function ghostPolicy(obs: number[]): ControlInput {
		const left = (obs[0] + obs[1] + obs[2]) / 3;
		const right = (obs[4] + obs[5] + obs[6]) / 3;
		const ahead = obs[3];
		// Sign matters and is easy to get backwards: `obs[0..2]` are the rays at
		// NEGATIVE offsets from `heading` (RAY_ANGLES starts at -1.2), so steering
		// toward that side means DECREASING heading, i.e. a negative `steer`.
		// `(left - right)` therefore steers away from the clear side and into the
		// wall — which is what this did, and why all three cars used to leave the
		// track within two seconds and sit there jittering at the start line.
		// Gain 1.1, down from 1.6: swept over all four tracks, 0.9-1.6 all lap the
		// Grand Circuit cleanly (5 laps a minute, 0% off-track), and the lower the
		// gain the less the pace cars saw at the wheel on the straights.
		const steer = clamp(-1, 1, (right - left) * 1.1);
		const throttle = clamp(-1, 1, ahead * 1.3 - 0.15);
		return { steer, throttle };
	}

	/** Pace-car speed tiers. Labelled honestly — these are NOT generations of
	 *  an evolved network. See the note in the bottom strip. */
	const PACE_TIERS = [
		{ id: 'slow', label: 'pace car (slow)', throttleCap: 0.45 },
		{ id: 'medium', label: 'pace car (medium)', throttleCap: 0.7 },
		{ id: 'fast', label: 'pace car (fast)', throttleCap: 1.0 }
	] as const;

	function applyTierCap(input: ControlInput, throttleCap: number): ControlInput {
		return {
			steer: input.steer,
			throttle: clamp(-throttleCap, throttleCap, input.throttle)
		};
	}

	function clamp(lo: number, hi: number, v: number): number {
		return v < lo ? lo : v > hi ? hi : v;
	}

	// Player steering feel lives in the module block above (`steerFromKeys`):
	// the physics constants are contract-locked (CONTRACTS §4, asserted to
	// 1e-9 by the Python port), so calming the car down happens on the input.

	// ---------------------------------------------------------------------
	// Per-car simulation bookkeeping. Plain (non-reactive) objects — the
	// simulation runs at 60 physics ticks/sec and must not go through Svelte
	// reactivity, which is reserved for the throttled HUD below.
	// ---------------------------------------------------------------------

	interface SimCar {
		id: 'player' | 'ghost' | 'rival';
		car: CarState;
		race: RaceState;
		control: ControlInput;
		lapStartTick: number;
		bestLapTicks: number | null;
		/** False until the car has crossed the gate once. The run from the grid
		 *  to the start line is an out-lap, not a lap: timing it logged a
		 *  ~1.2s "best" that no real lap round a 700m circuit can beat. */
		lapStarted: boolean;
	}

	function spawnCar(track: Track, id: SimCar['id'], lateralOffset: number): SimCar {
		const pts = track.centreline;
		const n = pts.length;
		const p = pts[track.startIndex];
		const q = pts[(track.startIndex + 1) % n];
		const dx = q[0] - p[0];
		const dy = q[1] - p[1];
		const len = Math.hypot(dx, dy) || 1;
		const tx = dx / len;
		const ty = dy / len;
		const nx = -ty;
		const ny = tx;
		// Start BEHIND the gate, not on it: spawning exactly on the start line
		// made the first tick a gate crossing, which logged a one-tick "best
		// lap" of 0:00.017 that no real lap could ever beat. Fall back to the
		// gate itself if the track doubles back so tightly that 6m upstream is
		// off the surface.
		const backoff = 6;
		let sx = p[0] - tx * backoff + nx * lateralOffset;
		let sy = p[1] - ty * backoff + ny * lateralOffset;
		if (!isOnTrack(track, sx, sy)) {
			sx = p[0] + nx * lateralOffset;
			sy = p[1] + ny * lateralOffset;
		}
		const car: CarState = {
			x: sx,
			y: sy,
			heading: Math.atan2(ty, tx),
			vx: 0,
			vy: 0,
			angularVelocity: 0
		};
		return {
			id,
			car,
			race: initRaceState(),
			control: { steer: 0, throttle: 0 },
			lapStartTick: 0,
			bestLapTicks: null,
			lapStarted: false
		};
	}

	// ---------------------------------------------------------------------
	// Reactive HUD state — committed at most every 140ms (see `runFrame`).
	// The canvas itself is drawn every animation frame from the plain sim
	// objects above, never from this. (Never named `state` — that name
	// breaks `$state` parsing in this codebase.)
	// ---------------------------------------------------------------------

	interface HudSnapshot {
		speedKph: number;
		lapNowMs: number;
		lapBestMs: number | null;
		ghostBestMs: number | null;
		rivalBestMs: number | null;
		playerControlled: boolean;
		status: string;
	}

	let hud = $state<HudSnapshot>({
		speedKph: 0,
		lapNowMs: 0,
		lapBestMs: null,
		ghostBestMs: null,
		rivalBestMs: null,
		playerControlled: false,
		status: 'loading track…'
	});

	let selectedTierIndex = $state(2); // fast, matching the design's default
	let trackError = $state<string | null>(null);
	let trackLoaded = $state(false);
	let showStartPrompt = $state(false);

	const rivalTierIndex = $derived(selectedTierIndex === 0 ? 1 : 0);

	// These MUST be `$state`. The mount effect below opens with
	// `if (!canvasEl) return`, and an effect only re-runs when a *reactive* read
	// changes. As plain `let` bindings, an effect that ran before `bind:this`
	// assigned would bail out and never run again — no track fetch, no cars, no
	// draw, and no error either, because the early return happens before any of
	// the loading code. The canvas just stays blank forever.
	let canvasEl = $state<HTMLCanvasElement | null>(null);
	let frameEl = $state<HTMLDivElement | null>(null);

	/** Set by the mount effect once the sim is running; the "restart lap"
	 *  button (outside the effect's closure) calls through this indirection
	 *  to reach the effect's private simulation state. */
	let restartHandler: (() => void) | null = null;

	/** Same indirection for the play/pause button. Deliberately NOT a `$state`
	 *  the effect reads: reading one inside `$effect` would make the effect
	 *  depend on it, so every pause would tear the whole simulation down and
	 *  respawn the cars. The effect only ever WRITES `isRunning` (writing
	 *  tracks nothing), and the button only ever calls `runHandler`. */
	let runHandler: ((run: boolean) => void) | null = null;

	/** Mirror of the effect's private `desiredRunning`, for the button label.
	 *  Not the same as "the loop is ticking" — an off-screen panel pauses
	 *  itself without changing what the viewer asked for. */
	let isRunning = $state(false);

	// ---------------------------------------------------------------------
	// Palette — read from CSS custom properties on mount/resize/theme change
	// so nothing in this file hardcodes a colour. See tokens.css.
	// ---------------------------------------------------------------------

	interface Palette {
		trackCasing: string;
		trackSurface: string;
		centreline: string;
		ghost: string;
		ghostStroke: string;
		ghostRival: string;
		ghostRivalStroke: string;
		accent: string;
	}

	let palette: Palette = {
		trackCasing: '',
		trackSurface: '',
		centreline: '',
		ghost: '',
		ghostStroke: '',
		ghostRival: '',
		ghostRivalStroke: '',
		accent: ''
	};

	/** Probe container: one zero-size span per token, each with `color` set to
	 *  that token (see the `[data-token]` rules in the style block). */
	let probeEl = $state<HTMLDivElement | null>(null);

	/**
	 * Read the palette through the probes rather than straight off the custom
	 * properties.
	 *
	 * `getPropertyValue('--color-x')` returns the token's CURRENT value, and
	 * custom properties do not interpolate — during the theme cross-fade it
	 * flips to the new value on the first frame. Reading it made the canvas
	 * snap to the new theme while the rest of the page was still a second and
	 * a half from arriving.
	 *
	 * `color` on a real element does interpolate, and the fade's blanket
	 * transition covers these spans like everything else, so their computed
	 * colour IS the in-between value. Steady state is unchanged: a span whose
	 * colour is `var(--color-ghost)` computes to exactly that token.
	 */
	function readPalette(): Palette {
		const read = (token: string): string => {
			const el = probeEl?.querySelector(`[data-token="${token}"]`);
			return el ? getComputedStyle(el).color : '';
		};
		return {
			trackCasing: read('track-casing'),
			trackSurface: read('track-surface'),
			centreline: read('centreline'),
			ghost: read('ghost'),
			ghostStroke: read('ghost-stroke'),
			ghostRival: read('ghost-rival'),
			ghostRivalStroke: read('ghost-rival-stroke'),
			accent: read('accent')
		};
	}

	// ---------------------------------------------------------------------
	// World <-> screen transform. World space is metres (the real track
	// files, unlike the design mock, are not pre-sized to any particular
	// pixel space) — fit the track's bounding box into the canvas, uniformly
	// scaled and centred.
	// ---------------------------------------------------------------------

	interface Transform {
		scale: number;
		offsetX: number;
		offsetY: number;
	}

	function computeTransform(track: Track, width: number, height: number): Transform {
		const pad = track.halfWidth + 10;
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const [x, y] of track.centreline) {
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
		minX -= pad;
		maxX += pad;
		minY -= pad;
		maxY += pad;
		const w = Math.max(1, maxX - minX);
		const h = Math.max(1, maxY - minY);
		const scale = Math.min(width / w, height / h);
		const offsetX = (width - w * scale) / 2 - minX * scale;
		const offsetY = (height - h * scale) / 2 - minY * scale;
		return { scale, offsetX, offsetY };
	}

	function toScreen(t: Transform, x: number, y: number): [number, number] {
		return [x * t.scale + t.offsetX, y * t.scale + t.offsetY];
	}

	function buildTrackPath(track: Track, t: Transform): Path2D {
		const path = new Path2D();
		const pts = track.centreline;
		const [sx, sy] = toScreen(t, pts[0][0], pts[0][1]);
		path.moveTo(sx, sy);
		for (let i = 1; i < pts.length; i++) {
			const [px, py] = toScreen(t, pts[i][0], pts[i][1]);
			path.lineTo(px, py);
		}
		path.closePath();
		return path;
	}

	function drawTrackLayer(
		ctx: CanvasRenderingContext2D,
		path: Path2D,
		lineWidth: number,
		color: string,
		dash: number[] = []
	) {
		ctx.save();
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		ctx.lineWidth = lineWidth;
		ctx.strokeStyle = color;
		ctx.setLineDash(dash);
		ctx.stroke(path);
		ctx.restore();
	}

	function drawStartLine(ctx: CanvasRenderingContext2D, track: Track, t: Transform, color: string) {
		const gate = startLineGate(track);
		const midX = (gate.a[0] + gate.b[0]) / 2;
		const midY = (gate.a[1] + gate.b[1]) / 2;
		const [sx, sy] = toScreen(t, midX, midY);
		const pts = track.centreline;
		const n = pts.length;
		const p = pts[track.startIndex];
		const q = pts[(track.startIndex + 1) % n];
		const angle = Math.atan2(q[1] - p[1], q[0] - p[0]);
		const gateLenWorld = Math.hypot(gate.a[0] - gate.b[0], gate.a[1] - gate.b[1]);
		const lengthPx = gateLenWorld * t.scale;
		const thicknessPx = 4;
		ctx.save();
		ctx.translate(sx, sy);
		ctx.rotate(angle);
		ctx.fillStyle = color;
		ctx.fillRect(-thicknessPx / 2, -lengthPx / 2, thicknessPx, lengthPx);
		ctx.restore();
	}

	function drawSensorBeams(
		ctx: CanvasRenderingContext2D,
		car: CarState,
		track: Track,
		t: Transform,
		accentColor: string
	) {
		const rays = castRays(car, track);
		const [ox, oy] = toScreen(t, car.x, car.y);
		ctx.save();
		for (let i = 0; i < RAY_ANGLES.length; i++) {
			const angle = car.heading + RAY_ANGLES[i];
			const norm = rays[i];
			const distWorld = norm * RAY_MAX_RANGE;
			const hx = car.x + Math.cos(angle) * distWorld;
			const hy = car.y + Math.sin(angle) * distWorld;
			const [ex, ey] = toScreen(t, hx, hy);
			ctx.beginPath();
			ctx.moveTo(ox, oy);
			ctx.lineTo(ex, ey);
			ctx.lineWidth = 1;
			ctx.globalAlpha = Math.max(0, 0.42 - norm * 0.25);
			ctx.strokeStyle = accentColor;
			ctx.stroke();
			ctx.globalAlpha = 0.5;
			ctx.beginPath();
			ctx.arc(ex, ey, 2, 0, Math.PI * 2);
			ctx.fillStyle = accentColor;
			ctx.fill();
		}
		ctx.restore();
	}

	function drawCar(
		ctx: CanvasRenderingContext2D,
		car: CarState,
		t: Transform,
		fill: string,
		stroke: string,
		alpha = 1,
		lineWidth = 1.4
	) {
		const [sx, sy] = toScreen(t, car.x, car.y);
		ctx.save();
		ctx.translate(sx, sy);
		ctx.rotate(car.heading);
		ctx.globalAlpha = alpha;
		ctx.fillStyle = fill;
		ctx.strokeStyle = stroke;
		ctx.lineWidth = lineWidth;
		ctx.beginPath();
		if (typeof ctx.roundRect === 'function') {
			ctx.roundRect(-13, -7, 26, 14, 3);
		} else {
			ctx.rect(-13, -7, 26, 14);
		}
		ctx.fill();
		ctx.stroke();
		ctx.restore();
	}

	// ---------------------------------------------------------------------
	// Mount effect: fetch + parse the track, spawn cars, run the fixed-step
	// loop, wire keyboard, clean everything up on teardown.
	// ---------------------------------------------------------------------

	$effect(() => {
		if (!canvasEl) return;
		let cancelled = false;

		const ctl = {
			raf: 0,
			keydown: null as ((e: KeyboardEvent) => void) | null,
			keyup: null as ((e: KeyboardEvent) => void) | null,
			resizeObserver: null as ResizeObserver | null,
			themeChange: null as ((e: Event) => void) | null,
			themeRaf: 0,
			visibility: null as VisibilityHandle | null
		};

		const pressed: Record<string, boolean> = {};
		/** Smoothed steering position, carried between ticks (see STEER_RATE). */
		let playerSteer = 0;
		let playerControlled = false;
		let reducedMotion = false;
		let track: Track | null = null;
		let cars: SimCar[] = [];
		let tickCount = 0;
		let lastHudCommit = 0;
		let lastFrameTime = 0;
		let accumulator = 0;

		// Off-screen / backgrounded-tab pause (see $lib/util/visibility).
		// `desiredRunning` is "should the sim be looping according to the
		// existing reduced-motion/start-prompt gating, ignoring visibility" —
		// true once the loop has actually been started by either the normal
		// path or a keypress out of the reduced-motion start prompt.
		// `offscreenOrHidden` is the pause signal. The rAF loop only actually
		// runs when both agree it should.
		let desiredRunning = false;
		let offscreenOrHidden = false;

		/** While the page is cross-fading between themes, the tokens this
		 *  canvas paints with are changing every frame. Re-read them until
		 *  this timestamp so the drawing fades with everything else instead
		 *  of holding the old palette and snapping at the end. */
		let paletteFadeUntil = 0;

		function startLoop(): void {
			if (ctl.raf) return;
			// Reset, never fast-forward: a frame after a pause must not
			// integrate the wall-clock time that passed while paused into one
			// huge physics step.
			lastFrameTime = 0;
			accumulator = 0;
			ctl.raf = requestAnimationFrame(runFrame);
		}

		function stopLoop(): void {
			if (ctl.raf) {
				cancelAnimationFrame(ctl.raf);
				ctl.raf = 0;
			}
			// Paused but not blank: redraw the last known state once so a
			// resize or first paint while paused never leaves the canvas empty.
			draw();
		}

		function syncRunning(): void {
			if (desiredRunning && !offscreenOrHidden) startLoop();
			else stopLoop();
			isRunning = desiredRunning;
		}

		function resizeCanvas() {
			if (!canvasEl || !frameEl) return;
			// `clientWidth`/`clientHeight`, NOT `getBoundingClientRect()`: the rect
			// is the frame's BORDER box, and `.canvas-frame` has a 1px border. Sizing
			// the canvas to the border box made the canvas 2px wider than the box that
			// contains it, which grew the frame, which re-fired the ResizeObserver —
			// a feedback loop that grew the canvas by 2px every frame and, because a
			// ResizeObserver callback runs after rAF and assigning `canvas.width`
			// clears the bitmap, wiped every frame the loop had just drawn. Blank
			// canvas, forever. The canvas is also `position: absolute` now, so it
			// cannot feed its own size back into the frame at all.
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			const w = Math.max(1, Math.round(frameEl.clientWidth));
			const h = Math.max(1, Math.round(frameEl.clientHeight));
			canvasEl.width = Math.max(1, Math.round(w * dpr));
			canvasEl.height = Math.max(1, Math.round(h * dpr));
			canvasEl.style.width = `${w}px`;
			canvasEl.style.height = `${h}px`;
			const ctx = canvasEl.getContext('2d');
			if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			palette = readPalette();
		}

		function playerObs(car: CarState, tr: Track): number[] {
			return castRays(car, tr);
		}

		function keysToControl(speed: number): ControlInput {
			playerSteer = steerFromKeys(pressed, speed, playerSteer);
			let throttle = 0;
			if (pressed.up) throttle += 1;
			if (pressed.down) throttle -= 1;
			return { steer: playerSteer, throttle };
		}

		function simulateTick(tr: Track) {
			for (const sim of cars) {
				let input: ControlInput;
				if (sim.id === 'player') {
					input = playerControlled
						? keysToControl(Math.hypot(sim.car.vx, sim.car.vy))
						: applyTierCap(ghostPolicy(playerObs(sim.car, tr)), PACE_TIERS[1].throttleCap);
				} else {
					const tierIndex = sim.id === 'ghost' ? selectedTierIndex : rivalTierIndex;
					input = applyTierCap(ghostPolicy(playerObs(sim.car, tr)), PACE_TIERS[tierIndex].throttleCap);
				}
				sim.control = input;

				const prev: [number, number] = [sim.car.x, sim.car.y];
				const nextCar = step(sim.car, input, tr);
				const onTrack = isOnTrack(tr, nextCar.x, nextCar.y);
				const curr: [number, number] = [nextCar.x, nextCar.y];
				const crossing = crossingDirection(tr, prev, curr);
				const nextRace = updateRaceState(sim.race, tr, prev, curr, onTrack);

				if (crossing === 1) {
					if (sim.lapStarted && nextRace.lapCount > sim.race.lapCount) {
						const lapTicks = tickCount + 1 - sim.lapStartTick;
						if (sim.bestLapTicks === null || lapTicks < sim.bestLapTicks) {
							sim.bestLapTicks = lapTicks;
						}
					}
					sim.lapStarted = true;
					sim.lapStartTick = tickCount + 1;
				}

				sim.car = nextCar;
				sim.race = nextRace;
			}
			tickCount += 1;
		}

		function commitHud(now: number) {
			if (now - lastHudCommit < 140) return;
			lastHudCommit = now;
			const player = cars.find((c) => c.id === 'player');
			const ghost = cars.find((c) => c.id === 'ghost');
			const rival = cars.find((c) => c.id === 'rival');
			if (!player) return;
			const speed = Math.hypot(player.car.vx, player.car.vy);
			const lapNowMs = ((tickCount - player.lapStartTick) * DT) * 1000;
			hud = {
				speedKph: Math.round(speed * 3.6),
				lapNowMs,
				lapBestMs: player.bestLapTicks === null ? null : player.bestLapTicks * DT * 1000,
				ghostBestMs: ghost?.bestLapTicks == null ? null : ghost.bestLapTicks * DT * 1000,
				rivalBestMs: rival?.bestLapTicks == null ? null : rival.bestLapTicks * DT * 1000,
				playerControlled,
				status: playerControlled
					? 'you have the wheel — green car'
					: 'cars are self-driving — press a key to take the wheel'
			};
		}

		function draw() {
			if (!canvasEl || !track) return;
			const ctx = canvasEl.getContext('2d');
			if (!ctx) return;
			// `getComputedStyle` per frame is not free, so only during a fade
			// (~150 frames), never in the steady state.
			if (performance.now() < paletteFadeUntil) palette = readPalette();
			const cssW = canvasEl.clientWidth || parseFloat(canvasEl.style.width) || 1;
			const cssH = canvasEl.clientHeight || parseFloat(canvasEl.style.height) || 1;
			ctx.clearRect(0, 0, cssW, cssH);
			const t = computeTransform(track, cssW, cssH);
			const path = buildTrackPath(track, t);

			drawTrackLayer(ctx, path, track.halfWidth * 2 * t.scale + 6, palette.trackCasing);
			drawTrackLayer(ctx, path, track.halfWidth * 2 * t.scale, palette.trackSurface);
			drawTrackLayer(ctx, path, 1.2, palette.centreline, [10, 16]);
			drawStartLine(ctx, track, t, palette.accent);

			const player = cars.find((c) => c.id === 'player');
			const ghost = cars.find((c) => c.id === 'ghost');
			const rival = cars.find((c) => c.id === 'rival');

			if (player) drawSensorBeams(ctx, player.car, track, t, palette.accent);
			if (rival) drawCar(ctx, rival.car, t, palette.ghostRival, palette.ghostRivalStroke, 1, 1.9);
			if (ghost) drawCar(ctx, ghost.car, t, palette.ghost, palette.ghostStroke, 1, 1.9);
			if (player) {
				drawCar(ctx, player.car, t, palette.accent, palette.accent, playerControlled ? 1 : 0.75);
			}
		}

		function runFrame(now: number) {
			ctl.raf = requestAnimationFrame(runFrame);
			if (!track) return;
			const elapsed = lastFrameTime === 0 ? 0 : Math.min(0.05, (now - lastFrameTime) / 1000);
			lastFrameTime = now;
			accumulator += elapsed;
			while (accumulator >= DT) {
				simulateTick(track);
				accumulator -= DT;
			}
			draw();
			commitHud(now);
		}

		function handleKey(e: KeyboardEvent) {
			const key = e.key.toLowerCase();
			const map: Record<string, 'up' | 'down' | 'left' | 'right'> = {
				arrowup: 'up',
				w: 'up',
				arrowdown: 'down',
				s: 'down',
				arrowleft: 'left',
				a: 'left',
				arrowright: 'right',
				d: 'right'
			};
			const mapped = map[key];
			if (!mapped) return;
			e.preventDefault();
			pressed[mapped] = e.type === 'keydown';
			if (e.type === 'keydown') {
				if (!playerControlled) playerControlled = true;
				showStartPrompt = false;
				// Taking the wheel implies starting, whether the sim is paused
				// because of reduced motion or because the viewer paused it.
				if (!desiredRunning) {
					desiredRunning = true;
					syncRunning();
				}
			}
		}

		(async () => {
			try {
				const res = await fetch(trackPath);
				const json = await res.json();
				const parsed = parseTrack(json);
				if (cancelled) return;
				track = parsed;
				cars = [
					spawnCar(parsed, 'player', -3),
					spawnCar(parsed, 'ghost', 0),
					spawnCar(parsed, 'rival', 3)
				];
				trackLoaded = true;
				trackError = null;
			} catch (err) {
				if (cancelled) return;
				trackError = err instanceof Error ? err.message : 'failed to load track';
				return;
			}

			resizeCanvas();
			if (frameEl && 'ResizeObserver' in window) {
				ctl.resizeObserver = new ResizeObserver(() => {
					resizeCanvas();
					// A resize clears the backing store, and this callback runs
					// after the frame's rAF work, so redraw unconditionally —
					// waiting for the next rAF would leave the just-cleared
					// canvas on screen for a frame (and forever while paused).
					draw();
				});
				ctl.resizeObserver.observe(frameEl);
			}

			if (frameEl) {
				ctl.visibility = observeVisibility(frameEl, (v) => {
					offscreenOrHidden = !v;
					syncRunning();
				});
			}

			reducedMotion =
				typeof window.matchMedia === 'function' &&
				window.matchMedia('(prefers-reduced-motion: reduce)').matches;

			ctl.keydown = handleKey;
			ctl.keyup = handleKey;
			window.addEventListener('keydown', ctl.keydown);
			window.addEventListener('keyup', ctl.keyup);

			ctl.themeChange = (e: Event) => {
				const detail = (e as CustomEvent<ThemeChangeDetail>).detail;
				const duration = detail?.duration ?? 0;
				// +1 frame so the final read lands after the transition has
				// settled on the new values rather than a hair short of them.
				paletteFadeUntil = performance.now() + duration + 32;
				palette = readPalette();
				// A paused or off-screen panel gets no rAF from the sim loop,
				// so drive the repaints here instead. Its own handle: the sim
				// loop's stop/start must not cancel this, or vice versa.
				if (!ctl.raf) {
					const tick = () => {
						draw();
						ctl.themeRaf =
							performance.now() < paletteFadeUntil ? requestAnimationFrame(tick) : 0;
					};
					if (!ctl.themeRaf) ctl.themeRaf = requestAnimationFrame(tick);
				}
			};
			window.addEventListener(THEME_CHANGE_EVENT, ctl.themeChange);

			restartHandler = () => {
				if (!track) return;
				cars = [
					spawnCar(track, 'player', -3),
					spawnCar(track, 'ghost', 0),
					spawnCar(track, 'rival', 3)
				];
				tickCount = 0;
				accumulator = 0;
				playerControlled = false;
				playerSteer = 0;
				pressed.up = pressed.down = pressed.left = pressed.right = false;
				hud = {
					...hud,
					lapNowMs: 0,
					lapBestMs: null,
					ghostBestMs: null,
					rivalBestMs: null,
					playerControlled: false,
					status: 'cars are self-driving — press a key to take the wheel'
				};
				// Repaint now: while the sim is paused there is no rAF coming,
				// so without this the canvas keeps showing the old positions.
				draw();
			};

			runHandler = (run: boolean) => {
				if (run) showStartPrompt = false;
				desiredRunning = run;
				syncRunning();
			};

			if (reducedMotion) {
				// Reduced motion: never start on its own. The overlay's play
				// button (or any driving key) starts it.
				showStartPrompt = true;
				isRunning = false;
				draw();
			} else {
				desiredRunning = true;
				syncRunning();
			}
		})();

		return () => {
			cancelled = true;
			if (ctl.raf) cancelAnimationFrame(ctl.raf);
			if (ctl.keydown) window.removeEventListener('keydown', ctl.keydown);
			if (ctl.keyup) window.removeEventListener('keyup', ctl.keyup);
			if (ctl.themeChange) window.removeEventListener(THEME_CHANGE_EVENT, ctl.themeChange);
			if (ctl.themeRaf) cancelAnimationFrame(ctl.themeRaf);
			if (ctl.resizeObserver) ctl.resizeObserver.disconnect();
			ctl.visibility?.dispose();
			restartHandler = null;
			runHandler = null;
			isRunning = false;
		};
	});

	function selectTier(index: number) {
		selectedTierIndex = index;
		hud = { ...hud, ghostBestMs: null, rivalBestMs: null };
	}

	/** "restart lap": rebuilds all three cars and returns the player car to
	 *  self-driving, per the handoff. Delegates to `restartHandler`, which
	 *  the mount effect sets so this button can reach into its closed-over
	 *  simulation state without that state living in reactive `$state`. */
	function restartLap() {
		restartHandler?.();
	}

	/** Play/pause. Same `restartLap` indirection story: the mount effect owns
	 *  the loop, this only asks it to start or stop. */
	function toggleRunning() {
		runHandler?.(!isRunning);
	}
</script>

<div class="racer">
	<!-- Colour probes for the canvas; see `readPalette`. Rendered (not
	     `display: none`) because a box that is not rendered does not run
	     transitions, which is the entire point of them. -->
	<div class="palette-probe" aria-hidden="true" bind:this={probeEl}>
		<span data-token="track-casing"></span>
		<span data-token="track-surface"></span>
		<span data-token="centreline"></span>
		<span data-token="ghost"></span>
		<span data-token="ghost-stroke"></span>
		<span data-token="ghost-rival"></span>
		<span data-token="ghost-rival-stroke"></span>
		<span data-token="accent"></span>
	</div>

	<div class="canvas-frame" bind:this={frameEl}>
		<canvas bind:this={canvasEl} aria-label="Racer canvas: track, sensor beams, pace cars and player car"
		></canvas>

		<div class="hint">↑↓←→ or WASD</div>

		<div class="best-lap">
			<div class="best-lap-heading">BEST&nbsp;LAP</div>
			<div class="best-lap-rows">
				<div class="best-lap-row row-you">
					<span>you</span><span>{formatLapTime(hud.lapBestMs)}</span>
				</div>
				<div class="best-lap-row row-ghost">
					<span>{PACE_TIERS[selectedTierIndex].label}</span>
					<span>{formatLapTime(hud.ghostBestMs)}</span>
				</div>
				<div class="best-lap-row row-rival">
					<span>{PACE_TIERS[rivalTierIndex].label}</span>
					<span>{formatLapTime(hud.rivalBestMs)}</span>
				</div>
			</div>
		</div>

		{#if trackLoaded && !isRunning && !trackError}
			<div class="start-prompt">
				<button type="button" class="play-overlay-button" onclick={toggleRunning}>
					▶ play simulation
				</button>
				{#if showStartPrompt}
					<span class="start-prompt-note">motion is reduced by your system settings, so this
						does not start on its own</span>
				{/if}
			</div>
		{/if}

		{#if trackError}
			<div class="start-prompt">could not load track: {trackError}</div>
		{/if}
	</div>

	<div class="bottom-strip">
		<span class="tier-group">
			<span>pace car</span>
			{#each PACE_TIERS as tier, i (tier.id)}
				<button
					type="button"
					class="tier-button"
					class:selected={selectedTierIndex === i}
					onclick={() => selectTier(i)}
				>
					{tier.label}
				</button>
			{/each}
		</span>
		<span class="status">{hud.status}</span>
		<span class="honesty-note"
			>pace cars are hand-written heuristics, not evolved networks — real ghosts arrive once
			the neuroevolution run (Phase 5) is done.</span
		>
		<span class="readouts">
			<span>speed <b>{hud.speedKph} km/h</b></span>
			<span>lap <b>{formatLapTime(hud.lapNowMs)}</b></span>
			<span class="accent">best <b>{formatLapTime(hud.lapBestMs)}</b></span>
			<span>ghost <b>{formatLapTime(hud.ghostBestMs)}</b></span>
		</span>
		<button type="button" class="play-button" onclick={toggleRunning}>
			{isRunning ? '❚❚ pause simulation' : '▶ play simulation'}
		</button>
		<button type="button" class="restart-button" onclick={restartLap}>restart lap</button>
	</div>
</div>

<style>
	.racer {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		height: 100%;
		min-height: 0;
	}

	.palette-probe {
		position: absolute;
		width: 0;
		height: 0;
		overflow: hidden;
		opacity: 0;
		pointer-events: none;
	}

	.palette-probe [data-token='track-casing'] {
		color: var(--color-track-casing);
	}
	.palette-probe [data-token='track-surface'] {
		color: var(--color-track-surface);
	}
	.palette-probe [data-token='centreline'] {
		color: var(--color-centreline);
	}
	.palette-probe [data-token='ghost'] {
		color: var(--color-ghost);
	}
	.palette-probe [data-token='ghost-stroke'] {
		color: var(--color-ghost-stroke);
	}
	.palette-probe [data-token='ghost-rival'] {
		color: var(--color-ghost-rival);
	}
	.palette-probe [data-token='ghost-rival-stroke'] {
		color: var(--color-ghost-rival-stroke);
	}
	.palette-probe [data-token='accent'] {
		color: var(--color-accent);
	}

	.canvas-frame {
		position: relative;
		flex: 1;
		min-height: 0;
		border: var(--border-width) solid var(--color-border);
		background: var(--color-surface);
	}

	canvas {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
	}

	.hint {
		position: absolute;
		left: 16px;
		top: 14px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-text-faint);
		pointer-events: none;
	}

	.best-lap {
		position: absolute;
		right: 16px;
		top: 14px;
		min-width: 188px;
		background: color-mix(in srgb, var(--color-surface) 92%, transparent);
		border: var(--border-width) solid var(--color-border);
		padding: 10px 12px;
		pointer-events: none;
	}

	.best-lap-heading {
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.07em;
		color: var(--color-text-faint);
		margin-bottom: 8px;
	}

	.best-lap-rows {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.best-lap-row {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		font-family: var(--font-mono);
		font-size: 11px;
		white-space: nowrap;
	}

	.row-you {
		color: var(--color-accent);
	}

	.row-ghost {
		color: var(--color-text);
	}

	.row-rival {
		color: var(--color-text-faintest);
	}

	.start-prompt {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		gap: 14px;
		align-items: center;
		justify-content: center;
		text-align: center;
		padding: var(--space-4);
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--color-text-faint);
		background: color-mix(in srgb, var(--color-surface) 85%, transparent);
	}

	.start-prompt-note {
		max-width: 44ch;
	}

	.play-overlay-button {
		padding: 12px 22px;
		font-family: var(--font-mono);
		font-size: 13px;
		cursor: pointer;
		border: var(--border-width) solid var(--color-accent);
		background: var(--color-accent-wash);
		color: var(--color-accent);
		transition: var(--transition-base);
	}

	.play-overlay-button:hover {
		background: var(--color-accent);
		color: var(--color-accent-contrast);
	}

	.bottom-strip {
		display: flex;
		align-items: baseline;
		gap: clamp(14px, 3vw, 36px);
		flex-wrap: wrap;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--color-text-faint);
	}

	.tier-group {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.tier-button,
	.play-button,
	.restart-button {
		padding: 6px 11px;
		font-family: var(--font-mono);
		font-size: 11px;
		white-space: nowrap;
		cursor: pointer;
		border: var(--border-width) solid var(--color-border);
		background: var(--color-surface);
		color: var(--color-text-muted);
		transition: var(--transition-base);
	}

	.tier-button:hover,
	.play-button:hover,
	.restart-button:hover {
		border-color: var(--color-accent);
	}

	.play-button {
		margin-left: auto;
		color: var(--color-accent);
		border-color: var(--color-accent-line);
	}

	.tier-button.selected {
		border-color: var(--color-accent);
		background: var(--color-accent-wash);
		color: var(--color-accent);
	}

	.restart-button {
		border: 1px dashed var(--color-border-dashed);
		background: transparent;
	}

	.restart-button:hover {
		color: var(--color-accent);
	}

	.honesty-note {
		max-width: 40ch;
		color: var(--color-text-faintest);
	}

	.readouts {
		display: flex;
		align-items: baseline;
		gap: clamp(14px, 3vw, 36px);
		margin-left: auto;
	}

	.readouts b {
		color: var(--color-text);
		font-weight: 500;
	}

	.readouts .accent b {
		color: var(--color-accent);
	}

	/* ── Narrow screens ─────────────────────────────────────────
	   The strip is a single row of nowrap groups pushed apart by two
	   `margin-left: auto`s. That is wider than a phone, and because the
	   canvas frame sits in the same column it was the strip, not the
	   canvas, deciding how wide the panel had to be. Here the groups
	   stack and nothing claims the leftover space. */
	@media (max-width: 760px) {
		.racer {
			gap: var(--space-3);
		}

		.bottom-strip {
			gap: 10px 16px;
			font-size: 11px;
		}

		.tier-group {
			flex-wrap: wrap;
			gap: 6px;
		}

		.readouts,
		.play-button,
		.restart-button {
			margin-left: 0;
		}

		.readouts {
			flex-wrap: wrap;
			gap: 8px 16px;
			width: 100%;
		}

		/* The overlay costs most of a phone's canvas width and repeats the lap
		   readouts below it. The honesty note stays: it is the reason these
		   cars can be called pace cars at all, and it is not optional because
		   the screen is small. */
		.best-lap {
			display: none;
		}

		.honesty-note {
			max-width: none;
			width: 100%;
			order: 99;
			font-size: 10px;
		}

		.hint {
			font-size: 10px;
			left: 10px;
			top: 10px;
		}

		.tier-button,
		.play-button,
		.restart-button {
			padding: 8px 10px;
		}
	}
</style>
