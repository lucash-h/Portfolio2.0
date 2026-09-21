<script lang="ts">
	/**
	 * Pinned horizontal scroll rail holding the two game figures.
	 *
	 * A tall scroll driver (280vh) contains a sticky viewport-height window. The
	 * rail inside it is 200vw wide and translated by scroll progress, so the two
	 * panels read as a horizontal scroll while the page scrolls vertically. No
	 * wheel hijacking: native scroll, trackpad, touch, keyboard and the real
	 * scrollbar all keep working.
	 *
	 * Performance note, and the reason this component looks the way it does:
	 * scroll progress is NOT reactive state. It lives in a plain variable and is
	 * written straight to `style.transform` inside a rAF-throttled handler.
	 * Routing it through `$state` would re-render both game panels on every
	 * scroll frame, which visibly stutters the board and the canvas. Only
	 * crossing the halfway mark flips a rune, because the dots genuinely need it.
	 *
	 * Below 760px none of that applies. A 200vw rail inside `overflow: hidden`
	 * needs a viewport wide enough to hold a panel, and a phone has not got
	 * one — the panels were being clipped, not scrolled, with no way to reach
	 * what was cut off. So on narrow screens the rail stops moving: the
	 * scroll driver collapses, one panel is shown at a time, and a pair of
	 * labelled tabs switches between them. Same markup, same two panels.
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		titleA: string;
		titleB: string;
		panelA: Snippet;
		panelB: Snippet;
	}

	let { titleA, titleB, panelA, panelB }: Props = $props();

	let scroller = $state<HTMLDivElement | null>(null);
	let rail = $state<HTMLDivElement | null>(null);
	let titleAEl = $state<HTMLSpanElement | null>(null);
	let titleBEl = $state<HTMLSpanElement | null>(null);
	let progEl = $state<HTMLSpanElement | null>(null);

	/** Which panel the dots highlight — and, on narrow screens, which panel is
	 *  shown at all. The only scroll-derived value that is reactive. */
	let activePanel = $state(0);

	/** Narrow layout: tabs instead of a scroll-driven rail. Kept in a rune
	 *  because the markup and the scroll handlers both branch on it. */
	let compact = $state(false);

	const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

	function progress(): number {
		if (!scroller) return 0;
		const top = scroller.offsetTop;
		const span = scroller.offsetHeight - window.innerHeight;
		if (span <= 0) return 0;
		return clamp((window.scrollY - top) / span, 0, 1);
	}

	/** Drop the inline styles the desktop path writes. They would otherwise win
	 *  on specificity over the compact layout's CSS and leave the rail
	 *  translated half a screen off, or a title stuck at `opacity: 0`. */
	function clearInlineStyles() {
		if (rail) rail.style.transform = '';
		for (const el of [titleAEl, titleBEl]) {
			if (!el) continue;
			el.style.opacity = '';
			el.style.transform = '';
		}
		if (progEl) progEl.style.transform = '';
	}

	function paint(p: number) {
		// Compact layout is CSS and `activePanel`; nothing here to drive.
		if (compact) return;
		if (rail) rail.style.transform = `translate3d(${-p * 50}%, 0, 0)`;

		// Dead zone at each end so the titles hold while a panel is fully on screen.
		const ease = clamp((p - 0.25) / 0.5, 0, 1);
		if (titleAEl) {
			titleAEl.style.opacity = String(1 - ease);
			titleAEl.style.transform = `translateY(${-ease * 10}px)`;
		}
		if (titleBEl) {
			titleBEl.style.opacity = String(ease);
			titleBEl.style.transform = `translateY(${(1 - ease) * 10}px)`;
		}
		if (progEl) progEl.style.transform = `translateX(${p * 36}px)`;

		const next = p > 0.5 ? 1 : 0;
		if (next !== activePanel) activePanel = next;
	}

	function scrollToPanel(i: number) {
		if (!scroller) return;
		const span = scroller.offsetHeight - window.innerHeight;
		window.scrollTo({ top: scroller.offsetTop + (i === 0 ? 0 : span), behavior: 'smooth' });
	}

	/** What the dots and the tabs both call. On a wide screen the panel IS the
	 *  scroll position, so it scrolls; on a narrow one it is just state. */
	function selectPanel(i: number) {
		if (!compact) {
			scrollToPanel(i);
			return;
		}
		activePanel = i;
		if (scroller && window.scrollY > scroller.offsetTop) {
			scroller.scrollIntoView({ block: 'start' });
		}
	}

	$effect(() => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
		// Must stay in step with the `max-width: 760px` blocks in this file's
		// style block and in +page.svelte: the CSS decides what is shown, this
		// decides whether the scroll handlers write inline styles over it.
		const mq = window.matchMedia('(max-width: 760px)');
		const sync = () => {
			compact = mq.matches;
			if (compact) clearInlineStyles();
			else paint(progress());
		};
		sync();
		mq.addEventListener('change', sync);
		return () => mq.removeEventListener('change', sync);
	});

	$effect(() => {
		let frame = 0;
		const onScroll = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				paint(progress());
			});
		};

		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
			// The racer uses arrows to drive. Only steal them while Fig. 1 is showing,
			// and never from a focused control.
			if (compact ? activePanel === 1 : progress() > 0.5) return;
			const el = document.activeElement;
			if (el && el !== document.body && el.closest('input, textarea, select, button, [tabindex]')) {
				return;
			}
			e.preventDefault();
			selectPanel(e.key === 'ArrowRight' ? 1 : 0);
		};

		paint(progress());
		window.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', onScroll, { passive: true });
		window.addEventListener('keydown', onKey);

		return () => {
			if (frame) cancelAnimationFrame(frame);
			window.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onScroll);
			window.removeEventListener('keydown', onKey);
		};
	});
