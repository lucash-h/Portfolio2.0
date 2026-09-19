# STATUS

Living snapshot of where the build actually is. Updated at the end of each work
session. `PLAN.md` is the intent; this file is the reality.

**Last updated:** 2026-09-19
**Branch:** `phase-0-foundation` (not yet pushed, not yet merged to `main`)

---

## Verified working

Everything below was checked by running it, not by taking an agent's word for it.

- `cd web && npm run check` — 347 files, 0 errors, 0 warnings
- `cd web && npm run test` — 330 tests passing across 4 files
- `cd web && npm run build` — clean; `node build` serves and honours `PORT`
- All routes return 200 from the production artifact: `/`, `/work`, `/about`, `/lab`, `/lab/connect4`
- `ruff check ml/` and `ruff format --check ml/` clean; `pytest ml/` passes
- `docker compose -f infra/docker-compose.yml config` valid

## Phase 0 — Foundation

| ID | Checkpoint | State |
|----|-----------|-------|
| C0.1 | SvelteKit app builds clean | **done** |
| C0.2 | Home + work pages, responsive, both themes | **done** (placeholder copy) |
| C0.3 | Local stack runs under docker compose | **blocked** — Docker Desktop daemon not running on this machine |
| C0.4 | Deploy-ready with runbook | **done** — `docs/DEPLOY.md`; no VPS yet, by design |

## Phase 1 — Connect 4

| ID | Checkpoint | State |
|----|-----------|-------|
| C1.1 | Engine passes every fixture case | **done** — 71 cases, 311 assertions |
| C1.2 | Board plays well, accessible | **done** — not yet verified in a real browser |
| C1.3 | Placeholder bot beats random | **done** — 15 tests incl. 200 games vs random |
| C1.4 | Live on the VPS | **blocked** — no VPS |

## Package ledger

| Package | State | Notes |
|---|---|---|
| P0-A web scaffold | done | Adapter config lives in `vite.config.ts`; there is no `svelte.config.js` in this SvelteKit version. Verified, not a mistake. |
| P0-B infra | done | Two bugs fixed post-hand-back: dockerignore path, and lockfile wrongly excluded from a context that runs `npm ci`. |
| P1-F fixtures | done | Agent died before reporting; work was complete and independently cross-validated. |
| P1-A engine | done | Written by the orchestrator, not an agent. |
| P1-B board UI | done | Fixed a Svelte 5 `$state` shadowing bug and an unworkable computed-style test. |
| P1-C minimax | done | Fixed two test bugs; search itself was correct. |
| P2-S ml scaffold | done | venv lives at `.ml_venv/`, now gitignored. |
| P2-D browser ONNX | **~20%** | Only `mlTypes.ts` + a synthetic `.onnx` fixture. Needs `session.ts`, `registry.ts`, `infer.worker.ts`, tests. |
| P0-C content | **not started** | Blocked on real content from Lucas. |

## What is next, in order

1. **Finish P2-D** — the browser ONNX runtime. Types and the synthetic test model
   already exist, so this is session caching, manifest loading, softmax + illegal-move
   masking, the worker, and tests. Needs no trained model; the signature is contract-fixed.
2. **C0.3** — start Docker Desktop, then `caddy validate` and a real `docker compose up`.
   This is the last unverified piece of the deploy story.
3. **Phase 2 proper** — P2-A (env + MCTS), then P2-B (net + training). P2-A is
   unblocked right now: the fixtures exist and the parity test can be written today.
4. **Phase 3** — P3-A (db + API) and P3-B (dashboard) are mutually independent and can
   run in parallel, since the `/api/stats` shape is fixed in the contract.
5. **P0-C** — real site content, whenever Lucas supplies it.

## Standing notes

- **Session rate limits killed four agents mid-flight** on 2026-09-18. Three had already
  written their files; only P2-D was a real loss. Check for partial work before re-running
  a package — do not assume a failed agent produced nothing.
- **Agent self-reports have overstated results three times** (a Caddy validation that never
  ran, a venv path, a claim of `.svelte-kit/output` being adapter-node's output). Every
  package gets independently verified before being marked done. This has caught real bugs
  every time.
- **Docker Desktop is not running**, so nothing container-related has been executed.
- Nothing is pushed to `origin` yet.
