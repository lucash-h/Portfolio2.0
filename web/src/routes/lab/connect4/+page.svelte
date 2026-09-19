<script lang="ts">
	/**
	 * Connect 4 exhibit page. Owns opponent-tier selection and supplies a move
	 * function to Connect4Board via the `opponentMove` prop. The real minimax
	 * / ML opponents are wired in later by the orchestrator — this page only
	 * ever supplies a placeholder so the exhibit is playable today.
	 */
	import Connect4Board from '$lib/components/Connect4Board.svelte';
	import { chooseMoveAsync } from '$lib/games/connect4/minimaxClient';
	import type { Column, GameState } from '$lib/games/connect4/types';

	interface CheckpointTier {
		id: string;
		label: string;
		file: string;
		gamesTrained: number;
		elo: number | null;
		mctsSims: number;
		sizeKb: number;
		/** Search depth, for the built-in minimax tiers. Absent on trained checkpoints. */
		searchDepth?: number;
	}

	interface Manifest {
		version: number;
		connect4: CheckpointTier[];
		racer: unknown[];
	}

	/**
	 * Built-in opponents, used until trained checkpoints are published. These are
	 * classical alpha-beta search at increasing depth, not learned models — the
	 * copy below says so rather than implying a training run that has not happened.
	 */
	function practiceTier(id: string, label: string, searchDepth: number): CheckpointTier {
		return {
			id,
			label,
			file: '',
			gamesTrained: 0,
			elo: null,
			mctsSims: 0,
			sizeKb: 0,
			searchDepth
		};
	}

	const PRACTICE_TIERS: CheckpointTier[] = [
		practiceTier('practice-easy', 'Practice — easy', 2),
		practiceTier('practice-medium', 'Practice — medium', 4),
		practiceTier('practice-hard', 'Practice — hard', 6)
	];

	let tiers = $state<CheckpointTier[]>(PRACTICE_TIERS);
	let selectedTierId = $state<string>(PRACTICE_TIERS[0].id);
	let manifestStatus = $state<'loading' | 'loaded' | 'fallback'>('loading');
	let gameKey = $state(0);

	$effect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch('/models/manifest.json');
				if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
				const data = (await res.json()) as Manifest;
				if (!Array.isArray(data.connect4) || data.connect4.length === 0) {
					throw new Error('manifest has no connect4 tiers');
				}
				if (!cancelled) {
					tiers = data.connect4;
					selectedTierId = tiers[0].id;
					manifestStatus = 'loaded';
				}
			} catch {
				// Manifest missing, unreachable, or malformed — fall back to the
				// single hardcoded practice bot so the exhibit still works today.
				if (!cancelled) {
					tiers = PRACTICE_TIERS;
					selectedTierId = PRACTICE_TIERS[0].id;
					manifestStatus = 'fallback';
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	});

	const selectedTier = $derived(tiers.find((t) => t.id === selectedTierId) ?? tiers[0]);

	/**
	 * Supplies the opponent's move. Runs alpha-beta search in a Web Worker so the
	 * board stays responsive; see minimaxClient for the fallback behaviour.
	 *
	 * When trained checkpoints land, branch here on `selectedTier.file` and route
	 * to ONNX inference instead. The board's prop signature does not change.
	 */
	async function opponentMove(state: GameState): Promise<Column> {
		const depth = selectedTier?.searchDepth ?? 4;
		return chooseMoveAsync(state, { maxDepth: depth });
	}

	function restartWithNewOpponent() {
		gameKey += 1;
	}
</script>

<svelte:head>
	<title>Connect 4 — Lab</title>
</svelte:head>

<h1>Connect 4</h1>
<p>
	Play against a bot. Once self-play training has run, each tier here will be a real
	checkpoint — the network as it was after a given number of games — so difficulty
	is a point in the training run rather than a tuning knob.
</p>

<div class="tier-picker">
	<label for="tier-select">Opponent</label>
	<select
		id="tier-select"
		bind:value={selectedTierId}
		onchange={restartWithNewOpponent}
	>
		{#each tiers as tier (tier.id)}
			<option value={tier.id}>
				{tier.label}{tier.elo ? ` (Elo ${tier.elo})` : ''}
			</option>
		{/each}
	</select>
	{#if manifestStatus === 'fallback'}
		<p class="tier-note">
			No trained checkpoints published yet. These practice tiers are classical
			alpha-beta search at increasing depth, not learned models.
		</p>
	{/if}
</div>

{#key gameKey}
	<Connect4Board {opponentMove} />
{/key}

<style>
	.tier-picker {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
		margin-bottom: var(--space-5);
	}

	.tier-picker label {
		font-weight: 600;
	}

	.tier-picker select {
		min-height: 44px;
		padding: var(--space-2) var(--space-3);
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-elevated);
		color: var(--color-text);
		font-size: var(--font-size-base);
	}

	.tier-note {
		flex-basis: 100%;
		margin: 0;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}
</style>
