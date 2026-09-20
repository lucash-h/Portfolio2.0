<script lang="ts">
	/**
	 * Minimal shell.
	 *
	 * The front page is a full-bleed pinned rail, so the layout deliberately adds
	 * no max-width, padding, header or footer — a constrained `main` would break
	 * the 100vw panels. Navigation lives in the page itself (a top bar that
	 * slides in once the rail is behind you), matching the design handoff.
	 *
	 * The theme toggle stays here rather than in the page: the design has no slot
	 * for it, but dark mode is supported, and a control that only appears after
	 * scrolling past two full screens is not a control anyone will find.
	 */
	import '$lib/styles/global.css';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let { children } = $props();
</script>

<a href="#main-content" class="skip-link">Skip to content</a>

<div class="theme-slot">
	<ThemeToggle />
</div>

<main id="main-content">
	{@render children()}
</main>

<style>
	main {
		display: block;
		width: 100%;
	}

	.theme-slot {
		position: fixed;
		top: clamp(18px, 4vh, 38px);
		right: clamp(16px, 3vw, 34px);
		z-index: 70;
	}

	/* On narrow screens the rail header and the toggle compete for the same
	   corner, so shrink the toggle rather than let them collide. */
	@media (max-width: 560px) {
		.theme-slot {
			top: 10px;
			right: 10px;
			transform: scale(0.85);
			transform-origin: top right;
		}
	}
</style>
