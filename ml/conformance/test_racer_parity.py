"""Cross-language parity: `ml/racer/{sim,track}.py` against
`shared/fixtures/racer_trace.json` — see docs/CONTRACTS.md §2 and §4.

Neither language owns the physics; the fixture (generated from
web/src/lib/games/racer/{physics,track}.ts) does. This test replays all 660
ticks of the golden trace through the Python port and asserts every field of
every tick matches to 1e-9, recasts rays at the 13 named checkpoints, checks
the exact literal values of every named constant, exercises wrap_pi and the
on/off-track boundary directly, and — critically — proves the test itself has
teeth: a deliberately reordered update must diverge from the trace.
"""

from __future__ import annotations

import json
import math

import pytest

from ml.paths import fixture
from ml.racer import sim, track
from ml.racer.sim import CarState, ControlInput
from ml.racer.track import Track

with open(fixture("racer_trace.json"), encoding="utf-8") as _f:
    _FIXTURE = json.load(_f)

_TRACK_DATA = _FIXTURE["track"]
_TRACK = Track(
    name=_TRACK_DATA["name"],
    centreline=tuple((p[0], p[1]) for p in _TRACK_DATA["centreline"]),
    half_width=_TRACK_DATA["halfWidth"],
    start_index=_TRACK_DATA["startIndex"],
)
_INITIAL_CAR = _FIXTURE["initialCar"]
_TICKS: list[dict] = _FIXTURE["ticks"]
_RAY_CHECKPOINTS: list[dict] = _FIXTURE["rayCheckpoints"]

TOLERANCE = 1e-9

_STATE_FIELDS = ("x", "y", "heading", "vx", "vy", "angularVelocity")


def _car_from_dict(d: dict) -> CarState:
    return CarState(
        x=d["x"],
        y=d["y"],
        heading=d["heading"],
        vx=d["vx"],
        vy=d["vy"],
        angular_velocity=d["angularVelocity"],
    )


def _car_field(car: CarState, name: str) -> float:
    if name == "angularVelocity":
        return car.angular_velocity
    return getattr(car, name)


# ---------------------------------------------------------------------------
# 1. Constants — must match CONTRACTS §4 literal values exactly.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("DT", 1.0 / 60.0),
        ("WHEELBASE", 2.5),
        ("MASS", 1100.0),
        ("MAX_SPEED", 55.0),
        ("MAX_REVERSE_SPEED", 18.0),
        ("MAX_STEER_ANGLE", 0.52),
        ("ENGINE_FORCE", 9000.0),
        ("BRAKE_FORCE", 14000.0),
        ("DRAG_COEFF", 0.42),
        ("ROLLING_RESISTANCE", 12.0),
        ("MAX_ANGULAR", 3.0),
        ("RAY_MAX_RANGE", 50.0),
    ],
)
def test_constant_matches_contract(name: str, expected: float) -> None:
    assert getattr(sim, name) == expected


def test_ray_angles_match_contract() -> None:
    assert sim.RAY_ANGLES == (-1.2, -0.8, -0.4, 0.0, 0.4, 0.8, 1.2)


def test_two_pi_derived_correctly() -> None:
    assert sim.TWO_PI == 2.0 * math.pi


def test_ray_march_constants_are_named_and_match_ts() -> None:
    # These are not physical constants from CONTRACTS §4, but P4-A exported
    # them specifically so this port reproduces identical ray-marching
    # arithmetic (same step size, same iteration count).
    assert sim.RAY_MARCH_STEP == 0.1
    assert sim.RAY_BISECTION_ITERATIONS == 32


# ---------------------------------------------------------------------------
# 2. Full trace conformance — all 660 ticks, every field, to 1e-9.
# ---------------------------------------------------------------------------


def _replay_all_ticks() -> list[CarState]:
    car = _car_from_dict(_INITIAL_CAR)
    states = []
    for entry in _TICKS:
        control = ControlInput(steer=entry["input"]["steer"], throttle=entry["input"]["throttle"])
        car = sim.step(car, control, _TRACK)
        states.append(car)
    return states


def test_trace_has_expected_tick_count() -> None:
    assert len(_TICKS) == 660


