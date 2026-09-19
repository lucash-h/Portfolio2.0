# Architecture review — 2026-09-19

Reviewed at the end of Phases 0–3. ~9,500 lines across `web/src` (6,009), `ml` (2,039),
`docs` (1,417), `shared` (473), `infra` (63). 405 web tests, 102 Python tests, all passing.

Findings are ordered by what I would fix first, not by how bad they sound.

---

## What is working

**The contracts-first approach paid for itself.** Eight packages were built by agents that
never saw each other's code. Only two integration seams needed repair, and both were
contract gaps rather than implementation failures — which is the cheap kind of mistake.
The alternative would have produced eight incompatible interpretations of the board layout.

**The parity rule is real, not aspirational.** The TypeScript engine and the Python
environment agree on all 71 fixture cases, and I verified the test has teeth by inverting
the perspective planes and flipping row order — both fail as they should.

**Failure paths are genuinely handled.** Missing manifest, absent database, failed model
load, unavailable worker — each degrades to something sensible rather than throwing. The
site serves correctly today with no Postgres, no checkpoints, and no manifest, which is
exactly the state a fresh clone is in.

---

## 1. The training → browser chain has no link yet · highest value

Everything on both ends is built. Nothing connects them.

- `ml/connect4/train.py` produces `.pt` checkpoints.
- `web/src/lib/ml/session.ts` consumes `.onnx` models via a manifest.
- **P2-C, which converts one to the other, does not exist.** `web/static/models/` is not
  even a directory.

So the project's entire premise — difficulty tiers that are real training checkpoints — is
currently unproven end to end. Every piece is tested in isolation and the seam between them
has never been exercised.

This is also the cheapest remaining high-value work: the ONNX signature is contract-fixed,
the checkpoint format is documented, and the browser side already loads a synthetic model
with that exact signature. Do this before anything else.

## 2. Elo is structurally unreachable · real, and nobody owns it

`/api/stats` returns `elo: null` for every checkpoint, always. Not a bug in P3-A — Elo
lives in the manifest (CONTRACTS §5), not in `game_log`, so the query cannot produce it.

But `EloCurve.svelte` is the dashboard's headline chart, and the tournament that computes
Elo (P3-C) writes into the manifest. **No package owns merging the two.** Each side
reasonably assumed the other would.

Fix: the `/api/stats` route reads the manifest and merges `elo` (and `aiBestMs`) into the
response. Cheap, but it needs deciding rather than drifting — left alone, the best chart on
the best page renders empty forever.

## 3. ONNX runtime loads for visitors who will never use it · performance

`session.ts` does a top-level `import * as ort from 'onnxruntime-web'`, and
`/lab/connect4` statically imports `session.ts`. So the route chunk carries the ORT
JavaScript runtime (~400 KB) for **every** visitor — including today, when all three tiers
are alpha-beta search and need no ONNX whatsoever.

Separately, `build/client` is **39 MB**, of which 27 MB is
`ort-wasm-simd-threaded.jsep.wasm`. That file is fetched lazily at session creation, so it
does not hit first paint, but it is deployed, it fills the Docker image, and it will be
served eventually.

Fixes, in order of value:
1. `await import('onnxruntime-web')` inside the session factory, so the runtime loads only
   when a trained checkpoint is actually selected.
2. Restrict which WASM variants ship. The threaded/JSEP build is the largest and is not
   needed for a network this small.

For a portfolio site where first impressions are load time, this matters more than it would
in an app.

## 4. Nothing has been opened in a browser · biggest untested surface

Every visual and interaction claim is asserted by construction, not observation:

- light and dark themes
- 360px layout
- 44px touch targets
- reduced-motion handling
- keyboard play
- the disc-drop animation
- 60fps anything

The agents were honest about this limitation, and the reasoning is sound — no hardcoded
colours, no fixed widths, tokens with documented contrast. But "should work" is not
"works", and **the value of this project to a visitor is almost entirely the part that has
never been run.**

A single Playwright smoke test (load each route, toggle the theme, play one game, assert no
console errors) would convert a large class of unknowns into knowns.

## 5. Test quality is uneven, and the good numbers hide it · meta-finding

I tamper-tested three claimed-verified areas. Two held up. The third — the value-target
sign, which I had explicitly flagged as the most important test in the package — turned out
to be **two tests that both passed against deliberately inverted code**. One reimplemented
the logic inside the test and asserted against its own copy, never touching the production
module. The other asserted only that signs alternated, which a full inversion preserves.

That is a one-in-three rate of confidently-reported, structurally hollow tests.

The implication is uncomfortable: 507 tests pass, and I have verified the teeth of maybe a
dozen. Green counts are weak evidence. Worth spot-tampering the other load-bearing ones —
in particular the rate limiter, the IP hashing, and the MCTS invariants.

## 6. Smaller things

- **No CI.** 507 tests and nothing runs them on push. A GitHub Actions workflow running
  `npm run check`, `npm run test`, `ruff`, and `pytest` is ~20 lines and closes the gap
  where a future change quietly breaks something nobody re-runs.
- **The branch name is now wrong.** `phase-0-foundation` carries Phases 0 through 3 across
  20 commits, and `main` still holds only the initial commit. Worth merging to `main` now
  that it is coherent, rather than growing a long-lived branch.
- **SQL is unverified against a real server.** Every query is exercised only by fakes. The
  `group by`, `jsonb_array_length` and `moves->>0` expressions have never been parsed by
  Postgres. This is the single largest thing gated on Docker.
- **The racer exists only as a contract.** That is by plan, and §4 is detailed enough to
  build against. Worth confirming the physics constants produce a car that is actually fun
  before committing to neuroevolution on top of them — a technically correct simulation
  that handles badly is still a bad exhibit.

---

## What I would do, in order

1. **P2-C** — close the training-to-browser loop. Nothing else proves the premise.
2. **Merge manifest Elo into `/api/stats`** — decide the owner, then do it.
3. **Dynamic-import ORT** and trim the WASM variants.
4. **Start Docker**, verify the SQL and the Caddyfile, close C0.3.
5. **One Playwright smoke test**, then a minimal CI workflow.
6. **Merge to `main`.**
7. Then run real training, and only then move to the racer.

Items 1–3 are half a day and convert the project from "well-built components" into
"a working system". Items 4–6 are the difference between something that works here and
something that will still work on a server in six months.
