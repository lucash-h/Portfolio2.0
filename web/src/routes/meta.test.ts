/**
 * Link-preview and icon assets.
 *
 * None of this is exercised by rendering the page: a missing icon or an
 * off-spec Open Graph image fails silently in a crawler days after the fact,
 * usually as "why does my link look like a grey box". These are file-level
 * assertions instead — that the assets exist, that `og.png` is really a
 * 1200x630 PNG (the ratio every scraper expects, and the one the width/height
 * meta tags claim), and that the markup still points at all of them.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const STATIC = path.join(process.cwd(), 'static');
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p));

/** Width and height out of a PNG's IHDR chunk, which is always first. */
function pngSize(buf: Buffer): { width: number; height: number } {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	expect(buf.subarray(0, 8).equals(signature)).toBe(true);
	expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('icons and link previews', () => {
	it('ships every icon the markup asks for', () => {
		for (const file of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'og.png']) {
			const stat = fs.statSync(path.join(STATIC, file));
			expect(stat.size, `${file} is empty`).toBeGreaterThan(0);
		}
	});

	it('serves an og image at the size the meta tags promise', () => {
		const og = read('static/og.png');
		expect(pngSize(og)).toEqual({ width: 1200, height: 630 });
		// Twitter drops images over 5MB; nowhere near it, but the check is free
		// and the failure mode (a huge screenshot dropped in) is plausible.
		expect(og.byteLength).toBeLessThan(5_000_000);
	});

	it('ships a 180x180 apple touch icon', () => {
		expect(pngSize(read('static/apple-touch-icon.png'))).toEqual({ width: 180, height: 180 });
	});

	it('references the icons from app.html', () => {
		const html = read('src/app.html').toString('utf8');
		expect(html).toContain('/favicon.svg');
		expect(html).toContain('/favicon.ico');
		expect(html).toContain('/apple-touch-icon.png');
		expect(html).toContain('theme-color');
	});

	it('declares canonical, Open Graph and Twitter tags on the front page', () => {
		const page = read('src/routes/+page.svelte').toString('utf8');
		for (const tag of [
			'rel="canonical"',
			'property="og:type"',
			'property="og:title"',
			'property="og:description"',
			'property="og:url"',
			'property="og:image"',
			'property="og:image:alt"',
			'name="twitter:card"',
			'name="twitter:image"'
		]) {
			expect(page, `missing ${tag}`).toContain(tag);
		}
		// Absolute URLs, built from the request rather than hardcoded: a
		// relative og:image is ignored by most scrapers.
		expect(page).toContain('page.url.origin');
	});
});
