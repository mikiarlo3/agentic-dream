import { sha256, shortHash } from '../store/hash.js';
import type { ConversationMeta, Turn } from '../types.js';
import type { Store } from '../store/store.js';

/**
 * Canonicalize a turn for hashing: string content ≡ single text block,
 * cache_control stripped. Lets us match client-side and server-captured
 * versions of the same turn.
 */
export function canonicalizeTurn(turn: Turn): { role: string; content: Array<Record<string, unknown>> } {
  const content =
    typeof turn.content === 'string'
      ? [{ type: 'text', text: turn.content }]
      : (turn.content as Array<Record<string, unknown>>).map((b) => {
          const { cache_control, ...rest } = b;
          void cache_control;
          return rest;
        });
  return { role: turn.role, content };
}

export function turnHash(turn: Turn): string {
  return sha256(JSON.stringify(canonicalizeTurn(turn))).slice(0, 16);
}

/**
 * Conversation identity: explicit x-dream-conversation-id header wins;
 * otherwise a stable prefix-hash of (system + first user turn). Conversations
 * are append-only, so the first turn anchors identity across stateless calls.
 */
export function resolveConversationId(headers: Record<string, string | undefined>, body: { system?: unknown; messages: Turn[] }): string {
  const explicit = headers['x-dream-conversation-id'];
  if (explicit && explicit.trim() !== '') return explicit.trim().slice(0, 64);
  const first = body.messages[0];
  const anchor = JSON.stringify(body.system ?? '') + '\x00' + (first ? JSON.stringify(canonicalizeTurn(first)) : '');
  return `auto-${shortHash(anchor)}`;
}

export interface SyncResult {
  meta: ConversationMeta;
  ns: string;
  newTurns: Turn[];
  forked: boolean;
  /** Incoming was a strict prefix of stored history (client retry/replay). */
  replay: boolean;
}

/**
 * Reconcile incoming full message history with the stored transcript.
 * Incoming must be a prefix-extension of what we have; if the client edited
 * history, fork to a fresh namespace rather than corrupting memory.
 */
export function syncConversation(store: Store, convId: string, incoming: Turn[], now = Date.now()): SyncResult {
  let ns = convId;
  let meta = store.getMeta(ns);
  let forked = false;

  if (meta) {
    // Content mismatch inside the overlap = the client edited history → fork.
    // Incoming SHORTER than stored with matching hashes = a retry/replay of a
    // request whose reply we already captured → not an edit, do not fork.
    const overlap = Math.min(meta.turnHashes.length, incoming.length);
    let diverged = false;
    for (let i = 0; i < overlap; i++) {
      if (turnHash(incoming[i]!) !== meta.turnHashes[i]) {
        diverged = true;
        break;
      }
    }
    if (diverged) {
      let n = 1;
      while (store.getMeta(`${convId}-fork-${n}`)) n++;
      ns = `${convId}-fork-${n}`;
      meta = null;
      forked = true;
    }
  }

  if (!meta) {
    meta = {
      id: convId,
      ns,
      createdAt: now,
      lastSeen: now,
      turnCount: 0,
      turnHashes: [],
      pressedUpTo: 0,
      consolidatedUpTo: 0,
      tierBlocks: {},
    };
  }

  const replay = !forked && incoming.length < meta.turnHashes.length;
  const newTurns = incoming.slice(meta.turnHashes.length);
  if (newTurns.length > 0) {
    store.appendTurns(ns, newTurns);
    meta.turnHashes.push(...newTurns.map(turnHash));
    meta.turnCount = meta.turnHashes.length;
  }
  meta.lastSeen = now;
  store.putMeta(meta);
  return { meta, ns, newTurns, forked, replay };
}

/** Record a server-captured assistant reply so the next client request matches. */
export function appendAssistantTurn(store: Store, meta: ConversationMeta, content: unknown): void {
  const turn: Turn = { role: 'assistant', content };
  store.appendTurns(meta.ns, [turn]);
  meta.turnHashes.push(turnHash(turn));
  meta.turnCount = meta.turnHashes.length;
  store.putMeta(meta);
}
