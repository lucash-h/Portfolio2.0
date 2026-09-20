import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Manifest, ManifestResult } from '$lib/ml/mlTypes';

/**
 * Connect4Figure loads the checkpoint manifest on mount via
 * `$lib/ml/registry`. Mocking it keeps these tests deterministic and free of
 * real network/fetch calls — the component's own fallback path (manifest
 * missing) is exercised directly by mocking an `ok: false` result rather than
 * by making a real request fail.
 */
const mockManifest: Manifest = {
	version: 1,
	connect4: [
		{ id: 'c4-0000050', label: '50 games', file: 'connect4/c4-0000050.onnx', gamesTrained: 50, elo: null, mctsSims: 48, sizeKb: 351 },
		{ id: 'c4-0000150', label: '150 games', file: 'connect4/c4-0000150.onnx', gamesTrained: 150, elo: null, mctsSims: 48, sizeKb: 351 },
		{ id: 'c4-0000300', label: '300 games', file: 'connect4/c4-0000300.onnx', gamesTrained: 300, elo: null, mctsSims: 48, sizeKb: 351 }
	],
	racer: []
};

const loadManifestMock = vi.fn<() => Promise<ManifestResult>>();

vi.mock('$lib/ml/registry', async () => {
	const actual = await vi.importActual<typeof import('$lib/ml/registry')>('$lib/ml/registry');
	return {
		...actual,
		loadManifest: () => loadManifestMock()
	};
});

const { default: Connect4Figure } = await import('./Connect4Figure.svelte');

describe('Connect4Figure', () => {
	let target: HTMLDivElement;

	beforeEach(() => {
		target = document.createElement('div');
		document.body.appendChild(target);
		loadManifestMock.mockReset();
		loadManifestMock.mockResolvedValue({ ok: true, manifest: mockManifest });
	});

	afterEach(() => {
		target.remove();
	});

	it('renders without throwing', () => {
		const component = mount(Connect4Figure, { target });
		flushSync();
		expect(target.querySelector('.fig1')).not.toBeNull();
		unmount(component);
	});

	it('renders a 42-cell board', () => {
		const component = mount(Connect4Figure, { target });
		flushSync();
		expect(target.querySelectorAll('.cell').length).toBe(42);
		unmount(component);
	});

	it('renders seven policy bars aligned with the board columns', () => {
		const component = mount(Connect4Figure, { target });
		flushSync();
		expect(target.querySelectorAll('.bar').length).toBe(7);
		expect(target.querySelectorAll('.column').length).toBe(7);
		unmount(component);
	});

	it('switches from demo to human mode when a column is clicked', () => {
		const component = mount(Connect4Figure, { target });
		flushSync();

		const caption = target.querySelector('.caption');
		expect(caption?.textContent).toContain('two checkpoints playing each other');
		expect(target.querySelectorAll('.disc').length).toBe(0);

		const columns = target.querySelectorAll<HTMLButtonElement>('.column');
		expect(columns.length).toBe(7);
		columns[3].click();
		flushSync();

		// The human's own move is applied synchronously (only the bot's reply
		// is timer-scheduled), so right after the click there is exactly one
		// disc on the board and the caption no longer reads the demo status.
		expect(target.querySelectorAll('.disc').length).toBe(1);
		expect(caption?.textContent).not.toContain('two checkpoints playing each other');

		unmount(component);
	});

	it('falls back without throwing when the manifest is missing', async () => {
		loadManifestMock.mockResolvedValue({ ok: false, reason: 'missing', detail: 'no manifest' });

		let component: unknown;
		expect(() => {
			component = mount(Connect4Figure, { target });
			flushSync();
		}).not.toThrow();

		// Let the mount effect's manifest-loading promise settle.
		await new Promise((r) => setTimeout(r, 0));
		flushSync();

		expect(target.querySelector('.fig1')).not.toBeNull();
		expect(target.querySelectorAll('.cell').length).toBe(42);
		expect(target.querySelector('.caption')?.textContent).toContain('checkpoints unavailable');

		unmount(component as ReturnType<typeof mount>);
	});
});
