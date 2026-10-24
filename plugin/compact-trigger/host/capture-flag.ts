/**
 * Round 11: flattened from `{ session: { cwd }, fs: { exists } }` to a plain two-closure shape.
 * The hook compiler's `$` spelling rule (CONTRACT.md's S4 spelling section) forbids passing the
 * real hook `$` (or a member of it, e.g. `$.fs`) into an imported function at all; every call site
 * now builds this object in-file with `$` spelled directly (`cwd: () => $.session.cwd()`,
 * `exists: (p) => $.fs.exists(p)`) instead of forwarding `$` itself or `$.session`/`$.fs` as a
 * nested value. The flattening is cosmetic (no behavior change) but keeps the object's own shape
 * a plain closure bag, matching `host/fs-adapter.ts`'s `FsLike` convention, rather than mirroring
 * `$`'s own nested `session.cwd`/`fs.exists` shape one level removed.
 *
 * 4.7.6: `root` (spelled `root: () => $.session.root()` at each call site) is the session's project
 * root, which a shell `cd` does not move. It is optional so that hosts and fakes without it keep
 * the working-directory behaviour.
 *
 * This file exists twice, here and as `plugin/compact-trigger/host/capture-flag.ts`, kept
 * byte-identical by hand (CONTRACT.md's S3/S4 mutual exclusion section; `compact-trigger/core/
 * handler.ts`'s header says why it is a copy rather than a cross-plugin import).
 */
export interface FlagHost {
  cwd: () => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  root?: () => Promise<string>;
  /**
   * 4.8.0: the user's home directory (host/home-dir.ts resolveHomeDir). It is the capture root when no flag or opt-out file
   * exists anywhere up either walk, so a plain plugin install is active without any setup step.
   */
  home: () => Promise<string | undefined>;
  /** 4.8.0: true when the SessionStart preflight found Node or Claude Code below the minimum; the session stays inert. */
  inert?: () => boolean;
}

export async function isCaptureEnabled(host: FlagHost): Promise<boolean> {
  return (await findCaptureRoot(host)) !== null;
}

/**
 * The directory that anchors this session's capture, or null when exo-compact is off for it.
 * 3.11.1: a project opts out with `.exovault/s4-compact-off`. Walking up, the nearest directory
 * holding either file decides, so an opt-out in a project beats a flag in the home directory
 * above it (the flag is checked first where both sit in one directory).
 * 4.7.6 (CONTRACT S5r): the walk from the working directory runs first; an opt-out there is final.
 * Then the walk from the session root (when usable) decides on either marker, and only when it
 * finds no marker does the working-directory result stand. A root that is absent, throws, rejects
 * or is not a non-empty string leaves the working-directory result as it was.
 * 4.8.0: installed means enabled. When neither walk finds a flag or an opt-out file the plugin is active and the root is
 * the home directory (where `setup.cjs enable ~` used to put the flag), unless the home directory itself holds an
 * opt-out or cannot be resolved. `setup.cjs disable <dir>` writes the opt-out file, because with no flag required there
 * is no flag left to delete.
 * 4.8.0 (CONTRACT S5r, one-project setup): an opt-out found from the working directory stays final unless the root walk
 * finds a flag in a directory below that opt-out's directory. `disable ~` plus `enable <project>` then survives a shell
 * `cd` elsewhere under the home directory, while a nearer opt-out that does not cover the session root still turns the
 * session off.
 */
export async function findCaptureRoot(host: FlagHost): Promise<string | null> {
  if (host.inert?.()) return null;
  const found = await findMarkerRoot(host);
  if (found !== undefined) return found;
  const home = await host.home();
  if (!home) return null;
  const directory = home.replace(/[\\/]+$/, '') || '/';
  if (await host.exists(`${directory === '/' ? '' : directory}/.exovault/s4-compact-off`)) return null;
  return directory;
}

/** The 4.7.6 two-walk decision: a flag directory, null for an opt-out, undefined when no marker exists on either walk. */
async function findMarkerRoot(host: FlagHost): Promise<string | null | undefined> {
  const cwd = await host.cwd();
  const fromCwd = await walkMarkers(host, cwd);
  const root = await usableRoot(host);
  const fromRoot = root !== undefined && root !== cwd ? await walkMarkers(host, root) : undefined;
  if (fromCwd?.kind === 'off') {
    return fromRoot?.kind === 'active' && isBelow(fromRoot.directory, fromCwd.directory) ? fromRoot.directory : null;
  }
  if (fromRoot !== undefined) return fromRoot.kind === 'active' ? fromRoot.directory : null;
  return fromCwd?.directory;
}

/** True when `child` lies strictly below `parent`; slashes are normalized, and drive-letter and UNC paths compare case-insensitively. */
function isBelow(child: string, parent: string): boolean {
  const normalize = (path: string) => {
    const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^([A-Za-z]:|\/\/)/.test(slashed) ? slashed.toLowerCase() : slashed;
  };
  const base = normalize(parent);
  return normalize(child).startsWith(base === '' ? '/' : `${base}/`);
}

/** The session root when the host has one and it answers with a non-empty string; otherwise undefined. */
export async function usableRoot(host: FlagHost): Promise<string | undefined> {
  if (host.root === undefined) return undefined;
  try {
    const root = await host.root();
    return typeof root === 'string' && root !== '' ? root : undefined;
  } catch {
    return undefined;
  }
}

/** Nearest marker above `start` (`s4-compact-active` is checked first in each directory), undefined for none. */
async function walkMarkers(host: FlagHost, start: string): Promise<{ kind: 'active' | 'off'; directory: string } | undefined> {
  let current = start;
  while (true) {
    const rootDrive = /^[A-Za-z]:[\\/]?$/.test(current) ? `${current.slice(0, 2)}\\` : undefined;
    const trimmed = current.replace(/[\\/]+$/, '');
    const directory = rootDrive ?? (trimmed || '/');
    const separator = /[\\/]$/.test(directory) ? '' : '/';
    if (await host.exists(`${directory}${separator}.exovault/s4-compact-active`)) return { kind: 'active', directory };
    if (await host.exists(`${directory}${separator}.exovault/s4-compact-off`)) return { kind: 'off', directory };
    if (rootDrive) return undefined;
    const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    if (slash < 0) {
      if (/^[A-Za-z]:$/.test(trimmed)) current = `${trimmed}\\`;
      else return undefined;
    } else if (slash === 0) current = trimmed[0];
    else if (slash === 2 && /^[A-Za-z]:/.test(trimmed)) current = `${trimmed.slice(0, 2)}\\`;
    else current = trimmed.slice(0, slash);
  }
}
