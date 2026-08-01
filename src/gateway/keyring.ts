// In-memory only. Holds the auth headers of the most recent request per
// conversation so background jobs (semantic press, extraction) can use the
// same credentials. Never persisted, never logged; entries expire.

const TTL_MS = 24 * 60 * 60 * 1000;

export interface KeyEntry {
  headers: Record<string, string>; // x-api-key and/or authorization (+ anthropic-version)
  lastSeen: number;
}

export class Keyring {
  private map = new Map<string, KeyEntry>();

  remember(convId: string, headers: Record<string, string | undefined>, now = Date.now()): void {
    const auth: Record<string, string> = {};
    if (headers['x-api-key']) auth['x-api-key'] = headers['x-api-key'];
    if (headers['authorization']) auth['authorization'] = headers['authorization'];
    if (Object.keys(auth).length === 0) return;
    this.map.set(convId, { headers: auth, lastSeen: now });
  }

  get(convId: string, now = Date.now()): Record<string, string> | null {
    const e = this.map.get(convId);
    if (!e) return null;
    if (now - e.lastSeen > TTL_MS) {
      this.map.delete(convId);
      return null;
    }
    return e.headers;
  }

  size(): number {
    return this.map.size;
  }
}
