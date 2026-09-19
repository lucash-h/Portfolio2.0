<script lang="ts">
	/**
	 * Human vs AI outcomes per checkpoint, as stacked columns.
	 *
	 * Bar HEIGHT is the sample size (total games for that checkpoint) — a
	 * checkpoint with 2 games and a checkpoint with 2,000 both existing as
	 * bars of very different height is the point: a 100% win rate off 2
	 * games is not the same claim as off 2000, and this makes that visible
	 * without a separate "n=" chart.
	 *
	 * The AI-win segment is the accent color (the thing this whole page is
	 * trying to prove — is the network actually winning); human-win and draw
	 * are de-emphasized ink tones. Identity is never color-alone: every
	 * segment also gets a legend swatch + label, and the exact counts live
	 * in the table view.
	 */
	import type { CheckpointOutcomeRow } from './charts.ts';
	import { scaleLinear, niceMax, ticks, formatCount } from './charts.ts';

	interface Props {
		rows: CheckpointOutcomeRow[];
	}

	let { rows }: Props = $props();

	const PAD_LEFT = 44;
	const PAD_RIGHT = 16;
	const PAD_TOP = 28;
	const PAD_BOTTOM = 44;
	const VIEW_W = 640;
	const VIEW_H = 300;
	const plotW = VIEW_W - PAD_LEFT - PAD_RIGHT;
	const plotH = VIEW_H - PAD_TOP - PAD_BOTTOM;
	const BAR_MAX = 56;
	const GAP = 2; // surface-color gap between stacked segments

	const totals = $derived(rows.map((r) => r.humanWins + r.aiWins + r.draws));
	const maxTotal = $derived(niceMax(Math.max(...totals, 1)));
	const yTicks = $derived(ticks(maxTotal, 4));

	function barWidth(): number {
		if (rows.length === 0) return 0;
		const slot = plotW / rows.length;
		return Math.min(BAR_MAX, slot * 0.6);
	}

	function xFor(index: number): number {
		const slot = plotW / rows.length;
		return PAD_LEFT + slot * index + slot / 2;
	}

	function heightFor(count: number): number {
		return scaleLinear(count, 0, maxTotal, 0, plotH);
	}

	interface Segment {
		key: 'human' | 'draw' | 'ai';
		label: string;
		count: number;
		className: string;
	}

	function segmentsFor(row: CheckpointOutcomeRow): Segment[] {
		return [
			{ key: 'human', label: 'Human win', count: row.humanWins, className: 'seg-human' },
			{ key: 'draw', label: 'Draw', count: row.draws, className: 'seg-draw' },
			{ key: 'ai', label: 'AI win', count: row.aiWins, className: 'seg-ai' }
		];
	}

	const baselineY = $derived(PAD_TOP + plotH);
</script>

<figure class="chart">
	<figcaption>
		<h3>Human vs AI outcomes</h3>
		<p class="subtitle">Games played per checkpoint, by outcome.</p>
	</figcaption>

	{#if rows.length === 0}
		<div class="empty" role="status">
			<p>
				No games logged yet. Every play against a checkpoint on the Connect 4 exhibit is
				counted here — human wins, AI wins, and draws, per opponent tier.
			</p>
		</div>
	{:else}
		<div class="legend" role="list">
			<span class="legend-item" role="listitem"
				><span class="swatch seg-human" aria-hidden="true"></span>Human win</span
			>
			<span class="legend-item" role="listitem"
				><span class="swatch seg-draw" aria-hidden="true"></span>Draw</span
			>
			<span class="legend-item" role="listitem"
				><span class="swatch seg-ai" aria-hidden="true"></span>AI win</span
			>
		</div>

		<svg
			viewBox="0 0 {VIEW_W} {VIEW_H}"
			role="img"
			aria-labelledby="winrate-title winrate-desc"
			class="viz-root"
		>
			<title id="winrate-title">Human vs AI outcomes per checkpoint</title>
			<desc id="winrate-desc">
				Stacked column chart of {rows.length} checkpoint{rows.length === 1 ? '' : 's'}.
				Each column's height is its total games played; segments show human wins, draws,
				and AI wins.
			</desc>

			{#each yTicks as t, tickIndex (tickIndex)}
				<line
					x1={PAD_LEFT}
					x2={VIEW_W - PAD_RIGHT}
					y1={baselineY - heightFor(t)}
					y2={baselineY - heightFor(t)}
					class="gridline"
				/>
				<text x={PAD_LEFT - 8} y={baselineY - heightFor(t)} class="tick-label y-tick">
					{t}
				</text>
			{/each}

			<line x1={PAD_LEFT} x2={VIEW_W - PAD_RIGHT} y1={baselineY} y2={baselineY} class="axis-line" />

			{#each rows as row, i (row.checkpointId)}
				{@const w = barWidth()}
				{@const cx = xFor(i)}
				{@const n = totals[i]}
				<g>
					{#if n === 0}
						<text x={cx} y={baselineY - 6} class="no-games-label" text-anchor="middle">
							no games
						</text>
					{:else}
						{#each segmentsFor(row) as seg, segIndex (seg.key)}
							{@const priorCount = segmentsFor(row)
								.slice(0, segIndex)
								.reduce((a, s) => a + s.count, 0)}
							{@const segH = heightFor(seg.count)}
							{@const segTop = baselineY - heightFor(priorCount) - segH}
							{#if seg.count > 0}
								<rect
									x={cx - w / 2}
									y={segTop}
									width={w}
									height={Math.max(0, segH - GAP)}
									class={seg.className}
									role="img"
									aria-label={`${row.checkpointId}: ${seg.label} ${seg.count} of ${n}`}
								>
									<title>{row.checkpointId} — {seg.label}: {seg.count} of {n}</title>
								</rect>
							{/if}
						{/each}
						<text x={cx} y={baselineY - heightFor(n) - 8} class="n-label" text-anchor="middle">
							n={formatCount(n)}
						</text>
					{/if}
					<text x={cx} y={baselineY + 16} class="tick-label x-tick" text-anchor="middle">
						{row.checkpointId.length > 10
							? `${row.checkpointId.slice(0, 9)}…`
							: row.checkpointId}
					</text>
				</g>
			{/each}
		</svg>
	{/if}

	{#if rows.length > 0}
		<details class="table-view">
			<summary>Table view</summary>
			<table>
				<caption class="visually-hidden">Human vs AI outcomes by checkpoint</caption>
				<thead>
					<tr>
						<th scope="col">Checkpoint</th>
						<th scope="col">Human win</th>
						<th scope="col">Draw</th>
						<th scope="col">AI win</th>
						<th scope="col">Total</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as row (row.checkpointId)}
						<tr>
							<td>{row.checkpointId}</td>
							<td>{row.humanWins}</td>
							<td>{row.draws}</td>
							<td>{row.aiWins}</td>
							<td>{row.humanWins + row.draws + row.aiWins}</td>
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

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-4);
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.legend-item {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
	}

	.swatch {
		display: inline-block;
		width: 12px;
		height: 12px;
		border-radius: 2px;
	}

	.viz-root {
		width: 100%;
		height: auto;
		display: block;
		overflow: visible;
	}

	.gridline,
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

	.n-label {
		font-size: 10px;
		fill: var(--color-text);
		font-weight: 600;
	}

	.no-games-label {
		font-size: 10px;
		fill: var(--color-text-muted);
		font-style: italic;
	}

	.seg-human {
		fill: var(--color-text-muted);
	}

	.seg-draw {
		fill: var(--color-border);
	}

	.seg-ai {
		fill: var(--color-accent);
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
