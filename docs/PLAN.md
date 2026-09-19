# PLAN

Portfolio site with two machine-learning exhibits. Read `CONTRACTS.md` before any work.

## The premise

A static portfolio belongs on GitHub Pages. The reason this one has a VPS is that it
hosts something that *runs*: bots that were actually trained, whose difficulty tiers are
literal training checkpoints, with a dashboard showing how they got there.

One concept carries both games: **a checkpoint is an opponent.**

- Connect 4: you play the network as it was after N self-play games.
- Racer: you race the ghost of the network after N generations.

Same mental model, same ONNX loading code, same dashboard, two very different RL regimes
(turn-based MCTS self-play; real-time neuroevolution).

## The architectural decision that keeps the VPS quiet

**No Python runs in production.** All inference happens in the visitor's browser via
ONNX Runtime Web. The Connect 4 network is small; the racer network is a few KB of matmul
per tick. Neither needs a server.

Production is: one Node process, Postgres, Caddy. Idle cost is close to nothing.

Python exists only in a training container, run on demand, pinned to a subset of cores so
it never competes with whatever else is on the box. It writes `.onnx` files and a manifest
into `web/static/models/` and then exits.

## Phases

Each phase ends deployable. If work stops after Phase 3, the site is still good.

---

### Phase 0 — Foundation and deploy

Goal: a real portfolio site, live, on the VPS. This alone replaces the old one.

| ID | Checkpoint | How it is verified |
|----|-----------|--------------------|
| C0.1 | SvelteKit app builds clean | `npm run build && npm run check` exits 0, no warnings |
| C0.2 | Home + work pages with real content | Renders at 360px wide with no horizontal scroll; light and dark both correct |
| C0.3 | Local stack runs | `docker compose up` serves the site on localhost through Caddy |
| C0.4 | Deploy-ready | Runbook in `docs/DEPLOY.md`; going live is setting `DOMAIN` + DB credentials and running `deploy.sh`. No code change. |

**Deploy timing.** There is no VPS yet. The whole project is built and verified locally
under `docker compose up`, which mirrors production closely enough that deployment is a
configuration step rather than a rewrite. Caddy serves plain HTTP on `:80` when `DOMAIN`
is unset and switches to automatic HTTPS when it is set — one file, both environments.
C0.4 is therefore "provably deployable", and the actual deploy happens whenever the VPS
and domain exist.

**Parallel packages** (disjoint directories, no shared files):

- **P0-A → `web/` scaffold, theming, layout** — SvelteKit + adapter-node + TypeScript
  strict, base layout, dark/light tokens, typography, nav. No page content.
- **P0-B → `infra/`** — docker-compose (web, postgres, caddy), Caddyfile, `.env.example`,
  `deploy.sh`. Postgres included now even though unused until Phase 3.
- **P0-C → `web/src/routes/(site)/` content pages** — home, work, about. Writes against
  the layout contract from P0-A, so it needs P0-A's layout landed first.

Sequencing: A and B run together. C starts when A lands.

---

### Phase 1 — Connect 4, playable

Goal: ship a game. The opponent is a placeholder; nobody visiting can tell yet.

| ID | Checkpoint | How it is verified |
|----|-----------|--------------------|
| C1.1 | Engine correct | Passes every case in `shared/fixtures/connect4_cases.json`, including all four win directions, draws, and illegal-move rejection |
| C1.2 | Board plays well | Click or tap to drop, disc falls with animation, winning four highlighted, keyboard accessible |
| C1.3 | Placeholder bot | Depth-6 minimax beats a random player in 99+ of 100 games |
| C1.4 | Live | Playable on the VPS |

**Parallel packages:**

- **P1-A → `web/src/lib/games/connect4/{types,engine}.ts` + `shared/fixtures/connect4_cases.json`**
  Pure functions and the fixture file. Highly testable, zero ambiguity.
- **P1-B → `web/src/lib/components/Connect4Board.svelte` + `web/src/routes/lab/connect4/`**
  UI only. Codes against the types in CONTRACTS.md §3, which exist before A finishes.
- **P1-C → `web/src/lib/games/connect4/minimax.ts`** — alpha-beta with a positional
  heuristic, runs in a Web Worker so the UI never blocks.

All three are genuinely independent because the interface is already fixed in the contract.

---

### Phase 2 — Self-play pipeline

Goal: the difficulty ladder stops being fake.

| ID | Checkpoint | How it is verified |
|----|-----------|--------------------|
| C2.1 | Python env matches TS | `ml/conformance/test_connect4_parity.py` green against the same fixtures |
| C2.2 | Training works | Loss decreases; the 1k-game checkpoint beats random in 95+ of 100 |
| C2.3 | Export round-trips | For 50 random boards, Python torch output and browser ONNX output agree to 1e-4 |
| C2.4 | Ladder is live | 4 checkpoints in the manifest, tier picker replaces minimax in the UI |

**Parallel packages:**

- **P2-A → `ml/connect4/{env,mcts}.py`** — environment (mirrors TS engine) and MCTS
  with PUCT, Dirichlet noise at the root, temperature schedule.
