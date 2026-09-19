<script lang="ts">
	import '$lib/styles/global.css';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let { children } = $props();

	const navLinks = [
		{ href: '/', label: 'Home' },
		{ href: '/work', label: 'Work' },
		{ href: '/lab', label: 'Lab' },
		{ href: '/about', label: 'About' }
	];
</script>

<a href="#main-content" class="skip-link">Skip to content</a>

<div class="page">
	<header class="site-header">
		<nav class="site-nav" aria-label="Primary">
			<a href="/" class="wordmark">Portfolio</a>
			<ul>
				{#each navLinks as link (link.href)}
					<li><a href={link.href}>{link.label}</a></li>
				{/each}
			</ul>
			<ThemeToggle />
		</nav>
	</header>

	<main id="main-content">
		{@render children()}
	</main>

	<footer class="site-footer">
		<p>&copy; {new Date().getFullYear()} <!-- PLACEHOLDER: real name goes here --> Lorem Ipsum.</p>
	</footer>
</div>

<style>
	.page {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}

	.site-header {
		border-bottom: var(--border-width) solid var(--color-border);
	}

	.site-nav {
		display: flex;
		align-items: center;
		gap: var(--space-5);
		flex-wrap: wrap;
		max-width: 72rem;
		margin: 0 auto;
		padding: var(--space-4) var(--space-4);
	}

	.wordmark {
		font-family: var(--font-sans);
		font-weight: 600;
		font-size: var(--font-size-md);
		color: var(--color-text);
		text-decoration: none;
		margin-right: auto;
	}

	.site-nav ul {
		display: flex;
		gap: var(--space-4);
		list-style: none;
		margin: 0;
		padding: 0;
		flex-wrap: wrap;
	}

	.site-nav a {
		text-decoration: none;
		color: var(--color-text);
		padding: var(--space-2) 0;
	}

	.site-nav ul a:hover {
		color: var(--color-accent);
	}

	main {
		flex: 1;
		width: 100%;
		max-width: 72rem;
		margin: 0 auto;
		padding: var(--space-6) var(--space-4);
	}

	.site-footer {
		border-top: var(--border-width) solid var(--color-border);
		padding: var(--space-5) var(--space-4);
	}

	.site-footer p {
		max-width: none;
		margin: 0;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
		text-align: center;
	}
</style>
