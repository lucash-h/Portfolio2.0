import { describe, expect, it } from 'vitest';

import {
	findConnect4Checkpoint,
	getConnect4Checkpoints,
	loadManifest,
	validateManifestShape
} from './registry';

const VALID_MANIFEST = {
	version: 1,
	connect4: [
		{
			id: 'c4-000001k',
			label: '1,000 games',
			file: 'connect4/c4-000001k.onnx',
			gamesTrained: 1000,
			elo: 412,
			mctsSims: 64,
			sizeKb: 180
		},
		{
			id: 'c4-000010k',
			label: '10,000 games',
			file: 'connect4/c4-000010k.onnx',
			gamesTrained: 10000,
			elo: null,
			mctsSims: 128,
			sizeKb: 180
		}
	],
	racer: [
		{
			id: 'rc-gen0005',
			label: 'Generation 5',
			file: 'racer/rc-gen0005.onnx',
			generation: 5,
			bestLapMs: 48210,
			sizeKb: 6
		}
	]
};

function fetchReturning(status: number, ok: boolean, body: string) {
	return async () => ({
		ok,
		status,
		text: async () => body
	});
}

function fetchThatThrows() {
	return async () => {
		throw new Error('ECONNREFUSED');
	};
}

describe('missing manifest', () => {
	it('a network error produces a typed, non-throwing "missing" result', async () => {
		const result = await loadManifest('/models/manifest.json', fetchThatThrows());
		expect(result).toEqual({ ok: false, reason: 'missing', detail: expect.any(String) });
	});

	it('a 404 response produces a typed "missing" result (the normal state today)', async () => {
		const result = await loadManifest('/models/manifest.json', fetchReturning(404, false, ''));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('missing');
	});
});

describe('malformed manifest', () => {
	it('invalid JSON is rejected, not passed through', async () => {
		const result = await loadManifest(
			'/models/manifest.json',
			fetchReturning(200, true, '{ not valid json')
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('invalid-json');
	});

	it('well-formed JSON with the wrong shape is rejected, not passed through', async () => {
		const wrongShape = JSON.stringify({ version: 1, connect4: 'nope', racer: [] });
		const result = await loadManifest('/models/manifest.json', fetchReturning(200, true, wrongShape));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('invalid-shape');
	});

	it('a single malformed entry invalidates the whole manifest', async () => {
		const badEntry = JSON.parse(JSON.stringify(VALID_MANIFEST));
		badEntry.connect4[1].gamesTrained = 'ten thousand'; // wrong type
		const result = await loadManifest('/models/manifest.json', fetchReturning(200, true, JSON.stringify(badEntry)));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('invalid-shape');
	});

	it('rejects a manifest missing required fields entirely', () => {
		expect(validateManifestShape({ version: 1, connect4: [{ id: 'x' }], racer: [] })).toBeNull();
	});

	it('rejects a top-level non-object', () => {
		expect(validateManifestShape('nope')).toBeNull();
		expect(validateManifestShape(null)).toBeNull();
		expect(validateManifestShape([1, 2, 3])).toBeNull();
	});
});

describe('valid manifest', () => {
	it('parses and validates a well-formed manifest, exposing checkpoints in manifest order', async () => {
		const result = await loadManifest(
			'/models/manifest.json',
			fetchReturning(200, true, JSON.stringify(VALID_MANIFEST))
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const checkpoints = getConnect4Checkpoints(result.manifest);
		expect(checkpoints.map((c) => c.id)).toEqual(['c4-000001k', 'c4-000010k']);
		expect(checkpoints[1].elo).toBeNull();

		expect(findConnect4Checkpoint(result.manifest, 'c4-000010k')?.gamesTrained).toBe(10000);
		expect(findConnect4Checkpoint(result.manifest, 'nope')).toBeUndefined();
	});
});
