import { createHash } from 'node:crypto';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function shortHash(text: string, len = 16): string {
  return sha256(text).slice(0, len);
}
