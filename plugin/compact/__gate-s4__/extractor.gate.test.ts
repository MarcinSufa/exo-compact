import { describe, it, expect, beforeAll } from 'vitest';
import { loadImpl } from './impl.js';
import { assistantCall, assistantText, humanPrompt, sha256, toolResultsMessage } from './fixtures/helpers.js';
import { SEED_SENTINEL, omittedHistoryMarker } from '../core/sentinel.js';
import type { SessionMessage, ContentWatermark } from '../core/types.js';
import type { reconcile as Reconcile, isSeedMessage as IsSeedMessage } from '../core/extractor.js';

let reconcile: typeof Reconcile;
let isSeedMessage: typeof IsSeedMessage;

beforeAll(async () => {
  ({ reconcile, isSeedMessage } = await loadImpl<{ reconcile: typeof Reconcile; isSeedMessage: typeof IsSeedMessage }>(
    'extractor',
  ));
});

const deps = { hash: sha256 };

function seedMessage(): SessionMessage {
  return humanPrompt(`${SEED_SENTINEL}\ncontract...\n${omittedHistoryMarker(40)}`);
}

describe('extractor: seed sentinel', () => {
  it('isSeedMessage is true for a message starting with the sentinel', () => {
    expect(isSeedMessage(seedMessage())).toBe(true);
  });

  it('reconcile never produces a record whose sourceHash traces back to the seed message', () => {
    const seed = seedMessage();
    const messages: SessionMessage[] = [seed, humanPrompt('a real user value')];
    const result = reconcile(messages, null, deps);
    const seedRecord = result.records.find((r) => JSON.stringify(r.body).includes(SEED_SENTINEL));
    expect(seedRecord, 'a seed must never be captured as a user-origin record').toBeUndefined();
  });
});

describe('extractor: reads text, not result', () => {
  it('an error tool result is captured from .text, ignoring a populated .result field', () => {
    const message: SessionMessage = {
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: 'toolu_1', text: 'real stderr tail', isError: true, result: 'THIS MUST BE IGNORED' }],
    };
    const result = reconcile([message], null, deps);
    const record = result.records.find((r) => r.kind === 'error');
    expect(record?.body.text).toBe('real stderr tail');
  });
});

describe('extractor: idempotence and watermark', () => {
  it('running reconcile twice from the same watermark yields the same records', () => {
    const messages: SessionMessage[] = [humanPrompt('VALUE key=budget: 6000 tokens')];
    const first = reconcile(messages, null, deps);
    const second = reconcile(messages, null, deps);
    expect(second.records).toEqual(first.records);
  });

  it('reconciling again from the resulting watermark yields no new records (no double-capture)', () => {
    const messages: SessionMessage[] = [humanPrompt('VALUE key=budget: 6000 tokens')];
    const first = reconcile(messages, null, deps);
    const second = reconcile(messages, first.watermark, deps);
    expect(second.records).toEqual([]);
  });

  it('the watermark is a content identity, not an index: prepending unrelated history does not change it', () => {
    const tail: SessionMessage[] = [humanPrompt('VALUE key=budget: 6000 tokens')];
    const withoutPrefix = reconcile(tail, null, deps);
    const withPrefix = reconcile([assistantText('unrelated older turn'), ...tail], null, deps);
    expect(withoutPrefix.watermark satisfies ContentWatermark).toBeTruthy();
    expect(withPrefix.records.map((r) => r.body)).toEqual(
      expect.arrayContaining(withoutPrefix.records.map((r) => r.body)),
    );
  });

  it('survives two compactions plus a restart: a fresh deps object and only the persisted watermark carry state', () => {
    const firstBatch: SessionMessage[] = [humanPrompt('VALUE key=a: one')];
    const afterFirst = reconcile(firstBatch, null, { hash: sha256 });
    const secondBatch: SessionMessage[] = [...firstBatch, humanPrompt('VALUE key=b: two')];
    const afterSecond = reconcile(secondBatch, afterFirst.watermark, { hash: sha256 });
    const thirdBatchAfterRestart: SessionMessage[] = [...secondBatch, humanPrompt('VALUE key=c: three')];
    const afterRestart = reconcile(thirdBatchAfterRestart, afterSecond.watermark, { hash: sha256 });
    expect(afterRestart.records).toHaveLength(1);
    expect(afterRestart.records[0].body).toEqual({ key: 'c', content: 'three' });
  });
});

