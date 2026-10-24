// `root` is the directory holding the `.exovault/s4-compact-active` flag that enabled S4
// (host/capture-flag.ts findCaptureRoot, found from the session root, else the working directory).
// Anchoring there keeps one session's capture in one place when the shell changes directory, and
// out of nested repos. Without a root the path stays relative to the session's working directory.
export function capturePath(sessionId: string, root?: string): string {
  let safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session';
  if (safe === '.' || safe === '..') safe = `session-${safe}`;
  if (root === undefined) return `.exovault/s4-capture/${safe}`;
  const separator = /[\\/]$/.test(root) ? '' : '/';
  return `${root}${separator}.exovault/s4-capture/${safe}`;
}

/** 4.8.1: `<root>/.exovault/.gitignore`, so a project's captures, flags and briefs never show up in `git status`. */
export const CAPTURE_GITIGNORE = '# Written by exo-compact: session captures stay out of git.\n*\n';

/** Writes the .gitignore when it is missing; one the user wrote is kept. Never throws: capture must not fail on it. */
export async function ensureCaptureGitignore(fs: { exists: (path: string) => Promise<boolean>; write: (path: string, text: string) => Promise<void> }, root: string): Promise<void> {
  const file = `${root}${/[\\/]$/.test(root) ? '' : '/'}.exovault/.gitignore`;
  try { if (!(await fs.exists(file))) await fs.write(file, CAPTURE_GITIGNORE); } catch { /* best effort */ }
}
