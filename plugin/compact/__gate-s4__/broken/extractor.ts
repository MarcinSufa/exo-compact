import type { ExtractorDeps, ExtractorResult } from '../../core/extractor.js';
import type { CaptureRecord, ContentWatermark, Hasher, SessionMessage } from '../../core/types.js';

/**
 * `core/extractor.ts` now stubs this out too (the implementer owns all core logic), so the
 * broken variant carries its own working copy instead of re-exporting a throwing stub.
 * Spec §3.2: sha256 of role, text and tool_use ids, not the engine `handle` or an index.
 */
export function contentIdentity(message: SessionMessage, hash: Hasher): string {
  const toolUseIds = message.toolUses.map((tool) => tool.tool_use_id).join(',');
  return hash(`${message.role}\u0000${message.text}\u0000${toolUseIds}`);
}

/**
 * Mutation-proof defect (brief-s4a-gate.md deliverable 3, "seed re-captured"): never skips a
 * seed, so a seed message round-trips into a capture record as ordinary user origin. Every
 * other extractor rule below is implemented so the rest of the family still discriminates on
 * this one defect instead of failing wholesale.
 */
export function isSeedMessage(): boolean {
  return false;
}

const SECRET_PATTERN = /sk-[A-Za-z0-9]{16,}/g;
const VALUE_PATTERN = /^VALUE key=([^:]+):\s*(.*)$/s;
const TODO_PATTERN = /^TODO id=([^\s]+)(?: status=([^\s]+))?( CLEARED)?$/;

function redact(text: string): string {
  return text.replace(SECRET_PATTERN, '[redacted]');
}

function toRecord(message: SessionMessage, hash: (s: string) => string): CaptureRecord | null {
  const sourceHash = contentIdentity(message, hash);
  if (message.role === 'user') {
    const valueMatch = VALUE_PATTERN.exec(message.text);
    if (valueMatch) {
      const [, key, content] = valueMatch;
      return {
        kind: 'value',
        origin: 'reconcile',
        producedBy: 's4-capture',
        body: { key: key.trim(), content: redact(content) },
        sourceHash,
      };
    }
    const todoMatch = TODO_PATTERN.exec(message.text);
    if (todoMatch) {
      const [, id, status, cleared] = todoMatch;
      return {
        kind: 'todo',
        origin: 'reconcile',
        producedBy: 's4-capture',
        body: { id, status: cleared ? 'cleared' : status ?? 'pending' },
        sourceHash,
      };
    }
  }
  for (const result of message.toolResults ?? []) {
    if (result.isError) {
      return {
        kind: 'error',
        origin: 'reconcile',
        producedBy: 's4-capture',
        body: { tool_use_id: result.tool_use_id, text: result.text, isError: true },
        sourceHash,
      };
    }
  }
  return null;
}

/** Folds same-key value/todo records to the latest one, dropping a todo marked CLEARED entirely. */
function fold(records: CaptureRecord[]): CaptureRecord[] {
  const byKey = new Map<string, CaptureRecord>();
  const order: string[] = [];
  for (const record of records) {
    if (record.kind === 'value' || record.kind === 'todo') {
      const key = `${record.kind}:${record.body.key ?? record.body.id}`;
      if (!byKey.has(key)) order.push(key);
      byKey.set(key, record);
    } else {
      const key = `${record.kind}:${order.length}:${record.sourceHash}`;
      order.push(key);
      byKey.set(key, record);
    }
  }
  return order
    .map((key) => byKey.get(key)!)
    .filter((record) => !(record.kind === 'todo' && record.body.status === 'cleared'));
}

export function reconcile(
  messages: readonly SessionMessage[],
  watermark: ContentWatermark | null,
  deps: ExtractorDeps,
): ExtractorResult {
  const ids = messages.map((message) => contentIdentity(message, deps.hash));
  const startIndex = watermark ? ids.lastIndexOf(watermark.sha256) + 1 : 0;
  const records: CaptureRecord[] = [];
  for (let i = startIndex; i < messages.length; i += 1) {
    const record = toRecord(messages[i], deps.hash);
    if (record) records.push(record);
  }
  const newWatermark = ids.length > 0 ? { sha256: ids[ids.length - 1] } : watermark ?? { sha256: '' };
  return { records: fold(records), watermark: newWatermark };
}
