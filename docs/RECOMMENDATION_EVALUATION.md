# Recommendation evaluation

## Purpose

`lexical-v1` is a deterministic ranking baseline, not a claim that lexical matching is generally sufficient for scholarly recommendation. The baseline should remain only while it is measurable, inspectable, and useful enough for this personal Paper Inbox.

Run the offline evaluation with:

```bash
npm run eval:recommendation
```

The command performs no network access. It reuses the production `lexical-v1` profile/scoring functions against a deterministic chronological fixture and exits non-zero if the learned profile stops improving the fixture or if any eligible holdout Paper disappears from the ranking.

## Evaluation fixture

The fixture deliberately contains a broad Feed intent (`graph algorithms optimization`) that is ambiguous between two subtopics.

Before the cutoff, the synthetic history contains:

- Saves on chordal graphs, separators, tree decompositions, and treewidth
- rejections on graph neural networks / language-model graph reasoning
- weaker implicit PDF/source-open evidence on a separator Paper

After the cutoff, held-out judgments contain two separator/chordal positives and two neural-representation negatives.

This is a regression fixture, not evidence of real-world recommendation quality. Its purpose is to prove that learned evidence can change ordering in the intended direction while preserving eligibility.

## Metrics

The command reports both an intent-only profile and the learned `lexical-v1` profile.

- **Pairwise accuracy** — fraction of held-out positive/negative pairs where the positive receives the higher score. Exact score ties receive half credit.
- **First-positive MRR** — reciprocal rank of the first held-out Save.
- **Positive-negative score gap** — mean held-out positive score minus mean held-out negative score. This is useful only as a within-model regression statistic; it is not a probability or calibrated confidence.
- **Eligibility recall** — fraction of held-out Papers still present in the ranking. It must remain exactly `1.0`.

The report also prints model version, explicit Save/Reject counts, implicit evidence mass, evidence strength, and the deterministic ranked holdout list.

## Current regression result

For fixture `graph-subtopic-chronological-v1`, CI currently reports:

| Metric | Intent only | `lexical-v1` |
| --- | ---: | ---: |
| Pairwise accuracy | 0.25 | 1.00 |
| First-positive MRR | 0.333333 | 1.00 |
| Positive-negative score gap | -0.12 | +0.27789 |
| Eligibility recall | 1.00 | 1.00 |

The training side contains four explicit judgments (2 Save / 2 Reject) plus bounded implicit evidence with aggregate model mass `1.727218`; the profile's evidence-strength term is saturated at `1.0`.

These values are regression expectations for this synthetic scenario. They must not be presented as production accuracy estimates.

## Cold-start contract

With no interaction evidence, `buildFeedProfile` uses only the user-authored Feed intent and exclusions. Recommendation must therefore remain deterministic before the first decision.

`lexical-v1` currently computes learned-evidence strength as:

```text
clamp(explicitCount * 0.55 + min(implicitMass, 4) / 8, 0, 1)
```

Consequences:

- zero evidence: learned contribution is exactly zero
- one explicit Save/Reject: learned evidence is already allowed to influence ranking, at strength `0.55`
- two explicit judgments: explicit evidence alone saturates the strength term at `1.0`
- implicit evidence may influence ranking before an explicit decision, but implicit-only strength is capped at `0.5`
- repeated implicit events use capped/logarithmic weights, so repeated opens cannot grow without bound
- explicit examples contribute much larger signed profile weights (`+4` Save, `-5` Reject) than a single implicit interaction

These numbers are part of model version `lexical-v1`. Changing them materially should require a new model version and rerunning evaluation.

## What this evaluation does not prove

The deterministic fixture cannot establish production recommendation quality. Known lexical limitations include:

- synonyms and vocabulary mismatch (`separator` vs a semantically equivalent term that never overlaps lexically)
- abbreviations and domain-specific aliases
- multilingual title/abstract text
- sparse or contradictory personal judgments
- broad Feed intents that share common vocabulary across unrelated subfields
- concept similarity that depends on mathematical or scientific meaning rather than word overlap

Real user decisions should eventually be evaluated chronologically as enough history accumulates. Do not describe `lexical-v1` as an ML-quality recommendation model merely because this regression fixture improves.

## When embeddings are justified

An embedding model becomes worth evaluating when all of the following are true:

1. there is enough real explicit history for a meaningful chronological holdout (preferably at least dozens of judgments and multiple positive/negative pairs rather than a handful of examples),
2. error inspection repeatedly shows semantic vocabulary mismatch, synonyms, or multilingual matching as a material source of ranking mistakes,
3. a reproducible offline comparison shows a meaningful improvement over `lexical-v1` (for example, roughly +0.10 absolute pairwise accuracy or a comparably clear MRR gain rather than noise),
4. every eligible Paper remains reachable, and
5. the latency, cost, deployment complexity, and privacy boundary of the embedding provider/model are acceptable.

That threshold justifies an embedding experiment, not automatic deployment. The simpler deterministic model remains preferable if measured gains are marginal.
