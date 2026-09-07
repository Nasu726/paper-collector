import type { DecisionState } from '../../../src/domain'
import type { FeedbackEventType, FeedbackSurface } from '../../../worker/feedback'
import type { LexicalFeed, LexicalPaper } from '../../../worker/recommendation'

export type EvaluationImplicitEvent = {
  type: FeedbackEventType
  surface: FeedbackSurface
  count: number
}

export type EvaluationTrainingItem = {
  paper: LexicalPaper
  judgedAt?: string
  explicitState?: DecisionState
  implicit: EvaluationImplicitEvent[]
}

export type EvaluationHoldoutItem = {
  paper: LexicalPaper
  judgedAt: string
  state: DecisionState
}

export const recommendationEvaluationFixture: {
  name: string
  cutoff: string
  feed: LexicalFeed
  training: EvaluationTrainingItem[]
  holdout: EvaluationHoldoutItem[]
} = {
  name: 'graph-subtopic-chronological-v1',
  cutoff: '2026-08-15T00:00:00Z',
  feed: {
    id: 'graph-algorithms',
    name: 'Graph Algorithms',
    intent: 'graph algorithms optimization',
  },
  training: [
    {
      paper: {
        id: 'train-save-chordal',
        title: 'Chordal graph separator algorithms',
        abstract: 'We study elimination orderings chordal graphs separators cliques trees efficient algorithms.',
      },
      judgedAt: '2026-07-10T09:00:00Z',
      explicitState: 'saved',
      implicit: [],
    },
    {
      paper: {
        id: 'train-save-treewidth',
        title: 'Tree decomposition algorithms',
        abstract: 'Dynamic algorithms exploit treewidth separators chordal structure.',
      },
      judgedAt: '2026-07-18T11:00:00Z',
      explicitState: 'saved',
      implicit: [],
    },
    {
      paper: {
        id: 'train-reject-neural',
        title: 'Graph neural network optimization',
        abstract: 'Neural representation learning for graph classification with transformers embeddings.',
      },
      judgedAt: '2026-07-23T14:00:00Z',
      explicitState: 'rejected',
      implicit: [],
    },
    {
      paper: {
        id: 'train-reject-llm',
        title: 'Large language model graph reasoning',
        abstract: 'Language models neural embeddings for graph reasoning and benchmark optimization.',
      },
      judgedAt: '2026-08-01T10:00:00Z',
      explicitState: 'rejected',
      implicit: [],
    },
    {
      paper: {
        id: 'train-implicit-separators',
        title: 'Clique separator enumeration',
        abstract: 'Algorithms enumerate clique separators and decomposition structures in chordal graphs.',
      },
      implicit: [
        { type: 'pdf_opened', surface: 'inbox', count: 2 },
        { type: 'source_opened', surface: 'inbox', count: 1 },
      ],
    },
  ],
  holdout: [
    {
      paper: {
        id: 'holdout-positive-minsep',
        title: 'Minimal separators in chordal graphs',
        abstract: 'We give efficient algorithms for clique trees elimination orders and treewidth.',
      },
      judgedAt: '2026-08-20T08:00:00Z',
      state: 'saved',
    },
    {
      paper: {
        id: 'holdout-positive-recognition',
        title: 'Faster chordal graph recognition',
        abstract: 'Separator based graph algorithms exploit perfect elimination ordering.',
      },
      judgedAt: '2026-08-25T12:00:00Z',
      state: 'saved',
    },
    {
      paper: {
        id: 'holdout-negative-transformer',
        title: 'Graph transformer optimization',
        abstract: 'Neural graph representation learning with attention embeddings and large models.',
      },
      judgedAt: '2026-08-29T15:00:00Z',
      state: 'rejected',
    },
    {
      paper: {
        id: 'holdout-negative-classification',
        title: 'Neural algorithms for graph classification',
        abstract: 'Optimization of graph neural networks for representation benchmarks.',
      },
      judgedAt: '2026-09-02T07:00:00Z',
      state: 'rejected',
    },
  ],
}
