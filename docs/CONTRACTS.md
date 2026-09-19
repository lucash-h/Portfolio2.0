# CONTRACTS

**This file is the law.** Every agent working on this repo reads it first and does not
change it. If a contract here is wrong or insufficient, stop and report it upward —
do not unilaterally redefine an interface that another package depends on.

The point of this file: multiple agents build different packages at the same time.
They never see each other's code. The only thing keeping their work compatible is
what is written here.

---

## 1. Repository layout

Each top-level area has exactly one owner at a time. Agents do not create or edit
files outside their assigned directory.

```
web/                      SvelteKit app (adapter-node). The only thing deployed.
  src/lib/games/connect4/ Pure TS game logic. No Svelte imports.
  src/lib/games/racer/    Pure TS physics. No Svelte imports.
  src/lib/ml/             ONNX session loading, checkpoint registry.
  src/lib/db/             Postgres schema + query helpers.
  src/lib/components/     Reusable Svelte components.
  src/routes/             Pages and API routes.
  static/models/          Exported .onnx checkpoints + manifest.json.
ml/                       Python. NEVER deployed. Training only.
  connect4/               env, mcts, net, selfplay, train
  racer/                  sim, evolution, train
  export/                 torch -> onnx, manifest generation
  tournament/             checkpoint round-robin -> Elo
  conformance/            cross-language parity tests
shared/fixtures/          Language-neutral JSON test vectors. Shared by TS and Python.
infra/                    docker-compose, Caddyfile, deploy script.
docs/                     PLAN.md, CONTRACTS.md.
```

## 2. The parity rule

Connect 4 and the racer each have **two implementations** of the same simulation:
TypeScript (runs in the browser) and Python (runs during training). If they disagree,
a network trained in Python plays badly in the browser, and the bug is miserable to find.

So: **both implementations are tested against the same JSON fixtures in
`shared/fixtures/`.** Neither language owns the truth; the fixture file does.

- `shared/fixtures/connect4_cases.json` — board states with expected legal moves,
  winner, and terminal status.
- `shared/fixtures/racer_trace.json` — a fixed sequence of control inputs and the
  exact expected physics state after each tick.

A change to a fixture file is a breaking change and requires regenerating checkpoints.

## 3. Connect 4

Board is 6 rows x 7 columns. Row 0 is the **bottom** row. Columns index 0..6 left to right.

```ts
// web/src/lib/games/connect4/types.ts
export type Player = 1 | 2;
export type Cell = 0 | Player;
export type Board = Cell[];            // length 42, index = row * 7 + col
export type Column = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface GameState {
  board: Board;
  toMove: Player;
  moves: Column[];                      // full history, in order
  winner: Player | null;
  isDraw: boolean;
  winningCells: number[] | null;        // 4 board indices, for UI highlight
}
```

Required pure functions (no I/O, no randomness, no mutation of inputs):

```ts
createGame(): GameState
legalMoves(s: GameState): Column[]
applyMove(s: GameState, col: Column): GameState   // returns NEW state; throws on illegal
isTerminal(s: GameState): boolean
```

### Connect 4 ONNX signature

Any Connect 4 checkpoint, regardless of training run, MUST have this signature:

| name     | direction | shape       | meaning |
|----------|-----------|-------------|---------|
| `board`  | input     | `[1,2,6,7]` | float32. Plane 0 = discs of the player to move. Plane 1 = opponent discs. 1.0 or 0.0. Row 0 is the bottom row. |
| `policy` | output    | `[1,7]`     | float32 **logits** (not softmaxed) over columns. |
| `value`  | output    | `[1,1]`     | float32 in [-1, 1]. +1 = player to move is winning. |

The board tensor is always from the **perspective of the player to move**. The network
never learns "red vs yellow"; it learns "me vs them". Callers flip planes, not the net.

Illegal columns are masked by the *caller* after softmax, not by the network.

**Batch dimension — where it is and is not.** The table above describes the ONNX graph,
which is batched: `[1,2,6,7]`. A single-position encoder does **not** include that
dimension; it produces `[2,6,7]`. The batch axis is added at the inference boundary.

| Layer | Shape | Who |
|---|---|---|
| `ml/connect4/env.py` `encode()` | `[2,6,7]` | one position, for training and MCTS |
| Training batch | `[N,2,6,7]` | stacked by the training loop |
| ONNX graph input | `[1,2,6,7]` | the exported model |
| `web/src/lib/ml/session.ts` | `[1,2,6,7]` | browser inference |

