<script lang="ts">
	/**
	 * Fig. 1 — Connect 4 self-play exhibit for the front page.
	 *
	 * Owns all game state itself: the page only gets `onGameEnd` / `onLatency`
	 * callbacks. Visual spec is the design handoff (`Front - Notebook.dc.html`,
	 * "Fig. 1 — Connect 4"): policy bars, board, opponent tier controls, caption.
	 *
	 * Rules and board geometry come from `$lib/games/connect4/engine` +
	 * `types` — this component never reimplements Connect 4 rules. Board index
	 * layout: flat length-42 array, index = row * COLS + col, row 0 is the
	 * BOTTOM row (see types.ts).
	 *
	 * Opponent moves prefer the real ONNX checkpoint (`$lib/ml/session`,
	 * `$lib/ml/registry`) and fall back to the local minimax search
	 * (`$lib/games/connect4/minimaxClient`) if the manifest is missing or a
	 * checkpoint fails to load/run — never freezing the exhibit.
	 *
	 * Accessibility: keyboard arrow keys move a column cursor, Enter/Space
	 * (native <button> behaviour) drops, a visible focus ring uses
	 * `--color-focus-ring`, and an `aria-live` region plus a visually-hidden
	 * board read-out announce moves and results — mirroring the pattern
	 * established in `Connect4Board.svelte`.
	 *
	 * Svelte 5 runes only. Deliberately never naming any variable `state` —
	 * that shadows the `$state` rune globally in this file.
	 */
	import { createGame, legalMoves, applyMove, isTerminal } from '$lib/games/connect4/engine';
	import { ROWS, COLS, idx, type Column, type GameState } from '$lib/games/connect4/types';
	import { chooseMove } from '$lib/ml/session';
	import { loadManifest, getConnect4Checkpoints } from '$lib/ml/registry';
	import type { Connect4CheckpointEntry } from '$lib/ml/mlTypes';
	import { chooseMoveAsync, disposeMinimaxWorker } from '$lib/games/connect4/minimaxClient';

	interface Props {
		/** Fires when a game ends, so the page can POST /api/games and bump its counter. */
		onGameEnd?: (r: {
			checkpointId: string;
			outcome: 'human_win' | 'ai_win' | 'draw';
			moves: number[];
			durationMs: number;
		}) => void;
		/** Most recent measured inference time, for the page's stat row. */
		onLatency?: (ms: number) => void;
	}

	let { onGameEnd, onLatency }: Props = $props();

	const HUMAN_PLAYER = 1 as const;
	const DEMO_INITIAL_DELAY_MS = 900;
	const DEMO_STEP_DELAY_MS = 760;
	const TAKEOVER_BOT_DELAY_MS = 420;
	const HUMAN_BOT_DELAY_MS = 520;
	const END_OF_GAME_DELAY_MS = 2200;

	let mode = $state<'demo' | 'human'>('demo');
	let game = $state<GameState>(createGame());
	let policy = $state<number[]>(new Array(COLS).fill(0));
	let announcement = $state('');
	let cursorCol = $state<Column>(3);
	let fallingDisc = $state<{ col: Column; row: number; player: 1 | 2 } | null>(null);
	let prefersReducedMotion = $state(false);

	let checkpoints = $state<Connect4CheckpointEntry[]>([]);
	let selectedTierId = $state<string | null>(null);
	let manifestFallback = $state(false);
	let fallbackNote = $state('');

	let columnButtons: (HTMLButtonElement | null)[] = [];

	// Guards against stale async work (from a previous round or after unmount)
	// applying a move to a board that has since moved on.
	let epoch = 0;
	let destroyed = false;
	let demoTimer: ReturnType<typeof setTimeout> | undefined;
	let botTimer: ReturnType<typeof setTimeout> | undefined;
	let endTimer: ReturnType<typeof setTimeout> | undefined;
	let fallTimer: ReturnType<typeof setTimeout> | undefined;
	let gameStartedAt = 0;

	const terminalNow = $derived(isTerminal(game));
	const legalSet = $derived(new Set(legalMoves(game)));

	function clearScheduled(): void {
		clearTimeout(demoTimer);
		clearTimeout(botTimer);
		clearTimeout(endTimer);
		demoTimer = undefined;
		botTimer = undefined;
		endTimer = undefined;
	}

	$effect(() => {
		destroyed = false;
		epoch++;
		const myEpoch = epoch;

		void (async () => {
			const result = await loadManifest();
			if (myEpoch !== epoch || destroyed) return;
			if (result.ok) {
				const list = getConnect4Checkpoints(result.manifest);
				if (list.length > 0) {
					checkpoints = list;
					selectedTierId = list[list.length - 1].id;
					manifestFallback = false;
					fallbackNote = '';
					return;
				}
			}
			manifestFallback = true;
			fallbackNote = ' (checkpoints unavailable — using local search)';
		})();

		gameStartedAt = performance.now();
		demoTimer = setTimeout(() => void runDemoStep(myEpoch), DEMO_INITIAL_DELAY_MS);

		return () => {
			destroyed = true;
			epoch++;
			clearScheduled();
			clearTimeout(fallTimer);
			disposeMinimaxWorker();
		};
	});

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

	function demoCheckpoint(): Connect4CheckpointEntry | null {
		return checkpoints[0] ?? null;
	}

	function botCheckpoint(): Connect4CheckpointEntry | null {
		return checkpoints.find((c) => c.id === selectedTierId) ?? checkpoints[checkpoints.length - 1] ?? null;
	}

	function botLabel(): string {
		return botCheckpoint()?.label ?? 'local search';
	}

	function playerLabel(p: 1 | 2): string {
		return p === HUMAN_PLAYER ? 'green' : 'ink';
	}

	function statusLine(): string {
		if (mode === 'demo') return 'two checkpoints playing each other';
		if (terminalNow) {
			if (game.isDraw) return 'draw';
			if (game.winner === HUMAN_PLAYER) return 'you win';
			return `${botLabel()} wins`;
		}
		if (game.toMove === HUMAN_PLAYER) return 'your move, you are green';
		return `${botLabel()} is searching`;
	}

	function landingRowIn(board: GameState['board'], col: Column): number | null {
		for (let row = 0; row < ROWS; row++) {
			if (board[idx(row, col)] === 0) return row;
		}
		return null;
	}

	/** Runs a checkpoint's policy if one is available, else the minimax fallback. Never throws. */
	async function pickMove(
		checkpoint: Connect4CheckpointEntry | null,
		g: GameState
	): Promise<{ col: Column; policy: Float32Array | null }> {
		const legal = legalMoves(g);
		if (checkpoint) {
			const t0 = performance.now();
			const result = await chooseMove(checkpoint, g, legal, { mode: 'greedy' });
			const elapsedMs = performance.now() - t0;
			if (result.ok) {
				onLatency?.(elapsedMs);
				return { col: result.column, policy: result.prediction.policy };
			}
			manifestFallback = true;
			fallbackNote = ` (${checkpoint.label} failed to run — using local search)`;
		}
		const col = await chooseMoveAsync(g);
		return { col, policy: null };
	}

	function applyGameMove(col: Column, policyOut?: Float32Array | null): void {
		const mover = game.toMove;
		const row = landingRowIn(game.board, col);
		game = applyMove(game, col);

		if (policyOut) {
			policy = Array.from(policyOut);
		}

		if (row !== null) {
			if (prefersReducedMotion) {
				fallingDisc = null;
			} else {
				fallingDisc = { col, row, player: mover };
				clearTimeout(fallTimer);
				fallTimer = setTimeout(() => {
					fallingDisc = null;
				}, 340);
			}
		}

		if (game.winner) {
			announcement = `${mover === HUMAN_PLAYER ? 'You' : botLabel()} dropped in column ${col + 1}. ${
				game.winner === HUMAN_PLAYER ? 'You win' : `${botLabel()} wins`
			}.`;
		} else if (game.isDraw) {
			announcement = `Dropped in column ${col + 1}. The game is a draw.`;
		} else {
			announcement = `${mover === HUMAN_PLAYER && mode === 'human' ? 'You' : 'The network'} dropped in column ${col + 1}.`;
		}
	}

	function handleGameEnd(): void {
		const outcome: 'human_win' | 'ai_win' | 'draw' = game.isDraw
			? 'draw'
			: mode === 'human' && game.winner === HUMAN_PLAYER
				? 'human_win'
				: 'ai_win';

		onGameEnd?.({
			checkpointId: botCheckpoint()?.id ?? 'minimax-fallback',
			outcome,
			moves: [...game.moves],
			durationMs: performance.now() - gameStartedAt
		});

		const myEpoch = epoch;
		endTimer = setTimeout(() => {
			if (myEpoch !== epoch || destroyed) return;
			game = createGame();
			policy = new Array(COLS).fill(0);
			fallingDisc = null;
			gameStartedAt = performance.now();
			if (mode === 'demo') {
				void runDemoStep(myEpoch);
			}
		}, END_OF_GAME_DELAY_MS);
	}

	async function runDemoStep(myEpoch: number): Promise<void> {
		if (myEpoch !== epoch || destroyed || mode !== 'demo') return;
		if (isTerminal(game)) return;

		const checkpoint = game.toMove === HUMAN_PLAYER ? demoCheckpoint() : botCheckpoint();
		const { col, policy: p } = await pickMove(checkpoint, game);
		if (myEpoch !== epoch || destroyed || mode !== 'demo') return;
		if (!legalMoves(game).includes(col)) return;

		applyGameMove(col, p);

		if (isTerminal(game)) {
			handleGameEnd();
		} else {
			demoTimer = setTimeout(() => void runDemoStep(myEpoch), DEMO_STEP_DELAY_MS);
		}
	}

	function beginHumanTakeover(col: Column): void {
		epoch++;
		clearScheduled();
		mode = 'human';
		game = createGame();
		policy = new Array(COLS).fill(0);
		fallingDisc = null;
		gameStartedAt = performance.now();
		attemptHumanMove(col, TAKEOVER_BOT_DELAY_MS);
	}

	function attemptHumanMove(col: Column, botDelay: number): void {
		if (isTerminal(game) || game.toMove !== HUMAN_PLAYER) return;
		if (!legalMoves(game).includes(col)) return;

		applyGameMove(col);

		if (isTerminal(game)) {
			handleGameEnd();
			return;
		}

		const myEpoch = epoch;
		botTimer = setTimeout(() => void runBotReply(myEpoch), botDelay);
	}

	async function runBotReply(myEpoch: number): Promise<void> {
		if (myEpoch !== epoch || destroyed || mode !== 'human') return;
		if (isTerminal(game)) return;

		const checkpoint = botCheckpoint();
		const { col, policy: p } = await pickMove(checkpoint, game);
		if (myEpoch !== epoch || destroyed || mode !== 'human') return;
		if (!legalMoves(game).includes(col)) return;

		applyGameMove(col, p);

		if (isTerminal(game)) {
			handleGameEnd();
		}
	}

	function handleColumnClick(col: Column): void {
		if (destroyed) return;
		cursorCol = col;
		if (mode === 'demo') {
			beginHumanTakeover(col);
			return;
		}
		if (terminalNow || game.toMove !== HUMAN_PLAYER) return;
		attemptHumanMove(col, HUMAN_BOT_DELAY_MS);
	}

	function pickTier(id: string): void {
		selectedTierId = id;
	}

	function reset(): void {
		epoch++;
		clearScheduled();
		clearTimeout(fallTimer);
		mode = 'demo';
		game = createGame();
		policy = new Array(COLS).fill(0);
		fallingDisc = null;
		announcement = 'New game started.';
		gameStartedAt = performance.now();
		const myEpoch = epoch;
		demoTimer = setTimeout(() => void runDemoStep(myEpoch), DEMO_STEP_DELAY_MS);
	}

	function moveCursor(delta: number): void {
		const next = ((cursorCol + delta + COLS) % COLS) as Column;
		cursorCol = next;
		columnButtons[next]?.focus();
	}

	function onColumnKeydown(e: KeyboardEvent, col: Column): void {
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			moveCursor(-1);
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			moveCursor(1);
		}
		// Enter / Space are native <button> activation and reach handleColumnClick via onclick.
	}

	function isColFull(col: Column): boolean {
		return !legalSet.has(col);
	}

	function isColDisabled(col: Column): boolean {
		if (isColFull(col)) return true;
		if (mode === 'human' && (terminalNow || game.toMove !== HUMAN_PLAYER)) return true;
		return false;
	}

	function cellPlayer(row: number, col: number): 0 | 1 | 2 {
		return game.board[idx(row, col)];
	}

	function isWinningCell(row: number, col: number): boolean {
		return game.winningCells?.includes(idx(row, col)) ?? false;
	}

	function cellDescription(row: number, col: number): string {
		const p = cellPlayer(row, col);
		return p === 0 ? 'empty' : `${playerLabel(p)} disc`;
	}
