<script lang="ts">
	/**
	 * Front page.
	 *
	 * A pinned horizontal rail holding the two ML figures, then Work / About /
	 * Contact below the fold. Built from the "Notebook" design handoff, with the
	 * design's hardcoded palette expressed through tokens so dark mode survives.
	 *
	 * Content is real: the projects, the about copy and the contact links are
	 * ported from the previous portfolio (github.com/lucash-h/Portfolio_Website)
	 * and checked against the repositories they point at.
	 */
	import { page } from '$app/state';
	import GameRail from '$lib/components/GameRail.svelte';
	import Connect4Figure from '$lib/components/Connect4Figure.svelte';
	import RacerCanvas from '$lib/components/RacerCanvas.svelte';

	// ---------------------------------------------------------------------
	// Page metadata and link previews.
	//
	// The absolute URLs come from the request rather than a hardcoded domain,
	// so the same build is correct on localhost, on a staging host and on the
	// real domain. That makes them only as correct as SvelteKit's idea of the
	// origin: behind Caddy, adapter-node needs PROTOCOL_HEADER/HOST_HEADER (or
	// ORIGIN) or it will report the internal http://localhost:3000 and every
	// preview will point at nothing. Both are set in infra/docker-compose.yml.
	// ---------------------------------------------------------------------

	const SITE_TITLE = 'Lucas — portfolio';
	const SITE_DESCRIPTION =
		'Software engineering student. Two machine-learning exhibits that run entirely in the browser.';
	const OG_IMAGE_ALT =
		'Lucas — two machine-learning exhibits that run in your browser. Connect 4 self-play and a raycast racer.';

	/** Canonical URL: origin + path, deliberately without query or hash, so a
	 *  link with `#work` on the end does not become a second canonical URL. */
	const canonical = $derived(`${page.url.origin}${page.url.pathname}`);
	const ogImage = $derived(`${page.url.origin}/og.png`);

	const headline =
		'Lucas Hately-Honeyman — software engineering student at the University of Victoria, training small networks and putting them on the web.';

	interface Project {
		title: string;
		meta: string;
		body: string;
		tags: string[];
		/** Repository, when there is a public one to show. */
		href?: string;
	}

	const projects: Project[] = [
		{
			title: 'NeatInfo',
			meta: '2026 · JavaScript, Cloudflare Workers, D1, R2',
			body:
				'A reading tracker built so the backlog can never become a guilt pile: anything left ' +
				'undecided past the lapse window resolves itself to “lapsed” rather than sitting there ' +
				'forever. Three surfaces — today, pending, archive — and nothing is ever deleted, so ' +
				'the archive stays searchable. One Worker serves both the API and the built frontend, ' +
				'with D1 for the queryable data and R2 for raw HTML.',
			tags: ['cloudflare', 'sqlite', 'full-stack'],
			href: 'https://github.com/lucash-h/NeatInfo'
		},
		{
			title: 'dev-pipeline — a Claude Code plugin',
			meta: '2026 · Python, Claude Code',
			body:
				'Takes a feature from idea to merged code: a PRD whose acceptance criteria are ' +
				'machine-checkable, a build loop that tests against them, and a gate that re-reads the ' +
				'finished diff against those criteria from cold context — because the model that wrote ' +
				'the code is the worst judge of whether it meets the spec.',
			tags: ['agents', 'tooling', 'ci'],
			href: 'https://github.com/lucash-h/Claudius_The_Third'
		},
		{
			title: 'AWS DeepRacer',
			meta: '2025 · Python, reinforcement learning',
			body:
				'A reward function tracking distance from the centre line across five markers instead ' +
				'of three, tuned hard for speed. It won in simulation and drove badly on the physical ' +
				'car — the 0.5–4 speed interval left it either crawling or out of control, where 0.5–2 ' +
				'would have been the right range. The most useful thing I got out of it was a concrete ' +
				'sense of how far a reward shaped to the simulator can be from the track it runs on.',
			tags: ['rl', 'reward-shaping', 'sim-to-real'],
			href: 'https://github.com/lucash-h/AWS_Deepracer'
		},
		{
			title: 'Manifold-Guided GAN',
			meta: '2024 · Python, TensorFlow',
			body:
				'A GAN that fights mode collapse with a second discriminator. Generated digits go ' +
				'through an encoder down to a 64-element latent vector and are judged there as well as ' +
				'at pixel level, so the generator is penalised for collapsing onto a handful of samples ' +
				'instead of covering the dataset. It sits next to a plain MNIST GAN in the same ' +
				'repository, which is what makes the difference legible.',
			tags: ['tensorflow', 'gans', 'mnist'],
			href: 'https://github.com/lucash-h/GANS'
		}
	];

	interface Experience {
		role: string;
		company: string;
		period: string;
		/** One line per thing worth saying; rendered as a list. */
		points: string[];
		tags: string[];
		href?: string;
		/** Marks the entry as not-yet-written. Anything true here renders a
		 *  visible warning above the section, so a half-filled entry cannot go
		 *  live quietly — see the note in `docs/STATUS.md` (P0-C). */
		placeholder?: boolean;
	}

	// PLACEHOLDER — Lucas is filling this in. Every field below is a stand-in,
	// not a description of the job. Delete `placeholder: true` once it is real
	// and the warning banner disappears with it.
	const experience: Experience[] = [
		{
			placeholder: true,
			role: 'TODO — job title',
			company: 'Brilliant Harvest',
			period: 'TODO — e.g. May–August 2025',
			points: [
				'TODO — the main thing you built or owned, and what it was for.',
				'TODO — a second piece of work, ideally one you would defend in an interview.',
				'TODO — anything measurable: throughput, time saved, scale, users.'
			],
			tags: ['todo — tech you used']
		}
	];

	const hasPlaceholderExperience = $derived(experience.some((e) => e.placeholder));

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
	<title>{SITE_TITLE}</title>
	<meta name="description" content={SITE_DESCRIPTION} />
	<link rel="canonical" href={canonical} />

	<meta property="og:type" content="website" />
	<meta property="og:site_name" content="Lucas" />
	<meta property="og:title" content={SITE_TITLE} />
	<meta property="og:description" content={SITE_DESCRIPTION} />
	<meta property="og:url" content={canonical} />
	<meta property="og:image" content={ogImage} />
	<meta property="og:image:type" content="image/png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content={OG_IMAGE_ALT} />

	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={SITE_TITLE} />
	<meta name="twitter:description" content={SITE_DESCRIPTION} />
	<meta name="twitter:image" content={ogImage} />
	<meta name="twitter:image:alt" content={OG_IMAGE_ALT} />
