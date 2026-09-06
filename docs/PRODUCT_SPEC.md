# Product Specification

## 1. Product definition

Paper Collector is a **mobile-first personal Paper Inbox** for continuously discovering and triaging research papers without requiring a daily review habit.

The system collects papers matching one or more user-defined research feeds, presents each paper as a compact card, and lets the user make a lightweight explicit decision:

- **Save**
- **Not interested**

The user can open the paper or PDF before deciding. The application learns from explicit decisions and selected implicit behavior, then uses that information only as **decision support**: recommendation must never become an automatic filter that hides eligible papers.

## 2. Core principles

### Inbox-first
The primary screen is the unprocessed paper queue. There is no analytics dashboard in the MVP.

### Mobile-first
The main flow must work comfortably on a phone and should require minimal navigation.

### Original-first
Titles and abstracts are shown in the original language. Translation is delegated to the browser if the user wants it.

### Recommendation is assistance, not filtering
Recommendation changes ordering and adds coarse relevance hints. It does not silently discard papers.

### Explicit profile and learned profile are separate
Each feed contains an explicit natural-language intent written by the user. Learned preferences are stored separately and may influence ranking, but must not rewrite the user's explicit intent.

### AI-optional
Collection, browsing, PDF access, Save, Not Interested, Saved and Archive must remain usable without an LLM.

## 3. Primary user flow

1. Open the app on a phone.
2. Land directly in Inbox.
3. Read the paper title and abstract.
4. Optionally open the PDF or source page.
5. Tap **Save** or **Not interested**.
6. Immediately continue to the next paper.

The system must support batch processing after days or weeks of inactivity.

## 4. Paper card

Required fields:

- title
- authors
- publication date
- venue / publication status when available
- source feed(s)
- abstract
- coarse recommendation level, when available
- short recommendation reason, when available
- paper/source URL
- PDF URL when available

Primary actions:

- Save
- Not interested
- Open PDF
- Open source

Opening a PDF or source page must not itself remove the paper from Inbox.

## 5. Research feeds

A user can create multiple research feeds. A feed contains:

- name
- natural-language interest description
- optional natural-language exclusions
- source policy (`published_only`, `accepted_when_verifiable`, `include_preprints`)
- active flag

A paper may match multiple feeds but must have one canonical paper identity.

## 6. Feedback

### Explicit

MVP labels:

- `saved`
- `rejected`

No star ratings, written reviews, or mandatory comments.

### Implicit

Candidate events:

- card viewed
- abstract expanded
- PDF opened
- source page opened
- reopened from Saved
- saved paper later removed

Signals have different confidence. Dwell time should be weak evidence because a phone may simply have been left idle.

## 7. Recommendation

Recommendation is intentionally coarse. Target presentation is 4-5 discrete levels, for example:

- Very high
- High
- Medium
- Low
- Very low

A short explanation should accompany the bucket where possible, for example:

> Graph algorithms · complexity improvement · similar to papers you saved

The score is not a claim about paper quality and must not be presented as a precise probability.

## 8. Saved and rejected archive

Saved papers remain directly accessible for later reading.

Rejected papers are not deleted. The system keeps the decision and relevant model metadata so preferences can later be re-evaluated and mistakes reversed.

## 9. Paper identity

Canonical identity should prefer stable identifiers in roughly this order:

1. DOI
2. arXiv identifier
3. other source-native stable identifier
4. normalized title + author/date heuristics as fallback

Identity resolution must eventually deduplicate the same work across feeds and data sources.

## 10. MVP scope

### Required

- mobile-first Inbox
- paper cards with original abstract
- PDF/source links
- Save / Not interested
- Saved list
- Rejected archive
- local persistence sufficient for UI prototype
- typed domain model

### Next

- real paper ingestion
- D1 persistence
- feed CRUD
- identity resolution
- implicit feedback event log
- recommendation baseline

### Later

- optional structured AI summaries
- richer ranking models
- saved-paper search and organization
- multiple data-source reconciliation

## 11. Success measures

Primary product metric: **seconds per paper** for first-pass triage.

Supporting metrics:

- papers processed per session
- fraction of Saved papers later opened as PDF/source
- Save rate by recommendation bucket
- queue processing throughput
- continued voluntary use over time

Recommendation accuracy is useful but is not the sole success criterion.
