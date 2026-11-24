/** Fake user directory: who someone is decides which flags they get. */
import { createHash } from 'node:crypto';

export type Group = 'internal' | 'beta' | 'everyone';

export function lookupUser(userId: string): { id: string; group: Group } {
  const n = createHash('sha256').update(userId).digest().readUInt8(0) % 100;

  return { id: userId, group: n < 5 ? 'internal' : n < 35 ? 'beta' : 'everyone' };
}
