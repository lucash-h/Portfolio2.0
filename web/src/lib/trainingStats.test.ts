/**
 * Training stats: the formatters, the defensive parse, and a shape check
 * against the real `static/models/training.json`.
 *
 * That last one is the point of this file. The JSON is written by
 * `ml/export/training_stats.py`, which nothing in the TypeScript build knows
 * about — so the two can drift silently, and the only symptom would be a
 * dashboard section that quietly stops rendering. This asserts the shipped
 * file still matches what the page reads.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
	formatDate,
	formatDuration,
	formatNumber,
	humanizeKey,
	parseTrainingStats
} from './trainingStats';

describe('formatDuration', () => {
	it('reads as minutes and seconds under an hour', () => {
		expect(formatDuration(551.216967)).toBe('9m 11s');
		expect(formatDuration(47)).toBe('47s');
		expect(formatDuration(60)).toBe('1m 00s');
	});

	it('switches to hours when it needs to', () => {
		expect(formatDuration(3600)).toBe('1h 00m');
		expect(formatDuration(3860)).toBe('1h 04m');
	});

	it('returns null rather than a fake duration', () => {
		expect(formatDuration(null)).toBeNull();
		expect(formatDuration(undefined)).toBeNull();
		expect(formatDuration(Number.NaN)).toBeNull();
		expect(formatDuration(-5)).toBeNull();
	});
});

describe('formatDate', () => {
	it('formats an ISO timestamp as a plain date', () => {
		expect(formatDate('2026-09-19T17:56:14.840400+00:00')).toBe('19 Sept 2026');
	});

	it('returns null for anything unparseable', () => {
		expect(formatDate(null)).toBeNull();
		expect(formatDate('')).toBeNull();
		expect(formatDate('not a date')).toBeNull();
	});
});

describe('formatNumber / humanizeKey', () => {
	it('groups thousands', () => {
		expect(formatNumber(89219)).toBe('89,219');
	});

	it('turns camelCase keys into words', () => {
		expect(humanizeKey('batchSize')).toBe('batch size');
		expect(humanizeKey('trainStepsPerCycle')).toBe('train steps per cycle');
		expect(humanizeKey('seed')).toBe('seed');
	});
});

describe('parseTrainingStats', () => {
	const valid = {
		version: 1,
		connect4: {
			architecture: { channels: 32, blocks: 4, parameters: 89219 },
			hyperparameters: { simulations: 48 },
			run: {
				gamesTrained: 300,
				firstCheckpointAt: '2026-09-19T17:56:14.840400+00:00',
				lastCheckpointAt: '2026-09-19T18:05:26.057367+00:00',
				spanSeconds: 551.2
			},
			checkpoints: [
				{
					id: 'c4-0000050',
					gamesTrained: 50,
					parameters: 89219,
					savedAt: '2026-09-19T17:56:14.840400+00:00',
					checkpointKb: 1095
				}
			]
		}
	};

	it('accepts a well-formed payload', () => {
		expect(parseTrainingStats(valid)?.architecture.parameters).toBe(89219);
	});

	it('returns null instead of throwing on anything unusable', () => {
		// A page whose subject is honesty about missing data must not crash
		// when the data is missing.
		expect(parseTrainingStats(null)).toBeNull();
		expect(parseTrainingStats('nope')).toBeNull();
		expect(parseTrainingStats({ version: 1, connect4: null })).toBeNull();
		expect(parseTrainingStats({ version: 1 })).toBeNull();
		expect(
			parseTrainingStats({ version: 1, connect4: { ...valid.connect4, checkpoints: [] } })
		).toBeNull();
		expect(
			parseTrainingStats({ version: 1, connect4: { ...valid.connect4, architecture: null } })
		).toBeNull();
	});
});

describe('the shipped training.json', () => {
	const file = path.join(process.cwd(), 'static', 'models', 'training.json');

	it('exists and parses into what the dashboard reads', () => {
		const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
		const stats = parseTrainingStats(raw);
		expect(stats, 'training.json no longer matches the shape the page expects').not.toBeNull();
		expect(stats!.architecture.parameters).toBeGreaterThan(0);
		expect(stats!.checkpoints.length).toBeGreaterThan(0);
		expect(stats!.run.gamesTrained).toBeGreaterThan(0);
	});

	it('agrees with manifest.json about the checkpoints that exist', () => {
		// Both files are written by the same export pass from the same
		// checkpoints; if they disagree, one of them was hand-edited.
		const training = parseTrainingStats(JSON.parse(fs.readFileSync(file, 'utf8')))!;
		const manifest = JSON.parse(
			fs.readFileSync(path.join(process.cwd(), 'static', 'models', 'manifest.json'), 'utf8')
		);
		const manifestIds = manifest.connect4.map((e: { id: string }) => e.id).sort();
		const trainingIds = training.checkpoints.map((c) => c.id).sort();
		expect(trainingIds).toEqual(manifestIds);

		for (const entry of manifest.connect4 as { id: string; gamesTrained: number }[]) {
			const row = training.checkpoints.find((c) => c.id === entry.id);
			expect(row?.gamesTrained, `${entry.id} games disagree`).toBe(entry.gamesTrained);
		}
	});
});
