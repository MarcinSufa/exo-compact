// 4.9.2: owner-only permissions for a capture store.
// The hook writes captures with `$.fs.write`, which takes no mode, so new files and directories follow the umask
// (often 664/775: readable by every local user). This script, run by the hook through `$.process.run`, sets 0700 on
// `<root>/.exovault`, `<root>/.exovault/s4-capture` and the session directory, and 0600 on every file under the session
// directory. It runs before a session's first capture write and again after every turn's and every cut's writes.
// A 0700 `s4-capture` alone already keeps every session directory below it from other users; the file modes are kept
// tight too so a copied or moved file stays private.
// Symbolic links are never followed. `--remove <name>` also deletes one file of the session directory (the held brief
// once it is back in the prompt box).
// On Windows chmod only toggles the read-only flag: the store keeps the ACL it inherits from its parent directory.
// Usage: node harden.mjs <root> [<session dir> [--remove <name>]]
// Exit code 0 always: hardening is best effort and must never fail a hook.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** `<root>/.exovault/s4-capture/<one segment>`, or undefined when `sessionDir` is anything else. */
function ownSessionDir(store, sessionDir) {
  const resolved = path.resolve(sessionDir);
  if (path.dirname(resolved) !== store) return undefined;
  const name = path.basename(resolved);
  return name === '' || name === '.' || name === '..' ? undefined : resolved;
}

/** Creates `dir` when missing; a directory gets `DIR_MODE`, a symlink or file in its place stops the walk. */
function secureDir(dir) {
  try { fs.mkdirSync(dir, { mode: DIR_MODE }); } catch (error) { if (error?.code !== 'EEXIST') return false; }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) return false;
  if ((stat.mode & 0o777) !== DIR_MODE) fs.chmodSync(dir, DIR_MODE);
  return true;
}

function secureTree(dir, depth = 0) {
  if (depth > 8) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { if ((stat.mode & 0o777) !== DIR_MODE) fs.chmodSync(file, DIR_MODE); secureTree(file, depth + 1); }
      else if (stat.isFile() && (stat.mode & 0o777) !== FILE_MODE) fs.chmodSync(file, FILE_MODE);
    } catch { /* a file removed meanwhile */ }
  }
}

/**
 * Secures the store under `root` and, when given, one session directory in it. Returns what it did, for tests;
 * never throws.
 */
export function hardenCapture(root, sessionDir, remove) {
  const done = { store: false, session: false, removed: false };
  try {
    if (typeof root !== 'string' || !path.isAbsolute(root)) return done;
    const exovault = path.join(path.resolve(root), '.exovault');
    const store = path.join(exovault, 's4-capture');
    if (!secureDir(exovault) || !secureDir(store)) return done;
    done.store = true;
    if (sessionDir === undefined) return done;
    const own = ownSessionDir(store, sessionDir);
    if (own === undefined || !secureDir(own)) return done;
    if (typeof remove === 'string' && remove !== '' && path.basename(remove) === remove && remove !== '.' && remove !== '..') {
      try { if (!fs.lstatSync(path.join(own, remove)).isDirectory()) { fs.unlinkSync(path.join(own, remove)); done.removed = true; } } catch { /* already gone */ }
    }
    secureTree(own);
    done.session = true;
  } catch { /* best effort */ }
  return done;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, sessionDir, flag, name] = process.argv.slice(2);
  hardenCapture(root, sessionDir, flag === '--remove' ? name : undefined);
}
