import type { Feed, Paper } from './domain'

export const demoFeeds: Feed[] = [
  {
    id: 'graph-algorithms',
    name: 'Graph Algorithms',
    intent:
      'Simple but nontrivial graph algorithms, structural graph theory, and meaningful complexity improvements.',
    exclusions: 'Avoid application-only machine learning papers.',
    sourcePolicy: 'include_preprints',
    active: true,
  },
  {
    id: 'compilers',
    name: 'Compilers',
    intent:
      'Compiler implementation, optimization, program analysis, unusual intermediate representations, and low-level code generation.',
    sourcePolicy: 'published_only',
    active: true,
  },
]

// Synthetic papers are used deliberately: this file exists to validate the triage UX,
// not to act as an ingestion source. Real provider adapters replace it in Milestone 3.
export const demoPapers: Paper[] = [
  {
    id: 'demo-graph-1',
    title: 'Separator-Guided Dynamic Shortest Paths in Sparse Graphs',
    abstract:
      'We study exact shortest-path maintenance in sparse graphs under edge updates. The algorithm combines a separator hierarchy with local repair certificates so that most updates avoid rebuilding global distance information. We prove an improved amortized update bound for a restricted but broad family of sparse graphs and give experiments intended only to illustrate the structural behavior of the method.',
    authors: ['A. Example', 'B. Example'],
    publishedAt: '2026-09-03',
    venue: 'Synthetic demo data',
    publicationStatus: 'preprint',
    sourceUrl: 'https://example.com/papers/demo-graph-1',
    pdfUrl: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    identifiers: [{ kind: 'provider', value: 'demo-graph-1', provider: 'demo' }],
    feedIds: ['graph-algorithms'],
    recommendation: {
      bucket: 'very_high',
      reasons: ['graph algorithms', 'complexity improvement', 'structural technique'],
      modelVersion: 'demo-v0',
    },
  },
  {
    id: 'demo-compiler-1',
    title: 'Profile-Free Loop Specialization for Tiny Esoteric Targets',
    abstract:
      'This paper considers loop specialization when the target instruction set is extremely small and conventional profile-guided optimization is unavailable. It introduces a static profitability model based on memory-motion cost and repeated control patterns, then evaluates the method on a collection of compact programs.',
    authors: ['C. Example'],
    publishedAt: '2026-08-28',
    venue: 'Synthetic demo data',
    publicationStatus: 'published',
    sourceUrl: 'https://example.com/papers/demo-compiler-1',
    pdfUrl: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    identifiers: [{ kind: 'provider', value: 'demo-compiler-1', provider: 'demo' }],
    feedIds: ['compilers'],
    recommendation: {
      bucket: 'high',
      reasons: ['compiler optimization', 'low-level code generation'],
      modelVersion: 'demo-v0',
    },
  },
  {
    id: 'demo-graph-2',
    title: 'A Revisit of Recognition Algorithms for Structured Intersection Graphs',
    abstract:
      'We revisit a classical graph-recognition problem and isolate a small set of invariants that permit a simpler implementation of the recognition phase. The asymptotic worst-case bound matches the best known general result, but the proof exposes a decomposition that may be useful in related ordering problems.',
    authors: ['D. Example', 'E. Example'],
    publishedAt: '2026-08-22',
    venue: 'Synthetic demo data',
    publicationStatus: 'accepted',
    sourceUrl: 'https://example.com/papers/demo-graph-2',
    identifiers: [{ kind: 'provider', value: 'demo-graph-2', provider: 'demo' }],
    feedIds: ['graph-algorithms'],
    recommendation: {
      bucket: 'medium',
      reasons: ['structural graph theory', 'ordering problem'],
      modelVersion: 'demo-v0',
    },
  },
  {
    id: 'demo-cross-1',
    title: 'Search-Order Constraints as a Compiler Scheduling Primitive',
    abstract:
      'We formulate a scheduling primitive in which a partial order restricts a greedy search process over a dependency graph. The formulation links a compiler scheduling problem with graph search orderings and yields a compact exact algorithm for small dependency regions.',
    authors: ['F. Example'],
    publishedAt: '2026-08-17',
    venue: 'Synthetic demo data',
    publicationStatus: 'published',
    sourceUrl: 'https://example.com/papers/demo-cross-1',
    pdfUrl: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    identifiers: [{ kind: 'provider', value: 'demo-cross-1', provider: 'demo' }],
    feedIds: ['graph-algorithms', 'compilers'],
    recommendation: {
      bucket: 'high',
      reasons: ['graph search', 'compiler scheduling', 'exact algorithm'],
      modelVersion: 'demo-v0',
    },
  },
]
