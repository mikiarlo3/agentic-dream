// Shared types across Dream components.

export interface Block {
  id: string; // t<tier>-<hash16>
  tier: number;
  ns: string;
  pressed: string;
  original: string; // text this block was pressed FROM (tier n-1 text)
  at: number; // epoch ms
  backend: 'mechanical' | 'semantic' | 'salience';
  originalTokens: number;
  pressedTokens: number;
  /** Segment range this block covers in the raw transcript, inclusive. */
  fromTurn?: number;
  toTurn?: number;
}

export type NodeKind = 'fact' | 'entity' | 'decision' | 'procedure' | 'episode';
export type NodeStatus = 'active' | 'superseded' | 'merged';
export type DecayClass = 'stable' | 'normal' | 'volatile';
export type EdgeRel = 'about' | 'derived_from' | 'supersedes' | 'used_in';

export interface GraphNode {
  id: string;
  ns: string;
  kind: NodeKind;
  label: string; // the one-line index entry
  data: Record<string, unknown>;
  confidence: number;
  status: NodeStatus;
  decay_class: DecayClass;
  source_episode: string | null;
  created_at: number;
  last_confirmed: number;
}

export interface GraphEdge {
  src: string;
  dst: string;
  rel: EdgeRel;
  created_at: number;
}

/** A single message turn in Anthropic Messages API shape. */
export interface Turn {
  role: 'user' | 'assistant';
  content: unknown; // string | ContentBlock[]
}

export interface ConversationMeta {
  id: string;
  ns: string;
  createdAt: number;
  lastSeen: number;
  turnCount: number;
  /** Per-turn content hashes, for prefix/divergence detection. */
  turnHashes: string[];
  /** Turn index up to which history has been pressed (exclusive). */
  pressedUpTo: number;
  /** Turn index up to which consolidation has run (exclusive). */
  consolidatedUpTo: number;
  /** Block ids by tier, oldest first. */
  tierBlocks: Record<string, string[]>;
  lastModel?: string;
}

export interface WindowStats {
  rawTokens: number;
  sentTokens: number;
  savingsPct: number;
  blocks: number;
  indexTokens: number;
  tailTurns: number;
  pressed: boolean;
}

export interface RecallResult {
  nodes: Array<GraphNode & { score: number }>;
  blocks: Block[];
}

export interface EvalTruth {
  question: string;
  probes: string[];
}

export interface EvalCurvePoint {
  tier: number;
  tokens: number;
  ratio: number;
  retention: number;
  lost: string[]; // questions whose probes all died at this tier
}

export interface EvalCurve {
  date: string;
  sessionTokens: number;
  backend: string;
  tiers: EvalCurvePoint[];
  cliff: number | null; // first tier where retention < 0.5
}

export interface RequestLogEntry {
  ts: number;
  convId: string;
  model: string;
  stream: boolean;
  status: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  dream: WindowStats | null;
  dreamToolHops?: number;
}
