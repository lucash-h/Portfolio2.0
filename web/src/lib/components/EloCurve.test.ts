import { describe, it, expect, beforeEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import EloCurve from './EloCurve.svelte';
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

describe('EloCurve', () => {
	let target: HTMLDivElement;

	beforeEach(() => {
		target = document.createElement('div');
		document.body.appendChild(target);
	});

	it('renders a populated fixture with a line through rated checkpoints', () => {
		const rows: CheckpointOutcomeRow[] = [
			row({ checkpointId: 'c4-000001k', elo: 400 }),
			row({ checkpointId: 'c4-000010k', elo: 520 }),
			row({ checkpointId: 'c4-000100k', elo: 780 })
		];
		const component = mount(EloCurve, { target, props: { rows } });
		flushSync();

		expect(target.querySelector('svg')).not.toBeNull();
		expect(target.querySelector('path.elo-line')).not.toBeNull();
		expect(target.querySelectorAll('circle.marker-rated').length).toBe(3);
		expect(target.textContent).toContain('780');

		unmount(component);
	});

	it('renders the empty state without throwing when there are no checkpoints', () => {
		expect(() => {
			const component = mount(EloCurve, { target, props: { rows: [] } });
			flushSync();
			expect(target.querySelector('svg')).toBeNull();
			expect(target.textContent).toContain('No checkpoints yet');
			unmount(component);
		}).not.toThrow();
	});

	it('handles a null Elo distinctly from a rated one, without breaking the line', () => {
		const rows: CheckpointOutcomeRow[] = [
			row({ checkpointId: 'c4-000001k', elo: 400 }),
			row({ checkpointId: 'c4-000010k', elo: null }),
			row({ checkpointId: 'c4-000100k', elo: 780 })
		];
		const component = mount(EloCurve, { target, props: { rows } });
		flushSync();

		// Only the two rated points get a filled marker; the null one gets the
		// distinct hollow "unrated" marker instead of a fabricated value.
		expect(target.querySelectorAll('circle.marker-rated').length).toBe(2);
		expect(target.querySelectorAll('circle.marker-unrated').length).toBe(1);
		expect(target.textContent).toContain('not yet rated');

		unmount(component);
	});

	it('handles a single data point without a line', () => {
		const rows: CheckpointOutcomeRow[] = [row({ checkpointId: 'c4-000001k', elo: 400 })];
		const component = mount(EloCurve, { target, props: { rows } });
		flushSync();

		expect(target.querySelectorAll('circle.marker-rated').length).toBe(1);
		// A single point has nothing to draw a line between.
		expect(target.querySelector('path.elo-line')).toBeNull();
		expect(target.textContent).toContain('Only one rated checkpoint');

		unmount(component);
	});
});
