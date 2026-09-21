import { describe, expect, it } from 'vitest';
import { validateTrack, parseTrack } from './validateTrack';
import type { Track } from './types';

describe('validateTrack', () => {
  // Helper to create a minimal valid track
  function createValidTrack(overrides: Partial<Track> = {}): Track {
    return {
      name: 'Test Track',
      centreline: [
        [0, 0],
        [10, 0],
        [20, 5],
        [25, 15],
        [20, 25],
        [10, 30],
        [0, 25],
        [-10, 15],
        [-15, 5],
        [-10, 0],
      ],
      halfWidth: 5,
      startIndex: 0,
      ...overrides,
    };
  }

  describe('shipped tracks', () => {
    it('oval.json validates cleanly', async () => {
      const ovalJson = await import('../../../../static/tracks/oval.json');
      const errors = validateTrack(parseTrack(ovalJson.default));
      expect(errors).toHaveLength(0);
    });

    it('technical.json validates cleanly', async () => {
      const technicalJson = await import('../../../../static/tracks/technical.json');
      const errors = validateTrack(parseTrack(technicalJson.default));
      expect(errors).toHaveLength(0);
    });

    it('hairpin.json validates cleanly', async () => {
      const hairpinJson = await import('../../../../static/tracks/hairpin.json');
      const errors = validateTrack(parseTrack(hairpinJson.default));
      expect(errors).toHaveLength(0);
    });

    it('grand.json validates cleanly', async () => {
      const grandJson = await import('../../../../static/tracks/grand.json');
      const errors = validateTrack(parseTrack(grandJson.default));
      expect(errors).toHaveLength(0);
    });

    it('grand.json is the long one, and its surfaces never merge into a shortcut', async () => {
      // `validateTrack` checks the centreline never crosses itself, but two
      // sections running close and parallel would still fuse into one blob of
      // drivable surface (on-track is "within halfWidth of the centreline"),
      // handing the cars a shortcut. Only pairs far apart ALONG the lap count:
      // consecutive points are supposed to be close.
      const grandJson = await import('../../../../static/tracks/grand.json');
      const track = parseTrack(grandJson.default);
      const pts = track.centreline;
      const n = pts.length;

      const segLen = pts.map((p, i) => Math.hypot(pts[(i + 1) % n][0] - p[0], pts[(i + 1) % n][1] - p[1]));
      const lapLength = segLen.reduce((a, b) => a + b, 0);
      expect(lapLength).toBeGreaterThan(600);

      const arc: number[] = [0];
      for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + segLen[i - 1];
      const arcApart = (i: number, j: number) => {
        const d = Math.abs(arc[i] - arc[j]);
        return Math.min(d, lapLength - d);
      };

      let closest = Infinity;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (arcApart(i, j) < 45) continue;
          closest = Math.min(closest, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
        }
      }
      expect(closest).toBeGreaterThan(track.halfWidth * 2.2);
    });
  });

  describe('baseline validity', () => {
    it('accepts a valid track', () => {
      const track = createValidTrack();
      const errors = validateTrack(track);
      expect(errors).toHaveLength(0);
    });

    it('requires at least 8 points', () => {
      const track = createValidTrack({
        centreline: [[0, 0], [10, 0], [20, 5], [25, 15], [20, 25], [10, 30], [0, 25]],
      });
      const errors = validateTrack(track);
      expect(errors).toContainEqual(expect.objectContaining({ type: 'insufficient_points' }));
    });

    it('rejects non-array centreline', () => {
      const track = createValidTrack({ centreline: null as unknown as any });
      const errors = validateTrack(track);
      expect(errors).toContainEqual(expect.objectContaining({ type: 'centreline_not_array' }));
    });
  });

  describe('duplicate points', () => {
    it('detects identical consecutive points', () => {
      const track = createValidTrack({
        centreline: [
          [0, 0],
          [10, 0],
          [10, 0], // Duplicate!
          [20, 5],
          [25, 15],
          [20, 25],
          [10, 30],
          [0, 25],
          [-10, 15],
        ],
      });
      const errors = validateTrack(track);
      expect(errors).toContainEqual(expect.objectContaining({ type: 'duplicate_consecutive_points' }));
    });

    it('detects duplicate when last and first points match', () => {
      const track = createValidTrack({
        centreline: [
          [0, 0],
          [10, 0],
          [20, 5],
          [25, 15],
          [20, 25],
          [10, 30],
          [0, 25],
          [-10, 15],
          [0, 0], // Duplicate of first!
        ],
      });
      const errors = validateTrack(track);
      expect(errors).toContainEqual(expect.objectContaining({ type: 'duplicate_consecutive_points' }));
    });
  });

  describe('halfWidth validation', () => {
    it('rejects negative halfWidth', () => {
      const track = createValidTrack({ halfWidth: -5 });
      const errors = validateTrack(track);
      expect(errors).toContainEqual(expect.objectContaining({ type: 'invalid_halfwidth' }));
    });

    it('rejects zero halfWidth', () => {
      const track = createValidTrack({ halfWidth: 0 });
      const errors = validateTrack(track);
      expect(errors).toContainEqual(expect.objectContaining({ type: 'invalid_halfwidth' }));
    });

    it('rejects non-number halfWidth', () => {
      const track = createValidTrack({ halfWidth: 'wide' as unknown as number });
      const errors = validateTrack(track);
      expect(errors).toContainEqual(expect.objectContaining({ type: 'invalid_halfwidth' }));
    });

    it('rejects excessively large halfWidth', () => {
      const track = createValidTrack({ halfWidth: 150 });
      const errors = validateTrack(track);
      expect(errors).toContainEqual(expect.objectContaining({ type: 'halfwidth_excessive' }));
    });
  });

  describe('startIndex validation', () => {
    it('rejects negative startIndex', () => {
      const track = createValidTrack({ startIndex: -1 });
      const errors = validateTrack(track);
      expect(errors).toContainEqual(expect.objectContaining({ type: 'startindex_out_of_range' }));
    });

    it('rejects startIndex beyond centreline length', () => {
      const track = createValidTrack({ startIndex: 15 });
      const errors = validateTrack(track);
      expect(errors).toContainEqual(expect.objectContaining({ type: 'startindex_out_of_range' }));
    });

    it('accepts startIndex at maximum valid value', () => {
      const track = createValidTrack({ startIndex: 9 });
      const errors = validateTrack(track);
      expect(errors.filter((e) => e.type === 'startindex_out_of_range')).toHaveLength(0);
    });
  });

  describe('self-intersection detection', () => {
    it('detects simple figure-eight self-intersection', () => {
      const track = createValidTrack({
        centreline: [
          [0, 0],
          [10, 10], // Going up-right
          [20, 0], // Down-right to create crossing
          [10, -10], // Down-left
          [0, 0], // Back to start would close, but let's make it cross
          [10, 0], // Crosses the line from [10, 10] to [20, 0]
          [20, 10],
          [-5, 5],
          [-10, -5],
        ],
      });
      const errors = validateTrack(track);
      expect(errors).toContainEqual(expect.objectContaining({ type: 'self_intersection' }));
    });

    it('allows non-intersecting complex shape', () => {
      const track = createValidTrack({
        centreline: [
          [0, 0],
          [10, 0],
          [15, 5],
          [15, 15],
          [10, 20],
          [0, 20],
          [-5, 15],
          [-5, 5],
          [-2, 2],
          [2, 2],
        ],
      });
      const errors = validateTrack(track);
      expect(errors.filter((e) => e.type === 'self_intersection')).toHaveLength(0);
    });
  });

  describe('corner radius validation', () => {
    it('rejects corner tighter than 4.3m', () => {
      // Create a sharp hairpin turn
      const track = createValidTrack({
        centreline: [
          [0, 0],
          [20, 0],
          [30, 0], // These three points form a very tight curve
          [32, 4], // radius ~3m
          [20, 8],
          [10, 8],
          [5, 4],
          [5, 0],
          [7, -2],
        ],
      });
      const errors = validateTrack(track);
      expect(errors).toContainEqual(expect.objectContaining({ type: 'corner_radius_too_tight' }));
    });

    it('allows corner at minimum navigable radius with margin', () => {
      // Create a track with all corners at safe radius
      const track = createValidTrack({
        centreline: [
          [0, 0],
          [15, 0],
          [25, 3],
          [32, 12],
          [30, 25],
          [18, 28],
          [8, 25],
          [2, 15],
          [0, 5],
        ],
      });
      const errors = validateTrack(track);
      expect(errors.filter((e) => e.type === 'corner_radius_too_tight')).toHaveLength(0);
    });

    it('flags all tight corners with specific indices', () => {
      // Create a track with multiple tight corners
      const track = createValidTrack({
        centreline: [
          [0, 0],
          [10, 0],
          [12, 0], // Very tight turn
          [14, 3],
          [12, 6],
          [10, 6],
          [8, 3],
          [7, 1],
          [5, 0],
        ],
      });
      const errors = validateTrack(track);
      const radiusErrors = errors.filter((e) => e.type === 'corner_radius_too_tight');
      expect(radiusErrors.length).toBeGreaterThan(0);

      // Check that at least one has point index information
      expect(radiusErrors[0].details).toHaveProperty('pointIndex');
      expect(typeof radiusErrors[0].details?.pointIndex).toBe('number');
    });
  });

  describe('degenerate segments', () => {
    it('rejects segments shorter than 0.5m', () => {
      const track = createValidTrack({
        centreline: [
          [0, 0],
          [10, 0],
          [10.1, 0], // Only 0.1m long!
          [20, 5],
          [25, 15],
          [20, 25],
          [10, 30],
          [0, 25],
          [-10, 15],
        ],
      });
      const errors = validateTrack(track);
      expect(errors).toContainEqual(expect.objectContaining({ type: 'degenerate_segment' }));
    });

    it('accepts segments 0.5m or longer', () => {
      const track = createValidTrack({
        centreline: [
          [0, 0],
          [10, 0],
          [10.5, 0], // Exactly 0.5m
          [20, 5],
          [25, 15],
          [20, 25],
          [10, 30],
          [0, 25],
          [-10, 15],
        ],
      });
      const errors = validateTrack(track);
      expect(errors.filter((e) => e.type === 'degenerate_segment')).toHaveLength(0);
    });
  });

  describe('error details', () => {
    it('includes specific error details for insufficient points', () => {
      const track = createValidTrack({
        centreline: [[0, 0], [10, 0], [20, 5], [25, 15], [20, 25], [10, 30], [0, 25]],
      });
      const errors = validateTrack(track);
      const error = errors.find((e) => e.type === 'insufficient_points');
      expect(error?.details?.pointCount).toBe(7);
    });

    it('includes segment indices in self-intersection errors', () => {
      const track = createValidTrack({
        centreline: [
          [0, 0],
          [10, 10],
          [20, 0],
          [10, -10],
          [0, 0],
          [10, 0],
          [20, 10],
          [-5, 5],
          [-10, -5],
        ],
      });
      const errors = validateTrack(track);
      const error = errors.find((e) => e.type === 'self_intersection');
      expect(error?.details?.segment1).toBeDefined();
      expect(error?.details?.segment2).toBeDefined();
    });

    it('includes radius in corner validation errors', () => {
      const track = createValidTrack({
        centreline: [
          [0, 0],
          [20, 0],
          [30, 0],
          [32, 4],
          [20, 8],
          [10, 8],
          [5, 4],
          [5, 0],
          [7, -2],
        ],
      });
      const errors = validateTrack(track);
      const error = errors.find((e) => e.type === 'corner_radius_too_tight');
      expect(error?.details?.radius).toBeDefined();
      expect(error?.details?.minRequired).toBe(4.3);
    });
  });

  describe('edge cases', () => {
    it('handles exactly 8 points (minimum)', () => {
      const track = createValidTrack({
        centreline: [
          [0, 0],
          [10, 0],
          [20, 5],
          [25, 15],
          [20, 25],
          [10, 30],
          [0, 25],
          [-10, 15],
        ],
      });
      const errors = validateTrack(track);
      expect(errors.filter((e) => e.type === 'insufficient_points')).toHaveLength(0);
    });

    it('handles startIndex 0', () => {
      const track = createValidTrack({ startIndex: 0 });
      const errors = validateTrack(track);
      expect(errors.filter((e) => e.type === 'startindex_out_of_range')).toHaveLength(0);
    });

    it('handles startIndex at last valid index', () => {
      const n = 10; // The test track has 10 points
      const track = createValidTrack({ startIndex: n - 1 });
      const errors = validateTrack(track);
      expect(errors.filter((e) => e.type === 'startindex_out_of_range')).toHaveLength(0);
    });
  });
});
