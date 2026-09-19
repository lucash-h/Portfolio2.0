<script lang="ts">
	/**
	 * The money chart: Elo rating across checkpoints, weakest to strongest.
	 * This is the one visual proof that self-play training actually made the
	 * network stronger over time, so it gets a single accent-colored line
	 * (one series needs no legend — the title names it) with the strongest
	 * checkpoint's rating labeled directly.
	 *
	 * `elo` is null until the tournament (P3-C) has run for that checkpoint.
	 * That is a *distinct* state from "rated at 0" — it means "not measured",
	 * so those checkpoints are drawn as hollow markers sitting on the axis
	 * baseline, excluded from the line and from the y-domain, never plotted
	 * at a fabricated height.
	 */
	import type { CheckpointOutcomeRow } from './charts.ts';
	import { clamp, scaleLinear, niceMax, ticks } from './charts.ts';

	interface Props {
		rows: CheckpointOutcomeRow[];
	}

	let { rows }: Props = $props();

	const PAD_LEFT = 48;
	const PAD_RIGHT = 16;
	const PAD_TOP = 28;
	const PAD_BOTTOM = 36;
	const VIEW_W = 640;
	const VIEW_H = 280;
	const plotW = VIEW_W - PAD_LEFT - PAD_RIGHT;
	const plotH = VIEW_H - PAD_TOP - PAD_BOTTOM;

	const rated = $derived(rows.filter((r) => r.elo !== null) as (CheckpointOutcomeRow & {
		elo: number;
	})[]);
	const unratedCount = $derived(rows.length - rated.length);

	const domainMax = $derived(niceMax(Math.max(...rated.map((r) => r.elo), 100) + 40));
	const domainMin = $derived(
		rated.length > 0 ? Math.floor(Math.min(...rated.map((r) => r.elo), 0) / 20) * 20 - 20 : 0
	);
	const yTicks = $derived(ticks(domainMax - domainMin, 4).map((t) => t + domainMin));

	function xFor(index: number): number {
		if (rows.length <= 1) return PAD_LEFT + plotW / 2;
		return PAD_LEFT + scaleLinear(index, 0, rows.length - 1, 0, plotW);
	}

	function yFor(elo: number): number {
		return PAD_TOP + plotH - scaleLinear(elo, domainMin, domainMax, 0, plotH);
	}

	const linePoints = $derived(
		rows
			.map((r, i) => (r.elo === null ? null : { x: xFor(i), y: yFor(r.elo), row: r }))
			.filter((p): p is { x: number; y: number; row: CheckpointOutcomeRow } => p !== null)
	);

	const pathD = $derived(
		linePoints.length > 1
			? linePoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
			: ''
	);

	const strongest = $derived(rated.length > 0 ? rated[rated.length - 1] : null);
	const baselineY = $derived(PAD_TOP + plotH);

	function truncateLabel(label: string): string {
		return label.length > 10 ? `${label.slice(0, 9)}…` : label;
	}
</script>

