import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbUnavailableError, __resetForTests, isDbAvailable, query } from './client';

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

describe('client (no DATABASE_URL)', () => {
	beforeEach(() => {
		delete process.env.DATABASE_URL;
		__resetForTests();
	});

	afterEach(() => {
		if (ORIGINAL_DATABASE_URL === undefined) {
			delete process.env.DATABASE_URL;
		} else {
			process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
		}
		__resetForTests();
	});

	it('does not throw merely by being imported/used when DATABASE_URL is absent', () => {
		expect(() => isDbAvailable()).not.toThrow();
	});

	it('isDbAvailable() is false', () => {
		expect(isDbAvailable()).toBe(false);
	});

	it('query() rejects with DbUnavailableError rather than crashing the caller', async () => {
		await expect(query('select 1')).rejects.toBeInstanceOf(DbUnavailableError);
	});
});
