# STATUS

Living snapshot of where the build actually is. Updated at the end of each work
session. `PLAN.md` is the intent; this file is the reality.

**Last updated:** 2026-09-21
**Branch:** merged. `phase-0-foundation` fast-forwarded into `main` (39 commits,
linear, no merge commit) and both are pushed and pointing at `901db8a`. The
branch name outlived the phase by a long way; it is kept only so existing links
resolve.

---

## Verified working

Everything below was checked by running it, not by taking an agent's word for it.
Dates are when it was last actually run.

- `cd web && npm run check` — 405 files, 0 errors, 0 warnings _(2026-09-21)_
- `cd web && npm run test` — 489 tests passing across 22 files _(2026-09-21)_
- `cd web && npm run build` — clean; `node build` serves and honours `PORT` _(2026-09-21)_
- Full Docker stack up and serving the real site on `http://localhost/` via Caddy
  _(2026-09-21)_ — see the gotcha under Phase 0 C0.3
- Both exhibits verified in a real browser, not just in tests _(2026-09-21)_:
  Connect 4 plays itself on the page with live ONNX inference (~2–3 ms reported),
  and the racer runs the Grand Circuit with all three cars lapping in 12–19 s
- Front page verified at a real 390×844 viewport: 390px document scroll width,
  zero elements past the viewport _(2026-09-21)_
- `.ml_venv/Scripts/python.exe -m pytest ml/ -q` — 86 tests passing _(2026-09-19,
  not re-run since; no `ml/` code has changed since then)_
- `ruff check ml/` and `ruff format --check ml/` clean _(2026-09-19)_

### Corrected claims

Two lines in the previous version of this file were wrong, and are worth naming
so they are not re-copied:

- **"All routes return 200: `/`, `/work`, `/about`, `/lab`, `/lab/connect4`"** —
  was false when written. `/work` and `/about` are in-page anchors (`#work`,
  `#about`), and `/lab/connect4` does not exist. `/lab` has since been rebuilt
  and does serve the dashboard. Checked 2026-09-21: `/` → 200, `/lab` → 200,
  `/work`, `/about`, `/lab/connect4` → **404**.
- **"Docker Desktop is not running, so nothing container-related has been
  executed"** — no longer true; the whole stack has now been built and run.

## Phase 0 — Foundation

| ID | Checkpoint | State |
|----|-----------|-------|
| C0.1 | SvelteKit app builds clean | **done** |
| C0.2 | Home + work pages, responsive, both themes | **done** — real content now, not placeholder copy; verified at 390px and 1422px, and in both themes |
| C0.3 | Local stack runs under docker compose | **done** — built and served end to end. Gotcha: `up -d --build` rebuilds the image but leaves the old container running, so the site does not change. It needs `--build --force-recreate`. |
| C0.4 | Deploy-ready with runbook | **done** — `docs/DEPLOY.md`; no VPS yet, by design |

## Phase 1 — Connect 4

| ID | Checkpoint | State |
|----|-----------|-------|
| C1.1 | Engine passes every fixture case | **done** — 71 cases, 311 assertions |
| C1.2 | Board plays well, accessible | **done** — now verified in a real browser: the figure self-plays and the board renders correctly at desktop and phone widths |
| C1.3 | Placeholder bot beats random | **done** — 15 tests incl. 200 games vs random |
| C1.4 | Live on the VPS | **blocked** — no VPS |

## Package ledger

