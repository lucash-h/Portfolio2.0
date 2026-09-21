/**
 * Theme toggle: the swap itself, the cross-fade window, and the lock.
 *
 * jsdom resolves no stylesheets, so the CSS side of the fade (the `*`
 * transition under `[data-theme-animating]`) cannot be asserted here — only
 * that the attribute driving it goes on and comes off at the right times, and
 * that the button is genuinely unusable in between. The colours actually
 * interpolating is a real-browser check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ThemeToggle, { THEME_CHANGE_EVENT, type ThemeChangeDetail } from './ThemeToggle.svelte';

/** jsdom has no matchMedia; each test installs the answers it needs. */
function stubMatchMedia(matches: Record<string, boolean>) {
	vi.stubGlobal(
		'matchMedia',
		vi.fn((query: string) => ({
			matches: matches[query] ?? false,
			media: query,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
			onchange: null
		}))
	);
}

describe('ThemeToggle', () => {
	let target: HTMLDivElement;

	beforeEach(() => {
		vi.useFakeTimers();
		stubMatchMedia({});
		localStorage.clear();
		document.documentElement.removeAttribute('data-theme');
		document.documentElement.removeAttribute('data-theme-animating');
		target = document.createElement('div');
		document.body.appendChild(target);
	});

	afterEach(() => {
		target.remove();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		document.documentElement.removeAttribute('data-theme-animating');
	});

	const button = () => target.querySelector('button') as HTMLButtonElement;

	it('swaps the theme and persists the choice', () => {
		const component = mount(ThemeToggle, { target });
		flushSync();

		button().click();
		flushSync();

		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
		expect(localStorage.getItem('theme')).toBe('dark');

		unmount(component);
	});

	it('marks the document as animating for the length of the fade, then stops', () => {
		const component = mount(ThemeToggle, { target });
		flushSync();

		button().click();
		flushSync();
		expect(document.documentElement.hasAttribute('data-theme-animating')).toBe(true);

		// Still fading a hair before the end...
		vi.advanceTimersByTime(2499);
		flushSync();
		expect(document.documentElement.hasAttribute('data-theme-animating')).toBe(true);

		vi.advanceTimersByTime(2);
		flushSync();
		expect(document.documentElement.hasAttribute('data-theme-animating')).toBe(false);

		unmount(component);
	});

	it('locks the button until the fade finishes', () => {
		const component = mount(ThemeToggle, { target });
		flushSync();

		expect(button().disabled).toBe(false);
		button().click();
		flushSync();

		expect(button().disabled).toBe(true);

		// A click that lands mid-fade must not start a second one, and must
		// not flip the theme back.
		button().click();
		flushSync();
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

		vi.advanceTimersByTime(2500);
		flushSync();
		expect(button().disabled).toBe(false);

		// ...and then it works again.
		button().click();
		flushSync();
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');

		unmount(component);
	});

	it('announces the change so canvases can follow the fade', () => {
		const seen: ThemeChangeDetail[] = [];
		const listener = (e: Event) => seen.push((e as CustomEvent<ThemeChangeDetail>).detail);
		window.addEventListener(THEME_CHANGE_EVENT, listener);

		const component = mount(ThemeToggle, { target });
		flushSync();
		button().click();
		flushSync();

		expect(seen).toHaveLength(1);
		expect(seen[0].theme).toBe('dark');
		expect(seen[0].duration).toBeGreaterThan(0);

		window.removeEventListener(THEME_CHANGE_EVENT, listener);
		unmount(component);
	});

	it('switches instantly, with no lock, when reduced motion is asked for', () => {
		stubMatchMedia({ '(prefers-reduced-motion: reduce)': true });
		const seen: ThemeChangeDetail[] = [];
		const listener = (e: Event) => seen.push((e as CustomEvent<ThemeChangeDetail>).detail);
		window.addEventListener(THEME_CHANGE_EVENT, listener);

		const component = mount(ThemeToggle, { target });
		flushSync();
		button().click();
		flushSync();

		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
		expect(document.documentElement.hasAttribute('data-theme-animating')).toBe(false);
		expect(button().disabled).toBe(false);
		expect(seen[0].duration).toBe(0);

		// Immediately usable again.
		button().click();
		flushSync();
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');

		window.removeEventListener(THEME_CHANGE_EVENT, listener);
		unmount(component);
	});

	it('does not strand the animating attribute if it unmounts mid-fade', () => {
		const component = mount(ThemeToggle, { target });
		flushSync();
		button().click();
		flushSync();
		expect(document.documentElement.hasAttribute('data-theme-animating')).toBe(true);

		unmount(component);
		flushSync();

		expect(document.documentElement.hasAttribute('data-theme-animating')).toBe(false);
	});
});
