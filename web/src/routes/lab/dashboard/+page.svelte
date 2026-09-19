<script lang="ts">
	/**
	 * The stats dashboard. This page is meant to be the strongest single
	 * artifact in the portfolio — it is what turns "there are two toy games"
	 * into "the machine learning behind them is real and measured."
	 *
	 * `GET /api/stats` (docs/CONTRACTS.md §7) is being built by a different
	 * package concurrently and may not exist yet, may 404, or may exist but
	 * report that nothing has happened yet. All three are the same case as
	 * far as this page is concerned: there is no data to show, and the
	 * honest response is to say so, not to render broken axes or fabricate
	 * numbers. Fetching happens client-side (like the connect4 exhibit's
	 * manifest fetch) rather than in a `load`, since this is a client-rendered
	 * lab page and the endpoint is explicitly cached/best-effort.
	 */
	import EloCurve from '$lib/components/EloCurve.svelte';
	import WinRateBars from '$lib/components/WinRateBars.svelte';
	import OpeningHeatmap from '$lib/components/OpeningHeatmap.svelte';
	import { EMPTY_STATS, formatCount, type StatsResponse } from '$lib/components/charts';

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
				// Missing endpoint, network failure, or malformed response — all
				// treated the same: show the empty-state dashboard rather than an
				// error page. The game UIs never depend on this succeeding.
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
</script>

<svelte:head>
	<title>Dashboard — Lab</title>
</svelte:head>

<h1>Dashboard</h1>
<p>
	Every chart below is built from real logged games and real trained checkpoints — nothing
	here is a mockup. Right now that data mostly doesn't exist yet: no games have been played
	against a trained network, and no tournament has run, so the honest state is empty charts
	that explain what will appear once training and play begin.
</p>

{#if status === 'unavailable'}
	<p class="status-note" role="status">
		The stats service isn't reachable right now, so the numbers below reflect nothing
		measured yet rather than an error.
	</p>
{/if}

<p class="total-games">
	<span class="total-games-value">{formatCount(stats.totalGames)}</span>
	<span class="total-games-label">games logged in total</span>
</p>

<section class="charts-grid">
	<div class="card">
		<EloCurve rows={stats.connect4.byCheckpoint} />
	</div>
	<div class="card">
		<WinRateBars rows={stats.connect4.byCheckpoint} />
	</div>
	<div class="card">
		<OpeningHeatmap heatmap={stats.connect4.openingHeatmap} />
	</div>
</section>

<section class="racer-section">
	<h2>Racer best times</h2>
	<p class="subtitle">Human vs AI best lap, per generation. Charts land once the racer exhibit ships.</p>
	{#if racerRows.length === 0}
		<div class="empty" role="status">
			<p>No racer checkpoints or races logged yet.</p>
		</div>
	{:else}
		<table>
			<caption class="visually-hidden">Racer best lap times by checkpoint</caption>
			<thead>
				<tr>
					<th scope="col">Checkpoint</th>
					<th scope="col">Human best (ms)</th>
					<th scope="col">AI best (ms)</th>
					<th scope="col">Races</th>
				</tr>
			</thead>
			<tbody>
				{#each racerRows as row (row.checkpointId)}
					<tr>
						<td>{row.checkpointId}</td>
						<td>{formatCount(row.humanBestMs)}</td>
						<td>{formatCount(row.aiBestMs)}</td>
						<td>{formatCount(row.races)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<style>
	.status-note {
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
		border-left: 3px solid var(--color-border);
		padding-left: var(--space-3);
	}

	.total-games {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		margin: var(--space-5) 0;
	}

	.total-games-value {
		font-size: var(--font-size-2xl);
		font-weight: 700;
		font-variant-numeric: proportional-nums;
	}

	.total-games-label {
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
	}

	.charts-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-5);
		margin-bottom: var(--space-7);
	}

	@media (min-width: 900px) {
		.charts-grid {
			grid-template-columns: repeat(2, 1fr);
		}
		.charts-grid .card:first-child {
			grid-column: 1 / -1;
		}
	}

	.card {
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-4);
		min-width: 0;
	}

	.racer-section h2 {
		font-size: var(--font-size-lg);
	}

	.racer-section .subtitle {
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
		margin-top: 0;
	}

	.empty {
		padding: var(--space-5);
		border: var(--border-width) dashed var(--color-border);
		border-radius: var(--radius-md);
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
	}

	.empty p {
		margin: 0;
	}

	table {
		width: 100%;
		border-collapse: collapse;
	}

	th,
	td {
		text-align: left;
		padding: var(--space-2);
		border-bottom: var(--border-width) solid var(--color-border);
		font-variant-numeric: tabular-nums;
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
</style>