<figure class="chart">
	<figcaption>
		<h3>Elo over training</h3>
		<p class="subtitle">
			Connect 4 checkpoints, weakest to strongest{strongest
				? ` — currently ${strongest.elo} Elo`
				: ''}.
		</p>
	</figcaption>

	{#if rows.length === 0}
		<div class="empty" role="status">
			<p>
				No checkpoints yet. Once self-play training exports at least one checkpoint, this
				chart will trace its Elo rating as training progresses.
			</p>
		</div>
	{:else}
		<svg
			viewBox="0 0 {VIEW_W} {VIEW_H}"
			role="img"
			aria-labelledby="elo-curve-title elo-curve-desc"
			class="viz-root"
		>
			<title id="elo-curve-title">Elo rating by checkpoint</title>
			<desc id="elo-curve-desc">
				{#if rated.length === 0}
					No checkpoint has a tournament rating yet.
				{:else}
					Line chart of {rated.length} rated checkpoint{rated.length === 1 ? '' : 's'},
					from {rated[0].elo} to {strongest?.elo} Elo.
					{#if unratedCount > 0}
						{unratedCount} additional checkpoint{unratedCount === 1 ? '' : 's'} exist but
						{unratedCount === 1 ? 'has' : 'have'} not been rated yet.
					{/if}
				{/if}
			</desc>

			<!-- y-axis gridlines + ticks -->
			{#each yTicks as t, tickIndex (tickIndex)}
				<line
					x1={PAD_LEFT}
					x2={VIEW_W - PAD_RIGHT}
					y1={yFor(t)}
					y2={yFor(t)}
					class="gridline"
				/>
				<text x={PAD_LEFT - 8} y={yFor(t)} class="tick-label y-tick">{t}</text>
			{/each}

			<!-- axis line -->
			<line x1={PAD_LEFT} x2={PAD_LEFT} y1={PAD_TOP} y2={baselineY} class="axis-line" />
			<line x1={PAD_LEFT} x2={VIEW_W - PAD_RIGHT} y1={baselineY} y2={baselineY} class="axis-line" />

			<!-- unrated checkpoints: hollow marker on the baseline, excluded from the line -->
			{#each rows as row, i (row.checkpointId)}
				{#if row.elo === null}
					<g class="unrated-marker">
						<circle cx={xFor(i)} cy={baselineY} r="5" class="marker-unrated" />
						<text x={xFor(i)} y={baselineY + 20} class="tick-label x-tick">
							{truncateLabel(row.checkpointId)}
						</text>
						<text x={xFor(i)} y={baselineY + 32} class="unrated-note">not yet rated</text>
					</g>
				{:else}
					<text x={xFor(i)} y={baselineY + 20} class="tick-label x-tick">
						{truncateLabel(row.checkpointId)}
					</text>
				{/if}
			{/each}

			<!-- the line itself -->
			{#if pathD}
				<path d={pathD} class="elo-line" fill="none" />
			{/if}

			<!-- rated markers, with a surface ring so they read clearly against the line -->
			{#each linePoints as p (p.row.checkpointId)}
				<circle cx={p.x} cy={p.y} r="6" class="marker-ring" />
				<circle cx={p.x} cy={p.y} r="4" class="marker-rated" />
			{/each}

			<!-- direct label on the strongest rated checkpoint -->
			{#if strongest && linePoints.length > 0}
				{@const last = linePoints[linePoints.length - 1]}
				<text x={last.x} y={last.y - 12} class="end-label" text-anchor="end">
					{strongest.elo}
				</text>
			{/if}

			{#if rated.length === 1}
				<text x={VIEW_W / 2} y={PAD_TOP + plotH / 2 - 14} class="single-point-note" text-anchor="middle">
					Only one rated checkpoint so far — a trend needs at least two.
				</text>
			{/if}
		</svg>
	{/if}

	{#if rows.length > 0}
		<details class="table-view">
			<summary>Table view</summary>
			<table>
				<caption class="visually-hidden">Elo rating by checkpoint</caption>
				<thead>
					<tr>
						<th scope="col">Checkpoint</th>
						<th scope="col">Elo</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as row (row.checkpointId)}
						<tr>
							<td>{row.checkpointId}</td>
							<td>{row.elo === null ? 'Not yet rated' : row.elo}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</details>
	{/if}
</figure>

<style>
	.chart {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		min-width: 0;
	}

	figcaption h3 {
		margin: 0;
		font-size: var(--font-size-md);
	}

	.subtitle {
		margin: var(--space-1) 0 0;
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
	}

	.viz-root {
		width: 100%;
		height: auto;
		display: block;
		overflow: visible;
	}

	.gridline {
		stroke: var(--color-border);
		stroke-width: 1;
	}

	.axis-line {
		stroke: var(--color-border);
		stroke-width: 1;
	}

	.tick-label {
		font-size: 10px;
		fill: var(--color-text-muted);
	}

	.y-tick {
		text-anchor: end;
		dominant-baseline: middle;
	}

	.x-tick {
		text-anchor: middle;
	}

	.unrated-note {
		text-anchor: middle;
		font-size: 9px;
		fill: var(--color-text-muted);
		font-style: italic;
	}

	.elo-line {
		stroke: var(--color-accent);
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;
	}

	.marker-ring {
		fill: var(--color-bg);
	}

	.marker-rated {
		fill: var(--color-accent);
	}

	.marker-unrated {
		fill: var(--color-bg);
		stroke: var(--color-text-muted);
		stroke-width: 2;
		stroke-dasharray: 2 2;
	}

	.end-label {
		fill: var(--color-text);
		font-size: 12px;
		font-weight: 600;
	}

	.single-point-note {
		fill: var(--color-text-muted);
		font-size: 11px;
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

	.table-view {
		font-size: var(--font-size-sm);
	}

	.table-view summary {
		cursor: pointer;
		color: var(--color-text-muted);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		margin-top: var(--space-2);
	}

	th,
	td {
		text-align: left;
		padding: var(--space-1) var(--space-2);
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