describe('extractor: redaction', () => {
  it('a secret-shaped value is redacted out of the captured body', () => {
    const messages: SessionMessage[] = [humanPrompt('VALUE key=api: token sk-ABCDEFGHIJ0123456789 in use')];
    const result = reconcile(messages, null, deps);
    const record = result.records.find((r) => r.kind === 'value');
    expect(String(record?.body.content)).not.toContain('sk-ABCDEFGHIJ0123456789');
  });
});

describe('extractor: corrected values', () => {
  it('a later value for the same key supersedes the earlier one, not both', () => {
    const messages: SessionMessage[] = [
      humanPrompt('VALUE key=port: 5003'),
      humanPrompt('VALUE key=port: 5432 (corrected)'),
    ];
    const result = reconcile(messages, null, deps);
    const portRecords = result.records.filter((r) => r.kind === 'value' && r.body.key === 'port');
    expect(portRecords).toHaveLength(1);
    expect(portRecords[0].body.content).toContain('5432');
  });
});

describe('extractor: watermark position among identical-content messages (round 7 D1)', () => {
  it('a watermark on the first of two identically-worded assistant closers still finds the first one, not the newest matching text', () => {
    const turn1Done = assistantText('Done.');
    const afterTurn1 = reconcile([humanPrompt('do the first thing'), turn1Done], null, deps);
    const messages: SessionMessage[] = [
      humanPrompt('do the first thing'),
      turn1Done,
      humanPrompt('VALUE key=port: 5432'),
      humanPrompt('now deploy to staging'),
      assistantText('Done.'),
    ];
    const result = reconcile(messages, afterTurn1.watermark, deps);
    const value = result.records.find((r) => r.kind === 'value');
    const deploy = result.records.find((r) => r.kind === 'user' && r.body.text === 'now deploy to staging');
    expect(value, 'a naive lastIndexOf on content identity finds the second, later Done. and skips everything before it, losing this VALUE').toBeDefined();
    expect(value?.body).toEqual({ key: 'port', content: '5432' });
    expect(deploy, 'the plain instruction between the two identical Done. closers must also be captured').toBeDefined();
  });

  it('a watermark on the 2nd of 3 identical closers is found at that position, not the 1st (round 8 finding 11: kills a match-first-identity mutant)', () => {
    const messages: SessionMessage[] = [
      humanPrompt('first thing'),
      assistantText('Done.'),
      humanPrompt('second thing'),
      assistantText('Done.'),
      humanPrompt('third thing'),
      assistantText('Done.'),
    ];
    const afterSecond = reconcile(messages.slice(0, 4), null, deps);
    const result = reconcile(messages, afterSecond.watermark, deps);
    const third = result.records.find((r) => r.kind === 'user' && r.body.text === 'third thing');
    expect(third, 'a watermark matched at the wrong (earlier) occurrence of "Done." would recapture "second thing" and "third thing" both; only "third thing" is new').toBeDefined();
    expect(result.records.some((r) => r.body.text === 'second thing'), 'the watermark must resolve to after the 2nd Done., not the 1st, so "second thing" is not recaptured').toBe(false);
  });

  it('a 2-identity suffix is not enough: a coincidental repeat of the last 2 identities earlier in the same list must not be mistaken for the boundary (round 9 finding 9: kills a K=2 mutant)', () => {
    // identities: [go, Done., other, go, Done.] - the last TWO identities ("go", "Done.") also
    // occur, as a pair, at the very start of the list. A watermark of length 2 would match that
    // earliest pair first (the leftmost-match rule) and stop there, wrongly recapturing "other".
    // A watermark of length 3 ("other", "go", "Done.") is unique to the true end and cannot.
    const messages: SessionMessage[] = [humanPrompt('go'), assistantText('Done.'), humanPrompt('other'), humanPrompt('go'), assistantText('Done.')];
    const saved = reconcile(messages, null, deps);
    const grown: SessionMessage[] = [...messages, humanPrompt('VALUE key=x: 1'), assistantText('ok')];
    const result = reconcile(grown, saved.watermark, deps);
    expect(result.records.some((r) => r.kind === 'user' && r.body.text === 'other'), 'a K=2 watermark would match the earlier "go"/"Done." pair at the start of the list and recapture "other", which was already captured by the first reconcile call').toBe(false);
    expect(result.records.some((r) => r.kind === 'value'), 'the genuinely new VALUE after the true boundary must still be captured').toBe(true);
  });
});

