<script lang="ts">
	/**
	 * Connect 4 board UI.
	 *
	 * Game rules live entirely in `$lib/games/connect4/engine`. This component
	 * only renders a GameState and turns input into `applyMove` calls. It never
	 * computes legality, winners, or board layout rules itself.
	 *
	 * Board geometry per CONTRACTS §3: `board` is a flat length-42 array,
	 * index = row * COLS + col, and ROW 0 IS THE BOTTOM ROW. The render loop
	 * below walks visual rows top-to-bottom but maps each visual row to
	 * `ROWS - 1 - visualRow` before indexing into the board, so a disc dropped
	 * into column 3 appears at the bottom of the grid, not the top.
	 *
	 * Interaction model: the seven column buttons above the board are the sole
	 * interactive surface (click, tap, or keyboard). The board grid beneath is
	 * a presentational read-out of state, exposed to assistive tech as a table
	 * with cell labels, not as a second set of controls — Connect 4 has one
	 * degree of freedom per turn (which column), so one set of controls is
	 * enough and avoids duplicate/confusing focus stops.
	 */
	import { createGame, legalMoves, applyMove, isTerminal } from '$lib/games/connect4/engine';
	import { ROWS, COLS, idx, type Column, type GameState } from '$lib/games/connect4/types';

	interface Props {
		/**
		 * Supplies the opponent's move. Called with the current state whenever
		 * it is the opponent's turn. The board awaits the promise and then
		 * applies the returned column. The caller is responsible for supplying
		 * a function that only ever returns a legal column.
		 */
		opponentMove: (game: GameState) => Promise<Column>;
		/** Which player the human controls. Defaults to 1 (moves first). */
		humanPlayer?: 1 | 2;
		/** Called after every state change (human or opponent move, new game). */
		onStateChange?: (game: GameState) => void;
	}

	let { opponentMove, humanPlayer = 1, onStateChange }: Props = $props();

	let game = $state<GameState>(createGame());
	let cursorCol = $state<Column>(3);
	let hoverCol = $state<Column | null>(null);
	let awaitingOpponent = $state(false);
	let announcement = $state('');
	let prefersReducedMotion = $state(false);
	let fallingDisc = $state<{ col: Column; row: number; player: 1 | 2 } | null>(null);
	let columnButtons: (HTMLButtonElement | null)[] = [];

	const terminal = $derived(isTerminal(game));
	const legal = $derived(new Set(legalMoves(game)));

	$effect(() => {
		if (typeof window === 'undefined') return;
		const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
		prefersReducedMotion = mq.matches;
		const handler = (e: MediaQueryListEvent) => {
			prefersReducedMotion = e.matches;
		};
		mq.addEventListener('change', handler);
		return () => mq.removeEventListener('change', handler);
	});

	function landingRow(col: Column): number | null {
		for (let row = 0; row < ROWS; row++) {
			if (game.board[idx(row, col)] === 0) return row;
		}
		return null;
	}

	function playerLabel(p: 1 | 2): string {
		return p === 1 ? 'Red' : 'Yellow';
	}

	function resultText(): string {
		if (game.winner) {
			const who = game.winner === humanPlayer ? 'You' : 'The opponent';
			return `${who} won as ${playerLabel(game.winner)}.`;
		}
		if (game.isDraw) return 'The game is a draw.';
		return '';
	}

	async function drop(col: Column) {
		if (terminal || awaitingOpponent) return;
		if (!legal.has(col)) return;
		if (game.toMove !== humanPlayer) return;

		const row = landingRow(col);
		commitMove(col, row);

		await maybeRunOpponent();
	}

	function commitMove(col: Column, row: number | null) {
		const mover = game.toMove;
		const next = applyMove(game, col);
		game = next;
		onStateChange?.(next);

		if (row !== null) {
			if (prefersReducedMotion) {
				fallingDisc = null;
			} else {
				fallingDisc = { col, row, player: mover };
				setTimeout(() => {
					if (fallingDisc?.col === col && fallingDisc?.row === row) {
						fallingDisc = null;
					}
				}, 420);
			}
		}

		if (next.winner) {
			announcement = `${playerLabel(mover)} dropped in column ${col + 1}. ${playerLabel(next.winner)} wins.`;
		} else if (next.isDraw) {
			announcement = `${playerLabel(mover)} dropped in column ${col + 1}. The game is a draw.`;
		} else {
			announcement = `${playerLabel(mover)} dropped in column ${col + 1}.`;
		}
	}

	async function maybeRunOpponent() {
		if (isTerminal(game)) return;
		if (game.toMove === humanPlayer) return;

		awaitingOpponent = true;
		try {
			const col = await opponentMove(game);
			if (!legalMoves(game).includes(col)) {
				throw new Error(`opponentMove returned illegal column ${col}`);
			}
			const row = landingRow(col);
			commitMove(col, row);
		} finally {
			awaitingOpponent = false;
		}
	}

	function newGame() {
		game = createGame();
		fallingDisc = null;
		hoverCol = null;
		awaitingOpponent = false;
		announcement = 'New game started.';
		onStateChange?.(game);
		void maybeRunOpponent();
	}

	function moveCursor(delta: number) {
		const next = ((cursorCol + delta + COLS) % COLS) as Column;
		cursorCol = next;
		columnButtons[next]?.focus();
	}

	function onColumnKeydown(e: KeyboardEvent, col: Column) {
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			moveCursor(-1);
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			moveCursor(1);
		} else if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			void drop(col);
		}
	}

	function isWinningCell(row: number, col: number): boolean {
		if (!game.winningCells) return false;
		return game.winningCells.includes(idx(row, col));
	}

	function cellPlayer(row: number, col: number): 0 | 1 | 2 {
		return game.board[idx(row, col)];
	}

	function cellDescription(row: number, col: number): string {
		const p = cellPlayer(row, col);
		return p === 0 ? 'empty' : `${playerLabel(p)} disc`;
	}
