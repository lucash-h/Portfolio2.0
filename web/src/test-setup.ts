/**
 * Vitest global setup.
 *
 * jsdom does not implement `window.matchMedia`, so any component that checks a
 * media query — e.g. `prefers-reduced-motion` — throws on mount under test.
 * This shim reports "does not match" for every query, which is the correct
 * default: components should render their full experience unless a user
 * preference explicitly asks otherwise.
 *
 * Tests that need a query to match can override `window.matchMedia` themselves.
 */

if (typeof window !== 'undefined' && !window.matchMedia) {
	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		configurable: true,
		value: (query: string): MediaQueryList => ({
			matches: false,
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			// Deprecated, but some libraries still call them.
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false
		})
	});
}