describe('extractor: content identity must include tool result content (finding 2)', () => {
  function toolResultShape(id: string, text: string, isError = false): SessionMessage {
    return { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError }] };
  }

  it('two distinct tool errors in one session are both captured, not folded into one', () => {
    const messages: SessionMessage[] = [
      toolResultShape('toolu_1', 'first error: disk full', true),
      assistantText('retrying'),
      toolResultShape('toolu_2', 'second error: permission denied', true),
    ];
    const result = reconcile(messages, null, deps);
    const errors = result.records.filter((r) => r.kind === 'error');
    expect(errors).toHaveLength(2);
    expect(errors.map((r) => r.body.text)).toEqual(
      expect.arrayContaining(['first error: disk full', 'second error: permission denied']),
    );
  });

  it('a watermark left on a tool-result message does not skip the assistant_text/user records that follow it, even when a later tool-result message has the same (colliding) content identity', () => {
    const first = toolResultShape('toolu_a', 'ok');
    const messages: SessionMessage[] = [
      first,
      assistantText('note about the first tool result'),
      humanPrompt('VALUE key=x: 1'),
      toolResultShape('toolu_b', 'ok'),
    ];
    const afterFirst = reconcile([first], null, deps);
    const result = reconcile(messages, afterFirst.watermark, deps);
    expect(result.records.some((r) => r.kind === 'assistant_text')).toBe(true);
    expect(result.records.some((r) => r.kind === 'value')).toBe(true);
  });
});

describe('extractor: watermark absent from the current message list (finding 7 / round 7 N2, post-core-fallback shape)', () => {
  it('never captures the leading unrecognized message (the core-fallback boundary) as a user record, even though it is shaped like a human prompt', () => {
    const stale: ContentWatermark = { identities: ['does-not-exist-in-this-list'] };
    const messages: SessionMessage[] = [
      { role: 'user', text: 'Prior conversation summary: did X, then Y, then Z.', toolUses: [] },
    ];
    const result = reconcile(messages, stale, deps);
    const summaryRecord = result.records.find((r) => String(r.body.text ?? '').includes('Prior conversation summary'));
    expect(summaryRecord, 'the core summary boundary message must never be captured as a user record').toBeUndefined();
    expect(result.watermark.identities).not.toEqual(stale.identities);
  });

  it('the runtime never calls reconcile twice for this: one turn.complete over [core summary, VALUE, assistant Done] with the stale watermark captures the VALUE in that same call (round 7 N2)', () => {
    const stale: ContentWatermark = { identities: ['gone-after-core-compaction'] };
    const summary: SessionMessage = { role: 'user', text: 'Prior conversation summary: did X, then Y, then Z.', toolUses: [] };
    const messages: SessionMessage[] = [summary, humanPrompt('VALUE key=db: postgres-16'), assistantText('Done.')];
    const result = reconcile(messages, stale, deps);
    const value = result.records.find((r) => r.kind === 'value');
    expect(value, 'the VALUE that arrives in the same turn as the post-fallback summary must be captured, not lost').toBeDefined();
    expect(value?.body).toEqual({ key: 'db', content: 'postgres-16' });
    expect(result.records.some((r) => r.kind === 'user' && String(r.body.text ?? '').includes('Prior conversation summary')), 'the summary boundary itself must never be captured as user').toBe(false);
  });

  it('round 8 finding 2 repro: a genuine watermark ending in "Done." does not false-match a post-core-compaction list that also ends in "Done."', () => {
    const before = reconcile([humanPrompt('do the first thing'), assistantText('Done.')], null, deps);
    const summary: SessionMessage = { role: 'user', text: 'Prior conversation summary: did X, then Y, then Z.', toolUses: [] };
    const messages: SessionMessage[] = [summary, humanPrompt('VALUE key=db: postgres-16'), assistantText('Done.')];
    const result = reconcile(messages, before.watermark, deps);
    const value = result.records.find((r) => r.kind === 'value');
    expect(value, 'occurrence-based matching found the old watermark by coincidence at the new closer and dropped this VALUE; a stored watermark from a different list must never match a same-text closer here').toBeDefined();
    expect(value?.body).toEqual({ key: 'db', content: 'postgres-16' });
    expect(result.records.some((r) => r.kind === 'user' && String(r.body.text ?? '').includes('Prior conversation summary'))).toBe(false);
  });
});

