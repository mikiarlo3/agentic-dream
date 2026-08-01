import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Block, ConversationMeta } from '../types.js';
import { shortHash } from './hash.js';

/**
 * Content-addressed block archive + conversation metadata, all on disk.
 *
 * Layout:
 *   <root>/ns/<convId>/blocks/t<tier>-<hash16>.json
 *   <root>/ns/<convId>/meta.json
 *   <root>/ns/<convId>/transcript.jsonl     (raw turns, append-only)
 *   <root>/graph/nodes.sqlite               (managed by graph/)
 *   <root>/graph/index-<ns>.txt
 *   <root>/skills/<name>.md
 *   <root>/eval/curve-<date>.json
 */
export class Store {
  private hits = 0;
  private misses = 0;

  constructor(readonly root: string) {
    mkdirSync(join(root, 'ns'), { recursive: true });
    mkdirSync(join(root, 'graph'), { recursive: true });
    mkdirSync(join(root, 'skills'), { recursive: true });
    mkdirSync(join(root, 'eval'), { recursive: true });
  }

  static blockId(tier: number, original: string): string {
    return `t${tier}-${shortHash(original)}`;
  }

  private nsDir(ns: string): string {
    // Namespace comes from conversation ids we generate (hex) or client
    // headers — sanitize to keep it a single safe path segment.
    const safe = ns.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    return join(this.root, 'ns', safe);
  }

  private blockPath(ns: string, id: string): string {
    return join(this.nsDir(ns), 'blocks', `${id}.json`);
  }

  /** Returns existing block for this (tier, original) if already pressed. */
  getByContent(ns: string, tier: number, original: string): Block | null {
    return this.get(ns, Store.blockId(tier, original));
  }

  get(ns: string, id: string): Block | null {
    const p = this.blockPath(ns, id);
    if (!existsSync(p)) {
      this.misses++;
      return null;
    }
    this.hits++;
    return JSON.parse(readFileSync(p, 'utf8')) as Block;
  }

  put(block: Block): string {
    const dir = join(this.nsDir(block.ns), 'blocks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.blockPath(block.ns, block.id), JSON.stringify(block, null, 2));
    return block.id;
  }

  /** Find a block by id across namespaces (for GET /blocks/:id). */
  findBlock(id: string): Block | null {
    if (!/^t\d+-[0-9a-f]{16}$/.test(id)) return null;
    for (const ns of this.listNamespaces()) {
      const b = this.get(ns, id);
      if (b) return b;
    }
    return null;
  }

  listNamespaces(): string[] {
    const dir = join(this.root, 'ns');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory());
  }

  listBlocks(ns: string): Block[] {
    const dir = join(this.nsDir(ns), 'blocks');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Block)
      .sort((a, b) => a.at - b.at);
  }

  // --- conversation metadata ---

  getMeta(ns: string): ConversationMeta | null {
    const p = join(this.nsDir(ns), 'meta.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as ConversationMeta;
  }

  putMeta(meta: ConversationMeta): void {
    const dir = this.nsDir(meta.ns);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  }

  // --- raw transcript (append-only) ---

  appendTurns(ns: string, turns: unknown[]): void {
    if (turns.length === 0) return;
    const dir = this.nsDir(ns);
    mkdirSync(dir, { recursive: true });
    const lines = turns.map((t) => JSON.stringify(t)).join('\n') + '\n';
    writeFileSync(join(dir, 'transcript.jsonl'), lines, { flag: 'a' });
  }

  readTurns(ns: string): unknown[] {
    const p = join(this.nsDir(ns), 'transcript.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  }

  // --- skills ---

  putSkill(name: string, markdown: string): void {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
    writeFileSync(join(this.root, 'skills', `${safe}.md`), markdown);
  }

  listSkills(): Array<{ name: string; markdown: string }> {
    const dir = join(this.root, 'skills');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ name: f.replace(/\.md$/, ''), markdown: readFileSync(join(dir, f), 'utf8') }));
  }

  // --- eval curves ---

  putCurve(date: string, curve: unknown): void {
    writeFileSync(join(this.root, 'eval', `curve-${date}.json`), JSON.stringify(curve, null, 2));
  }

  listCurves(): Array<{ date: string; curve: unknown }> {
    const dir = join(this.root, 'eval');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.startsWith('curve-') && f.endsWith('.json'))
      .sort()
      .map((f) => ({
        date: f.slice('curve-'.length, -'.json'.length),
        curve: JSON.parse(readFileSync(join(dir, f), 'utf8')),
      }));
  }

  stats(): { namespaces: number; blocks: number; blocksByTier: Record<string, number>; diskBytes: number; cacheHits: number; cacheMisses: number; cacheHitRate: number } {
    let blocks = 0;
    let diskBytes = 0;
    const blocksByTier: Record<string, number> = {};
    for (const ns of this.listNamespaces()) {
      for (const b of this.listBlocks(ns)) {
        blocks++;
        blocksByTier[`t${b.tier}`] = (blocksByTier[`t${b.tier}`] ?? 0) + 1;
        diskBytes += b.original.length + b.pressed.length;
      }
    }
    const total = this.hits + this.misses;
    return {
      namespaces: this.listNamespaces().length,
      blocks,
      blocksByTier,
      diskBytes,
      cacheHits: this.hits,
      cacheMisses: this.misses,
      cacheHitRate: total === 0 ? 0 : this.hits / total,
    };
  }
}
