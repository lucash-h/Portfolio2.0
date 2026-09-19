import { describe, it, expect, beforeEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import OpeningHeatmap from './OpeningHeatmap.svelte';

describe('OpeningHeatmap', () => {
	let target: HTMLDivElement;

	beforeEach(() => {
		target = document.createElement('div');
		document.body.appendChild(target);
	});

	it('renders a populated fixture with 7 columns', () => {
		const heatmap = [1204, 980, 1500, 3100, 1490, 960, 1180];
		const component = mount(OpeningHeatmap, { target, props: { heatmap } });
		flushSync();

		expect(target.querySelector('svg')).not.toBeNull();
		expect(target.querySelectorAll('rect.cell-fill').length).toBe(7);
		// Every cell is directly labeled with its count.
		expect(target.textContent).toContain('3,100');
		expect(target.textContent).toContain('col 4');

		unmount(component);
	});

	it('renders the empty state without throwing for undefined data', () => {
		expect(() => {
			const component = mount(OpeningHeatmap, { target, props: { heatmap: undefined } });
			flushSync();
			expect(target.querySelector('svg')).toBeNull();
			expect(target.textContent).toContain('No opening moves logged yet');
			unmount(component);
		}).not.toThrow();
	});

	it('renders the empty state without throwing for an all-zero fixture', () => {
		const heatmap = [0, 0, 0, 0, 0, 0, 0];
		expect(() => {
			const component = mount(OpeningHeatmap, { target, props: { heatmap } });
			flushSync();
			expect(target.querySelector('svg')).toBeNull();
			unmount(component);
		}).not.toThrow();
	});

	it('handles a single nonzero column', () => {
		const heatmap = [0, 0, 0, 50, 0, 0, 0];
		const component = mount(OpeningHeatmap, { target, props: { heatmap } });
		flushSync();

		expect(target.querySelectorAll('rect.cell-fill').length).toBe(7);
		expect(target.textContent).toContain('100%');

		unmount(component);
	});
});
