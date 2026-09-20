<script lang="ts">
	/**
	 * Front page.
	 *
	 * A pinned horizontal rail holding the two ML figures, then Work / About /
	 * Contact below the fold. Built from the "Notebook" design handoff, with the
	 * design's hardcoded palette expressed through tokens so dark mode survives.
	 *
	 * PLACEHOLDER CONTENT: the headline, the six work entries and the contact
	 * links are stand-ins for layout testing. Every one is marked below. None of
	 * it describes real projects or real accounts.
	 */
	import GameRail from '$lib/components/GameRail.svelte';
	import Connect4Figure from '$lib/components/Connect4Figure.svelte';
	import RacerCanvas from '$lib/components/RacerCanvas.svelte';

	// PLACEHOLDER — Lucas is rewriting this line.
	const headline = 'Lucas — software engineering student, training small networks and putting them on the web.';

	// PLACEHOLDER — invented entries for layout testing only. Replace wholesale.
	const projects = [
		{
			title: 'Distributed Task Scheduler',
			meta: '2026 · Go, Postgres',
			body: 'A work queue with at-least-once delivery, exponential backoff and a dead-letter path. Written to understand what actually goes wrong when a worker dies mid-job.',
			tags: ['go', 'postgres', 'queues']
		},
		{
			title: 'Static Site Compiler',
			meta: '2025 · Rust',
			body: 'Markdown to HTML with incremental rebuilds driven by a file-watch graph. Rebuilds only the pages whose inputs actually changed.',
			tags: ['rust', 'parsing', 'tooling']
		},
		{
			title: 'Sensor Telemetry Pipeline',
			meta: '2025 · Python, TimescaleDB',
			body: 'Ingests readings from a handful of microcontrollers, downsamples on write, and serves a rolling window to a dashboard over websockets.',
			tags: ['python', 'timeseries', 'iot']
		},
		{
			title: 'Type-Safe Query Builder',
			meta: '2025 · TypeScript',
			body: 'A small ORM-free layer that infers row types from a schema definition, so a renamed column is a compile error rather than a runtime surprise.',
			tags: ['typescript', 'types', 'sql']
		},
		{
			title: 'Terminal Text Editor',
			meta: '2024 · C',
			body: 'A modal editor with a piece-table buffer, syntax highlighting and undo. Built to find out why editors use piece tables instead of arrays.',
			tags: ['c', 'data structures']
		},
		{
			title: 'Route Planner',
			meta: '2024 · Java',
			body: 'Contraction hierarchies over an OpenStreetMap extract, cutting shortest-path queries on a city-sized graph from seconds to milliseconds.',
			tags: ['java', 'graphs', 'algorithms']
		}
	];

	let gamesLogged = $state<number | null>(null);
	let latencyMs = $state<number | null>(null);
	let navVisible = $state(false);

	/** Pull the logged-game count for the stat row. Absent API is not an error. */
	$effect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch('/api/stats');
				if (!res.ok) return;
				const data = (await res.json()) as { totalGames?: number };
				if (!cancelled && typeof data.totalGames === 'number') gamesLogged = data.totalGames;
			} catch {
				/* no API in dev; the stat just stays blank */
			}
		})();
		return () => {
			cancelled = true;
		};
	});

	/**
	 * Slide the top nav in once the pinned rail is behind us. Its own tiny
	 * rAF-throttled listener rather than a prop from GameRail, so the rail never
	 * has to push scroll values through reactive state.
	 */
	$effect(() => {
		let frame = 0;
		const update = () => {
			frame = 0;
			const el = document.getElementById('top');
			if (!el) return;
			const past = window.scrollY > el.offsetTop + el.offsetHeight - window.innerHeight + 40;
			if (past !== navVisible) navVisible = past;
		};
		const onScroll = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};
		update();
		window.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', onScroll, { passive: true });
		return () => {
			if (frame) cancelAnimationFrame(frame);
			window.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onScroll);
		};
	});

	/** Log a finished game. Fire-and-forget per CONTRACTS §7 — never block play. */
	function handleGameEnd(r: {
		checkpointId: string;
		outcome: 'human_win' | 'ai_win' | 'draw';
		moves: number[];
		durationMs: number;
	}) {
		if (gamesLogged !== null) gamesLogged += 1;
		void fetch('/api/games', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ game: 'connect4', ...r })
		}).catch(() => {
			/* a dropped log is not worth degrading the game for */
		});
	}
