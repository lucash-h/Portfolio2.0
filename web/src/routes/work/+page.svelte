<svelte:head>
	<title>Work</title>
</svelte:head>

<h1>Work</h1>
<p>
	<!-- PLACEHOLDER: real intro copy goes here -->
	Lorem ipsum dolor sit amet, consectetur adipiscing elit.
</p>

<ul class="project-grid">
	{#each ['Project One', 'Project Two', 'Project Three'] as name (name)}
		<li class="project-card">
			<h2>{name}</h2>
			<p><!-- PLACEHOLDER: real project description goes here -->Lorem ipsum dolor sit amet.</p>
		</li>
	{/each}
</ul>

<style>
	.project-grid {
		list-style: none;
		margin: var(--space-6) 0 0 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
		gap: var(--space-5);
	}

	.project-card {
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-5);
	}

	.project-card p {
		color: var(--color-text-muted);
		margin-bottom: 0;
	}
</style>
