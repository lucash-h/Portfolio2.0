# Training plan — a Connect 4 bot worth playing

Goal: a bot strong enough that beating it feels like an achievement, with a difficulty
ladder whose rungs are genuinely ordered.

Where we are: a 300-game run produced three checkpoints. They beat a random player
70–78% of the time, and the 300-game net scores *worse* against random than the
150-game one. The pipeline is proven; the training is not.

---

## 1. The real problem is throughput, not patience

Measured on this machine, 88,600-parameter net, 2,048 positions:

| Batch size | Throughput | Speedup |
|---|---|---|
| 1 | 312 pos/s | baseline |
| 32 | 3,354 pos/s | 10.7x |
| 128 | 6,746 pos/s | **21.6x** |
| 512 | 8,355 pos/s | 26.7x |

`make_eval_fn` currently does `unsqueeze(0)` — **one position per forward pass**. At 48
simulations across ~25 moves that is roughly 1,200 batch-size-1 forward passes per game,
and at that size the cost is almost entirely per-call overhead rather than arithmetic.

This is why 300 games took 11 minutes. It is not a hardware limit.

### What that changes

Current measured rate is ~17 games/min. The table above is a microbenchmark and the
realised gain will be lower — MCTS tree operations, Python object churn and game logic do
not disappear — so plan on **8–12x**, not 21x.

| Milestone | Today (~17/min) | Batched (~150/min, conservative) |
|---|---|---|
| 1,000 games | 1 hour | 7 minutes |
| 10,000 games | 10 hours | 1 hour |
| 100,000 games | 4 days | 11 hours (overnight) |
| 500,000 games | 20 days | 2–3 days |

That is the difference between a ladder we can only pretend to have and one we can
actually train.

## 2. How to batch without changing what the search does

Two options, and the choice matters.

**Leaf batching across concurrent games — recommended.** Run G games in one process,
stepped in lockstep. Each game's MCTS runs until it needs a leaf evaluated, hands that
position out, and suspends. Collect all G positions, run **one** batched forward pass,
hand results back.

The property that makes this the right call: **each game's search is bit-identical to the
sequential version.** Only the timing of the forward pass changes, not its inputs or the
tree that results. No new hyperparameter, no change to search semantics, nothing to
re-validate. It is a pure speedup.

Implementation: turn `_simulate` into a generator that yields a position and receives
`(priors, value)`, then drive G of them from a scheduler. `search()` keeps its current
signature for the single-game path so existing tests stay meaningful.

**Virtual loss within one tree — not yet.** Batching several leaves from the *same* tree
needs virtual loss to stop every simulation picking the same branch. It is a bigger win
per game but it *does* change search behaviour, and it would need its own validation. Worth
doing later, once the first approach is banked.

## 3. Free data: mirror symmetry

Connect 4 is symmetric left-to-right. A position mirrored horizontally, with its policy
target reversed, is an equally valid training example. That is a **2x effective data
multiplier for the cost of a `np.flip`**, and it also stops the network learning spurious
left/right asymmetries from a small sample.

Worth doing before any long run: it changes what 10,000 games are worth.

## 4. We currently cannot tell whether training is working

Loss going down is weak evidence. It measures fit to the current replay buffer, not
strength. The 300-game run had steadily falling policy loss and a non-monotonic ladder.

Add a real evaluation harness:

- **Fixed reference opponents** — random, plus alpha-beta at depths 2, 4 and 6. These never
  change, so numbers are comparable across the whole project.
- **Randomised openings.** This is not optional. Greedy argmax play is deterministic, so a
  60-game match between two nets is really *two* distinct games repeated 30 times each —
  which is exactly what produced the suspicious 30/30 splits in the first ladder check.
  Force diversity with temperature sampling or a random 2–4 ply opening book.
- **Gating** — AlphaZero style: a new checkpoint is promoted to "current best" only if it
  beats the incumbent in more than ~55% of games. This alone prevents the regression we
  already observed, where a later checkpoint was weaker than an earlier one.
- **Run it periodically during training**, not at the end, so a run that has stopped
  improving can be stopped early.

## 5. Hyperparameters to revisit once it is fast

| Knob | Now | Suggested | Why |
|---|---|---|---|
| Simulations/move | 48 | 160–400 | The main driver of play strength. Currently low because it was slow. |
| Games/cycle | 25 | 200–500 | Fewer, larger training cycles; less checkpoint churn. |
| Buffer | 200k positions | keep, sample recent-weighted | Stale positions from a much weaker net drag training. |
| LR | 1e-3 flat | step down at plateaus | Standard, and cheap to add. |
| Net width | 32ch / 4 blocks | keep initially | It is not the bottleneck yet. Revisit only if strength plateaus with search turned up. |

**Resignation** (abandon clearly lost positions early) is a further ~20–30% throughput win,
but it needs a false-positive check or it poisons value targets. Later.

## 6. The ladder we actually want

Retrain from scratch with milestones at **1k / 5k / 25k / 100k** games, each gated and
Elo-rated against the fixed references. Four rungs that are genuinely ordered beat six that
are not.

Then `ml/tournament/` (P3-C, specced but never built) computes Elo across checkpoints and
writes it into the manifest, so tiers can be labelled `1,000 games · Elo 412` rather than
by raw game count alone.

## 7. Order of work

1. **Batched leaf evaluation** — the unlock. Everything else is gated on it.
2. **Mirror-symmetry augmentation** — small change, doubles data value.
3. **Evaluation harness** with fixed references, randomised openings, and gating.
4. **Short validation run** (~5k games, under an hour) to confirm strength now increases
   monotonically. Do not start a long run before this passes.
5. **The real run** — 100k games overnight, checkpoints at the four milestones.
6. **Elo tournament**, write ratings into the manifest.
7. **Re-export**, publish the new ladder.

Steps 1–4 are the engineering. Steps 5–7 are mostly waiting.

---

## 8. UI: from exhibit to game

The front page figure is a *showcase* — it self-plays, and clicking takes over. That is the
right behaviour for a landing page and should stay.

But "the visitor plays the bot" is a different job, and the rail panel is a bad place for
it: the board is squeezed into half a panel, the horizontal rail competes for arrow keys,
and there is no room for anything around the board.

### What a real play mode needs

- **A focused board.** Full width, no rail, no scroll driver stealing keys.
- **A difficulty picker that means something** — checkpoint label plus Elo and games
  trained, so choosing a tier is an informed choice.
- **Win probability from the value head.** We already compute it and currently throw it
  away. A live bar reading "the network thinks it is winning 68%" is the single clearest
  way to show there is a real model here, and it costs nothing.
- **Post-game analysis.** Replay the game move by move with the network's evaluation at
  each step, flagging the move where the evaluation swung hardest against you. This is the
  feature that turns a game into a portfolio piece — it demonstrates the value head, the
  policy head and the training story in one screen.
- **Result tracking** across games in the session, and logged via the existing
  `POST /api/games`.
- **A layout that works on a phone**, where a 100vh rail panel currently does not leave
  room for a board plus controls.

### Where it lives

Open question for Lucas — see the summary. Either a dedicated route linked from the front
page figure, or a fullscreen mode that expands out of the existing panel.