describe('extractor: fork-shaped message list with no capture state at all (round 7 D5)', () => {
  it('a fresh store (watermark null) on a forked session does not re-capture the whole parent conversation, only what came after the last seed', () => {
    const seed: SessionMessage = { role: 'user', text: `${SEED_SENTINEL}\ncontract...\n${omittedHistoryMarker(12)}`, toolUses: [] };
    const messages: SessionMessage[] = [
      humanPrompt('old private instruction from the parent session'),
      assistantText('old reply'),
      seed,
      humanPrompt('new instruction after the fork'),
      assistantText('new reply'),
    ];
    const result = reconcile(messages, null, deps);
    expect(
      result.records.some((r) => r.kind === 'user' && String(r.body.text ?? '').includes('old private instruction')),
      'content from before the seed belongs to the parent session and must not flood into the fork\'s own store',
    ).toBe(false);
    expect(
      result.records.some((r) => r.kind === 'user' && String(r.body.text ?? '') === 'new instruction after the fork'),
      'content genuinely new to the forked session must still be captured',
    ).toBe(true);
  });

  it('a genuinely fresh session (no seed anywhere) still captures from the start, unaffected by the fork boundary', () => {
    const messages: SessionMessage[] = [humanPrompt('first ever prompt'), assistantText('first reply')];
    const result = reconcile(messages, null, deps);
    expect(result.records.some((r) => r.kind === 'user' && String(r.body.text ?? '') === 'first ever prompt')).toBe(true);
  });
});

it('retains a cleared todo event so the renderer can supersede an earlier open todo', () => {
  const openMessage = humanPrompt('TODO id=t1 status=in_progress');
  const open = reconcile([openMessage], null, deps);
  const cleared = reconcile([openMessage, humanPrompt('TODO id=t1 CLEARED')], open.watermark, deps);
  expect(cleared.records).toHaveLength(1);
  expect(cleared.records[0].body).toEqual({ id: 't1', status: 'cleared' });
});

describe('extractor: todo update and clear', () => {
  it('a later status update for the same todo id replaces the earlier one', () => {
    const messages: SessionMessage[] = [
      humanPrompt('TODO id=t1 status=pending'),
      humanPrompt('TODO id=t1 status=in_progress'),
    ];
    const result = reconcile(messages, null, deps);
    const t1 = result.records.filter((r) => r.kind === 'todo' && r.body.id === 't1');
    expect(t1).toHaveLength(1);
    expect(t1[0].body.status).toBe('in_progress');
  });

  it('a CLEARED todo is retained as the superseding record', () => {
    const messages: SessionMessage[] = [
      humanPrompt('TODO id=t2 status=in_progress'),
      humanPrompt('TODO id=t2 CLEARED'),
    ];
    const result = reconcile(messages, null, deps);
    expect(result.records.find((r) => r.kind === 'todo' && r.body.id === 't2')?.body.status).toBe('cleared');
  });
});