</svelte:head>

<nav class="topnav" class:visible={navVisible}>
	<a class="brand" href="#top">Lucas</a>
	<a href="#experience">experience</a>
	<a href="#work">work</a>
	<a href="#about">about</a>
	<a href="#contact">contact</a>
</nav>

<GameRail titleA="FIG. 1 — CONNECT 4 SELF-PLAY" titleB="FIG. 2 — RACER">
	{#snippet panelA()}
		<div class="fig1">
			<div class="fig1-copy">
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
	<section id="experience">
		<h2>EXPERIENCE</h2>
		{#if hasPlaceholderExperience}
			<p class="placeholder-note">
				Placeholder — this entry is not written yet. Do not ship it like this.
			</p>
		{/if}
		{#each experience as job (job.company + job.role)}
			<article class="entry" class:is-placeholder={job.placeholder}>
				<h3>
					{#if job.href}
						<a class="entry-link" href={job.href} target="_blank" rel="noreferrer noopener">
							{job.company}
						</a>
					{:else}
						{job.company}
					{/if}
				</h3>
				<div class="meta">{job.role} · {job.period}</div>
				<ul class="points">
					{#each job.points as point (point)}
						<li>{point}</li>
					{/each}
				</ul>
				<div class="tags">
					{#each job.tags as t (t)}<span class="tag">{t}</span>{/each}
				</div>
			</article>
		{/each}
	</section>

	<section id="work">
		<h2>WORK</h2>
		{#each projects as p (p.title)}
			<article class="entry">
				<h3>
					{#if p.href}
						<a class="entry-link" href={p.href} target="_blank" rel="noreferrer noopener">
							{p.title}
						</a>
					{:else}
						{p.title}
					{/if}
				</h3>
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
			Most of what is on this page exists because I wanted to know how the pieces fit together —
			how a network actually gets from self-play games to something you can click on. The
			training runs on my own machine, the checkpoints are exported to ONNX, and the site serves
			them as static files.
		</p>
		<p class="about-body">
			Outside of that I whitewater kayak, downhill ski, and read about whatever tech topic has my
			attention that week.
		</p>
	</section>

	<section id="contact">
		<h2>CONTACT</h2>
		<div class="links">
			<a href="mailto:lhatelyhoneyman@gmail.com">lhatelyhoneyman@gmail.com</a>
			<a href="https://github.com/lucash-h" target="_blank" rel="noreferrer noopener">github</a>
			<a
				href="https://www.linkedin.com/in/lucas-hately-honeyman-2bb481235/"
				target="_blank"
				rel="noreferrer noopener">linkedin</a
			>
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
		/* Explicit, and capped at the panel: an implicit column is `auto`, which
		   sizes to its widest max-content child. The racer's bottom strip is a
		   row of nowrap readouts, so on a phone it was setting the panel width
		   and pushing the canvas ~40px past the viewport, where `overflow:
		   hidden` on the rail quietly cut it off. */
		grid-template-columns: minmax(0, 1fr);
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

	.placeholder-note {
		margin: 0 0 var(--space-4);
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-accent);
		border: 1px dashed var(--color-accent-line);
		background: var(--color-accent-wash-soft);
		padding: 8px 12px;
	}

	/* Unwritten entries read as drafts rather than as content. */
	.entry.is-placeholder {
		border-left: 2px dashed var(--color-accent-line);
		padding-left: var(--space-4);
	}

	.points {
		margin: var(--space-3) 0 0;
		padding-left: 1.1rem;
		color: var(--color-text-body);
	}

	.points li {
		margin-bottom: 6px;
		line-height: var(--line-height-prose);
	}

	.entry-link {
		color: inherit;
		text-decoration: none;
		border-bottom: 1px solid var(--color-accent-line);
		transition: var(--transition-base);
	}

	.entry-link:hover {
		color: var(--color-accent);
		border-bottom-color: var(--color-accent);
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
	   viewport height, so it shrinks rather than overflowing. GameRail swaps
	   to its tab layout at the same breakpoint. */
	@media (max-width: 760px) {
		.fig1 {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto minmax(0, 1fr);
			align-content: start;
			gap: clamp(16px, 3vh, 28px);
			padding: clamp(70px, 12vh, 100px) clamp(14px, 4vw, 28px) clamp(18px, 3vh, 32px);
		}

		.fig1-copy .lead,
		.fig1-copy .hint {
			display: none;
		}

		.stats {
			margin-top: 16px;
		}

		.fig2 {
			padding: clamp(70px, 12vh, 100px) clamp(14px, 4vw, 28px) clamp(18px, 3vh, 32px);
		}

		/* The tracks are wide (the Grand Circuit is roughly 2.7:1), so on a
		   phone the canvas is width-limited and any extra height is empty
		   grey. Cap it: the panel then fits one screen, which keeps the
		   controls out from under the sticky tabs. The floor stops it
		   collapsing to a sliver when the strip below wraps to four lines. */
		.fig2 :global(.canvas-frame) {
			min-height: 30svh;
			max-height: 40svh;
		}

		.intro {
			font-size: 14px;
		}

		/* Four nav items plus the theme toggle do not fit on a phone; the
		   sections are a short scroll apart anyway. */
		.topnav a:not(.brand) {
			font-size: 12px;
		}
	}
</style>
