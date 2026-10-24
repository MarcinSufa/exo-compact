/**
 * Shared shapes for the S4a pure core. No Node imports anywhere in `core/`:
 * hashing and token counting are always injected (spec §3.6, no `node:crypto`
 * or `node:fs` inside a hook module).
 */

export type Role = 'user' | 'assistant';

export interface ToolUseSummary {
  tool_use_id: string;
  tool: string;
  input?: unknown;
  text?: string;
  result?: unknown;
  isError?: boolean;
}

export interface ToolResultSummary {
  tool_use_id: string;
  text: string;
  isError: boolean;
  result?: unknown;
}

/** Mirrors `claude-code`'s `SessionMessage` (cc.d.ts:7470-7496). */
export interface SessionMessage {
  role: Role;
  text: string;
  toolUses: ToolUseSummary[];
  toolResults?: ToolResultSummary[];
  handle?: string;
}

export type TokenCounter = (text: string) => number;
export type Hasher = (text: string) => string;
export type Clock = () => string;

/**
 * A durable content identity (spec §3.2): sha256 of role, text and tool_use ids. A single
 * identity is not a safe watermark on its own (a repeated "Done." or "continue" collides with
 * itself); round 7 D1 tried disambiguating by occurrence count, but that count is only valid
 * against the exact message list it was computed over; a compaction (ours or core's) rewrites
 * that list, so the same occurrence number stops meaning the same message (round 8 findings 1
 * and 2). `identities` is a short run of consecutive content identities (oldest first, up to
 * `WATERMARK_SEQUENCE_LENGTH` of them, see `core/extractor.ts`) ending at the watermark's
 * message: matching the whole run as a contiguous subsequence, searched from the end of the new
 * list, is specific enough that a single repeated closer no longer collides, and general enough
 * to still find the true position after a compaction that preserved that tail verbatim.
 */
export interface ContentWatermark {
  identities: string[];
}

/**
 * v2 rotation-capture spec §3.1/§3.2 and v3.1 §5.1: `user`, `todo`, `value`, `assistant_text`
 * are the hook-captured kinds; `gate`, `error`, `file` are also producible by S4 capture (the
 * prefilter's gate/error/file pointers, §3.2) but share a name with pre-existing S3 records
 * (`gate` itself, plus `intent`, `step`, `pointer`, model-written `decision`/`thread`/
 * `correction`) that are not part of this module's vocabulary at all. Kind alone cannot tell
 * an S4-produced `gate` from an S3 one; see `CaptureRecord.producedBy`.
 *
 * `file_write` (spec v3.3 §3.1.3, round 17, brief-s4a-fix17.md): the short text content of a
 * `Write`/`Edit` tool_use *input* (never a tool result) the session itself made during this
 * session, one of the two sources key-facts extraction reads (the other being `user`). Distinct
 * from `file` (S4d's own file-pointer records, spec §3.2) and from `assistant_text` (selector
 * D's reasoning source, spec §3.3): neither of those is scanned for facts, and mixing this into
 * either would pull it into a section it does not belong in.
 */
export type CaptureKind =
  | 'user'
  | 'todo'
  | 'value'
  | 'assistant_text'
  | 'tool_activity'
  | 'gate'
  | 'error'
  | 'file'
  | 'file_write'
  | 'tool_output'
  | 'work_event';

/**
 * Which capture path produced a record (v2 spec:63, 143; v3.1 §5.1 last bullet). `reconcile`
 * and per-turn capture always produce `'s4-capture'`; `'s3-existing'` only appears in a sync
 * batch, gap-retry resend or outbox replay that also carries pre-existing S3 records loaded
 * from disk (`exovault-hook.cjs:686`), and `sync-exclusion.ts` is what tells the two apart.
 */
export type RecordProvenance = 's4-capture' | 's3-existing';

export interface CaptureRecord {
  kind: CaptureKind;
  origin: 'turn' | 'reconcile';
  producedBy: RecordProvenance;
  body: Record<string, unknown>;
  sourceHash: string;
}

export type CompactTrigger = 'manual' | 'auto' | 'plugin' | 'precompute';

export interface CompactEvent {
  trigger: CompactTrigger;
  agentId?: string;
  instructions?: string;
  messages: readonly SessionMessage[];
}
