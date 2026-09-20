import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

/**
 * jsdom has no real canvas (`HTMLCanvasElement.prototype.getContext` returns
 * `null`), no `Path2D`, and no `ResizeObserver`. These tests therefore verify
 * mounting, track loading/parsing, keyboard listener lifecycle and the pure
 * lap-time formatter — NOT actual pixel output. What is explicitly NOT
 * covered:
 *   - That anything is drawn correctly (layer order, colours, transform math,
 *     sensor beam geometry, car rotation). The `getContext` stub below is a
 *     Proxy returning a no-op function for every method/property access, so
 *     draw calls succeed without asserting what was drawn.
 *   - Real devicePixelRatio-scaled backing-store sizing (jsdom's layout
 *     engine reports 0 for getBoundingClientRect, so canvas sizing runs but
 *     against degenerate dimensions).
 *   - The fixed-timestep accumulator actually producing physically-correct
 *     motion over many frames (that's `physics.test.ts`'s job upstream).
 * A real-browser or visual-regression check is needed for the rendering
 * itself.
 */

class FakePath2D {
	moveTo(_x?: number, _y?: number) {}
	lineTo(_x?: number, _y?: number) {}
	closePath() {}
}

function installCanvasStub() {
	const ctxProxy = new Proxy(
		{},
		{
			get: () => vi.fn()
		}
	);
	// @ts-expect-error - test stub, not a full CanvasRenderingContext2D
	HTMLCanvasElement.prototype.getContext = vi.fn(() => ctxProxy);
	// @ts-expect-error - jsdom has no Path2D
	global.Path2D = FakePath2D;
}

const ovalTrack = {
	name: 'Oval Basin',
	centreline: [
		[0, 0],
		[15, 5],
		[25, 15],
		[30, 30],
		[25, 45],
		[15, 55],
		[0, 60],
		[-15, 55],
		[-25, 45],
		[-30, 30],
		[-25, 15],
		[-15, 5]
	],
	halfWidth: 8,
	startIndex: 0
};

function installFetchStub() {
	global.fetch = vi.fn(async () => ({
		ok: true,
		json: async () => ovalTrack
	})) as unknown as typeof fetch;
}

/** Flush the microtask queue enough times for the component's async mount
 *  effect (fetch -> parseTrack -> spawn cars -> wire listeners) to settle. */
async function flushAsyncEffects() {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
	flushSync();
}

describe('RacerCanvas', () => {
	let target: HTMLDivElement;
	let RacerCanvas: typeof import('./RacerCanvas.svelte').default;
	let formatLapTime: typeof import('./RacerCanvas.svelte').formatLapTime;

	beforeEach(async () => {
		installCanvasStub();
		installFetchStub();
		target = document.createElement('div');
		document.body.appendChild(target);
		const mod = await import('./RacerCanvas.svelte');
		RacerCanvas = mod.default;
		formatLapTime = mod.formatLapTime;
	});

	afterEach(() => {
		target.remove();
		vi.restoreAllMocks();
	});

	it('formats lap times as m:ss.mmm', () => {
		expect(formatLapTime(0)).toBe('0:00.000');
		expect(formatLapTime(1000)).toBe('0:01.000');
		expect(formatLapTime(61234)).toBe('1:01.234');
		expect(formatLapTime(3_725_006)).toBe('62:05.006');
	});

	it('formats a missing lap time as --.---', () => {
		expect(formatLapTime(null)).toBe('--.---');
		expect(formatLapTime(Number.NaN)).toBe('--.---');
		expect(formatLapTime(Infinity)).toBe('--.---');
	});

	it('mounts, loads and parses a track without throwing', async () => {
		const component = mount(RacerCanvas, { target, props: {} });
		flushSync();
		await flushAsyncEffects();

		expect(target.querySelector('canvas')).not.toBeNull();
		expect(target.querySelector('.best-lap-heading')?.textContent).toContain('BEST');
		// The oval track's fetch resolved and parsed successfully, so no
		// error banner should be present.
		expect(target.textContent).not.toContain('could not load track');

		unmount(component);
	});

	it('shows an honest pace-car label, never a generation label', async () => {
		const component = mount(RacerCanvas, { target, props: {} });
		flushSync();
		await flushAsyncEffects();

		expect(target.textContent).toMatch(/pace car/);
		expect(target.textContent).not.toMatch(/gen-\d/);

		unmount(component);
	});

	it('adds keydown/keyup listeners on mount and removes them on unmount', async () => {
		const addSpy = vi.spyOn(window, 'addEventListener');
		const removeSpy = vi.spyOn(window, 'removeEventListener');

		const component = mount(RacerCanvas, { target, props: {} });
		flushSync();
		await flushAsyncEffects();

		const addedTypes = addSpy.mock.calls.map((c) => c[0]);
		expect(addedTypes).toContain('keydown');
		expect(addedTypes).toContain('keyup');

		unmount(component);

		const removedTypes = removeSpy.mock.calls.map((c) => c[0]);
		expect(removedTypes).toContain('keydown');
		expect(removedTypes).toContain('keyup');
	});

	it('reports a load error in the DOM if the track fetch fails, instead of throwing', async () => {
		global.fetch = vi.fn(async () => ({
			ok: false,
			json: async () => {
				throw new Error('bad json');
			}
		})) as unknown as typeof fetch;

		const component = mount(RacerCanvas, { target, props: {} });
		flushSync();
		await flushAsyncEffects();

		expect(target.textContent).toContain('could not load track');

		unmount(component);
	});
});
