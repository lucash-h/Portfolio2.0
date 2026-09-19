<script lang="ts">
	/**
	 * First-move frequency across all logged Connect 4 games, one cell per
	 * column. This is a 1-D distribution over board columns, so it is drawn
	 * as a single row of 7 cells laid out exactly like the board's columns
	 * (same order, same proportions) rather than as an abstract heatmap grid
	 * — the reader's mental model of "column 4 is the middle" transfers
	 * directly.
	 *
	 * Sequential magnitude -> one hue (the accent), light to dark by opacity.
	 * Every cell is also directly labeled with its count, so identity never
	 * depends on shade alone (there are only 7 values, so labeling all of
	 * them is the table, not "a number on every point" of a dense chart).
	 */
	import { formatCount } from './charts.ts';

	interface Props {
		/** Length-7 first-move counts, column 0..6 left to right. May be empty/undefined. */
		heatmap: number[] | undefined;
	}

	let { heatmap }: Props = $props();

	const COLS = 7;
	const cells = $derived.by(() => {
		const data = heatmap && heatmap.length === COLS ? heatmap : new Array(COLS).fill(0);
		const max = Math.max(...data, 0);
		return data.map((count, col) => ({
			col,
			count,
			opacity: max > 0 ? 0.12 + 0.88 * (count / max) : 0
		}));
	});
	const total = $derived(cells.reduce((a, c) => a + c.count, 0));
	const hasData = $derived(total > 0);

	const VIEW_W = 560;
	const VIEW_H = 140;
	const PAD = 16;
	const CELL_GAP = 4;
	const cellSize = $derived((VIEW_W - PAD * 2 - CELL_GAP * (COLS - 1)) / COLS);
</script>

<figure class="chart">
	<figcaption>
		<h3>Opening move distribution</h3>
		<p class="subtitle">Which column humans and AIs play first, across all logged games.</p>
	</figcaption>

	{#if !heatmap || heatmap.length === 0 || !hasData}
		<div class="empty" role="status">
			<p>
				No opening moves logged yet. Once games are played, this will show which of the 7
				columns gets picked first most often — laid out left to right just like the board.
			</p>
		</div>
	{:else}
		<svg
			viewBox="0 0 {VIEW_W} {VIEW_H}"
			role="img"
			aria-labelledby="heatmap-title heatmap-desc"
			class="viz-root"
		>
			<title id="heatmap-title">First-move frequency by column</title>
			<desc id="heatmap-desc">
				One row of 7 cells, one per board column, shaded by how often that column was
				played first, out of {formatCount(total)} opening moves total. Column
				{cells.reduce((best, c) => (c.count > best.count ? c : best), cells[0]).col + 1} is
				the most common.
			</desc>

			{#each cells as cell (cell.col)}
				{@const x = PAD + cell.col * (cellSize + CELL_GAP)}
				<g>
					<rect
						x={x}
						y={20}
						width={cellSize}
						height={cellSize}
						rx="6"
						class="cell-bg"
					/>
					<rect
						x={x}
						y={20}
						width={cellSize}
						height={cellSize}
						rx="6"
						class="cell-fill"
						style="opacity: {cell.opacity}"
					/>
					<text
						x={x + cellSize / 2}
						y={20 + cellSize / 2 - 4}
						text-anchor="middle"
						class="cell-count"
					>
						{formatCount(cell.count)}
					</text>
					<text
						x={x + cellSize / 2}
						y={20 + cellSize / 2 + 16}
						text-anchor="middle"
						class="cell-pct"
					>
						{total > 0 ? Math.round((cell.count / total) * 100) : 0}%
					</text>
					<text x={x + cellSize / 2} y={20 + cellSize + 20} text-anchor="middle" class="col-label">
						col {cell.col + 1}
					</text>
				</g>
			{/each}
		</svg>
	{/if}

	{#if heatmap && heatmap.length === COLS && hasData}
		<details class="table-view">
			<summary>Table view</summary>
			<table>
				<caption class="visually-hidden">First-move frequency by column</caption>
				<thead>
					<tr>
						<th scope="col">Column</th>
						<th scope="col">First moves</th>
						<th scope="col">Share</th>
					</tr>
				</thead>
				<tbody>
					{#each cells as cell (cell.col)}
						<tr>
							<td>{cell.col + 1}</td>
							<td>{cell.count}</td>
							<td>{total > 0 ? Math.round((cell.count / total) * 100) : 0}%</td>
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

	.cell-bg {
		fill: var(--color-bg-elevated);
		stroke: var(--color-border);
		stroke-width: 1;
	}

	.cell-fill {
		fill: var(--color-accent);
	}

	.cell-count {
		fill: var(--color-text);
		font-size: 13px;
		font-weight: 600;
	}

	.cell-pct {
		fill: var(--color-text-muted);
		font-size: 10px;
	}

	.col-label {
		fill: var(--color-text-muted);
		font-size: 10px;
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
