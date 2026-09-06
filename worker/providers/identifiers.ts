export function normalizeDoi(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase()
  return normalized.startsWith('10.') && normalized.includes('/') ? normalized : undefined
}

export function normalizeOpenAlexId(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const candidate = value.trim().replace(/^https?:\/\/openalex\.org\//i, '')
  return /^W\d+$/i.test(candidate) ? candidate.toUpperCase() : undefined
}