</script>

<svelte:head>
	<title>Lucas — portfolio</title>
	<meta
		name="description"
		content="Software engineering student. Two machine-learning exhibits that run entirely in the browser."
	/>
</svelte:head>

<nav class="topnav" class:visible={navVisible}>
	<a class="brand" href="#top">Lucas</a>
	<a href="#work">work</a>
	<a href="#about">about</a>
	<a href="#contact">contact</a>
</nav>

<GameRail titleA="FIG. 1 — CONNECT 4 SELF-PLAY" titleB="FIG. 2 — RACER">
	{#snippet panelA()}
		<div class="fig1">
			<div class="fig1-copy">
				<!-- PLACEHOLDER headline -->
				<h1>{headline}</h1>
				<p class="lead">
					So I trained the two things on this page. No inference server: the checkpoints are
					exported to ONNX and run in this tab, which is also why the difficulty levels are
					honest — each one is the network as it stood after that many self-play games.
				</p>
				<div class="stats">
					<span>
						games logged <b>{gamesLogged ?? '—'}</b>
					</span>
					<span>
						inference <b>{latencyMs === null ? '—' : `${latencyMs.toFixed(1)} ms`}</b>
					</span>
				</div>
				<div class="hint">scroll → fig. 2</div>
			</div>
			<div class="fig1-figure">
				<Connect4Figure onGameEnd={handleGameEnd} onLatency={(ms) => (latencyMs = ms)} />
			</div>
		</div>
	{/snippet}

	{#snippet panelB()}
		<div class="fig2">
			<p class="intro">
				A small MLP driving by raycast, racing the lap clock. The physics is fixed-timestep and
				deterministic, so a lap time means the same thing every run — which is what makes it
				trainable at all.
			</p>
			<RacerCanvas />
		</div>
	{/snippet}
</GameRail>

<div class="below">
	<section id="work">
		<h2>WORK</h2>
		<!-- PLACEHOLDER: delete this line and the entries below once real projects are in. -->
		<p class="placeholder-note">Placeholder entries — replace with real projects.</p>
		{#each projects as p (p.title)}
			<article class="entry">
				<h3>{p.title}</h3>
				<div class="meta">{p.meta}</div>
				<p>{p.body}</p>
				<div class="tags">
					{#each p.tags as t (t)}<span class="tag">{t}</span>{/each}
				</div>
			</article>
		{/each}
	</section>

	<section id="about">
		<h2>ABOUT</h2>
		<p class="about-lead">{headline}</p>
		<p class="about-body">
			<!-- PLACEHOLDER body copy -->
			Most of what is on this page exists because I wanted to know how the pieces fit together —
			how a network actually gets from self-play games to something you can click on. The
			training runs on my own machine, the checkpoints are exported to ONNX, and the site serves
			them as static files.
		</p>
	</section>

	<section id="contact">
		<h2>CONTACT</h2>
		<!-- PLACEHOLDER links — not real accounts. -->
		<div class="links">
			<a href="mailto:hello@example.com">hello@example.com</a>
			<a href="https://example.com">github</a>
			<a href="https://example.com">linkedin</a>
		</div>
	</section>

	<footer>© {new Date().getFullYear()} Lucas</footer>
</div>

<style>
	.topnav {
		position: fixed;
		inset: 0 0 auto 0;
		z-index: 60;
		display: flex;
		align-items: center;
		gap: 26px;
		padding: 14px 26px;
		background: color-mix(in srgb, var(--color-bg) 90%, transparent);
		backdrop-filter: blur(8px);
		border-bottom: 1px solid var(--color-border-soft);
		transform: translateY(-100%);
		transition: transform var(--transition-base);
	}

	.topnav.visible {
		transform: translateY(0);
	}

	.topnav a {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--color-text-muted);
		text-decoration: none;
		border: 0;
	}

	.topnav a:hover {
		color: var(--color-accent);
	}

	.topnav .brand {
		font-weight: 600;
		font-size: 13px;
		color: var(--color-text);
		margin-right: auto;
	}

	/* ── Fig. 1 ─────────────────────────────────────────────── */

	.fig1 {
		height: 100%;
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		align-items: center;
		gap: clamp(24px, 5vw, 80px);
		padding: clamp(84px, 14vh, 130px) clamp(28px, 6vw, 88px) clamp(28px, 6vh, 64px);
		box-sizing: border-box;
	}

	.fig1-copy {
		max-width: 46ch;
	}

	h1 {
		margin: 0;
		font-size: clamp(28px, 3.8vw, 50px);
		line-height: 1.12;
		letter-spacing: -0.03em;
		font-weight: 500;
		text-wrap: pretty;
	}

	.lead {
		margin: 24px 0 0;
		font-size: 16px;
		line-height: var(--line-height-prose);
		color: var(--color-text-body);
		max-width: 44ch;
	}

	.stats {
		display: flex;
		gap: 26px;
		margin-top: 30px;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--color-text-muted);
	}

	.stats b {
		color: var(--color-text);
		font-weight: 500;
	}

	.hint {
		margin-top: 34px;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--color-text-faint);
	}

	.fig1-figure {
		display: flex;
		justify-content: center;
		min-width: 0;
	}

	/* ── Fig. 2 ─────────────────────────────────────────────── */

	.fig2 {
		height: 100%;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		gap: clamp(12px, 2vh, 22px);
		padding: clamp(84px, 14vh, 130px) clamp(28px, 6vw, 88px) clamp(28px, 6vh, 64px);
		box-sizing: border-box;
	}

	.intro {
		margin: 0;
		font-size: 15px;
		line-height: var(--line-height-prose);
		color: var(--color-text-body);
		max-width: 62ch;
	}

	/* ── Below the fold ─────────────────────────────────────── */

	.below {
		max-width: 960px;
		margin: 0 auto;
		padding: clamp(60px, 10vh, 110px) clamp(24px, 6vw, 56px);
	}

	.below section {
		margin-bottom: clamp(48px, 8vh, 90px);
	}

	h2 {
		font-family: var(--font-mono);
		font-size: 12px;
		letter-spacing: 0.08em;
		color: var(--color-accent);
		font-weight: 500;
		margin: 0 0 var(--space-4);
	}

	.placeholder-note {
		margin: 0 0 var(--space-4);
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-text-faint);
	}

	.entry {
		border-top: 1px solid var(--color-border-soft);
		padding: 30px 0;
	}

	.entry h3 {
		margin: 0;
		font-size: 21px;
		font-weight: 500;
		letter-spacing: -0.02em;
	}

	.meta {
		margin-top: 6px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-text-faint);
	}

	.entry p {
		margin: 14px 0 0;
		font-size: 16px;
		line-height: var(--line-height-prose);
		color: var(--color-text-body);
		max-width: 66ch;
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 16px;
	}

	.tag {
		padding: 3px 9px;
		background: var(--color-cell);
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-text-muted);
	}

	.about-lead {
		font-size: clamp(21px, 2.6vw, 30px);
		font-weight: 300;
		line-height: 1.4;
		max-width: 26ch;
		margin: 0;
	}

	.about-body {
		margin: 24px 0 0;
		font-size: 16px;
		line-height: var(--line-height-prose);
		color: var(--color-text-body);
		max-width: 66ch;
	}

	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 12px 36px;
		font-family: var(--font-mono);
		font-size: 14px;
	}

	footer {
		border-top: 1px solid var(--color-border-soft);
		padding-top: 24px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-text-faintest);
	}

	/* Single column below ~760px, per the handoff. The board is sized from
	   viewport height, so it shrinks rather than overflowing. */
	@media (max-width: 760px) {
		.fig1 {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto minmax(0, 1fr);
			align-content: start;
			gap: clamp(16px, 3vh, 28px);
			padding-top: clamp(70px, 12vh, 100px);
		}

		.fig1-copy .lead,
		.fig1-copy .hint {
			display: none;
		}

		.stats {
			margin-top: 16px;
		}
	}
</style>