</script>

<div id="top" class="scroller" bind:this={scroller}>
	<div class="pin">
		<div class="header">
			<span class="wordmark">Lucas</span>
			<div class="titles">
				<span class="fig-title" class:shown={activePanel === 0} bind:this={titleAEl}>{titleA}</span>
				<span class="fig-title" class:shown={activePanel === 1} style="opacity:0" bind:this={titleBEl}
					>{titleB}</span
				>
			</div>
			<div class="progress">
				<span>01</span>
				<span class="track"><span class="thumb" bind:this={progEl}></span></span>
				<span>02</span>
			</div>
		</div>

		<div class="rail" bind:this={rail}>
			<section class="panel" class:active={activePanel === 0}>{@render panelA()}</section>
			<section class="panel" class:active={activePanel === 1}>{@render panelB()}</section>
		</div>

		<!-- Compact-layout switch. Separate from the dots rather than a restyle
		     of them: only one of the two is ever displayed, so the other is out
		     of the accessibility tree instead of being a duplicate control. -->
		<div class="tabs">
			<button type="button" class="tab" class:on={activePanel === 0} onclick={() => selectPanel(0)}>
				01 · {titleA.replace(/^FIG\.\s*\d+\s*—\s*/, '')}
			</button>
			<button type="button" class="tab" class:on={activePanel === 1} onclick={() => selectPanel(1)}>
				02 · {titleB.replace(/^FIG\.\s*\d+\s*—\s*/, '')}
			</button>
		</div>

		<div class="dots">
			<button
				type="button"
				class="dot"
				class:on={activePanel === 0}
				aria-label="Go to figure 1, Connect 4"
				aria-current={activePanel === 0}
				onclick={() => selectPanel(0)}
			></button>
			<button
				type="button"
				class="dot"
				class:on={activePanel === 1}
				aria-label="Go to figure 2, racer"
				aria-current={activePanel === 1}
				onclick={() => selectPanel(1)}
			></button>
		</div>
	</div>
</div>