| Package | State | Notes |
|---|---|---|
| P0-A web scaffold | done | Adapter config lives in `vite.config.ts`; there is no `svelte.config.js` in this SvelteKit version. Verified, not a mistake. |
| P0-B infra | done | Two bugs fixed post-hand-back: dockerignore path, and lockfile wrongly excluded from a context that runs `npm ci`. Since then: `PROTOCOL_HEADER`/`HOST_HEADER` added so adapter-node trusts Caddy and stops reporting `localhost:3000` as the public origin. |
| P1-F fixtures | done | Agent died before reporting; work was complete and independently cross-validated. |
| P1-A engine | done | Written by the orchestrator, not an agent. |
| P1-B board UI | done | Fixed a Svelte 5 `$state` shadowing bug and an unworkable computed-style test. |
| P1-C minimax | done | Fixed two test bugs; search itself was correct. |
| P2-S ml scaffold | done | venv lives at `.ml_venv/`, now gitignored. |
| P2-D browser ONNX | done | Real inference verified by tampering: corrupting the synthetic model fails exactly the tests that use it. Wired into the exhibit page. |
| P2-A env + MCTS | done | Parity proven both ways; tamper-tested. Python and TypeScript now agree with the same fixture corpus. |
| P2-B/P2-C training + export | done | Real checkpoints at 50/150/300 self-play games, exported to ONNX and listed in `web/static/models/manifest.json`. The exhibit's difficulty ladder is those three checkpoints. |
| P3-A db + API | done | `/api/games` and `/api/stats`. Both degrade to an empty-state response with no database, so a fresh install renders. |
| P3-B dashboard | done | Live at `/lab`, linked from the nav and from the front page's "games logged" stat. The original `/lab/dashboard` page was deleted by the redesign (381eadb) along with the whole route tree; this is a rebuild against the current design, not a revert. Acceptance met: renders against a fixture payload and the empty case, no horizontal scroll at 360px. |
| P4 racer | done | Deterministic fixed-step physics with TS/Python parity, four tracks incl. the 698 m Grand Circuit (now the default), lap timing, play/pause. |
| P5-B neuroevolution | **not started** | `ml/racer/` holds only `sim.py` and `track.py` (that is P5-A, the physics port); no `net`/`evolution`/`train`, no racer checkpoints. `manifest.json` carries an empty `"racer": []` ready for them. The pace cars are a hand-written raycast heuristic and the page says so. |
| P0-C content | **mostly done** | Projects, about copy and contact links ported from the old portfolio and checked against the repos. One placeholder left: the Brilliant Harvest experience entry. It renders a visible warning until `placeholder: true` comes off it. |

## What is next, in order

1. **Brilliant Harvest** — the one placeholder left on the page. Lucas is writing it.
2. **Pace-car tiers are cosmetic.** All three converge on ~12.1 s laps, because even the
   0.45 throttle cap reaches top speed on a 698 m lap. Needs a speed cap, not a throttle
   cap, or the three buttons are theatre.
3. **Docs that overclaim.** `ml/racer/__init__.py` advertises `net`/`evolution`/`train`
   modules that do not exist, and `docs/TRAINING-PLAN.md:223` says "The racer already uses
   neuroevolution". It does not.
4. **Security review before the API is public.** `/api/games` is an unauthenticated POST
   into Postgres, rate-limited on a client-supplied hash.
5. **Hosting.** No VPS yet; C1.4 and C5.4 both block on it.
6. **P5-B** — the racer's neuroevolution run, whenever the appetite is there. `ghostPolicy`
   in `RacerCanvas.svelte` is the single seam an evolved net replaces.

### Notes for P5-B specifically

- `ghostPolicy(obs) -> {steer, throttle}` is the only function to replace. Every caller
  passes exactly that shape.
- Steering sign is the trap, and has been got wrong twice: `RAY_ANGLES` starts at −1.2, so
  `obs[0..2]` are the rays to the car's left, and steering toward them means a **negative**
  `steer`. `RacerCanvas.test.ts` pins this down by driving `step()` and asserting the car
  moves up-screen, not by asserting a sign.
- Physics constants are contract-locked (CONTRACTS §4) and asserted to 1e-9 by
  `ml/conformance/test_racer_parity.py`. Anything about how the car *feels* belongs on the
  input side, which is where the speed-scaled steering authority lives.

## Standing notes

- **A redesign can delete a package.** `381eadb` collapsed the site to one page and took
  `work/`, `about/`, `lab/`, `lab/connect4/` and `lab/dashboard/` with it. The dashboard's
  components survived in `$lib`, still passing their tests, rendering nowhere, for two
  days — a green suite says nothing about whether anything imports the thing it tests.

- **Session rate limits killed four agents mid-flight** on 2026-09-18. Three had already
  written their files; only P2-D was a real loss. Check for partial work before re-running
  a package — do not assume a failed agent produced nothing.
- **Agent self-reports have overstated results repeatedly** (a Caddy validation that never
  ran, a venv path, a claim of `.svelte-kit/output` being adapter-node's output). Every
  package gets independently verified before being marked done. This has caught real bugs
  every time — including, this session, two false claims in this very file.
- **jsdom cannot test rendering.** It has no canvas, no layout engine and resolves no
  stylesheets. Every bug that reached Lucas this session was in that gap: a canvas erasing
  itself every frame, cars painted in colours matching the track, an inverted steering sign,
  a hidden table 1300px wide forcing horizontal scroll. The suite stayed green through all
  of them. Anything visual needs a real browser.
- **Chrome's `setDeviceMetricsOverride` does not override `window.innerWidth`.** Fixed
  elements and any JS reading it see the real window, which makes mobile checks lie. Launch
  Chrome with a real `--window-size` and a fresh `--user-data-dir` (an existing profile
  restores its old window size).
- `main` and `phase-0-foundation` are the same commit and both pushed. The repo is public.
