<script lang="ts">
	/**
	 * The lab: what the two exhibits have actually measured.
	 *
	 * This page existed once, at `/lab/dashboard`, and was deleted wholesale by
	 * the Notebook front-page redesign (381eadb) along with the rest of the
	 * route tree. Its three charts survived in `$lib/components` with their
	 * tests and have been rendering nowhere since. This restores them, rebuilt
	 * against the current design rather than the pre-redesign layout.
	 *
	 * `GET /api/stats` (CONTRACTS §7) is cached and best-effort: it may be
	 * absent, it may fail, or it may report that nothing has happened yet. All
	 * three are the same case here — there is nothing to show, and the honest
	 * response is to say so rather than render broken axes or invent numbers.
	 * Fetched client-side rather than in a `load`, matching how the exhibit
	 * fetches its manifest.
	 */
	import { page } from '$app/state';
	import EloCurve from '$lib/components/EloCurve.svelte';
	import WinRateBars from '$lib/components/WinRateBars.svelte';
	import OpeningHeatmap from '$lib/components/OpeningHeatmap.svelte';
	import {
		EMPTY_STATS,
		formatCount,
		formatLapMs,
		type StatsResponse
	} from '$lib/components/charts';

	const TITLE = 'Lab — what the exhibits have measured';
	const DESCRIPTION =
		'Elo, win rates and opening choices for the Connect 4 checkpoints, plus racer lap times. Built from logged games, with honest empty states.';

	const canonical = $derived(`${page.url.origin}${page.url.pathname}`);

	let stats = $state<StatsResponse>(EMPTY_STATS);
	let status = $state<'loading' | 'loaded' | 'unavailable'>('loading');

	$effect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch('/api/stats');
				if (!res.ok) throw new Error(`stats fetch failed: ${res.status}`);
				const data = (await res.json()) as StatsResponse;
				if (!cancelled) {
					stats = data;
					status = 'loaded';
				}
			} catch {
				if (!cancelled) {
					stats = EMPTY_STATS;
					status = 'unavailable';
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	});

	const racerRows = $derived(stats.racer.byCheckpoint);
	const c4Rows = $derived(stats.connect4.byCheckpoint);

	/** Whether anything has been measured at all. The intro explains the empty
	 *  page while that is true, and must stop claiming it the moment it is
	 *  not — a page that says "most of this is empty" above a full chart is
	 *  exactly the kind of stale copy this project keeps finding. */
	const nothingYet = $derived(
		stats.totalGames === 0 && c4Rows.length === 0 && racerRows.length === 0
	);
</script>

<svelte:head>
	<title>{TITLE}</title>
	<meta name="description" content={DESCRIPTION} />
	<link rel="canonical" href={canonical} />
	<meta property="og:type" content="website" />
	<meta property="og:title" content={TITLE} />
	<meta property="og:description" content={DESCRIPTION} />
	<meta property="og:url" content={canonical} />
	<meta property="og:image" content={`${page.url.origin}/og.png`} />
	<meta name="twitter:card" content="summary_large_image" />
</svelte:head>

