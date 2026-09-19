import { describe, it, expect, beforeEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import WinRateBars from './WinRateBars.svelte';
import type { CheckpointOutcomeRow } from './charts';

function row(overrides: Partial<CheckpointOutcomeRow> = {}): CheckpointOutcomeRow {
	return {
		checkpointId: 'c4-000001k',
		humanWins: 0,
		aiWins: 0,
		draws: 0,
		elo: null,
		...overrides
	};
}

describe('WinRateBars', () => {
	let target: HTMLDivElement;

	beforeEach(() => {
		target = document.createElement('div');
		document.body.appendChild(target);
	});

	it('renders a populated fixture with stacked segments and a sample-size label', () => {
		const rows: CheckpointOutcomeRow[] = [
			row({ checkpointId: 'c4-000001k', humanWins: 40, aiWins: 12, draws: 3 }),
			row({ checkpointId: 'c4-000010k', humanWins: 5, aiWins: 90, draws: 5 })
		];
		const component = mount(WinRateBars, { target, props: { rows } });
		flushSync();

		expect(target.querySelector('svg')).not.toBeNull();
		expect(target.querySelectorAll('rect.seg-human').length).toBe(2);
		expect(target.querySelectorAll('rect.seg-ai').length).toBe(2);
		expect(target.querySelectorAll('rect.seg-draw').length).toBe(2);
		// Sample size is shown per checkpoint (55 and 100), so a small-n result
		// doesn't read the same as a large-n one.
		expect(target.textContent).toContain('n=55');
		expect(target.textContent).toContain('n=100');

		unmount(component);
	});

	it('renders the empty state without throwing when there are no checkpoints', () => {
		expect(() => {
			const component = mount(WinRateBars, { target, props: { rows: [] } });
			flushSync();
			expect(target.querySelector('svg')).toBeNull();
			expect(target.textContent).toContain('No games logged yet');
			unmount(component);
		}).not.toThrow();
	});

	it('handles a single data point', () => {
		const rows: CheckpointOutcomeRow[] = [
			row({ checkpointId: 'c4-000001k', humanWins: 2, aiWins: 1, draws: 0 })
		];
		const component = mount(WinRateBars, { target, props: { rows } });
		flushSync();

		expect(target.querySelectorAll('rect.seg-human').length).toBe(1);
		expect(target.querySelectorAll('rect.seg-ai').length).toBe(1);
		// Zero-count segment (draws) is not drawn as a rect.
		expect(target.querySelectorAll('rect.seg-draw').length).toBe(0);
		expect(target.textContent).toContain('n=3');

		unmount(component);
	});

	it('handles a checkpoint with zero games without throwing', () => {
		const rows: CheckpointOutcomeRow[] = [
			row({ checkpointId: 'c4-000001k', humanWins: 0, aiWins: 0, draws: 0 })
		];
		expect(() => {
			const component = mount(WinRateBars, { target, props: { rows } });
			flushSync();
			expect(target.textContent).toContain('no games');
			unmount(component);
		}).not.toThrow();
	});
});