describe('extractor: S2, CC command wrapper and local-command-output messages are not captured as user records (review-opus-r10.md S2)', () => {
  // Real shapes from review-opus-r10.md S2: confirmed live in the capture stores (G2, G3), a
  // scripted `/compact` (and `/usage`) lands as a plain `role: 'user'` message with no
  // `toolResults`, wrapped in these tags.
  it('a <command-name>/<command-message> wrapper (a scripted /compact) is not captured as kind=user', () => {
    const wrapper = '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>';
    const messages: SessionMessage[] = [humanPrompt(wrapper)];
    const result = reconcile(messages, null, deps);
    expect(result.records.find((r) => r.kind === 'user')).toBeUndefined();
  });

  it('a <local-command-stdout> (the compact confirmation) is not captured as kind=user', () => {
    const messages: SessionMessage[] = [humanPrompt('<local-command-stdout>Compacted 40 messages.</local-command-stdout>')];
    const result = reconcile(messages, null, deps);
    expect(result.records.find((r) => r.kind === 'user')).toBeUndefined();
  });

  it('a <command-args> wrapper is not captured as kind=user', () => {
    const messages: SessionMessage[] = [humanPrompt('<command-args>--foo</command-args>')];
    const result = reconcile(messages, null, deps);
    expect(result.records.find((r) => r.kind === 'user')).toBeUndefined();
  });

  it('a real user instruction in the same batch is still captured (only the wrapper is skipped)', () => {
    const messages: SessionMessage[] = [
      humanPrompt('<command-name>/compact</command-name>\n<command-message>compact</command-message>'),
      humanPrompt('You must never delete the staging database.'),
    ];
    const result = reconcile(messages, null, deps);
    const userRecords = result.records.filter((r) => r.kind === 'user');
    expect(userRecords).toHaveLength(1);
    expect(userRecords[0].body.text).toContain('never delete the staging database');
  });

  it('a plain user message that only mentions the tag name in prose (not as the opening wrapper) is still captured', () => {
    const messages: SessionMessage[] = [humanPrompt('Please do not rely on <command-name> tags in your own output.')];
    const result = reconcile(messages, null, deps);
    expect(result.records.find((r) => r.kind === 'user')).toBeDefined();
  });
});

describe('extractor: round 17 (brief-s4a-fix17.md), Write/Edit tool_use input is captured as kind=file_write', () => {
  it('a Write call\'s input.content becomes a file_write record', () => {
    const call = assistantCall('Write', { input: { file_path: '/tmp/notes.txt', content: 'Ticket: KESTREL-9. Owner: Alice Morgan.' } });
    const messages: SessionMessage[] = [call];
    const result = reconcile(messages, null, deps);
    const record = result.records.find((r) => r.kind === 'file_write');
    expect(record).toBeDefined();
    expect(record!.body.text).toBe('Ticket: KESTREL-9. Owner: Alice Morgan.');
    expect(record!.body.tool).toBe('Write');
    expect(record!.body.tool_use_id).toBe(call.toolUses[0].tool_use_id);
  });

  it('an Edit call\'s input.new_string becomes a file_write record, not input.old_string', () => {
    const call = assistantCall('Edit', { input: { file_path: '/tmp/notes.txt', old_string: 'Deadline: 2026-11-19.', new_string: 'Deadline: 2026-11-25.' } });
    const result = reconcile([call], null, deps);
    const record = result.records.find((r) => r.kind === 'file_write');
    expect(record).toBeDefined();
    expect(record!.body.text).toBe('Deadline: 2026-11-25.');
    expect(String(record!.body.text)).not.toContain('2026-11-19');
  });

  it('a tool other than Write/Edit never produces a file_write record', () => {
    const call = assistantCall('Bash', { input: { command: 'echo Ticket: KESTREL-9' } });
    const result = reconcile([call], null, deps);
    expect(result.records.find((r) => r.kind === 'file_write')).toBeUndefined();
  });

  it('a tool RESULT (a Read call\'s returned content), never a tool_use input, is never captured as file_write -- results are not a key-facts source (brief-s4a-fix17.md item 1)', () => {
    const call = assistantCall('Read', { input: { file_path: '/tmp/notes.txt' } });
    const result = toolResultsMessage([{ toolUseId: call.toolUses[0].tool_use_id, options: { text: 'Ticket: KESTREL-9. Owner: Alice Morgan.' } }]);
    const messages: SessionMessage[] = [call, result];
    const extracted = reconcile(messages, null, deps);
    expect(extracted.records.find((r) => r.kind === 'file_write')).toBeUndefined();
  });

  it('an empty Write content produces no file_write record', () => {
    const call = assistantCall('Write', { input: { file_path: '/tmp/notes.txt', content: '' } });
    const result = reconcile([call], null, deps);
    expect(result.records.find((r) => r.kind === 'file_write')).toBeUndefined();
  });

  it('two Write calls with distinct tool_use_id are both captured, not folded together', () => {
    const first = assistantCall('Write', { input: { file_path: '/tmp/a.txt', content: 'Ticket: KESTREL-9.' } });
    const second = assistantCall('Write', { input: { file_path: '/tmp/b.txt', content: 'Owner: Alice Morgan.' } });
    const result = reconcile([first, second], null, deps);
    const records = result.records.filter((r) => r.kind === 'file_write');
    expect(records).toHaveLength(2);
  });

  it('reconcile stays idempotent: replaying the same Write call from the resulting watermark yields no new file_write record', () => {
    const call = assistantCall('Write', { input: { file_path: '/tmp/notes.txt', content: 'Ticket: KESTREL-9.' } });
    const messages: SessionMessage[] = [humanPrompt('turn 1'), assistantText('ack'), humanPrompt('turn 2'), call];
    const first = reconcile(messages, null, deps);
    const second = reconcile(messages, first.watermark, deps);
    expect(second.records.find((r) => r.kind === 'file_write')).toBeUndefined();
  });
});

