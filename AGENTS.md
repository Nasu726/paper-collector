# AGENTS.md

## Mission

Build Paper Collector as a mobile-first personal Paper Inbox. Optimize first for low-friction triage and faithful user control, not for recommendation sophistication.

## Non-negotiable product constraints

- Inbox is the default workflow.
- Original title and abstract remain available.
- PDF/source may be opened before a decision.
- Opening external content must not implicitly Save/Reject a paper.
- Explicit decisions stay lightweight: Save / Not interested.
- Rejected papers are archived, not destroyed.
- Recommendation may rank but must not silently filter eligible papers.
- User-written feed intent and learned preferences are separate data.
- Core use must continue to work without an LLM.

## Engineering constraints

- Keep domain types independent from UI components.
- Keep persistence behind adapter-like modules so localStorage can be replaced by an API/D1 implementation.
- Treat provider-specific ingestion as adapters feeding a normalized paper model.
- Preserve provenance when inferring publication status or merging identities.
- Prefer small dependencies and web-platform primitives.
- Maintain mobile usability and accessible tap targets.

## Validation

Run before considering a change complete:

```bash
npm run typecheck
npm run build
```

Update relevant docs when changing product behavior, data model, architecture, or roadmap.