Everything else about the encoding — plane order, perspective, row 0 at the bottom —
is identical at every layer. Only the leading axis differs.

## 4. Racer

### Determinism requirements

Training in Python is worthless if the browser physics differ. Therefore:

- Fixed timestep, exactly `1/60` second per tick. Never use frame delta time for physics.
  Render interpolation is fine; simulation steps are fixed.
- All physics state is float64 (TS `number` is already float64; Python must use
  plain floats or `np.float64`, never `float32`).
- No `Math.random()` anywhere in the simulation. Any randomness is seeded and passed in.
- Operations are applied in the exact order given in `shared/fixtures/racer_trace.json`.

```ts
// web/src/lib/games/racer/types.ts
export interface CarState {
  x: number; y: number;        // world position, metres
  heading: number;             // radians, 0 = +x axis, increases counter-clockwise
  vx: number; vy: number;      // world-frame velocity, m/s
  angularVelocity: number;     // rad/s
}

export interface ControlInput {
  steer: number;               // clamped to [-1, 1], positive = left
  throttle: number;            // clamped to [-1, 1], negative = brake/reverse
}

export function step(car: CarState, input: ControlInput, track: Track): CarState;
export function castRays(car: CarState, track: Track): number[];  // length 7
```

### Physics model — exact specification

A kinematic bicycle model. Deliberately slip-free: a simpler model is a model two
languages can actually agree on to 1e-9, and lateral slip buys realism we do not need.

Constants (identical in both implementations, defined once per language as named consts):

```
DT                  = 1.0 / 60.0    s
WHEELBASE           = 2.5           m
MASS                = 1100.0        kg
MAX_SPEED           = 55.0          m/s
MAX_REVERSE_SPEED   = 18.0          m/s
MAX_STEER_ANGLE     = 0.52          rad
ENGINE_FORCE        = 9000.0        N
BRAKE_FORCE         = 14000.0       N
DRAG_COEFF          = 0.42          N per (m/s)^2
ROLLING_RESISTANCE  = 12.0          N per (m/s)
MAX_ANGULAR         = 3.0           rad/s   (normalisation only, not a physical limit)
RAY_MAX_RANGE       = 50.0          m
```

`step()` applies these operations in **exactly this order**. Order matters: floating point
is not associative, and a reordered update will break parity.

1. `steer = clamp(input.steer, -1, 1)`, `throttle = clamp(input.throttle, -1, 1)`
2. `steerAngle = steer * MAX_STEER_ANGLE`
3. `speed = car.vx * cos(car.heading) + car.vy * sin(car.heading)`
4. `fLong = throttle >= 0 ? throttle * ENGINE_FORCE : throttle * BRAKE_FORCE`
5. `fDrag = -DRAG_COEFF * speed * abs(speed)`
6. `fRoll = -ROLLING_RESISTANCE * speed`
7. `accel = (fLong + fDrag + fRoll) / MASS`
8. `speed = clamp(speed + accel * DT, -MAX_REVERSE_SPEED, MAX_SPEED)`
9. `angularVelocity = speed * tan(steerAngle) / WHEELBASE`
10. `heading = wrapPi(car.heading + angularVelocity * DT)`
11. `vx = speed * cos(heading)`, `vy = speed * sin(heading)`
12. `x = car.x + vx * DT`, `y = car.y + vy * DT`

`wrapPi` must be implemented exactly as `h - TWO_PI * floor((h + PI) / TWO_PI)` in both
languages. Do not substitute `fmod`, `%`, or `atan2(sin, cos)` — they differ at the edges.

### Track representation

A track is a closed centreline polyline plus a constant half-width. Everything else is
derived, which keeps the Python port trivial.

```ts
export interface Track {
  name: string;
  centreline: [number, number][];   // closed loop, last point implicitly joins first
  halfWidth: number;                // metres
  startIndex: number;               // centreline segment the car starts on
}
```

- **On track** is `distanceToNearestCentrelineSegment(x, y) <= halfWidth`. Leaving the
  track is a `dnf` outcome for the lap, not a physics event — the car is not bounced.
- **Rays** are cast from the car centre against the track boundary implied by the
  centreline and half-width, clipped to `RAY_MAX_RANGE`, then normalised as
  `distance / RAY_MAX_RANGE`. A ray hitting nothing in range reports exactly `1.0`.
- **Lap timing** counts crossing the start segment in the forward direction. Crossing
  backwards does not decrement; it invalidates the lap.

