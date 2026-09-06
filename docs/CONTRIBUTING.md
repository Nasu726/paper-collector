# Contributing / Development Notes

## Local setup

```bash
npm install
npm run dev
```

Before opening or updating a PR:

```bash
npm run typecheck
npm run build
```

## Product invariants

Do not break these without an explicit product decision:

1. Inbox is the default and shortest path to triage.
2. Original title/abstract remain available.
3. Opening a PDF/source does not implicitly decide a paper.
4. Recommendation may rank but must not silently filter eligible papers.
5. User-written feed intent is separate from learned preferences.
6. Rejected papers are archived rather than destroyed.
7. Core triage must not depend on an LLM.

## Implementation style

- Prefer small typed domain modules over components with embedded business logic.
- Keep persistence behind an adapter boundary.
- Avoid adding dependencies for UI behavior that can be implemented clearly with platform APIs/CSS.
- Preserve mobile usability when adding desktop affordances.
- Add ingestion providers through adapters rather than provider-specific fields throughout the app.

## Branches

Use focused branches such as:

- `feat/mvp-foundation`
- `feat/d1-persistence`
- `feat/ingestion-crossref`
- `feat/recommendation-baseline`

## Documentation

Update the relevant document when changing a product invariant, target architecture, data model, or roadmap milestone.