- **P2-B → `ml/connect4/{net,train,selfplay}.py`** — small residual CNN, policy + value
  heads, replay buffer, self-play driver with multiprocessing workers.
- **P2-C → `ml/export/` + `web/src/lib/ml/`** — torch-to-ONNX export, manifest writer,
  and the browser side: ORT session cache, tier registry, worker-based inference.

A and B share the env interface; A lands first, B builds on it. C is fully independent
and can start immediately since the ONNX signature is already fixed in CONTRACTS.md §3.

---

### Phase 3 — Data and dashboard

Goal: the page that proves the ML is real. This is the strongest single portfolio artifact.

| ID | Checkpoint | How it is verified |
|----|-----------|--------------------|
| C3.1 | Games log | `POST /api/games` writes rows; rate limit returns 429; raw IP appears nowhere |
| C3.2 | Elo computed | Round-robin between checkpoints produces a monotonically increasing ladder |
| C3.3 | Dashboard renders | Elo curve, human win-rate per tier, opening heatmap — all from live data |
| C3.4 | Live | Numbers move as people play |

**Parallel packages:**

- **P3-A → `web/src/lib/db/` + `web/src/routes/api/`** — schema, pooled client, the two
  endpoints, rate limiting, the daily-salt hashing from CONTRACTS.md §6.
- **P3-B → `web/src/routes/lab/dashboard/` + chart components** — visualisation only,
  built against the `/api/stats` response shape already fixed in CONTRACTS.md §7.
- **P3-C → `ml/tournament/elo.py`** — checkpoint round-robin, Elo with confidence
  intervals, writes ratings back into the manifest.

Fully parallel. The API response shape is contract-fixed, so B does not wait on A.

---

### Phase 4 — Racer, playable

Goal: ship the second game, human-only first.

| ID | Checkpoint | How it is verified |
|----|-----------|--------------------|
| C4.1 | Physics deterministic | Same inputs produce a bit-identical trace across 1000 runs; trace committed as the fixture |
| C4.2 | Feels good | 60fps canvas, keyboard and touch, lap timer, sensible handling |
| C4.3 | Three tracks | Varied difficulty, all completable |
| C4.4 | Live | Playable with a local best-lap table |

**Parallel packages:**

- **P4-A → `web/src/lib/games/racer/{types,physics,track}.ts` + `shared/fixtures/racer_trace.json`**
  The hard, precise one. Fixed-timestep bicycle model, raycasting, trace generation.
- **P4-B → `web/src/lib/components/RacerCanvas.svelte` + `web/src/routes/lab/racer/`**
  Rendering, input, HUD, lap timing.
- **P4-C → `web/static/tracks/`** — track definitions plus a small validator.

---

### Phase 5 — Neuroevolution ghosts

Goal: the racer gets the same checkpoint ladder Connect 4 has.

| ID | Checkpoint | How it is verified |
|----|-----------|--------------------|
| C5.1 | Python sim matches TS | Reproduces `racer_trace.json` to within 1e-9 per tick |
| C5.2 | It learns | Best lap time improves monotonically across generations; curve plotted |
| C5.3 | Ghosts drive | Exported nets drive live in the browser and recover after a collision |
| C5.4 | Live | Ghost ladder selectable, lap times in the dashboard |

**Parallel packages:**

- **P5-A → `ml/racer/sim.py` + `ml/conformance/test_racer_parity.py`** — the port, and
  the test that proves it is a faithful one. Highest-risk package in the project.
- **P5-B → `ml/racer/{evolution,train}.py`** — evolution strategy over a tiny MLP,
  population evaluated in parallel, checkpoint export per generation.

A must land before B is useful. Not parallel with each other; parallel with Phase 4 work.

---

### Phase 6 — Predicting the human

Goal: the delightful one. Needs Phase 3 data to have accumulated first.

| ID | Checkpoint | How it is verified |
|----|-----------|--------------------|
| C6.1 | Model trained | Held-out top-1 accuracy above 45% (random is 14%) |
| C6.2 | Overlay works | Shows predicted column and confidence before you move, updates live |
| C6.3 | Live | Running in the browser, no server round-trip |

Single package. Small.

---

## Orchestration notes

**Why the contracts come first.** Parallel agents never see each other's code. Every
interface they share has to be written down before they start, or they each invent their
own and nothing composes. `CONTRACTS.md` is that written-down thing.

**Partitioning rule.** No two concurrently running agents may write to the same file.
Packages are defined by directory ownership, listed explicitly above.

**Effort allocation.** Mechanical, well-specified work with clear pass/fail tests
(engines, fixtures, config, tracks, schema) goes to cheaper models. Work needing taste or
judgment (Svelte components, training loops, MCTS, dashboard design) gets a stronger one.
Contracts, parity design, integration, and review stay with the orchestrator.

**Definition of done for every package:** its tests pass, `npm run check` (or `ruff`) is
clean, and it touched no file outside its assigned directory.

**Biggest technical risk:** racer physics parity between TypeScript and Python (Phase 5).
Mitigated by making the fixture trace the source of truth and writing the conformance test
before the training code that depends on it.
