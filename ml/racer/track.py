"""Track geometry — Python port of web/src/lib/games/racer/track.ts.

Implements CONTRACTS §4 "Track representation". A track is a closed
centreline polyline plus a constant half-width; everything else (on-track
test, ray boundary, lap crossing) is derived from that.

Pure functions only. No I/O, no randomness.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


@dataclass(frozen=True)
class Track:
    """A closed centreline polyline plus a constant half-width. Everything
    else (on-track test, ray casting, lap crossing) is derived from this."""

    name: str
    # Closed loop; the last point implicitly joins the first. At least 3 points.
    centreline: tuple[tuple[float, float], ...]
    # Metres, applied uniformly around the whole centreline.
    half_width: float
    # Index into centreline; the segment (this point -> the next point,
    # wrapping) is the start/finish line's gate.
    start_index: int = 0


@dataclass
class RaceState:
    """Lap-validity bookkeeping across ticks. NOT part of CONTRACTS §4 — the
    contract only specifies the rule in prose. This module implements that
    rule against this shape; callers thread the returned value from one tick
    to the next."""

    # Number of laps completed by a forward crossing of the start gate while
    # the in-progress lap was still valid.
    lap_count: int = 0
    # False once the car has left the track (dnf) or crossed the start gate
    # backwards during the current lap. Reset to true on the next forward
    # crossing, which starts a new lap.
    lap_valid: bool = field(default=True)


def _distance_to_segment_squared(
    px: float, py: float, ax: float, ay: float, bx: float, by: float
) -> float:
    """Squared distance from (px,py) to the segment a->b. Squared to avoid
    an unnecessary sqrt while scanning every segment for the minimum."""
    abx = bx - ax
    aby = by - ay
    ab_len_sq = abx * abx + aby * aby
    apx = px - ax
    apy = py - ay
    t = _clamp((apx * abx + apy * aby) / ab_len_sq, 0.0, 1.0) if ab_len_sq > 0 else 0.0
    cx = ax + abx * t
    cy = ay + aby * t
    dx = px - cx
    dy = py - cy
    return dx * dx + dy * dy


def distance_to_nearest_centreline_segment(track: Track, x: float, y: float) -> float:
    """Minimum distance from (x, y) to the closed centreline polyline, per
    CONTRACTS §4. The loop closes implicitly (segment from the last point
    back to the first)."""
    pts = track.centreline
    n = len(pts)
    min_dist_sq = math.inf
    for i in range(n):
        a = pts[i]
        b = pts[(i + 1) % n]
        d = _distance_to_segment_squared(x, y, a[0], a[1], b[0], b[1])
        if d < min_dist_sq:
            min_dist_sq = d
    return math.sqrt(min_dist_sq)


def is_on_track(track: Track, x: float, y: float) -> bool:
    """On track per CONTRACTS §4: distance to the nearest centreline
    segment is at most the half-width. Leaving the track is a dnf for the
    lap, not a physics event — callers do not bounce the car off this
    boundary."""
    return distance_to_nearest_centreline_segment(track, x, y) <= track.half_width


# ---------------------------------------------------------------------------
# Lap crossing. NOT specified structurally by CONTRACTS §4 (the contract only
# gives the rule in prose: forward crossing of the start segment counts,
# backward invalidates rather than decrements). Ported faithfully from
# track.ts's own design, which that file itself flags as provisional.
# ---------------------------------------------------------------------------


def _cross2(ax: float, ay: float, bx: float, by: float) -> float:
    """Signed 2D cross product of (ax,ay) and (bx,by)."""
    return ax * by - ay * bx


def _segments_intersect(
    p1: tuple[float, float],
    p2: tuple[float, float],
    p3: tuple[float, float],
    p4: tuple[float, float],
) -> bool:
    """Standard segment-segment intersection test (proper crossing,
    including endpoints) via the parametric line intersection. Returns False
    for parallel (including collinear) segments — a car travelling exactly
    along the gate line is not a meaningful case for this track model."""
    d1x = p2[0] - p1[0]
    d1y = p2[1] - p1[1]
    d2x = p4[0] - p3[0]
    d2y = p4[1] - p3[1]
    denom = _cross2(d1x, d1y, d2x, d2y)
    if denom == 0:
        return False
    rx = p3[0] - p1[0]
    ry = p3[1] - p1[1]
    t = _cross2(rx, ry, d2x, d2y) / denom
    u = _cross2(rx, ry, d1x, d1y) / denom
    return 0 <= t <= 1 and 0 <= u <= 1


def start_line_gate(track: Track) -> tuple[tuple[float, float], tuple[float, float]]:
    """The start/finish gate: a segment perpendicular to the centreline
    direction at track.centreline[track.start_index], spanning wider than
    the track (1.5x the half-width on each side) so a car anywhere across
    the track width still crosses it."""
    pts = track.centreline
    n = len(pts)
    p = pts[track.start_index]
    q = pts[(track.start_index + 1) % n]
    dx = q[0] - p[0]
    dy = q[1] - p[1]
    length = math.hypot(dx, dy)
    nx = -dy / length
    ny = dx / length
    half = track.half_width * 1.5
    return (
        (p[0] + nx * half, p[1] + ny * half),
        (p[0] - nx * half, p[1] - ny * half),
    )


def crossing_direction(
    track: Track,
    prev: tuple[float, float],
    curr: tuple[float, float],
) -> int:
    """Whether the car's movement from prev to curr crossed the start gate,
    and in which direction. Direction is the sign of the dot product between
    the movement vector and the centreline's forward tangent at the start
    point: +1 means "with the track direction" (forward), -1 means against
    it (backward). Returns 0 when the gate was not crossed."""
    gate_a, gate_b = start_line_gate(track)
    if not _segments_intersect(prev, curr, gate_a, gate_b):
        return 0

    pts = track.centreline
    n = len(pts)
    p = pts[track.start_index]
    q = pts[(track.start_index + 1) % n]
    tangent_x = q[0] - p[0]
    tangent_y = q[1] - p[1]
    move_x = curr[0] - prev[0]
    move_y = curr[1] - prev[1]
    dot = tangent_x * move_x + tangent_y * move_y
    if dot > 0:
        return 1
    if dot < 0:
        return -1
    return 0


def init_race_state() -> RaceState:
    return RaceState(lap_count=0, lap_valid=True)


def update_race_state(
    state: RaceState,
    track: Track,
    prev: tuple[float, float],
    curr: tuple[float, float],
    on_track: bool,
) -> RaceState:
    """Advance lap bookkeeping by one tick. `on_track` is the caller's own
    is_on_track check for the *current* position (leaving the track
    invalidates the in-progress lap; the car is not moved or bounced). A
    forward gate crossing completes the in-progress lap (if it was still
    valid) and starts a fresh, valid one. A backward crossing invalidates
    the current lap without decrementing lap_count."""
    lap_count = state.lap_count
    lap_valid = state.lap_valid
    if not on_track:
        lap_valid = False

    crossing = crossing_direction(track, prev, curr)
    if crossing == 1:
        if lap_valid:
            lap_count += 1
        lap_valid = True
    elif crossing == -1:
        lap_valid = False

    return RaceState(lap_count=lap_count, lap_valid=lap_valid)
