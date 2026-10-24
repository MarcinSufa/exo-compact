/**
 * Host-side derivation of "the project transcript dir" (spec §3.1.2's fallback branch), used
 * only when no run-log-recorded `transcript_path` is available (see CONTRACT.md's S4d section:
 * that is always the case today). This is a path-construction concern, not pure logic, so it
 * lives in `host/`, not `core/` (CONTRACT.md's core/host split).
 */
export interface TranscriptPathHost {
  cwd: () => Promise<string>;
  /** `$.env.get('HOME')`; undefined/empty when unavailable. */
  home: () => Promise<string | undefined>;
  /** 4.7.0: `$.env.get('CLAUDE_CONFIG_DIR')`; when set, Claude Code's `projects/` is under it instead of `<home>/.claude`. */
  configDir?: () => Promise<string | undefined>;
}

/** The directory holding the per-project transcript dirs, or null when neither CLAUDE_CONFIG_DIR nor a home is known. */
async function projectsRoot(host: TranscriptPathHost): Promise<string | null> {
  const configDir = host.configDir ? await host.configDir() : undefined;
  if (configDir) return `${configDir.replace(/[\\/]+$/, '')}/projects`;
  const home = await host.home();
  return home ? `${home}/.claude/projects` : null;
}

/**
 * Best-effort guess at Claude Code's on-disk transcript layout
 * (`<home>/.claude/projects/<cwd, "/" -> "-">/<session-id>.jsonl`). Uncertain: `cc.d.ts:2293`
 * documents `$.session.id()` as "the transcript file's name" but never states the directory's
 * naming convention, and a live probe to confirm it is out of scope for this slice (brief-s4d.md
 * forbids live probes). If this guess is wrong on a real install, `compact.ts`'s own
 * `$.fs.exists` check on the result fails closed: the pointer is omitted and
 * `seed.transcript_pointer=missing` is logged (spec §3.1.2), never a broken path shown to the
 * model. Returns null when `HOME` is unavailable (nothing to derive from).
 */
export async function derivedTranscriptPath(host: TranscriptPathHost, sessionId: string): Promise<string | null> {
  const root = await projectsRoot(host);
  if (root === null) return null;
  const cwd = await host.cwd();
  const sanitizedCwd = cwd.replace(/[^A-Za-z0-9]/g, '-');
  return `${root}/${sanitizedCwd}/${sessionId}.jsonl`;
}

export interface TranscriptFs {
  exists: (path: string) => Promise<boolean>;
  /** Entry names under `path` (`$.fs.list`); only directories are looked into. */
  list: (path: string) => Promise<readonly { name: string; kind: string }[]>;
}

/**
 * S4i: `$.session.cwd()` follows the session's `cd`s, so once the agent works in another
 * directory the derived path points at a project dir the transcript is not in (seen live: seed
 * with no Transcript section and no recall index after `cd ~/work/proj/voice`). Tries the
 * derived path first, then `<home>/.claude/projects/*\/<session-id>.jsonl`. Null when neither
 * exists or anything throws.
 */
export async function findTranscriptPath(host: TranscriptPathHost, sessionId: string, fs: TranscriptFs): Promise<string | null> {
  try {
    const derived = await derivedTranscriptPath(host, sessionId);
    if (derived === null) return null;
    if (await fs.exists(derived)) return derived;
    const root = derived.slice(0, derived.lastIndexOf('/', derived.lastIndexOf('/') - 1));
    // In parallel: one exists check per project dir, and there can be hundreds.
    const candidates = (await fs.list(root)).filter((entry) => entry.kind === 'dir').map((entry) => `${root}/${entry.name}/${sessionId}.jsonl`);
    const found = await Promise.all(candidates.map(async (candidate) => ((await fs.exists(candidate)) ? candidate : null)));
    return found.find((candidate) => candidate !== null) ?? null;
  } catch { /* fail closed like the derived-only path */ }
  return null;
}