### Racer ONNX signature

| name     | direction | shape    | meaning |
|----------|-----------|----------|---------|
| `obs`    | input     | `[1,9]`  | float32. Indices 0-6: ray distances normalised to [0,1] (1.0 = nothing within max range). Index 7: `speed / MAX_SPEED`, clamped [0,1]. Index 8: `angularVelocity / MAX_ANGULAR`, clamped [-1,1]. |
| `action` | output    | `[1,2]`  | float32, both already `tanh`-bounded to [-1,1]. Index 0 = steer, index 1 = throttle. |

Ray angles, relative to heading, in this exact order:
`[-1.2, -0.8, -0.4, 0.0, +0.4, +0.8, +1.2]` radians. Max ray range `50.0` metres.

## 5. Checkpoint manifest

`web/static/models/manifest.json` is the single source of truth for which opponents
exist. The UI reads it; nothing hardcodes a checkpoint. The Python export step writes it.

```json
{
  "version": 1,
  "connect4": [
    {
      "id": "c4-000001k",
      "label": "1,000 games",
      "file": "connect4/c4-000001k.onnx",
      "gamesTrained": 1000,
      "elo": 412,
      "mctsSims": 64,
      "sizeKb": 180
    }
  ],
  "racer": [
    {
      "id": "rc-gen0005",
      "label": "Generation 5",
      "file": "racer/rc-gen0005.onnx",
      "generation": 5,
      "bestLapMs": 48210,
      "sizeKb": 6
    }
  ]
}
```

- `id` is stable forever and is what gets written to the database. Never reuse an id
  for a different set of weights.
- Arrays are ordered weakest-first. The UI renders them in array order.
- `file` is relative to `web/static/models/`.
- `elo` may be `null` until the tournament has run.

## 6. Database

Postgres. Applied from `web/src/lib/db/schema.sql`.

```sql
create table if not exists game_log (
  id            bigserial primary key,
  game          text        not null check (game in ('connect4', 'racer')),
  checkpoint_id text        not null,
  outcome       text        not null check (outcome in ('human_win','ai_win','draw','dnf')),
  moves         jsonb,            -- connect4: [3,3,4,...]. racer: null.
  lap_ms        integer,          -- racer only. null for connect4.
  duration_ms   integer     not null,
  client_hash   text        not null,
  created_at    timestamptz not null default now()
);

create index if not exists game_log_game_checkpoint_idx on game_log (game, checkpoint_id);
create index if not exists game_log_created_at_idx      on game_log (created_at desc);
```

**Privacy rule, not negotiable:** `client_hash` is `sha256(ip + daily_rotating_salt)`,
truncated to 16 hex chars. Raw IPs are never written to disk or logged. The salt rotates
daily and is not persisted, so the hashes are useless for tracking anyone across days.
They exist only for same-day rate limiting and de-duplication.

## 7. HTTP API

`POST /api/games` — log a completed game.

```jsonc
// request
{ "game": "connect4", "checkpointId": "c4-000001k", "outcome": "ai_win",
  "moves": [3,3,4], "durationMs": 48120 }
// response 202
{ "ok": true }
```

Rejects with 400 on schema violation, 429 when a `client_hash` exceeds 60 games/hour.
The endpoint is **fire-and-forget from the client's perspective** — the game UI never
blocks on it and never shows an error if it fails. A dropped log is not worth a
degraded game.

`GET /api/stats` — dashboard data. Cached 60s.

```jsonc
{
  "totalGames": 18422,
  "connect4": {
    "byCheckpoint": [ { "checkpointId": "c4-000001k", "humanWins": 40,
                        "aiWins": 12, "draws": 3, "elo": 412 } ],
    "openingHeatmap": [1204, 980, 1500, 3100, 1490, 960, 1180]
  },
  "racer": {
    "byCheckpoint": [ { "checkpointId": "rc-gen0005", "humanBestMs": 44100,
                        "aiBestMs": 48210, "races": 212 } ]
  }
}
```

## 8. Conventions

- TypeScript `strict: true`. No `any` in committed code.
- Game logic in `src/lib/games/**` imports nothing from `svelte` or `$app`. It must be
  runnable in a plain Node test and in a Web Worker.
- Python 3.12, type hints on public functions, `ruff` clean.
- No secrets in the repo. Config via environment variables, documented in `.env.example`.
- Every package ships with tests that can be run by a single documented command.
