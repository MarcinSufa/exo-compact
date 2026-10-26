/**
 * 4.9.2 (CONTRACT S5u): owner-only permissions for the capture store.
 *
 * `$.fs.write` takes no mode, so a capture file or directory follows the umask (observed 664/775: readable by every
 * local user). The hook therefore runs `harden.mjs` (plugin root) through `$.process.run`:
 * - once per capture root per process at session start, before any capture write: `<root>/.exovault` and
 *   `<root>/.exovault/s4-capture` become 0700, which already keeps every session directory below them from other users;
 * - after each turn's capture and each cut's writes: the session directory becomes 0700 and every file in it 0600;
 * - once a held brief is back in the prompt box: `held-brief.md`, the one verbatim copy of a prompt, is deleted.
 *
 * 4.9.2 review (CONTRACT S5u): a run counts only when harden.mjs exits 0, which it does only when every directory it was
 * given is a real, owner-only directory of this user. `makeCaptureGuard` runs it on the store and the session directory
 * of every capture root the hook picks, awaited, before the first capture write under that root (findCaptureRoot's
 * `secure`); a root that fails is not remembered and gets no capture write. Without a trusted plugin root
 * (host/plugin-root.ts) nothing can run, so no root passes. A failed run never fails a hook.
 * `$` never enters this file (the hook compiler's rule): the hook passes closures over its own `$`.
 */
export const HARDEN_TIMEOUT_MS = 5000;

export interface HardenHost {
  /** host/plugin-root.ts trustedPluginRoot, or undefined. */
  pluginRoot: () => string | undefined;
  run: (argv: string[], init: { timeoutMs: number }) => Promise<{ exitCode?: number } | undefined>;
}

export function hardenArgv(pluginRoot: string, root: string, sessionDir?: string, remove?: string): string[] {
  return ['node', `${pluginRoot}/harden.mjs`, root, ...(sessionDir === undefined ? [] : [sessionDir]), ...(sessionDir !== undefined && remove !== undefined ? ['--remove', remove] : [])];
}

/** Runs harden.mjs; true only when it exited 0. Never throws. */
export async function hardenCapture(host: HardenHost, root: string, sessionDir?: string, remove?: string): Promise<boolean> {
  try {
    const pluginRoot = host.pluginRoot();
    if (!pluginRoot) return false;
    const ran = await host.run(hardenArgv(pluginRoot, root, sessionDir, remove), { timeoutMs: HARDEN_TIMEOUT_MS });
    return ran?.exitCode === 0;
  } catch {
    return false;
  }
}

/** `<root>/.exovault` and `<root>/.exovault/s4-capture`: true when both are owner-only directories of this user. */
export function hardenCaptureRoot(host: HardenHost, root: string): Promise<boolean> {
  return hardenCapture(host, root);
}

/** The store and `sessionDir` in it (0600 on its files); true when all three directories are owner-only. */
export function hardenCaptureSession(host: HardenHost, root: string, sessionDir: string, remove?: string): Promise<boolean> {
  return hardenCapture(host, root, sessionDir, remove);
}

export interface CaptureGuard {
  /** Hardens and verifies the store and `sessionDir` once per process; a failure is not remembered, the next call retries. */
  secure: (host: HardenHost, root: string, sessionDir: string) => Promise<boolean>;
}

export function makeCaptureGuard(): CaptureGuard {
  const verified = new Map<string, Promise<boolean>>();
  return {
    secure: (host, root, sessionDir) => {
      const key = `${root}\u0000${sessionDir}`;
      const known = verified.get(key);
      if (known !== undefined) return known;
      const pending = hardenCaptureSession(host, root, sessionDir).then((ok) => { if (!ok) verified.delete(key); return ok; });
      verified.set(key, pending);
      return pending;
    },
  };
}
