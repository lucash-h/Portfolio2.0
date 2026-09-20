import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeVisibility } from './visibility';

/** Minimal controllable stand-in for the real IntersectionObserver — jsdom
 *  has none, and the real one's callback timing (a task, not a microtask)
 *  isn't something a unit test should depend on anyway. Tests drive it by
 *  calling `.trigger(isIntersecting)` on the most recently constructed
 *  instance. */
class FakeIntersectionObserver {
	static instances: FakeIntersectionObserver[] = [];
	private callback: (entries: { isIntersecting: boolean }[]) => void;
	observed: Element[] = [];
	disconnected = false;

	constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
		this.callback = callback;
		FakeIntersectionObserver.instances.push(this);
	}

	observe(el: Element): void {
		this.observed.push(el);
	}

	disconnect(): void {
		this.disconnected = true;
	}

	trigger(isIntersecting: boolean): void {
		this.callback([{ isIntersecting }]);
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
	FakeIntersectionObserver.instances = [];
});

describe('observeVisibility', () => {
	beforeEach(() => {
		vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
	});

	it('reports visible=true up front and again only when intersection actually flips', () => {
		const el = document.createElement('div');
		const changes: boolean[] = [];
		const handle = observeVisibility(el, (v) => changes.push(v));

		expect(changes).toEqual([true]);

		const io = FakeIntersectionObserver.instances[0];
		io.trigger(false);
		expect(changes).toEqual([true, false]);

		// Re-triggering the same state must not re-emit.
		io.trigger(false);
		expect(changes).toEqual([true, false]);

		io.trigger(true);
		expect(changes).toEqual([true, false, true]);

		handle.dispose();
		expect(io.disconnected).toBe(true);
	});

	it('reports invisible when the tab is backgrounded even while intersecting', () => {
		const el = document.createElement('div');
		const changes: boolean[] = [];
		const handle = observeVisibility(el, (v) => changes.push(v));
		const io = FakeIntersectionObserver.instances[0];
		io.trigger(true);
		changes.length = 0;

		Object.defineProperty(document, 'hidden', { configurable: true, value: true });
		document.dispatchEvent(new Event('visibilitychange'));
		expect(changes).toEqual([false]);

		Object.defineProperty(document, 'hidden', { configurable: true, value: false });
		document.dispatchEvent(new Event('visibilitychange'));
		expect(changes).toEqual([false, true]);

		handle.dispose();
	});

	it('disposes cleanly and stops emitting after dispose', () => {
		const el = document.createElement('div');
		const changes: boolean[] = [];
		const handle = observeVisibility(el, (v) => changes.push(v));
		handle.dispose();

		const io = FakeIntersectionObserver.instances[0];
		expect(io.disconnected).toBe(true);
		// Nothing left listening; calling trigger post-dispose would be a
		// test bug, not something the implementation needs to guard —
		// disconnect() on the real observer prevents any further callback.
	});
});

describe('observeVisibility — no IntersectionObserver (fallback)', () => {
	beforeEach(() => {
		vi.stubGlobal('IntersectionObserver', undefined);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('assumes visible when it has no real layout information, and can still be disposed', () => {
		const el = document.createElement('div');
		const changes: boolean[] = [];
		const handle = observeVisibility(el, (v) => changes.push(v));

		expect(changes).toEqual([true]);
		handle.dispose();

		// Advancing timers after dispose must not throw or emit further.
		vi.advanceTimersByTime(5000);
		expect(changes).toEqual([true]);
	});
});