def test_full_trace_conformance_all_fields() -> None:
    car = _car_from_dict(_INITIAL_CAR)
    worst: dict[str, float] = dict.fromkeys(_STATE_FIELDS, 0.0)
    worst_tick: dict[str, int] = dict.fromkeys(_STATE_FIELDS, -1)

    for entry in _TICKS:
        control = ControlInput(steer=entry["input"]["steer"], throttle=entry["input"]["throttle"])
        car = sim.step(car, control, _TRACK)

        expected = entry["state"]
        for field_name in _STATE_FIELDS:
            actual_val = _car_field(car, field_name)
            expected_val = expected[field_name]
            dev = abs(actual_val - expected_val)
            if dev > worst[field_name]:
                worst[field_name] = dev
                worst_tick[field_name] = entry["tick"]
            assert dev <= TOLERANCE, (
                f"tick {entry['tick']} field {field_name}: "
                f"actual={actual_val!r} expected={expected_val!r} deviation={dev!r}"
            )

        expected_on_track = entry["onTrack"]
        actual_on_track = track.is_on_track(_TRACK, car.x, car.y)
        assert actual_on_track == expected_on_track, f"tick {entry['tick']}: onTrack mismatch"

    # Report the worst deviation observed across the whole trace, per field.
    print("\nWorst absolute deviation per field across all 660 ticks:")
    for field_name in _STATE_FIELDS:
        print(f"  {field_name}: {worst[field_name]!r} (tick {worst_tick[field_name]})")


# ---------------------------------------------------------------------------
# 3. Ray checkpoints — the fixture's 13 named checkpoints.
# ---------------------------------------------------------------------------


def test_ray_checkpoint_count() -> None:
    assert len(_RAY_CHECKPOINTS) == 13


@pytest.mark.parametrize("checkpoint", _RAY_CHECKPOINTS, ids=[c["label"] for c in _RAY_CHECKPOINTS])
def test_ray_checkpoint(checkpoint: dict) -> None:
    car = _car_from_dict(checkpoint["state"])
    actual_rays = sim.cast_rays(car, _TRACK)
    expected_rays = checkpoint["rays"]
    assert len(actual_rays) == len(expected_rays) == 7
    for i, (actual, expected) in enumerate(zip(actual_rays, expected_rays, strict=True)):
        dev = abs(actual - expected)
        assert dev <= TOLERANCE, (
            f"checkpoint {checkpoint['label']} ray {i}: "
            f"actual={actual!r} expected={expected!r} deviation={dev!r}"
        )


# ---------------------------------------------------------------------------
# 4. wrap_pi at boundaries.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("h", "expected"),
    [
        # Exactly `h - TWO_PI * floor((h + PI) / TWO_PI)`, evaluated literally
        # (not "wrapped into (-PI, PI]" by assumption) — at odd multiples of
        # PI, `(h + PI) / TWO_PI` lands on an integer, so floor rounds up and
        # the formula returns -PI, not +PI. Both languages must agree on this
        # exact behaviour, edge cases included, since it is bit-for-bit what
        # CONTRACTS §4 specifies.
        (math.pi, -math.pi),
        (-math.pi, -math.pi),
        (2 * math.pi, 0.0),
        (-2 * math.pi, 0.0),
        (3 * math.pi, -math.pi),
        (-3 * math.pi, -math.pi),
        (100 * math.pi, 0.0),
        (101 * math.pi, -3.1415926535897825),
        (-100 * math.pi, 0.0),
    ],
)
def test_wrap_pi_boundaries(h: float, expected: float) -> None:
    actual = sim.wrap_pi(h)
    assert abs(actual - expected) <= TOLERANCE, f"wrap_pi({h}) = {actual}, expected {expected}"


def test_wrap_pi_matches_literal_formula_definition() -> None:
    # Belt-and-suspenders: assert wrap_pi is *exactly* the contract's formula,
    # not merely numerically close to some other wrapping strategy (fmod,
    # atan2(sin,cos), etc, which the contract explicitly forbids because they
    # differ at these boundaries).
    for h in [0.1, -0.1, math.pi, -math.pi, 5.0, -5.0, 123.456, -123.456]:
        expected = h - sim.TWO_PI * math.floor((h + math.pi) / sim.TWO_PI)
        assert sim.wrap_pi(h) == expected


def test_wrap_pi_result_always_in_range() -> None:
    # (-PI, PI] by construction of the formula.
    for h in [0.0, 1.0, -1.0, 10.0, -10.0, 1000.5, -1000.5]:
        w = sim.wrap_pi(h)
        assert -math.pi < w <= math.pi + TOLERANCE


# ---------------------------------------------------------------------------
# 5. On/off-track boundary, including exactly at halfWidth.
# ---------------------------------------------------------------------------


def test_on_track_at_centre() -> None:
    cx, cy = _TRACK.centreline[0]
    assert track.is_on_track(_TRACK, cx, cy)


def _axis_aligned_segment_track() -> Track:
    # A minimal synthetic track (not the fixture's oval) whose single
    # meaningful segment is horizontal, so a point offset along its normal
    # by exactly half_width lands at exactly that distance with no floating
    # point drift from an angled normal — the boundary test needs that
    # exactness, which a vertex of the 24-gon fixture track cannot give
    # (corner regions are closer to an adjacent segment than the perpendicular
    # offset suggests).
    return Track(name="boundary-test", centreline=((0.0, 0.0), (10.0, 0.0)), half_width=3.0)


