import { describe, it, expect, beforeAll } from 'vitest';
import { loadImpl } from './impl.js';
import type {
  TRANSCRIPT_POINTER_INSTRUCTION as TranscriptPointerInstruction,
  renderTranscriptPointer as RenderTranscriptPointer,
  resolveTranscriptPath as ResolveTranscriptPath,
} from '../core/transcript-pointer.js';
import type { derivedTranscriptPath as DerivedTranscriptPath, TranscriptPathHost } from '../host/transcript-path.js';

let TRANSCRIPT_POINTER_INSTRUCTION: typeof TranscriptPointerInstruction;
let renderTranscriptPointer: typeof RenderTranscriptPointer;
let resolveTranscriptPath: typeof ResolveTranscriptPath;
let derivedTranscriptPath: typeof DerivedTranscriptPath;

beforeAll(async () => {
  const [pointerImpl, pathImpl] = await Promise.all([
    loadImpl<{
      TRANSCRIPT_POINTER_INSTRUCTION: typeof TranscriptPointerInstruction;
      renderTranscriptPointer: typeof RenderTranscriptPointer;
      resolveTranscriptPath: typeof ResolveTranscriptPath;
    }>('transcript-pointer'),
    loadImpl<{ derivedTranscriptPath: typeof DerivedTranscriptPath }>('transcript-path'),
  ]);
  ({ TRANSCRIPT_POINTER_INSTRUCTION, renderTranscriptPointer, resolveTranscriptPath } = pointerImpl);
  ({ derivedTranscriptPath } = pathImpl);
});

function host(overrides: Partial<{ cwd: () => Promise<string>; home: () => Promise<string | undefined> }> = {}): TranscriptPathHost {
  return {
    cwd: overrides.cwd ?? (async () => '/workspace/project'),
    home: overrides.home ?? (async () => '/home/u'),
  };
}

describe('resolveTranscriptPath: priority order (spec §3.1.2)', () => {
  it('the run log\'s transcript_path wins when present', () => {
    expect(resolveTranscriptPath('/from/run-log.jsonl', '/derived/path.jsonl')).toBe('/from/run-log.jsonl');
  });

  it('falls through to the derived path when the run log has none', () => {
    expect(resolveTranscriptPath(null, '/derived/path.jsonl')).toBe('/derived/path.jsonl');
  });

  it('is null when neither candidate is available', () => {
    expect(resolveTranscriptPath(null, null)).toBeNull();
  });
});

describe('derivedTranscriptPath: from $.session.id() under the project transcript dir (spec §3.1.2)', () => {
  it('builds a path under HOME using the sanitized cwd and the session id', async () => {
    const path = await derivedTranscriptPath(host({ cwd: async () => '/workspace/project', home: async () => '/home/u' }), 'abc-123');
    expect(path).toBe('/home/u/.claude/projects/-workspace-project/abc-123.jsonl');
  });

  it('returns null when HOME is unavailable, so the caller falls closed rather than guessing', async () => {
    const path = await derivedTranscriptPath(host({ home: async () => undefined }), 'abc-123');
    expect(path).toBeNull();
  });

  it('sanitizes every path separator in the cwd, not just the leading one', async () => {
    const path = await derivedTranscriptPath(host({ cwd: async () => '/a/b/c' }), 'sess');
    expect(path).not.toContain('/a/b/c');
    expect(path).toBe('/home/u/.claude/projects/-a-b-c/sess.jsonl');
  });

  it('maps every non-alphanumeric cwd character to "-", as Claude Code names project dirs', async () => {
    // Observed in ~/.claude/projects: /tmp/claude-1001/-home-u -> -tmp-claude-1001--home-u.
    const path = await derivedTranscriptPath(host({ cwd: async () => '/tmp/x.y_z/-q' }), 'sess');
    expect(path).toBe('/home/u/.claude/projects/-tmp-x-y-z--q/sess.jsonl');
  });
});

describe('renderTranscriptPointer: fixed instruction opens section 7 (spec §3.1.2)', () => {
  it('starts with the absolute path, then the fixed instruction text', () => {
    const text = renderTranscriptPointer('/home/u/.claude/projects/-workspace-project/abc-123.jsonl');
    expect(text.startsWith('/home/u/.claude/projects/-workspace-project/abc-123.jsonl')).toBe(true);
    expect(text).toContain(TRANSCRIPT_POINTER_INSTRUCTION);
  });

  it('keeps the v3.4.6 pointer byte-identical when recall is disabled', () => {
    expect(renderTranscriptPointer('/a/session.jsonl')).toBe(
      '/a/session.jsonl\n\nThis seed is a filtered subset: a fact delivered via a file read or a tool result is not ' +
      'in it. Before answering UNKNOWN or guessing about an earlier detail, Grep this file with a ' +
      'bounded pattern, e.g. `.{0,200}TERM.{0,200}` (lines are very long), content mode, not count mode.',
    );
  });

  it('uses the neutral recall tool instruction only when recall is enabled', () => {
    const text = renderTranscriptPointer('/a/session.jsonl', { sessionId: 'abc' });
    expect(text).toBe(
      '/a/session.jsonl\n\n' +
      'Context note: this seed keeps only part of the earlier session; file contents read earlier, command output, exact values, ids and decisions are searchable with the search_session tool (server recall) using session "abc": ask a short question in plain words and include any specific name you know (a path, an id, a setting). ' +
      'Its short excerpts cost far less than re-reading files, so it is the first place to look for an earlier detail, including before answering UNKNOWN or acting on an earlier setting, value or decision; a later message wins over an older seed fact. ' +
      'The transcript path above is the fallback.',
    );
    expect(text).toContain('search_session tool (server recall) using session "abc"');
    expect(text).toContain('first place to look for an earlier detail');
    expect(text).toContain('a later message wins over an older seed fact');
    expect(text).toContain('before answering UNKNOWN');
    expect(text.slice(text.indexOf('\n\n') + 2).match(/[^.!?]+[.!?]/g)?.length).toBeLessThanOrEqual(3);
    expect(text).not.toContain('Grep');
  });

  it('uses the session recall tool before answering UNKNOWN and keeps transcript fallback available', () => {
    expect(TRANSCRIPT_POINTER_INSTRUCTION).toMatch(/Grep/);
    expect(TRANSCRIPT_POINTER_INSTRUCTION).toMatch(/before answering UNKNOWN/i);
    expect(renderTranscriptPointer('/tmp/session.jsonl')).toContain('Grep this file');
    expect(renderTranscriptPointer('/tmp/session.jsonl', { sessionId: 's1' })).toContain('The transcript path above is the fallback.');
    expect(renderTranscriptPointer('/tmp/session.jsonl', { sessionId: 's1' })).toContain('search_session tool (server recall) using session "s1"');
  });
});

describe('v3.4.6 disabled-path pointer gates', () => {
  it('mentions Grep unconditionally', () => { expect(TRANSCRIPT_POINTER_INSTRUCTION).toMatch(/Grep/); });
  it('is not gated on tool availability', () => {
    expect(TRANSCRIPT_POINTER_INSTRUCTION).not.toMatch(/you have a file search tool/);
    expect(TRANSCRIPT_POINTER_INSTRUCTION).not.toMatch(/Otherwise answer from what is above/);
  });
  it('uses the exact bounded content-mode instruction', () => {
    expect(TRANSCRIPT_POINTER_INSTRUCTION).toContain('.{0,200}TERM.{0,200}');
    expect(TRANSCRIPT_POINTER_INSTRUCTION).toMatch(/content mode/);
    expect(TRANSCRIPT_POINTER_INSTRUCTION).toMatch(/not count mode/);
  });
});
