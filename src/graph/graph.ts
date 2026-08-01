import { randomBytes } from 'node:crypto';
import type { DecayClass, EdgeRel, GraphEdge, GraphNode, NodeKind, NodeStatus } from '../types.js';
import { GraphDb } from './db.js';

export interface UpsertCandidate {
  ns: string;
  kind: NodeKind;
  data: Record<string, unknown>;
  confidence?: number;
  decay_class?: DecayClass;
  source_episode?: string | null;
  label?: string;
}

export interface UpsertResult {
  node: GraphNode;
  action: 'inserted' | 'confirmed' | 'superseded';
  supersededId?: string;
}

interface NodeRow {
  id: string; ns: string; kind: string; label: string; data: string;
  confidence: number; status: string; decay_class: string;
  source_episode: string | null; created_at: number; last_confirmed: number;
}

function rowToNode(r: NodeRow): GraphNode {
  return { ...r, kind: r.kind as NodeKind, status: r.status as NodeStatus, decay_class: r.decay_class as DecayClass, data: JSON.parse(r.data) };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/** Natural key per kind — what makes two candidates "the same knowledge". */
export function naturalKey(kind: NodeKind, data: Record<string, unknown>): string {
  switch (kind) {
    case 'fact': return `${slug(String(data.subject ?? ''))}|${slug(String(data.predicate ?? ''))}`;
    case 'entity': return slug(String(data.name ?? ''));
    case 'decision': return slug(String(data.choice ?? '')).slice(0, 40);
    case 'procedure': return slug(String(data.trigger ?? ''));
    case 'episode': return String(data.transcript_ref ?? randomBytes(8).toString('hex'));
  }
}

export function makeLabel(kind: NodeKind, data: Record<string, unknown>): string {
  switch (kind) {
    case 'fact': return `fact: ${data.subject} ${data.predicate} ${data.object}`;
    case 'entity': return `entity(${data.type ?? '?'}): ${data.name}${data.one_liner ? ` — ${data.one_liner}` : ''}`;
    case 'decision': return `decision: ${data.choice}${data.rationale ? ` (because ${data.rationale})` : ''}`;
    case 'procedure': return `procedure: when ${data.trigger} → ${Array.isArray(data.steps) ? (data.steps as unknown[]).length : '?'} steps`;
    case 'episode': return `episode: ${data.summary ?? data.transcript_ref}`;
  }
}

export class Graph {
  constructor(readonly db: GraphDb) {}

  private ftsBody(node: { label: string; data: Record<string, unknown> }): string {
    const flat = (v: unknown): string =>
      typeof v === 'string' ? v : Array.isArray(v) ? v.map(flat).join(' ') : typeof v === 'object' && v !== null ? Object.values(v).map(flat).join(' ') : String(v ?? '');
    return `${node.label} ${flat(node.data)}`;
  }

  getNode(id: string): GraphNode | null {
    const r = this.db.get<NodeRow>('SELECT * FROM nodes WHERE id = ?', id);
    return r ? rowToNode(r) : null;
  }

  /** Find the active node matching a candidate's natural key. */
  findByNaturalKey(ns: string, kind: NodeKind, data: Record<string, unknown>): GraphNode | null {
    const key = naturalKey(kind, data);
    const rows = this.db.all<NodeRow>("SELECT * FROM nodes WHERE ns = ? AND kind = ? AND status = 'active'", ns, kind);
    for (const r of rows) {
      const n = rowToNode(r);
      if (naturalKey(kind, n.data) === key) return n;
    }
    return null;
  }

  /**
   * Reconcile-friendly upsert:
   * - no active node with the same natural key → insert
   * - same natural key, same value → confirm (confidence up, last_confirmed now)
   * - same natural key, different value → new node + supersedes edge
   */
  upsert(c: UpsertCandidate, now = Date.now()): UpsertResult {
    const existing = this.findByNaturalKey(c.ns, c.kind, c.data);
    const label = c.label ?? makeLabel(c.kind, c.data);

    if (existing) {
      const sameValue = this.sameValue(c.kind, existing.data, c.data);
      if (sameValue) {
        const confidence = Math.min(1, existing.confidence + 0.15);
        this.db.run('UPDATE nodes SET confidence = ?, last_confirmed = ? WHERE id = ?', confidence, now, existing.id);
        return { node: { ...existing, confidence, last_confirmed: now }, action: 'confirmed' };
      }
      const node = this.insert(c, label, now);
      this.db.run("UPDATE nodes SET status = 'superseded' WHERE id = ?", existing.id);
      this.addEdge(node.id, existing.id, 'supersedes', now);
      this.refreshFts(existing.id);
      return { node, action: 'superseded', supersededId: existing.id };
    }

    return { node: this.insert(c, label, now), action: 'inserted' };
  }

  private sameValue(kind: NodeKind, a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    switch (kind) {
      case 'fact': return slug(String(a.object ?? '')) === slug(String(b.object ?? ''));
      case 'entity': return true; // same name = same entity; details merge via confirm
      case 'decision': return String(a.status ?? 'active') === String(b.status ?? 'active') && slug(String(a.rationale ?? '')) === slug(String(b.rationale ?? ''));
      case 'procedure': return JSON.stringify(a.steps ?? []) === JSON.stringify(b.steps ?? []);
      case 'episode': return true;
    }
  }

  private insert(c: UpsertCandidate, label: string, now: number): GraphNode {
    const node: GraphNode = {
      id: `${c.kind.slice(0, 2)}_${randomBytes(6).toString('hex')}`,
      ns: c.ns,
      kind: c.kind,
      label,
      data: c.data,
      confidence: c.confidence ?? 0.5,
      status: 'active',
      decay_class: c.decay_class ?? 'normal',
      source_episode: c.source_episode ?? null,
      created_at: now,
      last_confirmed: now,
    };
    this.db.run(
      'INSERT INTO nodes (id, ns, kind, label, data, confidence, status, decay_class, source_episode, created_at, last_confirmed) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      node.id, node.ns, node.kind, node.label, JSON.stringify(node.data), node.confidence, node.status, node.decay_class, node.source_episode, node.created_at, node.last_confirmed,
    );
    this.db.run('INSERT INTO nodes_fts (id, ns, label, body) VALUES (?,?,?,?)', node.id, node.ns, node.label, this.ftsBody(node));
    if (node.source_episode) this.addEdge(node.id, node.source_episode, 'derived_from', now);
    return node;
  }

  private refreshFts(id: string): void {
    const n = this.getNode(id);
    if (!n) return;
    this.db.run('DELETE FROM nodes_fts WHERE id = ?', id);
    this.db.run('INSERT INTO nodes_fts (id, ns, label, body) VALUES (?,?,?,?)', n.id, n.ns, n.label, this.ftsBody(n));
  }

  updateNode(id: string, fields: Partial<Pick<GraphNode, 'confidence' | 'status' | 'label' | 'data' | 'last_confirmed'>>): void {
    const n = this.getNode(id);
    if (!n) return;
    const merged = { ...n, ...fields };
    this.db.run(
      'UPDATE nodes SET label = ?, data = ?, confidence = ?, status = ?, last_confirmed = ? WHERE id = ?',
      merged.label, JSON.stringify(merged.data), merged.confidence, merged.status, merged.last_confirmed, id,
    );
    this.refreshFts(id);
  }

  addEdge(src: string, dst: string, rel: EdgeRel, now = Date.now()): void {
    this.db.run('INSERT OR IGNORE INTO edges (src, dst, rel, created_at) VALUES (?,?,?,?)', src, dst, rel, now);
  }

  edges(nodeId: string): GraphEdge[] {
    return this.db.all<GraphEdge>('SELECT * FROM edges WHERE src = ? OR dst = ?', nodeId, nodeId);
  }

  listNodes(ns?: string, opts: { includeInactive?: boolean } = {}): GraphNode[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (ns) { where.push('ns = ?'); params.push(ns); }
    if (!opts.includeInactive) where.push("status = 'active'");
    const sql = `SELECT * FROM nodes${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at`;
    return this.db.all<NodeRow>(sql, ...params).map(rowToNode);
  }

  listEdges(ns?: string): GraphEdge[] {
    if (!ns) return this.db.all<GraphEdge>('SELECT * FROM edges');
    return this.db.all<GraphEdge>(
      'SELECT e.* FROM edges e JOIN nodes n ON n.id = e.src WHERE n.ns = ?', ns,
    );
  }

  /** FTS query returning {node, bm25} — raw material for recall ranking. */
  search(ns: string, query: string, limit = 50): Array<{ node: GraphNode; bm25: number }> {
    // FTS5 syntax errors on raw user text — quote each term.
    const terms = query.split(/\s+/).filter((t) => t.length > 0).map((t) => `"${t.replace(/"/g, '')}"`);
    if (terms.length === 0) return [];
    const match = terms.join(' OR ');
    const rows = this.db.all<{ id: string; rank: number }>(
      'SELECT id, rank FROM nodes_fts WHERE ns = ? AND nodes_fts MATCH ? ORDER BY rank LIMIT ?',
      ns, match, limit,
    );
    const out: Array<{ node: GraphNode; bm25: number }> = [];
    for (const r of rows) {
      const n = this.getNode(r.id);
      if (n) out.push({ node: n, bm25: -r.rank }); // fts5 rank is negative-better
    }
    return out;
  }

  stats(): { nodes: number; byKind: Record<string, number>; edges: number; superseded: number } {
    const byKind: Record<string, number> = {};
    for (const r of this.db.all<{ kind: string; c: number }>('SELECT kind, COUNT(*) c FROM nodes GROUP BY kind')) byKind[r.kind] = r.c;
    return {
      nodes: this.db.get<{ c: number }>('SELECT COUNT(*) c FROM nodes')?.c ?? 0,
      byKind,
      edges: this.db.get<{ c: number }>('SELECT COUNT(*) c FROM edges')?.c ?? 0,
      superseded: this.db.get<{ c: number }>("SELECT COUNT(*) c FROM nodes WHERE status='superseded'")?.c ?? 0,
    };
  }
}