<div class="lab">
	<nav class="crumb"><a href="/">← back to the portfolio</a></nav>

	<header class="intro">
		<h1>LAB</h1>
		{#if nothingYet}
			<p>
				Every number on this page comes from logged games and trained checkpoints. Nothing here
				is a mockup, which is also why it is empty: the site is not live yet, so almost nothing
				has been played. The charts say so rather than filling themselves in.
			</p>
		{:else}
			<p>
				Every number on this page comes from logged games and trained checkpoints. Nothing here
				is a mockup, and nothing is filled in to look busier than it is.
			</p>
		{/if}

		{#if status === 'unavailable'}
			<p class="note" role="status">
				The stats service is not reachable right now, so everything below reflects nothing
				measured — not an error in the exhibits.
			</p>
		{/if}

		<p class="total">
			<span class="total-value">{formatCount(stats.totalGames)}</span>
			<span class="total-label">games logged in total</span>
		</p>
	</header>

	<section>
		<h2>CONNECT 4</h2>
		{#if c4Rows.length === 0}
			<p class="empty" role="status">
				No games logged against a checkpoint yet. Once the site is live, each game played on the
				front page lands here: strength per checkpoint, win rates, and which column people open
				with.
			</p>
		{/if}
		<div class="charts">
			<div class="card"><EloCurve rows={c4Rows} /></div>
			<div class="card"><WinRateBars rows={c4Rows} /></div>
			<div class="card wide"><OpeningHeatmap heatmap={stats.connect4.openingHeatmap} /></div>
		</div>
	</section>

	<section>
		<h2>RACER</h2>
		{#if racerRows.length === 0}
			<p class="empty" role="status">
				No races logged. The pace cars are a hand-written heuristic today — there are no evolved
				checkpoints to compare against yet, so there is nothing honest to plot.
			</p>
		{:else}
			<div class="table-wrap">
				<table>
					<caption class="visually-hidden">Racer best lap times by checkpoint</caption>
					<thead>
						<tr>
							<th scope="col">Checkpoint</th>
							<th scope="col">Human best</th>
							<th scope="col">AI best</th>
							<th scope="col">Races</th>
						</tr>
					</thead>
					<tbody>
						{#each racerRows as row (row.checkpointId)}
							<tr>
								<td>{row.checkpointId}</td>
								<td>{formatLapMs(row.humanBestMs)}</td>
								<td>{formatLapMs(row.aiBestMs)}</td>
								<td>{formatCount(row.races)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>

<style>
	.lab {
		max-width: 960px;
		margin: 0 auto;
		padding: clamp(48px, 9vh, 96px) clamp(18px, 6vw, 56px) clamp(60px, 10vh, 110px);
	}

	.crumb {
		font-family: var(--font-mono);
		font-size: 12px;
		margin-bottom: clamp(28px, 5vh, 52px);
	}

	.crumb a {
		color: var(--color-text-faint);
		text-decoration: none;
		transition: var(--transition-base);
	}

	.crumb a:hover {
		color: var(--color-accent);
	}

	h1 {
		font-family: var(--font-mono);
		font-size: 12px;
		letter-spacing: 0.08em;
		color: var(--color-accent);
		font-weight: 500;
		margin: 0 0 var(--space-4);
	}

	.intro p {
		margin: 0 0 var(--space-4);
		font-size: 16px;
		line-height: var(--line-height-prose);
		color: var(--color-text-body);
		max-width: 62ch;
	}

	.note {
		border-left: 2px solid var(--color-accent-line);
		padding-left: var(--space-3);
		color: var(--color-text-muted);
		font-size: 14px;
	}

	.total {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		margin: clamp(28px, 5vh, 46px) 0 0;
	}

	.total-value {
		font-size: var(--font-size-2xl);
		font-weight: 600;
		letter-spacing: -0.02em;
		font-variant-numeric: proportional-nums;
	}

	.total-label {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--color-text-faint);
	}

	section {
		margin-top: clamp(48px, 8vh, 90px);
		border-top: 1px solid var(--color-border-soft);
		padding-top: clamp(20px, 3vh, 34px);
	}

	h2 {
		font-family: var(--font-mono);
		font-size: 12px;
		letter-spacing: 0.08em;
		color: var(--color-accent);
		font-weight: 500;
		margin: 0 0 var(--space-4);
	}

	.empty {
		margin: 0 0 var(--space-5);
		font-size: 15px;
		line-height: var(--line-height-prose);
		color: var(--color-text-muted);
		max-width: 62ch;
	}

	.charts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
		gap: clamp(16px, 2.5vw, 28px);
	}

	.card {
		min-width: 0;
		border: var(--border-width) solid var(--color-border);
		background: var(--color-surface);
		padding: clamp(14px, 2vw, 22px);
	}

	.card.wide {
		grid-column: 1 / -1;
	}

	/* A table is the right element for per-checkpoint lap times; on a narrow
	   screen it scrolls inside its own box rather than widening the page. */
	.table-wrap {
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-family: var(--font-mono);
		font-size: 13px;
	}

	th,
	td {
		text-align: left;
		padding: 10px 14px 10px 0;
		border-bottom: 1px solid var(--color-border-soft);
		white-space: nowrap;
	}

	th {
		color: var(--color-text-faint);
		font-weight: 500;
		font-size: 11px;
		letter-spacing: 0.04em;
	}

	td {
		color: var(--color-text);
	}
</style>
