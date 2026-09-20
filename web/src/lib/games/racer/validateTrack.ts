import type { Track } from './types';

export interface ValidationError {
  type: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Compute the radius of curvature for three consecutive points.
 * Returns the radius of the circle passing through all three points.
 * If the points are collinear (or very close), returns Infinity.
 */
function computeCurveRadius(p1: [number, number], p2: [number, number], p3: [number, number]): number {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const [x3, y3] = p3;

  // Vectors from p2 to p1 and p2 to p3
  const ax = x1 - x2;
  const ay = y1 - y2;
  const bx = x3 - x2;
  const by = y3 - y2;

  // Cross product to get twice the area
  const cross = ax * by - ay * bx;

  if (Math.abs(cross) < 1e-10) {
    // Points are collinear or coincident
    return Infinity;
  }

  // Side lengths
  const a = Math.sqrt((x3 - x2) ** 2 + (y3 - y2) ** 2);
  const b = Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
  const c = Math.sqrt((x3 - x1) ** 2 + (y3 - y1) ** 2);

  // Circumradius = (a * b * c) / (4 * area)
  const area = Math.abs(cross) / 2;
  const radius = (a * b * c) / (4 * area);

  return radius;
}

/**
 * Check if two line segments intersect.
 * Returns true if the segments intersect (not including endpoints touching).
 */
function segmentsIntersect(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number]
): boolean {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const [x3, y3] = p3;
  const [x4, y4] = p4;

  const ccw = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
    return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
  };

  // Check if segments actually intersect (not just bounding boxes)
  return ccw(x1, y1, x3, y3, x4, y4) !== ccw(x2, y2, x3, y3, x4, y4) &&
    ccw(x1, y1, x2, y2, x3, y3) !== ccw(x1, y1, x2, y2, x4, y4);
}

/**
 * Validate a track definition.
 * Returns an array of validation errors. Empty array means the track is valid.
 */
