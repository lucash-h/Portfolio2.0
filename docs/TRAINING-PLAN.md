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

## 8. UI — settled, no work needed

An earlier draft of this section argued for a dedicated play route: the board squeezed into
half a rail panel, arrow keys contested, nowhere to put analysis.

**Lucas tried it and it plays fine as-is.** The takeover flow already does the right thing —
the figure self-plays, clicking a column drops your token, the bot replies, and it
alternates from there. The layout stays exactly as built.

So there is no UI work in this plan. Ideas that were in the earlier draft and are *not*
being built unless asked for later:

- a dedicated full-width play route
- a live win-probability bar from the value head
- post-game move-by-move analysis

They are recorded here only so the reasoning is not lost. The value head is still computed
and currently discarded, so the win-probability bar remains cheap if it is ever wanted.

---

## 9. Other approaches worth demonstrating

Self-play is the right algorithm here and should stay the headline. But several
alternatives are worth building *as exhibits* — not because they would produce a stronger
bot, but because the comparison is the interesting part. A portfolio that shows one method
working says "I followed a recipe". One that shows several and explains why this one won
says something rather different.

Ordered by payoff per unit of effort.

### 9.1 The solver as a measuring instrument — do this one

Connect 4 is **solved**: with perfect play the first player wins. A perfect player is
alpha-beta with transposition tables and an opening book, and it is not much code.

As an *opponent* it is useless — unbeatable is not fun, and there is no learning story. As
a **ruler** it is the most valuable thing on this list:

> For each checkpoint, sample N positions and report the fraction of its moves that match
> optimal play, and the average value it gives up per move against ground truth.

"Checkpoint 4 plays the optimal move 87% of the time" is an absolute, falsifiable claim.
Elo against its own ancestors is relative and can drift — a ladder can look beautifully
monotonic while the whole population is mediocre. Measuring against truth cannot flatter
itself.

It also dissolves the evaluation problem from §4: no randomised openings, no gating
matches, no worrying that a deterministic 60-game match is really two games repeated
thirty times. Just compare against the correct answer.

**Effort:** moderate. **Payoff:** the single best number this project could put on a page.

### 9.2 Ablations — cheap, and unusually legible

Same architecture, same budget, one thing removed. Each is a short run and each answers a
question a reader will actually have:

| Ablation | What it shows |
|---|---|
| Policy head only, no search at play time | How much of the strength is MCTS rather than the network |
| No value head (rollouts instead) | Whether the learned evaluation is earning its place |
| No Dirichlet noise at the root | Exploration collapse — usually dramatic and easy to see |
| No mirror-symmetry augmentation | What 2x effective data is worth |

The first is the most interesting: **search and network strength are separable**, and
showing the gap between "network alone" and "network plus 400 simulations" is the clearest
possible demonstration of what MCTS contributes. It is also nearly free, since both modes
already exist in the code.

**Effort:** low. **Payoff:** high, because each one is a single honest graph.

### 9.3 Supervised distillation from the solver — the instructive contrast

Generate positions, label them with the solver's optimal move and value, train the same
network by imitation. No MCTS in the loop, and it converges far faster than self-play.

The contrast is the point: **identical architecture, two completely different data
sources.** Self-play discovers; distillation copies. Plot both learning curves on the same
axes and the difference in sample efficiency — and in what each one gets wrong — is the
whole lesson.

Also pragmatic: it makes a good warm start. Distil first to skip the slow early phase,
then hand off to self-play.

**Effort:** low once the solver exists. **Payoff:** high, and it reuses §9.1's work.

### 9.4 A second paradigm on the same game

The racer already uses neuroevolution. Running it on **Connect 4 as well** gives a direct
comparison that is rare in portfolios: one game, two learning paradigms, one Elo scale.

Evolution will lose, and losing is fine — the honest finding that gradient-based
self-play with search is far more sample-efficient for a perfect-information board game is
a better result than a contrived tie.

**Effort:** moderate. **Payoff:** good, mostly as narrative.

### 9.5 Methods not worth building here

Recorded so the choice is visibly deliberate rather than an omission:

- **PPO / policy gradient** — model-free, no search. Higher variance and much more
  sample-hungry on this class of game; would end up weaker than what already exists.
- **DQN** — needs self-play and careful perspective handling anyway, and is generally
  beaten by search-based methods on perfect-information games.
- **MuZero** — learns a model of the dynamics. Pointless when the rules are known exactly.
- **TD-learning with shallow search** — how backgammon was cracked, cheap, works. Mostly
  of historical interest here, and §9.2's ablations already cover the "is the value head
  pulling its weight" question more directly.

### Suggested order

`9.1` (solver + optimality metric) → `9.2` (ablations, which it enables) → `9.3`
(distillation, which reuses it) → `9.4` if there is appetite.

All three of the first items share one piece of work: **building the solver.** That is the
dependency worth paying for.
