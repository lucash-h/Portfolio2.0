<svelte:head>
	<title>Lab</title>
</svelte:head>

<h1>Lab</h1>
<p>
	<!-- PLACEHOLDER: real intro copy goes here -->
	This corner of the site hosts two small game exhibits. Each one is playable
	against a bot, and the bot is not a fixed script: every difficulty tier you can
	pick is a literal checkpoint saved during that bot's training. Picking "easy"
	means playing the network after a small number of self-play games or
	evolutionary generations; picking "hard" means playing it much later in the
	same run. The ladder is the training history, not a hand-tuned difficulty
	slider.
</p>
<ul class="exhibits">
	<li>
		<a href="/lab/connect4">Connect 4</a>
		<p>
			Alpha-beta search today; self-play checkpoints once training has run.
		</p>
	</li>
	<li>
		<span class="pending">Racer</span>
		<p>
			A time-trial track raced against ghosts evolved by neuroevolution. Not built yet.
		</p>
	</li>
</ul>

<style>
	.exhibits {
		list-style: none;
		padding: 0;
		display: grid;
		gap: var(--space-4);
	}

	.exhibits li {
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-4);
	}

	.exhibits p {
		margin: var(--space-2) 0 0;
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
	}

	.pending {
		color: var(--color-text-muted);
	}
</style>