</script>

<div class="fig1">
	<div class="policy-bars" aria-hidden="true">
		{#each Array(COLS) as _, col (col)}
			{@const p = policy[col] ?? 0}
			<div class="bar" class:filled={p > 0.35} style={`height:${Math.max(2, 3 + p * 30)}px`}></div>
		{/each}
	</div>

	<div class="board" role="group" aria-label="Connect 4 columns — drop a disc">
		{#each Array(COLS) as _, col (col)}
			{@const disabled = isColDisabled(col as Column)}
			<button
				bind:this={columnButtons[col]}
				type="button"
				class="column"
				tabindex={cursorCol === col ? 0 : -1}
				{disabled}
				aria-label={`Drop in column ${col + 1}`}
				onclick={() => handleColumnClick(col as Column)}
				onkeydown={(e) => onColumnKeydown(e, col as Column)}
				onfocus={() => (cursorCol = col as Column)}
			>
				{#each Array(ROWS) as _, visualRow (visualRow)}
					{@const row = ROWS - 1 - visualRow}
					{@const player = cellPlayer(row, col)}
					{@const falling = !prefersReducedMotion && fallingDisc?.col === col && fallingDisc?.row === row}
					<div class="cell">
						{#if player}
							<div
								class="disc"
								class:disc-human={player === HUMAN_PLAYER}
								class:disc-network={player !== HUMAN_PLAYER}
								class:winning={isWinningCell(row, col)}
								class:falling
							></div>
						{/if}
					</div>
				{/each}
			</button>
		{/each}
	</div>

	<table class="visually-hidden" aria-label="Connect 4 board, 6 rows by 7 columns, row 1 is the bottom">
		<caption class="visually-hidden">Current board state</caption>
		<tbody>
			{#each Array(ROWS) as _, visualRow (visualRow)}
				{@const row = ROWS - 1 - visualRow}
				<tr>
					{#each Array(COLS) as _, col (col)}
						<td>Row {visualRow + 1}, column {col + 1}: {cellDescription(row, col)}</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>

	<div class="controls">
		<span class="controls-label">opponent</span>
		{#each checkpoints as tier (tier.id)}
			<button
				type="button"
				class="tier"
				class:selected={selectedTierId === tier.id}
				onclick={() => pickTier(tier.id)}
			>
				{tier.label}
			</button>
		{/each}
		<button type="button" class="reset" onclick={reset}>reset</button>
	</div>

	<p class="caption">
		<b>Fig. 1</b> — {statusLine()}{fallbackNote}. Bars above the board are π(a|s), the policy head's
		distribution over the seven legal drops. Click a column to take over.
	</p>

	<p class="visually-hidden" role="status" aria-live="polite">{announcement}</p>
</div>

<style>
	.fig1 {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-3);
		min-width: 0;
	}

	.policy-bars {
		display: grid;
		grid-template-columns: repeat(7, clamp(32px, 5vh, 54px));
		gap: 7px;
		align-items: end;
		height: 38px;
		padding: 0 12px;
	}

	.bar {
		width: 100%;
		min-height: 2px;
		background: color-mix(in srgb, var(--color-accent) 30%, transparent);
		transition: height 260ms ease;
	}

	.bar.filled {
		background: var(--color-accent);
	}

	.board {
		display: grid;
		grid-template-columns: repeat(7, clamp(32px, 5vh, 54px));
		gap: 7px;
		padding: 12px;
		background: var(--color-surface);
		border: var(--border-width) solid var(--color-border);
		box-shadow: 0 1px 0 var(--color-border-soft);
	}

	.column {
		display: flex;
		flex-direction: column;
		gap: 7px;
		padding: 0;
		border: none;
		background: transparent;
		cursor: pointer;
	}

	.column:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-accent) 6%, transparent);
	}

	.column:disabled {
		cursor: default;
	}

	.column:focus-visible {
		outline: 2px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.cell {
		width: clamp(32px, 5vh, 54px);
		height: clamp(32px, 5vh, 54px);
		border-radius: 50%;
		background: var(--color-cell);
		box-shadow: inset 0 0 0 1px var(--color-cell-inset);
		overflow: hidden;
	}

	.disc {
		width: 100%;
		height: 100%;
		border-radius: 50%;
		box-shadow: inset 0 -3px 6px color-mix(in srgb, black 20%, transparent);
		animation: c4drop 340ms var(--ease-drop);
	}

	.disc:not(.falling) {
		animation: none;
	}

	.disc-human {
		background: var(--color-disc-human);
	}

	.disc-network {
		background: var(--color-disc-network);
	}

	.disc.winning {
		box-shadow:
			0 0 0 2px var(--color-surface),
			0 0 0 4px var(--color-accent);
	}

	@keyframes c4drop {
		0% {
			transform: translateY(-360px);
		}
		72% {
			transform: translateY(6px);
		}
		100% {
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.disc {
			animation: none;
		}
		.bar {
			transition: none;
		}
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 6px;
	}

	.controls-label {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-text-faint);
	}

	.tier,
	.reset {
		padding: 6px 11px;
		font-family: var(--font-mono);
		font-size: 11px;
		white-space: nowrap;
		cursor: pointer;
		background: var(--color-surface);
	}

	.tier {
		border: var(--border-width) solid var(--color-border);
		color: var(--color-text-muted);
	}

	.tier:hover,
	.reset:hover {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.tier.selected {
		border-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
		color: var(--color-accent);
	}

	.reset {
		border: 1px dashed var(--color-border-dashed);
		background: transparent;
		color: var(--color-text-faint);
	}

	.caption {
		margin: 8px 0 0;
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.6;
		color: var(--color-text-faintest);
		max-width: 52ch;
	}

	.caption b {
		color: var(--color-text);
		font-weight: 500;
	}
</style>
