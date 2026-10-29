// 4.10.1 (CONTRACT S5y): a plugin seated before the user tier can send exo-compact's hook events on past it; Claude
// Code then logs `exo-compact: its <event> hook was skipped. "<plugin>" runs first and sent the event on past it.`,
// and the line lands in the session transcript. findBypass reads it back; pluginDigest computes the digest managed
// settings name under extraKnownMarketplaces[<marketplace>].pluginDigests[<plugin>] to seat a plugin past it.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NEWEST = 3;
// ponytail: only the first 16 MiB of each transcript is read; a skip line after that is missed. The line comes with
// the first skipped event, so the head is where it is.
const MAX_BYTES = 16 * 1024 * 1024;
const QUOTE = '(?:"|&quot;)';
const SKIP_LINE = new RegExp(String.raw`exo-compact: its ([A-Za-z0-9._-]+) hook was skipped\. ${QUOTE}([A-Za-z0-9._@:/-]+)${QUOTE} runs first and sent the event on past it\.`, 'g');

function head(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(fs.fstatSync(fd).size, MAX_BYTES));
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** The text of a notice Claude Code queued itself (a queue operation or a queued command), not one a person or the model wrote. */
function queuedNotice(line) {
  let record;
  try { record = JSON.parse(line); } catch { return undefined; }
  const text = record?.type === 'queue-operation' ? record.content
    : record?.type === 'attachment' && record.attachment?.type === 'queued_command' ? record.attachment.prompt
      : undefined;
  return typeof text === 'string' ? text : undefined;
}

/**
 * The plugins that skipped exo-compact's hooks in the newest transcripts of one project dir, newest file first:
 * `[{ by, events, file }]`, file the newest one the plugin was seen in. [] when there is none; never throws.
 */
export function findBypass(projectDir) {
  let files;
  try {
    files = fs.readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => { const file = path.join(projectDir, entry.name); return { file, mtime: fs.statSync(file).mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, NEWEST);
  } catch {
    return [];
  }
  const found = new Map();
  for (const { file } of files) {
    let text;
    try { text = head(file); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('hook was skipped')) continue;
      for (const [, event, by] of queuedNotice(line)?.matchAll(SKIP_LINE) ?? []) {
        const entry = found.get(by) ?? { by, events: [], file };
        if (!entry.events.includes(event)) entry.events.push(event);
        found.set(by, entry);
      }
    }
  }
  return [...found.values()];
}

// Read from Claude Code 2.1.312 (its plugin digest): names left out at the root only, and its limits.
const LEFT_OUT = new Set(['.git', '.claude-plugin-link', '.in_use', '.links_materialized', '.orphaned_at']);
const MAX_FILES = 4096;
const MAX_TOTAL = 32 * 1024 * 1024;
const TYPES_DIR = '.claude-plugin/types/';

const crlfText = (bytes) => !bytes.includes(0) && bytes.includes('\r\n');

/**
 * The pluginDigests entry for a plugin folder, as Claude Code computes it: `sha256-` and the base64 SHA-256 of, for
 * every regular file in UTF-16 code unit order of its `/` path, "f PATH" NUL decimal byte length NUL bytes.
 * `{ digest, files }`, or `{ problem }` where Claude Code would refuse the folder or the digest could not match the
 * published bytes (CRLF line endings, or `.claude-plugin/types/` Claude Code added when it loaded the folder). Never throws.
 */
export function pluginDigest(folder) {
  const names = [];
  try {
    for (const stack = ['']; stack.length > 0;) {
      const dir = stack.pop();
      for (const raw of fs.readdirSync(path.join(folder, dir), { encoding: 'buffer' })) {
        const name = raw.toString('utf8');
        if (!Buffer.from(name, 'utf8').equals(raw)) return { problem: `a name under ${dir || 'its root'} is not UTF-8, so Claude Code would refuse this folder` };
        if (dir === '' && LEFT_OUT.has(name)) continue;
        const relative = dir === '' ? name : `${dir}/${name}`;
        if (`${relative}/` === TYPES_DIR) return { problem: `${TYPES_DIR} is in the folder: Claude Code writes it there when it loads the plugin from a folder the person owns, so this digest would not match the release; digest a fresh LF clone of the release tag instead (README, "Hooks skipped by another plugin")` };
        const stat = fs.lstatSync(path.join(folder, relative));
        if (stat.isDirectory()) stack.push(relative);
        else if (stat.isFile()) names.push(relative);
        else return { problem: `${relative} is not a regular file or folder (a symbolic link?), so Claude Code would refuse this folder` };
      }
      if (names.length > MAX_FILES) return { problem: `it holds more than ${MAX_FILES} files, so Claude Code would refuse this folder` };
    }
  } catch (error) {
    return { problem: `cannot read ${folder} (${error?.code ?? 'error'})` };
  }
  const hash = createHash('sha256');
  let total = 0;
  for (const name of names.toSorted()) {
    let bytes;
    try { bytes = fs.readFileSync(path.join(folder, name)); } catch (error) { return { problem: `cannot read ${name} (${error?.code ?? 'error'})` }; }
    total += bytes.length;
    if (total > MAX_TOTAL) return { problem: `it holds more than ${MAX_TOTAL} bytes, so Claude Code would refuse this folder` };
    if (crlfText(bytes)) return { problem: `${name} has CRLF line endings (a checkout that converted them), so its digest would not match a copy with the published bytes` };
    hash.update(`f ${name}\u0000${bytes.length}\u0000`);
    hash.update(bytes);
  }
  return { digest: `sha256-${hash.digest('base64')}`, files: names.length };
}
