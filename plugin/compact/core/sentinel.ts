import type { SessionMessage } from './types.js';

/**
 * First line of every seed message (spec §3.1). Fixed and grep-able so the
 * extractor (spec §3.2) can skip a seed without reading its whole body, and so
 * a live probe can assert a seed round-tripped.
 */
export const SEED_SENTINEL = '[[exovault:s4-seed:v1]]';

/** Marker that ends a seed message in place of a separate marker message (spec §3.1). */
export function omittedHistoryMarker(omittedCount: number): string {
  return `[… ${omittedCount} messages omitted, pointers above]`;
}

export function isSeedMessage(message: Pick<SessionMessage, 'role' | 'text'>): boolean {
  return message.role === 'user' && message.text.startsWith(SEED_SENTINEL);
}
