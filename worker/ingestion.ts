import type { Feed, PaperIdentifier } from '../src/domain'
import {
  FIELD_POLICY_VERSION,
  recordFieldEvidence,
  selectFieldSource,
  selectFieldSourceIfMissing,
  type CanonicalFieldName,
} from './fieldEvidence'
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
  const matchingPaperIds = new Set<string>()

  for (const identifier of paper.identifiers) {
    const row = await db
      .prepare(
        `SELECT paper_id FROM paper_identifiers
         WHERE kind = ? AND value = ? AND provider = ?
         LIMIT 1`,
      )
      .bind(identifier.kind, identifier.value, identifierProvider(identifier))
      .first<{ paper_id: string }>()
    if (row) matchingPaperIds.add(row.paper_id)
  }

  const preferredId = preferredPaperId(paper)
  const preferredRow = await db
    .prepare('SELECT id FROM papers WHERE id = ?')
    .bind(preferredId)
    .first<{ id: string }>()
  if (preferredRow) matchingPaperIds.add(preferredRow.id)

  if (matchingPaperIds.size > 1) {
    throw new Error(
      `Identity conflict for ${paper.provider}:${paper.providerRecordId}; matched papers ${[
        ...matchingPaperIds,
      ].join(', ')}`,
    )
  }

  const [paperId] = matchingPaperIds
  if (!paperId) return null

  return db
    .prepare('SELECT id, identifiers_json FROM papers WHERE id = ?')
    .bind(paperId)
    .first<ExistingPaperRow>()
}

async function refreshSeenAliases(
  db: D1Database,
  identifiers: PaperIdentifier[],
): Promise<void> {
  const seenAt = new Date().toISOString()
  const statements = identifiers.map((identifier) =>
    db
      .prepare(
        `INSERT INTO seen_paper_identifiers (
           kind, value, provider, first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(kind, value, provider) DO UPDATE SET
           last_seen_at = excluded.last_seen_at`,
      )
      .bind(
        identifier.kind,
        identifier.value,
        identifierProvider(identifier),
        seenAt,
        seenAt,
      ),
  )
  if (statements.length) await db.batch(statements)
}

async function wasPreviouslyPurged(db: D1Database, paper: ProviderPaper): Promise<boolean> {
  const identifiers = paper.identifiers
  if (identifiers.length) {
    const clauses = identifiers.map(() => '(kind = ? AND value = ? AND provider = ?)').join(' OR ')
    const bindings = identifiers.flatMap((identifier) => [
      identifier.kind,
      identifier.value,
      identifierProvider(identifier),
    ])
    const match = await db
      .prepare(`SELECT 1 AS found FROM seen_paper_identifiers WHERE ${clauses} LIMIT 1`)
      .bind(...bindings)
      .first<{ found: number }>()
    if (match) {
      await refreshSeenAliases(db, identifiers)
      return true
    }
  }

  const purged = await db
    .prepare('SELECT 1 AS found FROM purged_paper_learning WHERE paper_id = ? LIMIT 1')
    .bind(preferredPaperId(paper))
    .first<{ found: number }>()
  if (!purged) return false

  await refreshSeenAliases(db, identifiers)
  return true
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

async function recordProviderEvidence(db: D1Database, paperId: string, paper: ProviderPaper): Promise<void> {
  const evidence: Array<{ fieldName: CanonicalFieldName; sourceField: string; value: unknown }> = [
    { fieldName: 'title', sourceField: 'title', value: paper.title },
    { fieldName: 'abstract', sourceField: 'abstract_inverted_index', value: paper.abstract },
    { fieldName: 'authors', sourceField: 'authorships', value: paper.authors },
    { fieldName: 'publication_status', sourceField: 'locations/type', value: paper.publicationStatus },
    { fieldName: 'source_url', sourceField: 'primary_location', value: paper.sourceUrl },
  ]
  if (paper.publishedAt) evidence.push({ fieldName: 'published_at', sourceField: 'publication_date', value: paper.publishedAt })
  if (paper.venue) evidence.push({ fieldName: 'venue', sourceField: 'primary_location.source', value: paper.venue })
  if (paper.pdfUrl) evidence.push({ fieldName: 'pdf_url', sourceField: 'best_oa_location/primary_location', value: paper.pdfUrl })

  for (const item of evidence) {
    await recordFieldEvidence(db, {
      paperId,
      fieldName: item.fieldName,
      provider: paper.provider,
      providerRecordId: paper.providerRecordId,
      sourceField: item.sourceField,
      value: item.value,
    })
  }

  for (const item of evidence) {
    const source = {
      paperId,
      fieldName: item.fieldName,
      provider: paper.provider,
      providerRecordId: paper.providerRecordId,
      sourceField: item.sourceField,
      policyVersion: FIELD_POLICY_VERSION,
    }
    if (item.fieldName === 'published_at' || item.fieldName === 'venue' || item.fieldName === 'publication_status') {
      await selectFieldSourceIfMissing(db, source)
    } else {
      await selectFieldSource(db, source)
    }
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
    if (!existing && (await wasPreviouslyPurged(db, paper))) continue

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
           published_at = CASE
             WHEN EXISTS (
               SELECT 1 FROM paper_field_sources s
               WHERE s.paper_id = excluded.id AND s.field_name = 'published_at' AND s.provider = 'crossref'
             ) THEN papers.published_at
             ELSE excluded.published_at
           END,
           venue = CASE
             WHEN EXISTS (
               SELECT 1 FROM paper_field_sources s
               WHERE s.paper_id = excluded.id AND s.field_name = 'venue' AND s.provider = 'crossref'
             ) THEN papers.venue
             ELSE excluded.venue
           END,
           publication_status = CASE
             WHEN EXISTS (
               SELECT 1 FROM paper_field_sources s
               WHERE s.paper_id = excluded.id AND s.field_name = 'publication_status' AND s.provider = 'crossref'
             ) THEN papers.publication_status
             ELSE excluded.publication_status
           END,
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
    await recordProviderEvidence(db, paperId, paper)

    const membershipResult = await db
      .prepare('INSERT OR IGNORE INTO paper_feeds (paper_id, feed_id) VALUES (?, ?)')
      .bind(paperId, feed.id)
      .run()
    if (membershipResult.meta.changes > 0) attached += 1

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
