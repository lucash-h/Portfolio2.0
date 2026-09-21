<script module lang="ts">
	/** Event name for "the theme just changed and is cross-fading for N ms".
	 *  Anything that paints its own colours instead of inheriting them — the
	 *  racer canvas reads the tokens through `getComputedStyle` — listens for
	 *  this so it can follow the fade instead of snapping at the end. */
	export const THEME_CHANGE_EVENT = 'themechange';

	export interface ThemeChangeDetail {
		theme: 'light' | 'dark';
		/** Milliseconds the cross-fade will take; 0 when it is instant. */
		duration: number;
	}

	/** The fade length, read from `--theme-transition-duration` so the CSS
	 *  animation and the button's lock cannot drift apart. Falls back to the
	 *  token's own value if the property is missing or unparseable (jsdom
	 *  resolves no stylesheets, so tests land here unless they set it). */
	export function themeTransitionMs(): number {
		if (typeof document === 'undefined') return 0;
		const raw = getComputedStyle(document.documentElement)
			.getPropertyValue('--theme-transition-duration')
			.trim();
		const ms = raw.endsWith('ms') ? parseFloat(raw) : raw.endsWith('s') ? parseFloat(raw) * 1000 : NaN;
		return Number.isFinite(ms) && ms >= 0 ? ms : 2500;
	}
</script>

<script lang="ts">
	import { onDestroy } from 'svelte';

	type Theme = 'light' | 'dark';

	function readStoredTheme(): Theme | null {
		try {
			const value = localStorage.getItem('theme');
			return value === 'light' || value === 'dark' ? value : null;
		} catch {
			return null;
		}
	}

	function currentDomTheme(): Theme | null {
		if (typeof document === 'undefined') return null;
		const attr = document.documentElement.getAttribute('data-theme');
		return attr === 'light' || attr === 'dark' ? attr : null;
	}

	function prefersDark(): boolean {
		try {
			return (
				typeof window !== 'undefined' &&
				window.matchMedia('(prefers-color-scheme: dark)').matches
			);
		} catch {
			return false;
		}
	}

	function prefersReducedMotion(): boolean {
		try {
			return (
				typeof window !== 'undefined' &&
				typeof window.matchMedia === 'function' &&
				window.matchMedia('(prefers-reduced-motion: reduce)').matches
			);
		} catch {
			return false;
		}
	}

	let theme = $state<Theme>(readStoredTheme() ?? currentDomTheme() ?? (prefersDark() ? 'dark' : 'light'));

	/**
	 * True while the page is cross-fading. The button is genuinely `disabled`
	 * for the duration rather than just ignoring the click: a control that
	 * silently does nothing reads as broken, and `disabled` is the state
	 * assistive technology and the cursor both already understand.
	 */
	let fading = $state(false);
	let fadeTimer: ReturnType<typeof setTimeout> | null = null;

	function endFade() {
		fadeTimer = null;
		fading = false;
		document.documentElement.removeAttribute('data-theme-animating');
	}

	function applyTheme(next: Theme) {
		theme = next;
		if (typeof document !== 'undefined') {
			document.documentElement.setAttribute('data-theme', next);
		}
		try {
			localStorage.setItem('theme', next);
		} catch {
			/* storage unavailable (e.g. private browsing); theme still applies for this load */
		}
	}

	function toggle() {
		// Guard as well as `disabled`: a keyboard "click" can still arrive in
		// the same frame the attribute is being set, and starting a second
		// fade would leave the first one's timer to clear the attribute early.
		if (fading) return;

		const next: Theme = theme === 'dark' ? 'light' : 'dark';
		const duration = prefersReducedMotion() ? 0 : themeTransitionMs();

		if (duration > 0) {
			// The attribute must be on the element BEFORE the colours change,
			// or the first frame of the new theme paints untransitioned.
			document.documentElement.setAttribute('data-theme-animating', '');
			fading = true;
			fadeTimer = setTimeout(endFade, duration);
		}

		applyTheme(next);

		window.dispatchEvent(
			new CustomEvent<ThemeChangeDetail>(THEME_CHANGE_EVENT, {
				detail: { theme: next, duration }
			})
		);
	}

	onDestroy(() => {
		if (fadeTimer !== null) {
			clearTimeout(fadeTimer);
			// Unmounting mid-fade must not strand the attribute on <html>,
			// which would leave every element with a 2.5s colour transition.
			endFade();
		}
	});
</script>

<button
	type="button"
	onclick={toggle}
	disabled={fading}
	aria-pressed={theme === 'dark'}
	class="theme-toggle"
	class:fading
>
	<span aria-hidden="true">{theme === 'dark' ? '☾' : '☀'}</span>
	<span class="visually-hidden">
		{#if fading}
			Switching theme…
		{:else if theme === 'dark'}
			Switch to light theme
		{:else}
			Switch to dark theme
		{/if}
	</span>
</button>

<style>
	.theme-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text);
		cursor: pointer;
		font-size: var(--font-size-md);
		line-height: 1;
		transition:
			border-color var(--transition-fast),
			background-color var(--transition-fast);
	}

	.theme-toggle:hover:not(:disabled) {
		border-color: var(--color-accent);
	}

	/* Locked while the page fades. Dimming it says "not now" without moving
	   anything, which matters when the reason it is locked is that a 2.5s
	   animation is already running. */
	.theme-toggle.fading {
		cursor: progress;
		opacity: 0.45;
	}
</style>