describe('extractor: round 18 (brief-s4a-fix18.md F2/F3), secret-path denylist, broader redaction, prose-only capture, per-write cap', () => {
  // Fake data only: `file_path` here is a plain string field on a synthetic tool_use, never an
  // actual filesystem read or write by this module or this test (`core/extractor.ts` reconciles
  // already-parsed session messages, it never touches disk) -- no real .env, settings or key file
  // anywhere is read to build or run this test.
  //
  // Round 19 (brief-s4a-fix19.md F13, review-opus-r18.md finding F13): the `.env` test and the
  // denylist `it.each` below used to pass under `S4_GATE_IMPL=broken` for the wrong reason --
  // `broken/extractor.ts` never produces a `file_write` record AT ALL, for any path, so
  // `.find(...).toBeUndefined()` was true vacuously, not because the denylist worked. Both now also
  // Write to an allowed control path in the same call and assert exactly one `file_write` record
  // survives, from that control write: under the real implementation the denied path still produces
  // nothing and the control still does; under `broken`, the control write also produces nothing, so
  // `toHaveLength(1)` now fails there as it should.
  it('a Write targeting a fake .env path produces no file_write record at all: nothing secret reaches the capture store', () => {
    const denied = assistantCall('Write', {
      input: {
        file_path: '/project/.env',
        content: 'DATABASE_URL=postgres://admin:S3cretPass@db.internal:5432/app\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLE\n',
      },
    });
    const allowed = assistantCall('Write', { input: { file_path: '/project/notes.md', content: 'Ticket: KESTREL-9.' } });
    const result = reconcile([denied, allowed], null, deps);
    const records = result.records.filter((r) => r.kind === 'file_write');
    expect(records, 'exactly one file_write record must survive, from the allowed control write').toHaveLength(1);
    expect(records[0].body.tool_use_id).toBe(allowed.toolUses[0].tool_use_id);
    expect(JSON.stringify(result.records)).not.toContain('S3cretPass');
    expect(JSON.stringify(result.records)).not.toContain('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLE');
  });

  it.each([
    '/project/.env.local',
    '/project/id_rsa',
    '/project/server.pem',
    '/project/credentials.json',
    '/project/.npmrc',
    '/project/settings.local.json',
    // Round 19 (brief-s4a-fix19.md F11, review-opus-r18.md finding F11): previously missed key
    // types and file shapes.
    '/home/user/.ssh/id_ed25519',
    '/home/user/.ssh/id_ecdsa',
    '/home/user/.pgpass',
    '/project/certs/prod.keystore',
    '/project/tokens.txt',
    '/project/service-account-prod.json',
  ])('a Write targeting %s is denied regardless of its content', (filePath) => {
    const denied = assistantCall('Write', { input: { file_path: filePath, content: 'Owner: Alice Morgan. Deadline: 2026-11-19.' } });
    const allowed = assistantCall('Write', { input: { file_path: '/project/notes.md', content: 'Owner: Alice Morgan.' } });
    const result = reconcile([denied, allowed], null, deps);
    const records = result.records.filter((r) => r.kind === 'file_write');
    expect(records, 'exactly one file_write record must survive, from the allowed control write').toHaveLength(1);
    expect(records[0].body.tool_use_id).toBe(allowed.toolUses[0].tool_use_id);
  });

  it('an id_rsa.pub / id_ed25519.pub PUBLIC key basename is also denied (same as the pre-existing id_rsa behavior, which never distinguished private from public)', () => {
    const call = assistantCall('Write', { input: { file_path: '/home/user/.ssh/id_ed25519.pub', content: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLE user@host' } });
    const result = reconcile([call], null, deps);
    expect(result.records.find((r) => r.kind === 'file_write')).toBeUndefined();
  });

  it('a secret-shaped assignment in an otherwise-allowed prose file is redacted, not captured verbatim', () => {
    const call = assistantCall('Write', {
      input: { file_path: '/tmp/handoff.txt', content: 'Ticket: KESTREL-9. api_key=sk-abcdefghij0123456789 for the staging integration.' },
    });
    const result = reconcile([call], null, deps);
    const record = result.records.find((r) => r.kind === 'file_write');
    expect(record).toBeDefined();
    expect(record!.body.text).toContain('KESTREL-9');
    expect(record!.body.text).not.toContain('sk-abcdefghij0123456789');
    expect(record!.body.text).toContain('[redacted]');
  });

  // Round 19 (brief-s4a-fix19.md F11, review-opus-r18.md finding F11): the 4000-char cap used to
  // run BEFORE redaction, so a PEM block long enough to push the whole write past 4000 characters
  // could get its `-----END...-----` marker cut off by the cap before the PEM pattern ever saw it,
  // leaving the (still very much secret) key body sitting in the capped text, unredacted. Synthetic
  // PEM body only -- not a real key, never read from disk.
  it('a PEM private key inside a .md file over the 4000-character cap is still fully redacted, not leaked by capping before redaction', () => {
    const fakeKeyBody = Array.from({ length: 100 }, (_, i) => `ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ${i}`).join('\n');
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${fakeKeyBody}\n-----END RSA PRIVATE KEY-----`;
    expect(pem.length).toBeGreaterThan(4000);
    const call = assistantCall('Write', { input: { file_path: '/notes/handoff.md', content: `Ticket: KESTREL-9.\n${pem}\n` } });
    const result = reconcile([call], null, deps);
    const record = result.records.find((r) => r.kind === 'file_write');
    expect(record).toBeDefined();
    expect(record!.body.text).toContain('KESTREL-9');
    expect(record!.body.text).toContain('[redacted]');
    expect(record!.body.text).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(record!.body.text).not.toContain('ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ0');
  });

  // Round 19 (brief-s4a-fix19.md F16, review-opus-r18.md finding F16): the generic secret-assignment
  // pattern used to match the keyword anywhere inside a longer identifier, so ordinary non-secret
  // shapes were wrongly redacted. These must all survive untouched; the last one confirms a real
  // secret is still caught (the keyword IS the whole trailing identifier, immediately before `:`).
  it.each([
    'Budget in tokens: 6000.',
    'max_tokens: 4096.',
    'tokenizer: tiktoken.',
    'secretary: Anna Nowak.',
  ])('%s is not redacted (not a real secret shape)', (text) => {
    const call = assistantCall('Write', { input: { file_path: '/tmp/handoff.txt', content: text } });
    const result = reconcile([call], null, deps);
    const record = result.records.find((r) => r.kind === 'file_write');
    expect(record).toBeDefined();
    expect(record!.body.text).toBe(text);
    expect(record!.body.text).not.toContain('[redacted]');
  });

  it('a real secret: assignment is still redacted even after the F16 boundary fix', () => {
    // The value pattern captures one whitespace-delimited token (`\S+`), same as before this
    // round, so the synthetic secret value here is a single token, not a multi-word phrase.
    const call = assistantCall('Write', { input: { file_path: '/tmp/handoff.txt', content: 'secret: marmalade-fjord-x9k2.' } });
    const result = reconcile([call], null, deps);
    const record = result.records.find((r) => r.kind === 'file_write');
    expect(record).toBeDefined();
    expect(record!.body.text).toContain('[redacted]');
    expect(record!.body.text).not.toContain('marmalade-fjord-x9k2');
  });

  it('a Write targeting a code file (non-prose extension, code-shaped content) is not captured', () => {
    const denied = assistantCall('Write', {
      input: { file_path: '/project/src/config.ts', content: "export const PORT = 4821;\nexport const OWNER = 'Alice Morgan';\n" },
    });
    const allowed = assistantCall('Write', { input: { file_path: '/project/notes.md', content: 'Owner: Alice Morgan.' } });
    const result = reconcile([denied, allowed], null, deps);
    const records = result.records.filter((r) => r.kind === 'file_write');
    expect(records, 'exactly one file_write record must survive, from the allowed control write').toHaveLength(1);
    expect(records[0].body.tool_use_id).toBe(allowed.toolUses[0].tool_use_id);
  });

  it('a Write with no file_path at all still falls back to a content-based prose check and is captured when the content reads like prose', () => {
    const call = assistantCall('Write', { input: { content: 'Ticket: KESTREL-9. Owner: Alice Morgan.' } });
    const result = reconcile([call], null, deps);
    expect(result.records.find((r) => r.kind === 'file_write')).toBeDefined();
  });

  // Round 19 (brief-s4a-fix19.md F12, review-opus-r18.md finding F12): before this round,
  // `isProseLikeWrite` returned `true` unconditionally for ANY path-less or extensionless write, so
  // this content-based check never actually ran for either shape below.
  // These two also carry a control write (same "gate honesty" reasoning as the F13 restructuring
  // above): `broken/extractor.ts` never produces a file_write record for anything, so a bare
  // `toBeUndefined()` here would pass vacuously under `S4_GATE_IMPL=broken` too.
  it('a Write with no file_path at all and code-shaped content is NOT captured (path-less writes must go through the prose check too)', () => {
    const denied = assistantCall('Write', { input: { content: "export const PORT = 4821;\nexport const OWNER = 'Alice Morgan';\n" } });
    const allowed = assistantCall('Write', { input: { file_path: '/project/notes.md', content: 'Owner: Alice Morgan.' } });
    const result = reconcile([denied, allowed], null, deps);
    const records = result.records.filter((r) => r.kind === 'file_write');
    expect(records, 'exactly one file_write record must survive, from the allowed control write').toHaveLength(1);
    expect(records[0].body.tool_use_id).toBe(allowed.toolUses[0].tool_use_id);
  });

  it('a Write to an extensionless file (e.g. Makefile) with code-shaped content is NOT captured', () => {
    const denied = assistantCall('Write', { input: { file_path: '/project/Makefile', content: 'export PATH=/usr/bin:$PATH\n' } });
    const allowed = assistantCall('Write', { input: { file_path: '/project/notes.md', content: 'Owner: Alice Morgan.' } });
    const result = reconcile([denied, allowed], null, deps);
    const records = result.records.filter((r) => r.kind === 'file_write');
    expect(records, 'exactly one file_write record must survive, from the allowed control write').toHaveLength(1);
    expect(records[0].body.tool_use_id).toBe(allowed.toolUses[0].tool_use_id);
  });

  it('a Write to an extensionless file (e.g. NOTES) with prose content is still captured (extensionless is not an automatic pass, but it is not an automatic reject either)', () => {
    const call = assistantCall('Write', { input: { file_path: '/project/NOTES', content: 'Ticket: KESTREL-9. Owner: Alice Morgan.' } });
    const result = reconcile([call], null, deps);
    expect(result.records.find((r) => r.kind === 'file_write')).toBeDefined();
  });

  it('a Write to a .md file with code-shaped content is still captured (extension alone is enough for the prose-like check)', () => {
    const call = assistantCall('Write', { input: { file_path: '/project/notes.md', content: 'export const PORT = 4821;\n' } });
    const result = reconcile([call], null, deps);
    expect(result.records.find((r) => r.kind === 'file_write')).toBeDefined();
  });

  it('a Write whose content is over the 4000-character cap is truncated, not dropped', () => {
    const longContent = `${'Owner: Alice Morgan. '.repeat(200)}`;
    expect(longContent.length).toBeGreaterThan(4000);
    const call = assistantCall('Write', { input: { file_path: '/tmp/long-notes.txt', content: longContent } });
    const result = reconcile([call], null, deps);
    const record = result.records.find((r) => r.kind === 'file_write');
    expect(record).toBeDefined();
    expect(String(record!.body.text).length).toBeLessThanOrEqual(4000);
    expect(record!.body.text).toContain('[truncated]');
  });
});
