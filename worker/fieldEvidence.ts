export type CanonicalFieldName =
  | 'title'
  | 'abstract'
  | 'authors'
  | 'published_at'
  | 'accepted_at'
  | 'venue'
  | 'publication_status'
  | 'source_url'
  | 'pdf_url'

export type FieldEvidence = {
  paperId: string
  fieldName: CanonicalFieldName
  provider: string
  providerRecordId: string
  sourceField: string
  value: unknown
}

export type FieldSource = {
  paperId: string
  fieldName: CanonicalFieldName
  provider: string
  providerRecordId: string
  sourceField: string
  policyVersion: string
}

export const FIELD_POLICY_VERSION = 'field-policy-v1'

export async function recordFieldEvidence(db: D1Database, evidence: FieldEvidence): Promise<void> {
  await db
    .prepare(
      `INSERT INTO paper_field_evidence (
         paper_id, field_name, provider, provider_record_id,
         source_field, value_json, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(paper_id, field_name, provider, provider_record_id, source_field)
       DO UPDATE SET
         value_json = excluded.value_json,
         observed_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      evidence.paperId,
      evidence.fieldName,
      evidence.provider,
      evidence.providerRecordId,
      evidence.sourceField,
      JSON.stringify(evidence.value),
    )
    .run()
}

export async function selectFieldSource(db: D1Database, source: FieldSource): Promise<void> {
  await db
    .prepare(
      `INSERT INTO paper_field_sources (
         paper_id, field_name, provider, provider_record_id,
         source_field, policy_version, selected_at
       ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(paper_id, field_name) DO UPDATE SET
         provider = excluded.provider,
         provider_record_id = excluded.provider_record_id,
         source_field = excluded.source_field,
         policy_version = excluded.policy_version,
         selected_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      source.paperId,
      source.fieldName,
      source.provider,
      source.providerRecordId,
      source.sourceField,
      source.policyVersion,
    )
    .run()
}

export async function selectFieldSourceIfMissing(db: D1Database, source: FieldSource): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO paper_field_sources (
         paper_id, field_name, provider, provider_record_id,
         source_field, policy_version, selected_at
       ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    )
    .bind(
      source.paperId,
      source.fieldName,
      source.provider,
      source.providerRecordId,
      source.sourceField,
      source.policyVersion,
    )
    .run()
}
