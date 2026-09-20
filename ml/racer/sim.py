"""Racer physics — Python port of web/src/lib/games/racer/physics.ts.

Mirrors docs/CONTRACTS.md §4 exactly: the twelve-step kinematic bicycle model
update, `wrap_pi`, and the fixed-step-march-plus-bisection ray caster. Order
matters — floating point is not associative, and a reordered update breaks
parity with the TypeScript implementation this is trained against. Do not
"clean up" `step()` without re-checking every step against CONTRACTS §4 and
against `physics.ts` line by line.

All state is float64 (plain Python floats / np.float64). Never np.float32
here — it costs six orders of magnitude of precision and fails the 1e-9
parity tolerance in ml/conformance/test_racer_parity.py.

Pure functions only. No I/O, no randomness.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import TYPE_CHECKING

from ml.racer.track import is_on_track

if TYPE_CHECKING:
    from ml.racer.track import Track

# ---------------------------------------------------------------------------
# Constants — CONTRACTS §4. Named module-level constants with the contract's
# exact literal values, so a test can assert against them directly. Must
# match web/src/lib/games/racer/physics.ts exactly.
# ---------------------------------------------------------------------------

DT = 1.0 / 60.0  # s
WHEELBASE = 2.5  # m
MASS = 1100.0  # kg
MAX_SPEED = 55.0  # m/s
MAX_REVERSE_SPEED = 18.0  # m/s
MAX_STEER_ANGLE = 0.52  # rad
ENGINE_FORCE = 9000.0  # N
BRAKE_FORCE = 14000.0  # N
DRAG_COEFF = 0.42  # N per (m/s)^2
ROLLING_RESISTANCE = 12.0  # N per (m/s)
MAX_ANGULAR = 3.0  # rad/s (normalisation only, not a physical limit)
RAY_MAX_RANGE = 50.0  # m

# Derived, but named so both languages compute wrap_pi from the same literal
# constant rather than re-deriving 2 * pi inline.
TWO_PI = 2.0 * math.pi

# Ray angles relative to heading, in this exact order (CONTRACTS §4).
RAY_ANGLES: tuple[float, ...] = (-1.2, -0.8, -0.4, 0.0, 0.4, 0.8, 1.2)

# Ray-casting resolution. NOT part of CONTRACTS §4 in the sense of being a
# physical constant — the contract specifies the ray angles, max range, and
# normalisation, but not how a ray finds the track boundary (the boundary has
# no closed form for an arbitrary polyline). physics.ts's choice: march in
# fixed steps of RAY_MARCH_STEP from the car, then refine the last on/off
# bracket with RAY_BISECTION_ITERATIONS bisection steps. These constants must
# match physics.ts exactly, same step size and iteration count, so this port
# reproduces identical arithmetic rather than an approximate root-finder.
RAY_MARCH_STEP = 0.1  # m
RAY_BISECTION_ITERATIONS = 32


@dataclass(frozen=True)
class CarState:
    """World-frame car state. Position in metres, heading in radians (0 = +x
    axis, increases counter-clockwise), velocities in m/s, all float64."""

    x: float
    y: float
    heading: float
    vx: float
    vy: float
    angular_velocity: float


@dataclass(frozen=True)
class ControlInput:
    """Raw control input for one tick. steer/throttle are clamped to
    [-1, 1] inside step(); callers do not need to pre-clamp."""

    steer: float
    throttle: float


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def wrap_pi(h: float) -> float:
    """Wrap a heading into (-PI, PI]. Must be exactly this formula —
    CONTRACTS §4 explicitly forbids fmod, %, or atan2(sin, cos) substitutes,
    which differ from this at the boundaries."""
    return h - TWO_PI * math.floor((h + math.pi) / TWO_PI)


def step(car: CarState, control: ControlInput, _track: Track | None = None) -> CarState:
    """Advance the car one fixed tick (DT seconds) per CONTRACTS §4's twelve
    numbered steps, applied in exactly that order. `_track` is accepted to
    match the contract's declared TS signature but is not consulted by the
    update itself — none of the twelve steps reference it. Leaving the track
    is a dnf handled by callers via track.py's is_on_track/update_race_state,
    not a physics event this function reacts to (the car is never bounced).
    """
    # 1
    steer = _clamp(control.steer, -1.0, 1.0)
    throttle = _clamp(control.throttle, -1.0, 1.0)
    # 2
    steer_angle = steer * MAX_STEER_ANGLE
    # 3
    speed = car.vx * math.cos(car.heading) + car.vy * math.sin(car.heading)
    # 4
    f_long = throttle * ENGINE_FORCE if throttle >= 0 else throttle * BRAKE_FORCE
    # 5
    f_drag = -DRAG_COEFF * speed * abs(speed)
    # 6
    f_roll = -ROLLING_RESISTANCE * speed
    # 7
    accel = (f_long + f_drag + f_roll) / MASS
    # 8
    speed = _clamp(speed + accel * DT, -MAX_REVERSE_SPEED, MAX_SPEED)
    # 9
    angular_velocity = (speed * math.tan(steer_angle)) / WHEELBASE
    # 10
    heading = wrap_pi(car.heading + angular_velocity * DT)
    # 11
    vx = speed * math.cos(heading)
    vy = speed * math.sin(heading)
    # 12
    x = car.x + vx * DT
    y = car.y + vy * DT

    return CarState(x=x, y=y, heading=heading, vx=vx, vy=vy, angular_velocity=angular_velocity)


def _cast_single_ray(
    track: Track,
    origin_x: float,
    origin_y: float,
    dir_x: float,
    dir_y: float,
) -> float:
    """March outward from (origin_x, origin_y) along (dir_x, dir_y) and
    bisect the last on/off-track bracket. Returns the raw (unnormalised) hit
    distance, or RAY_MAX_RANGE if nothing was hit within range."""
    if not is_on_track(track, origin_x, origin_y):
        return 0.0

    prev_t = 0.0
    t = 0.0
    while t <= RAY_MAX_RANGE:
        px = origin_x + dir_x * t
        py = origin_y + dir_y * t
        if not is_on_track(track, px, py):
            lo = prev_t
            hi = t
            for _ in range(RAY_BISECTION_ITERATIONS):
                mid = (lo + hi) / 2
                mx = origin_x + dir_x * mid
                my = origin_y + dir_y * mid
                if is_on_track(track, mx, my):
                    lo = mid
                else:
                    hi = mid
            return lo
        prev_t = t
        t += RAY_MARCH_STEP
    return RAY_MAX_RANGE


def cast_rays(car: CarState, track: Track) -> list[float]:
    """Cast the 7 rays of CONTRACTS §4 from the car centre, at RAY_ANGLES
    relative to car.heading, clipped to RAY_MAX_RANGE and normalised to
    distance / RAY_MAX_RANGE. A ray hitting nothing in range reports exactly
    1.0."""
    rays: list[float] = []
    for offset in RAY_ANGLES:
        angle = car.heading + offset
        dist = _cast_single_ray(track, car.x, car.y, math.cos(angle), math.sin(angle))
        rays.append(dist / RAY_MAX_RANGE)
    return rays
