import type { Feed, PaperIdentifier } from '../src/domain'
import type { ProviderPaper } from './providers/types'

type ExistingPaperRow = {
  id: string
  identifiers_json: string
}

export type IngestionResult = {
  fetched: number
  inserted: number
  updated: number
  attached: number
}

function identifierProvider(identifier: PaperIdentifier): string {
  return identifier.provider ?? ''
}

function mergeIdentifiers(existingRaw: string | null, incoming: PaperIdentifier[]): PaperIdentifier[] {
  let existing: PaperIdentifier[] = []
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw) as unknown
      if (Array.isArray(parsed)) existing = parsed as PaperIdentifier[]
    } catch {
      existing = []
    }
  }

  const merged = new Map<string, PaperIdentifier>()
  for (const identifier of [...existing, ...incoming]) {
    const key = `${identifier.kind}\u0000${identifierProvider(identifier)}\u0000${identifier.value}`
    merged.set(key, identifier)
  }
  return [...merged.values()]
}

function preferredPaperId(paper: ProviderPaper): string {
  const doi = paper.identifiers.find((identifier) => identifier.kind === 'doi')
  if (doi) return `doi:${doi.value}`
  return `${paper.provider}:${paper.providerRecordId.toLowerCase()}`
}

async function findExistingPaper(db: D1Database, paper: ProviderPaper): Promise<ExistingPaperRow | null> {
  for (const identifier of paper.identifiers) {
    const row = await db
      .prepare(
        `SELECT p.id, p.identifiers_json
         FROM paper_identifiers i
         JOIN papers p ON p.id = i.paper_id
         WHERE i.kind = ? AND i.value = ? AND i.provider = ?
         LIMIT 1`,
      )
      .bind(identifier.kind, identifier.value, identifierProvider(identifier))
      .first<ExistingPaperRow>()
    if (row) return row
  }

  return db
    .prepare('SELECT id, identifiers_json FROM papers WHERE id = ?')
    .bind(preferredPaperId(paper))
    .first<ExistingPaperRow>()
}

async function registerIdentifiers(db: D1Database, paperId: string, identifiers: PaperIdentifier[]): Promise<void> {
  for (const identifier of identifiers) {
    const conflict = await db
      .prepare(
        `SELECT paper_id FROM paper_identifiers
         WHERE kind = ? AND value = ? AND provider = ?`,
      )
      .bind(identifier.kind, identifier.value, identifierProvider(identifier))
      .first<{ paper_id: string }>()

    if (conflict && conflict.paper_id !== paperId) {
      throw new Error(
        `Identifier conflict for ${identifier.kind}:${identifier.value}; belongs to ${conflict.paper_id}`,
      )
    }

    await db
      .prepare(
        `INSERT OR IGNORE INTO paper_identifiers (paper_id, kind, value, provider)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(paperId, identifier.kind, identifier.value, identifierProvider(identifier))
      .run()
  }
}

export async function persistProviderPapers(
  db: D1Database,
  feed: Feed,
  papers: ProviderPaper[],
  queryText: string,
): Promise<IngestionResult> {
  let inserted = 0
  let updated = 0
  let attached = 0

  for (const paper of papers) {
    const existing = await findExistingPaper(db, paper)
    const paperId = existing?.id ?? preferredPaperId(paper)
    const identifiers = mergeIdentifiers(existing?.identifiers_json ?? null, paper.identifiers)

    await db
      .prepare(
        `INSERT INTO papers (
           id, title, abstract, authors_json, published_at, venue,
           publication_status, source_url, pdf_url, identifiers_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           abstract = excluded.abstract,
           authors_json = excluded.authors_json,
           published_at = excluded.published_at,
           venue = excluded.venue,
           publication_status = excluded.publication_status,
           source_url = excluded.source_url,
           pdf_url = excluded.pdf_url,
           identifiers_json = excluded.identifiers_json,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(
        paperId,
        paper.title,
        paper.abstract,
        JSON.stringify(paper.authors),
        paper.publishedAt ?? null,
        paper.venue ?? null,
        paper.publicationStatus,
        paper.sourceUrl,
        paper.pdfUrl ?? null,
        JSON.stringify(identifiers),
      )
      .run()

    if (existing) updated += 1
    else inserted += 1

    await registerIdentifiers(db, paperId, identifiers)

    const membership = await db
      .prepare('SELECT 1 AS present FROM paper_feeds WHERE paper_id = ? AND feed_id = ?')
      .bind(paperId, feed.id)
      .first<{ present: number }>()
    if (!membership) {
      await db
        .prepare('INSERT INTO paper_feeds (paper_id, feed_id) VALUES (?, ?)')
        .bind(paperId, feed.id)
        .run()
      attached += 1
    }

    await db
      .prepare(
        `INSERT INTO ingestion_provenance (
           paper_id, feed_id, provider, provider_record_id,
           query_text, provider_updated_at, first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(paper_id, feed_id, provider, provider_record_id) DO UPDATE SET
           query_text = excluded.query_text,
           provider_updated_at = excluded.provider_updated_at,
           last_seen_at = CURRENT_TIMESTAMP`,
      )
      .bind(
        paperId,
        feed.id,
        paper.provider,
        paper.providerRecordId,
        queryText,
        paper.providerUpdatedAt ?? null,
      )
      .run()
  }

  return {
    fetched: papers.length,
    inserted,
    updated,
    attached,
  }
}