def test_on_track_exactly_at_half_width() -> None:
    t = _axis_aligned_segment_track()
    # Midpoint of the segment (0,0)->(10,0), offset by exactly half_width
    # along the exact vertical normal.
    px, py = 5.0, 3.0
    dist = track.distance_to_nearest_centreline_segment(t, px, py)
    assert dist == t.half_width
    assert track.is_on_track(t, px, py)


def test_off_track_just_beyond_half_width() -> None:
    t = _axis_aligned_segment_track()
    px, py = 5.0, 3.0 + 1e-6
    assert not track.is_on_track(t, px, py)


def test_on_track_just_inside_half_width() -> None:
    t = _axis_aligned_segment_track()
    px, py = 5.0, 3.0 - 1e-6
    assert track.is_on_track(t, px, py)


def test_far_off_track() -> None:
    assert not track.is_on_track(_TRACK, 10000.0, 10000.0)


# ---------------------------------------------------------------------------
# 6. Teeth test: a deliberately reordered/wrong update must diverge from the
# golden trace. If this test cannot tell the correct port from a broken one,
# the parity test above is decoration, not verification.
# ---------------------------------------------------------------------------


def _tampered_step(car: CarState, control: ControlInput) -> CarState:
    """A deliberately WRONG reordering of sim.step's twelve steps: computes
    angular_velocity (step 9) from the pre-clamp speed (before step 8) rather
    than the post-clamp speed. Mirrors CONTRACTS §4's own example of the kind
    of reordering that must be caught."""
    steer = max(-1.0, min(1.0, control.steer))
    throttle = max(-1.0, min(1.0, control.throttle))
    steer_angle = steer * sim.MAX_STEER_ANGLE
    speed_pre = car.vx * math.cos(car.heading) + car.vy * math.sin(car.heading)
    f_long = throttle * sim.ENGINE_FORCE if throttle >= 0 else throttle * sim.BRAKE_FORCE
    f_drag = -sim.DRAG_COEFF * speed_pre * abs(speed_pre)
    f_roll = -sim.ROLLING_RESISTANCE * speed_pre
    accel = (f_long + f_drag + f_roll) / sim.MASS
    speed_post = max(-sim.MAX_REVERSE_SPEED, min(sim.MAX_SPEED, speed_pre + accel * sim.DT))
    # BUG: uses speed_pre (pre-clamp) instead of speed_post (post-clamp).
    angular_velocity = (speed_pre * math.tan(steer_angle)) / sim.WHEELBASE
    heading = sim.wrap_pi(car.heading + angular_velocity * sim.DT)
    vx = speed_post * math.cos(heading)
    vy = speed_post * math.sin(heading)
    x = car.x + vx * sim.DT
    y = car.y + vy * sim.DT
    return CarState(x=x, y=y, heading=heading, vx=vx, vy=vy, angular_velocity=angular_velocity)


def test_teeth_correct_step_matches_trace() -> None:
    """Sanity companion to the tamper test: the real sim.step reproduces the
    trace exactly (well within tolerance) when replayed the same way."""
    car = _car_from_dict(_INITIAL_CAR)
    for entry in _TICKS:
        control = ControlInput(steer=entry["input"]["steer"], throttle=entry["input"]["throttle"])
        car = sim.step(car, control, _TRACK)
    last_expected = _TICKS[-1]["state"]
    assert abs(car.x - last_expected["x"]) <= TOLERANCE
    assert abs(car.y - last_expected["y"]) <= TOLERANCE
    assert abs(car.heading - last_expected["heading"]) <= TOLERANCE


def test_teeth_tampered_step_diverges_from_trace() -> None:
    """The permanent teeth test: prove the parity test can actually detect a
    reordering. A step that computes angular_velocity from the pre-clamp
    speed instead of the post-clamp speed must diverge from the golden trace
    well beyond tolerance somewhere in the 660 ticks — anywhere a nonzero
    throttle drives speed into its clamp range with nonzero steer."""
    car = _car_from_dict(_INITIAL_CAR)
    max_divergence = 0.0
    for entry in _TICKS:
        control = ControlInput(steer=entry["input"]["steer"], throttle=entry["input"]["throttle"])
        car = _tampered_step(car, control)
        expected = entry["state"]
        max_divergence = max(max_divergence, abs(car.heading - expected["heading"]))

    assert max_divergence > 1e-6, (
        "the tampered (reordered) step failed to diverge from the golden trace — "
        "this parity test would not catch a real reordering bug"
    )