</script>

<div class="c4">
	<div class="status">
		{#if terminal}
			<p class="result">{resultText()}</p>
		{:else if awaitingOpponent}
			<p>Opponent is thinking…</p>
		{:else}
			<p>{playerLabel(game.toMove)} to move{game.toMove === humanPlayer ? ' (you)' : ''}.</p>
		{/if}
	</div>

	<div class="board-wrap">
		<div class="column-controls" role="group" aria-label="Drop a disc into a column">
			{#each Array(COLS) as _, col (col)}
				{@const disabled = terminal || awaitingOpponent || !legal.has(col as Column)}
				<button
					bind:this={columnButtons[col]}
					type="button"
					class="col-button"
					class:hover-preview={hoverCol === col && !disabled}
					tabindex={cursorCol === col ? 0 : -1}
					{disabled}
					aria-label={`Drop in column ${col + 1}`}
					onclick={() => {
						cursorCol = col as Column;
						void drop(col as Column);
					}}
					onkeydown={(e) => onColumnKeydown(e, col as Column)}
					onmouseenter={() => (hoverCol = col as Column)}
					onmouseleave={() => (hoverCol = null)}
					onfocus={() => (cursorCol = col as Column)}
				>
					<span aria-hidden="true">▼</span>
				</button>
			{/each}
		</div>

		<table class="board" aria-label="Connect 4 board, 6 rows by 7 columns, row 1 is the bottom">
			<caption class="visually-hidden">Current board state</caption>
			<tbody>
				{#each Array(ROWS) as _, visualRow (visualRow)}
					{@const row = ROWS - 1 - visualRow}
					<tr>
						{#each Array(COLS) as _, col (col)}
							{@const player = cellPlayer(row, col)}
							{@const isFalling =
								!prefersReducedMotion && fallingDisc?.col === col && fallingDisc?.row === row}
							<td
								class="cell"
								class:hover-preview={hoverCol === col && legal.has(col as Column) && !terminal}
							>
								<span class="visually-hidden"
									>Row {visualRow + 1}, column {col + 1}: {cellDescription(row, col)}</span
								>
								{#if player}
									<span
										class="disc"
										aria-hidden="true"
										class:disc-red={player === 1}
										class:disc-yellow={player === 2}
										class:falling={isFalling}
										class:winning={isWinningCell(row, col)}
										style={isFalling ? `--fall-distance: ${ROWS - 1 - row}` : undefined}
									></span>
								{/if}
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<div class="controls">
		<button type="button" class="new-game" onclick={newGame}>New game</button>
	</div>

	<p class="live-region visually-hidden" role="status" aria-live="polite">{announcement}</p>
</div>

<style>
	.c4 {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		align-items: center;
		width: 100%;
	}

	.status p {
		margin: 0;
		font-size: var(--font-size-md);
		max-width: none;
	}

	.status .result {
		font-weight: 600;
		color: var(--color-accent);
	}

	.board-wrap {
		width: 100%;
		max-width: 32rem;
	}

	.column-controls {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: var(--space-1);
		margin-bottom: var(--space-1);
	}

	.col-button {
		--c4-control-min: 44px;
		min-width: var(--c4-control-min);
		min-height: var(--c4-control-min);
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--color-bg-elevated);
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-sm);
		color: var(--color-text-muted);
		cursor: pointer;
		font-size: var(--font-size-md);
	}

	.col-button:disabled {
		cursor: default;
		opacity: 0.4;
	}

	.col-button.hover-preview {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.board {
		width: 100%;
		border-collapse: separate;
		border-spacing: var(--space-1);
		background: var(--color-bg-elevated);
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-md);
		table-layout: fixed;
	}

	.cell {
		position: relative;
		aspect-ratio: 1 / 1;
		background: var(--color-bg);
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: var(--space-1);
		text-align: center;
		overflow: visible;
	}

	.cell.hover-preview {
		background: color-mix(in srgb, var(--color-accent) 12%, var(--color-bg));
	}

	.disc {
		display: block;
		width: 82%;
		height: 82%;
		margin: 0 auto;
		border-radius: 50%;
	}

	.disc-red {
		background: #c23b3b;
	}

	.disc-yellow {
		background: #d9a721;
	}

	.disc.winning {
		box-shadow: 0 0 0 3px var(--color-accent);
	}

	.disc.falling {
		animation: fall 350ms cubic-bezier(0.3, 0, 0.7, 1) 1;
	}

	@keyframes fall {
		from {
			transform: translateY(calc(-1 * var(--fall-distance, 0) * (100% + var(--space-1) * 2)));
		}
		to {
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.disc.falling {
			animation: none;
		}
	}

	.controls {
		display: flex;
		justify-content: center;
	}

	.new-game {
		min-height: 44px;
		padding: var(--space-2) var(--space-5);
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-accent);
		color: var(--color-accent-contrast);
		font-weight: 600;
		cursor: pointer;
		transition: opacity var(--transition-fast);
	}

	.new-game:hover {
		opacity: 0.9;
	}

	@media (max-width: 360px) {
		.board-wrap {
			max-width: 100%;
		}
	}
</style>
