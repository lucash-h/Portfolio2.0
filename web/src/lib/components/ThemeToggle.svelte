<script lang="ts">
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

	let theme = $state<Theme>(readStoredTheme() ?? currentDomTheme() ?? (prefersDark() ? 'dark' : 'light'));

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
		applyTheme(theme === 'dark' ? 'light' : 'dark');
	}
</script>

<button type="button" onclick={toggle} aria-pressed={theme === 'dark'} class="theme-toggle">
	<span aria-hidden="true">{theme === 'dark' ? '☾' : '☀'}</span>
	<span class="visually-hidden">
		{theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
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

	.theme-toggle:hover {
		border-color: var(--color-accent);
	}
</style>
