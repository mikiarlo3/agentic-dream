// Thin adapter over node:sqlite. Isolates the experimental API so a swap to
// better-sqlite3 is a one-file change. Synchronous, WAL, single process.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  ns TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('fact','entity','decision','procedure','episode')),
  label TEXT NOT NULL,
  data TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'active',
  decay_class TEXT NOT NULL DEFAULT 'normal',
  source_episode TEXT,
  created_at INTEGER NOT NULL,
  last_confirmed INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_ns_kind ON nodes(ns, kind, status);
CREATE TABLE IF NOT EXISTS edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  rel TEXT NOT NULL CHECK(rel IN ('about','derived_from','supersedes','used_in')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (src, dst, rel)
);
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(id UNINDEXED, ns UNINDEXED, label, body);
`;

export class GraphDb {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  run(sql: string, ...params: Array<string | number | null>): void {
    this.db.prepare(sql).run(...params);
  }

  get<T = Record<string, unknown>>(sql: string, ...params: Array<string | number | null>): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: Array<string | number | null>): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  close(): void {
    this.db.close();
  }
}