<style>
	.scroller {
		position: relative;
		height: 280vh;
	}

	.pin {
		position: sticky;
		top: 0;
		height: 100vh;
		overflow: hidden;
		background-color: var(--color-bg);
		background-image:
			linear-gradient(var(--color-grid-line) 1px, transparent 1px),
			linear-gradient(90deg, var(--color-grid-line) 1px, transparent 1px);
		background-size: var(--grid-size) var(--grid-size);
	}

	.header {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 30;
		display: flex;
		align-items: baseline;
		gap: clamp(16px, 3vw, 34px);
		padding: clamp(22px, 4.5vh, 44px) clamp(28px, 6vw, 88px) 0;
		pointer-events: none;
	}

	.wordmark {
		font-family: var(--font-mono);
		font-size: 13px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--color-text);
	}

	.titles {
		position: relative;
		flex: 1;
		height: 20px;
		min-width: 0;
	}

	.fig-title {
		position: absolute;
		left: 0;
		top: 0;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 12px;
		letter-spacing: 0.05em;
		color: var(--color-accent);
	}

	.progress {
		display: flex;
		align-items: center;
		gap: 10px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-text-faint);
	}

	.track {
		position: relative;
		display: block;
		width: 72px;
		height: 2px;
		background: var(--color-border-soft);
	}

	.thumb {
		position: absolute;
		left: 0;
		top: 0;
		height: 2px;
		width: 36px;
		background: var(--color-accent);
		transition: transform var(--transition-progress);
	}

	.rail {
		display: flex;
		width: 200vw;
		height: 100vh;
		will-change: transform;
	}

	.panel {
		width: 100vw;
		height: 100vh;
		box-sizing: border-box;
	}

	.dots {
		position: absolute;
		bottom: 18px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		gap: 8px;
		z-index: 30;
	}

	.dot {
		width: 7px;
		height: 7px;
		padding: 0;
		border: 1px solid var(--color-border-dashed);
		border-radius: 50%;
		background: transparent;
		cursor: pointer;
	}

	.dot.on {
		background: var(--color-accent);
		border-color: var(--color-accent);
	}

	.dot:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 3px;
	}

	/* Hidden on wide screens: the rail itself is the navigation there. */
	.tabs {
		display: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.thumb {
			transition: none;
		}
	}

	/* ── Compact layout ─────────────────────────────────────────
	   No scroll driver, no 200vw rail, no transform. One panel at a
	   time, switched by the tabs. Everything here is layout only —
	   the panels' own contents are unchanged. */
	@media (max-width: 760px) {
		.scroller {
			height: auto;
		}

		.pin {
			/* `relative`, not `static`: the header is absolutely positioned and
			   would otherwise anchor to the viewport. */
			position: relative;
			height: auto;
			min-height: 100svh;
			overflow: visible;
			display: flex;
			flex-direction: column;
		}

		.rail {
			width: 100%;
			height: auto;
			flex: 1;
			will-change: auto;
			/* Room for the sticky tabs to float over. A stuck element still
			   overlaps whatever is behind it, and without this it sat on top
			   of the racer's last row of buttons. */
			padding-bottom: 58px;
		}

		.panel {
			width: 100%;
			height: auto;
			min-width: 0;
			display: none;
		}

		.panel.active {
			display: block;
			flex: 1;
		}

		/* The title crossfade and the 01—02 thumb are both scroll-derived. */
		.fig-title {
			opacity: 0;
			transform: none;
		}

		.fig-title.shown {
			opacity: 1;
		}

		.progress,
		.dots {
			display: none;
		}

		.tabs {
			position: sticky;
			bottom: 0;
			z-index: 30;
			display: flex;
			gap: 8px;
			padding: 10px clamp(14px, 4vw, 28px) calc(10px + env(safe-area-inset-bottom));
			background: color-mix(in srgb, var(--color-bg) 94%, transparent);
			border-top: var(--border-width) solid var(--color-border-soft);
		}

		.tab {
			flex: 1;
			min-width: 0;
			padding: 11px 8px;
			font-family: var(--font-mono);
			font-size: 11px;
			letter-spacing: 0.02em;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			cursor: pointer;
			border: var(--border-width) solid var(--color-border);
			background: var(--color-surface);
			color: var(--color-text-muted);
		}

		.tab.on {
			border-color: var(--color-accent);
			background: var(--color-accent-wash);
			color: var(--color-accent);
		}

		.tab:focus-visible {
			outline: 2px solid var(--color-focus-ring);
			outline-offset: 2px;
		}
	}
</style>
