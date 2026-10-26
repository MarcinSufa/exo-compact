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
 * Best effort: without a trusted plugin root (host/plugin-root.ts) nothing runs, and a failed run never fails a hook.
 * `$` never enters this file (the hook compiler's rule): the hook passes closures over its own `$`.
 */
export const HARDEN_TIMEOUT_MS = 5000;

export interface HardenHost {
  /** host/plugin-root.ts trustedPluginRoot, or undefined. */
  pluginRoot: () => string | undefined;
  run: (argv: string[], init: { timeoutMs: number }) => Promise<unknown>;
}

export function hardenArgv(pluginRoot: string, root: string, sessionDir?: string, remove?: string): string[] {
  return ['node', `${pluginRoot}/harden.mjs`, root, ...(sessionDir === undefined ? [] : [sessionDir]), ...(sessionDir !== undefined && remove !== undefined ? ['--remove', remove] : [])];
}

/** Runs harden.mjs; true when it ran. Never throws. */
export async function hardenCapture(host: HardenHost, root: string, sessionDir?: string, remove?: string): Promise<boolean> {
  try {
    const pluginRoot = host.pluginRoot();
    if (!pluginRoot) return false;
    await host.run(hardenArgv(pluginRoot, root, sessionDir, remove), { timeoutMs: HARDEN_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}
