# STATUS

Living snapshot of where the build actually is. Updated at the end of each work
session. `PLAN.md` is the intent; this file is the reality.

**Last updated:** 2026-09-19
**Branch:** `phase-0-foundation` — pushed to origin, not yet merged to `main`

---

## Verified working

Everything below was checked by running it, not by taking an agent's word for it.

- `cd web && npm run check` — 367 files, 0 errors, 0 warnings
- `cd web && npm run test` — 353 tests passing across 7 files
- `.ml_venv/Scripts/python.exe -m pytest ml/ -q` — 86 tests passing
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
| P2-D browser ONNX | done | Real inference verified by tampering: corrupting the synthetic model fails exactly the tests that use it. Wired into the exhibit page. |
| P2-A env + MCTS | done | Parity proven both ways; tamper-tested. Python and TypeScript now agree with the same fixture corpus. |
| P0-C content | **not started** | Blocked on real content from Lucas. |

## What is next, in order

1. **P2-B — network and training loop.** The last piece before real checkpoints exist.
   Needs torch installed into `.ml_venv` (a large download, deliberately deferred until
   now). Builds on `env.encode()` and the injected-evaluator MCTS, both done.
2. **P2-C — ONNX export + manifest.** Small once P2-B produces weights. The moment a
   manifest lands in `web/static/models/`, the exhibit switches to real networks with
   no code change — that path is already wired and typechecked.
3. **C0.3** — start Docker Desktop, then `caddy validate` and a real `docker compose up`.
   The last unverified piece of the deploy story.
4. **Phase 3** — P3-A (db + API) and P3-B (dashboard) are mutually independent and can
   run in parallel right now; the `/api/stats` shape is contract-fixed. Neither depends
   on training finishing.
5. **P0-C** — real site content, whenever Lucas supplies it.

### Notes for P2-B specifically

- `mcts.search(node, eval_fn, n)` adds `n` **new** simulations to whatever the node
  already has; it does not target a total. Matters when reusing a subtree via
  `advance_root`.
- `env.encode()` returns `[2,6,7]`. The training loop stacks to `[N,2,6,7]`; the ONNX
  graph is `[1,2,6,7]`. See the batch-dimension table in CONTRACTS §3.
- `env.apply_move()` raises plain `ValueError` on an illegal move.
- Self-play must honour a core limit. The VPS runs other things and Lucas asked for it
  to stay light.

## Standing notes

- **Session rate limits killed four agents mid-flight** on 2026-09-18. Three had already
  written their files; only P2-D was a real loss. Check for partial work before re-running
  a package — do not assume a failed agent produced nothing.
- **Agent self-reports have overstated results repeatedly** (a Caddy validation that never
  ran, a venv path, a claim of `.svelte-kit/output` being adapter-node's output). Every
  package gets independently verified before being marked done. This has caught real bugs
  every time.
- **Docker Desktop is not running**, so nothing container-related has been executed.
- `phase-0-foundation` is pushed to `origin`; `main` still holds only the initial commit.