export function validateTrack(track: Track): ValidationError[] {
  const errors: ValidationError[] = [];

  // Check that centreline is an array with at least 8 points
  if (!Array.isArray(track.centreline)) {
    errors.push({
      type: 'centreline_not_array',
      message: 'centreline must be an array',
    });
    return errors; // Can't proceed without this
  }

  if (track.centreline.length < 8) {
    errors.push({
      type: 'insufficient_points',
      message: `centreline must have at least 8 points, got ${track.centreline.length}`,
      details: { pointCount: track.centreline.length },
    });
  }

  // Check for duplicate consecutive points
  for (let i = 0; i < track.centreline.length; i++) {
    const curr = track.centreline[i];
    const next = track.centreline[(i + 1) % track.centreline.length];

    if (curr[0] === next[0] && curr[1] === next[1]) {
      errors.push({
        type: 'duplicate_consecutive_points',
        message: `Points at indices ${i} and ${(i + 1) % track.centreline.length} are identical`,
        details: { index1: i, index2: (i + 1) % track.centreline.length, point: [curr[0], curr[1]] },
      });
    }
  }

  // Check halfWidth is positive and sane
  if (typeof track.halfWidth !== 'number' || track.halfWidth <= 0) {
    errors.push({
      type: 'invalid_halfwidth',
      message: `halfWidth must be a positive number, got ${track.halfWidth}`,
      details: { halfWidth: track.halfWidth },
    });
  }

  if (track.halfWidth > 100) {
    errors.push({
      type: 'halfwidth_excessive',
      message: `halfWidth is unreasonably large (${track.halfWidth}m), maximum 100m`,
      details: { halfWidth: track.halfWidth },
    });
  }

  // Check startIndex is in range
  if (typeof track.startIndex !== 'number' || track.startIndex < 0 || track.startIndex >= track.centreline.length) {
    errors.push({
      type: 'startindex_out_of_range',
      message: `startIndex must be in range [0, ${track.centreline.length - 1}], got ${track.startIndex}`,
      details: { startIndex: track.startIndex, pointCount: track.centreline.length },
    });
  }

  // Check for self-intersection of the centreline
  // Compare each segment with non-adjacent segments
  const n = track.centreline.length;
  for (let i = 0; i < n; i++) {
    const p1 = track.centreline[i];
    const p2 = track.centreline[(i + 1) % n];

    // Only check against segments that are at least 2 apart (non-adjacent)
    for (let j = i + 2; j < i + n - 1; j++) {
      const jj = j % n;
      const p3 = track.centreline[jj];
      const p4 = track.centreline[(jj + 1) % n];

      if (segmentsIntersect(p1, p2, p3, p4)) {
        errors.push({
          type: 'self_intersection',
          message: `Centreline self-intersects: segment ${i}->${(i + 1) % n} crosses segment ${jj}->${(jj + 1) % n}`,
          details: { segment1: [i, (i + 1) % n], segment2: [jj, (jj + 1) % n] },
        });
      }
    }
  }

  // Check corner radius navigability
  // The car's minimum radius at full lock is approximately 4.3m
  const MIN_NAVIGABLE_RADIUS = 4.3;
  const SAFE_MARGIN = 1.0; // Use 5.3m as practical minimum

  for (let i = 0; i < track.centreline.length; i++) {
    const p1 = track.centreline[i];
    const p2 = track.centreline[(i + 1) % track.centreline.length];
    const p3 = track.centreline[(i + 2) % track.centreline.length];

    const radius = computeCurveRadius(p1, p2, p3);

    if (radius < MIN_NAVIGABLE_RADIUS) {
      errors.push({
        type: 'corner_radius_too_tight',
        message: `Corner at point ${(i + 1) % track.centreline.length} has radius ${radius.toFixed(2)}m, minimum is ${MIN_NAVIGABLE_RADIUS}m`,
        details: {
          pointIndex: (i + 1) % track.centreline.length,
          radius,
          minRequired: MIN_NAVIGABLE_RADIUS,
        },
      });
    } else if (radius < SAFE_MARGIN + MIN_NAVIGABLE_RADIUS) {
      // Warning level - not an error, but note it
      // Actually, per the task, this is a hard error
      errors.push({
        type: 'corner_radius_too_tight',
        message: `Corner at point ${(i + 1) % track.centreline.length} has radius ${radius.toFixed(2)}m, should be > ${SAFE_MARGIN + MIN_NAVIGABLE_RADIUS}m for safety margin`,
        details: {
          pointIndex: (i + 1) % track.centreline.length,
          radius,
          minRequired: MIN_NAVIGABLE_RADIUS,
          safetyMargin: SAFE_MARGIN,
        },
      });
    }
  }

  // Check for degenerate segment lengths
  // A segment much shorter than halfWidth can cause issues
  for (let i = 0; i < track.centreline.length; i++) {
    const p1 = track.centreline[i];
    const p2 = track.centreline[(i + 1) % track.centreline.length];

    const segLen = Math.sqrt((p2[0] - p1[0]) ** 2 + (p2[1] - p1[1]) ** 2);

    if (segLen < 0.5) {
      errors.push({
        type: 'degenerate_segment',
        message: `Segment ${i}->${(i + 1) % track.centreline.length} is too short (${segLen.toFixed(3)}m), minimum 0.5m`,
        details: { segmentIndex: i, length: segLen },
      });
    }
  }

  return errors;
}

/**
 * Parse untrusted JSON into a `Track`.
 *
 * Track files are fetched at runtime from `static/tracks/`, and a JSON import
 * widens `[number, number][]` to `number[][]` — TypeScript cannot know a nested
 * array has exactly two entries. Rather than casting that away at each call
 * site, this checks the shape once and narrows properly.
 *
 * Returns the track, or throws with a message naming what was wrong. Callers
 * that want the full list of problems should run `validateTrack` afterwards:
 * this only proves the value is shaped like a Track, not that it is drivable.
 */
export function parseTrack(json: unknown): Track {
	if (typeof json !== 'object' || json === null) {
		throw new Error('track: expected an object');
	}
	const t = json as Record<string, unknown>;

	if (typeof t.name !== 'string') throw new Error('track: name must be a string');
	if (typeof t.halfWidth !== 'number' || !Number.isFinite(t.halfWidth)) {
		throw new Error('track: halfWidth must be a finite number');
	}
	if (!Number.isInteger(t.startIndex)) {
		throw new Error('track: startIndex must be an integer');
	}
	if (!Array.isArray(t.centreline)) {
		throw new Error('track: centreline must be an array');
	}

	const centreline: [number, number][] = t.centreline.map((point, i) => {
		if (!Array.isArray(point) || point.length !== 2) {
			throw new Error(`track: centreline[${i}] must be a pair of numbers`);
		}
		const [x, y] = point;
		if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
			throw new Error(`track: centreline[${i}] must contain two finite numbers`);
		}
		return [x, y];
	});

	return {
		name: t.name,
		centreline,
		halfWidth: t.halfWidth,
		startIndex: t.startIndex as number
	};
}
