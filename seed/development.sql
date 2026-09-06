PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO feeds (id, name, intent, exclusions, source_policy, active)
VALUES
  (
    'graph-algorithms',
    'Graph Algorithms',
    'Simple but nontrivial graph algorithms, structural graph theory, and meaningful complexity improvements.',
    'Avoid application-only machine learning papers.',
    'include_preprints',
    1
  ),
  (
    'compilers',
    'Compilers',
    'Compiler implementation, optimization, program analysis, unusual intermediate representations, and low-level code generation.',
    NULL,
    'published_only',
    1
  );

INSERT OR IGNORE INTO papers (
  id, title, abstract, authors_json, published_at, venue,
  publication_status, source_url, pdf_url, identifiers_json
)
VALUES
  (
    'demo-graph-1',
    'Separator-Guided Dynamic Shortest Paths in Sparse Graphs',
    'We study exact shortest-path maintenance in sparse graphs under edge updates. The algorithm combines a separator hierarchy with local repair certificates so that most updates avoid rebuilding global distance information. We prove an improved amortized update bound for a restricted but broad family of sparse graphs and give experiments intended only to illustrate the structural behavior of the method.',
    '["A. Example","B. Example"]',
    '2026-09-03',
    'Synthetic demo data',
    'preprint',
    'https://example.com/papers/demo-graph-1',
    'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    '[{"kind":"provider","value":"demo-graph-1","provider":"demo"}]'
  ),
  (
    'demo-compiler-1',
    'Profile-Free Loop Specialization for Tiny Esoteric Targets',
    'This paper considers loop specialization when the target instruction set is extremely small and conventional profile-guided optimization is unavailable. It introduces a static profitability model based on memory-motion cost and repeated control patterns, then evaluates the method on a collection of compact programs.',
    '["C. Example"]',
    '2026-08-28',
    'Synthetic demo data',
    'published',
    'https://example.com/papers/demo-compiler-1',
    'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    '[{"kind":"provider","value":"demo-compiler-1","provider":"demo"}]'
  ),
  (
    'demo-graph-2',
    'A Revisit of Recognition Algorithms for Structured Intersection Graphs',
    'We revisit a classical graph-recognition problem and isolate a small set of invariants that permit a simpler implementation of the recognition phase. The asymptotic worst-case bound matches the best known general result, but the proof exposes a decomposition that may be useful in related ordering problems.',
    '["D. Example","E. Example"]',
    '2026-08-22',
    'Synthetic demo data',
    'accepted',
    'https://example.com/papers/demo-graph-2',
    NULL,
    '[{"kind":"provider","value":"demo-graph-2","provider":"demo"}]'
  ),
  (
    'demo-cross-1',
    'Search-Order Constraints as a Compiler Scheduling Primitive',
    'We formulate a scheduling primitive in which a partial order restricts a greedy search process over a dependency graph. The formulation links a compiler scheduling problem with graph search orderings and yields a compact exact algorithm for small dependency regions.',
    '["F. Example"]',
    '2026-08-17',
    'Synthetic demo data',
    'published',
    'https://example.com/papers/demo-cross-1',
    'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    '[{"kind":"provider","value":"demo-cross-1","provider":"demo"}]'
  );

INSERT OR IGNORE INTO paper_feeds (paper_id, feed_id)
VALUES
  ('demo-graph-1', 'graph-algorithms'),
  ('demo-compiler-1', 'compilers'),
  ('demo-graph-2', 'graph-algorithms'),
  ('demo-cross-1', 'graph-algorithms'),
  ('demo-cross-1', 'compilers');

INSERT OR IGNORE INTO recommendation_snapshots (
  id, paper_id, feed_id, bucket, reasons_json, model_version, scored_at
)
VALUES
  (
    'demo-rec-graph-1',
    'demo-graph-1',
    NULL,
    'very_high',
    '["graph algorithms","complexity improvement","structural technique"]',
    'demo-v0',
    '2026-09-03T00:00:00Z'
  ),
  (
    'demo-rec-compiler-1',
    'demo-compiler-1',
    NULL,
    'high',
    '["compiler optimization","low-level code generation"]',
    'demo-v0',
    '2026-08-28T00:00:00Z'
  ),
  (
    'demo-rec-graph-2',
    'demo-graph-2',
    NULL,
    'medium',
    '["structural graph theory","ordering problem"]',
    'demo-v0',
    '2026-08-22T00:00:00Z'
  ),
  (
    'demo-rec-cross-1',
    'demo-cross-1',
    NULL,
    'high',
    '["graph search","compiler scheduling","exact algorithm"]',
    'demo-v0',
    '2026-08-17T00:00:00Z'
  );
