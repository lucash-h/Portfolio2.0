/**
 * Shared "should this panel be doing work right now" signal.
 *
 * Two independent things gate work in the front-page game panels:
 *  - whether the panel element is actually in the viewport (it may be
 *    scrolled off-screen inside GameRail's horizontally-translated rail), and
 *  - whether the tab itself is backgrounded (`document.hidden`).
 *
 * `observeVisibility` combines both into one boolean and calls back only when
 * the combined value actually flips.
 *
 * On IntersectionObserver and CSS transforms: GameRail moves its panels with
 * `rail.style.transform = translate3d(...)`, never by changing layout
 * position. Per the Intersection Observer spec (and MDN), the target's
 * intersection rectangle is computed from its rendered client rect — i.e.
 * post-transform, the same geometry `getBoundingClientRect()` reports — so a
 * translated-out-of-view panel is correctly reported as non-intersecting.
 * This is unambiguous, spec-defined behaviour, not a special case that needs
 * a different code path. The manual fallback below (used only when
 * `IntersectionObserver` itself is unavailable — old browsers, some test
 * environments) reads `getBoundingClientRect()` directly, which is exactly
 * the same post-transform geometry, so both paths agree.
 */

export interface VisibilityHandle {
	/** Stops observing and removes every listener/timer this call installed. */
	dispose(): void;
}

export interface VisibilityOptions {
	/** Passed straight through to IntersectionObserver's `threshold`. Default 0. */
	threshold?: number;
	/** Fallback poll interval (ms) when IntersectionObserver is unavailable. Default 500. */
	pollMs?: number;
}

function rectIntersectsViewport(el: Element): boolean {
	const r = el.getBoundingClientRect();
	// An all-zero rect means "no real layout information" (jsdom without a
	// layout engine, or an element measured before first paint) rather than
	// "genuinely a zero-size box at the origin" — assume visible rather than
	// pausing work with no signal that it will ever be told to resume.
	if (r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0) return true;
	const vw = window.innerWidth || document.documentElement.clientWidth;
	const vh = window.innerHeight || document.documentElement.clientHeight;
	return r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh && r.width > 0 && r.height > 0;
}

/**
 * Reports whether `el` is visible: intersecting the viewport AND the page is
 * not hidden. Calls `onChange` synchronously once with the initial state,
 * then again every time the combined value flips. Never throws in
 * environments lacking these APIs (SSR, jsdom without IntersectionObserver) —
 * it degrades to "always visible" so callers never pause work they have no
 * way to safely resume.
 */
export function observeVisibility(
	el: Element,
	onChange: (visible: boolean) => void,
	options: VisibilityOptions = {}
): VisibilityHandle {
	if (typeof window === 'undefined') {
		return { dispose() {} };
	}

	let intersecting = true;
	let pageVisible = typeof document === 'undefined' ? true : !document.hidden;
	let last: boolean | null = null;

	function emit(): void {
		const next = intersecting && pageVisible;
		if (next !== last) {
			last = next;
			onChange(next);
		}
	}

	let io: IntersectionObserver | null = null;
	let pollId: ReturnType<typeof setInterval> | null = null;

	if (typeof IntersectionObserver !== 'undefined') {
		io = new IntersectionObserver(
			(entries) => {
				const entry = entries[entries.length - 1];
				intersecting = entry.isIntersecting;
				emit();
			},
			{ threshold: options.threshold ?? 0 }
		);
		io.observe(el);
		// IntersectionObserver's first callback is async (a task, not
		// microtask), so read the real geometry synchronously up front rather
		// than assuming "visible" until it fires.
		intersecting = rectIntersectsViewport(el);
	} else {
		// Fallback: no IntersectionObserver. Poll the element's own
		// post-transform bounding rect, which reflects GameRail's transform
		// exactly as IntersectionObserver would have.
		intersecting = rectIntersectsViewport(el);
		pollId = setInterval(() => {
			intersecting = rectIntersectsViewport(el);
			emit();
		}, options.pollMs ?? 500);
	}

	let visibilityHandler: (() => void) | null = null;
	if (typeof document !== 'undefined') {
		visibilityHandler = () => {
			pageVisible = !document.hidden;
			emit();
		};
		document.addEventListener('visibilitychange', visibilityHandler);
	}

	emit();

	return {
		dispose() {
			io?.disconnect();
			if (pollId !== null) clearInterval(pollId);
			if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
		}
	};
}
