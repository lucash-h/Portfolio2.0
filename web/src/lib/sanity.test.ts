import { describe, expect, it } from 'vitest';

// Trivial placeholder test so later packages inherit a working Vitest harness.
describe('sanity', () => {
	it('adds numbers', () => {
		expect(1 + 1).toBe(2);
	});
});
