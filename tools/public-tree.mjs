#!/usr/bin/env node
// exo-compact public tree: the tracked files of one ref, without the private paths, as a new repository with a single
// commit and no history. Local only: it sets no remote and pushes nothing.
//   node tools/public-tree.mjs <out-dir> [--ref <ref>] [--author "Name <email>"] [--verify]
// <out-dir> must be empty or absent and outside this repository. The commit's author and committer are --author, or else
// the git identity of whoever runs it (user.name and user.email as git sees them here); with neither it stops. --verify then runs npm ci, npm run typecheck and
// npm test inside it, the way a fresh clone of the public repository would.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Paths that stay in the private repository: design notes, briefs and reviews, the benchmark, the gate log. */
export const PRIVATE_PATHS = ['docs/ctx-s4/', 'tools/ctxbench/', 'plugin/compact/__gate-s4__/GATE.md'];

const isPrivate = (file) => PRIVATE_PATHS.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry));

/** The real path of `target`, or of its nearest existing ancestor with the rest appended, so symlinks resolve. */
function realish(target) {
  const rest = [];
  for (let dir = path.resolve(target); ; dir = path.dirname(dir)) {
    if (fs.existsSync(dir)) return path.join(fs.realpathSync(dir), ...rest);
    rest.unshift(path.basename(dir));
    if (path.dirname(dir) === dir) return path.resolve(target);
  }
}

const AUTHOR = /^([^<>\n]*[^<>\s])\s*<([^<>\s@]+@[^<>\s@]+)>$/;

/** `{ name, email }` from `"Name <email>"`, or from the git identity in `cwd` (config or GIT_AUTHOR_* variables). */
function commitIdentity(cwd, author) {
  if (author === undefined) {
    try {
      // useConfigOnly: git must not make up a name and an address from the login and the host name.
      author = execFileSync('git', ['-c', 'user.useConfigOnly=true', 'var', 'GIT_AUTHOR_IDENT'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/ \d+ [+-]\d{4}$/, '');
    } catch {
      throw new Error('no git identity: set user.name and user.email, or pass --author "Name <email>"');
    }
  }
  const match = AUTHOR.exec(author);
  if (!match) throw new Error(`author must be "Name <email>", got ${JSON.stringify(author)}`);
  return { name: match[1].trim(), email: match[2] };
}

/** Builds the tree and returns what it kept and dropped. Throws, leaving `out` as it was, on any failure. */
export function buildPublicTree({ source, out, ref = 'HEAD', author }) {
  source = path.resolve(source);
  out = path.resolve(out);
  const inside = path.relative(realish(source), realish(out));
  if (inside === '' || (inside !== '..' && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside))) throw new Error(`${out} is inside the source repository`);
  const existed = fs.existsSync(out);
  if (existed && fs.readdirSync(out).length > 0) throw new Error(`${out} is not empty`);
  const identity = commitIdentity(source, author);
  const git = (cwd, args, options = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, ...options });
  // Every entry as `<mode> <type> <id>\t<path>`. A symlink (120000) or submodule (160000) is refused: removing a
  // private path through a symlinked parent would delete what it points at.
  const entries = git(source, ['ls-tree', '-r', '-z', '--full-tree', ref]).split('\0').filter(Boolean)
    .map((line) => ({ mode: line.slice(0, line.indexOf(' ')), file: line.slice(line.indexOf('\t') + 1) }));
  const links = entries.filter((entry) => entry.mode === '120000' || entry.mode === '160000').map((entry) => entry.file);
  if (links.length > 0) throw new Error(`symlink or submodule: ${links.join(', ')}`);
  // `export-ignore` would drop tracked files from the archive, `export-subst` would rewrite them and a `filter` would
  // run a configured command on them. Global and system attribute files are switched off below.
  const attributeFiles = entries.filter((entry) => path.posix.basename(entry.file) === '.gitattributes').map((entry) => `${ref}:${entry.file}`);
  const infoAttributes = path.resolve(source, git(source, ['rev-parse', '--git-path', 'info/attributes']).trim());
  const attributes = [...attributeFiles.map((spec) => git(source, ['show', spec])), fs.existsSync(infoAttributes) ? fs.readFileSync(infoAttributes, 'utf8') : ''];
  if (attributes.some((text) => /\b(export-(ignore|subst)|filter)\b/.test(text))) throw new Error('export-ignore, export-subst or filter attributes would change the archive');
  const tracked = entries.map((entry) => entry.file);
  const dropped = tracked.filter(isPrivate);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'public-tree-'));
  const tar = path.join(scratch, 'tree.tar'), noHooks = path.join(scratch, 'no-hooks'), noAttributes = path.join(scratch, 'no-attributes');
  const plain = { env: { ...process.env, GIT_ATTR_NOSYSTEM: '1' } };
  try {
    fs.mkdirSync(noHooks);
    fs.writeFileSync(noAttributes, '');
    fs.mkdirSync(out, { recursive: true });
    git(source, ['-c', `core.attributesFile=${noAttributes}`, 'archive', '--format=tar', `--output=${tar}`, ref], plain);
    execFileSync('tar', ['-xf', tar, '-C', out]);
    for (const entry of PRIVATE_PATHS) fs.rmSync(path.join(out, entry), { recursive: true, force: true });
    const version = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8')).version;
    // An empty hooks directory: no global or template hook (a post-commit that pushes, say) runs in the new repository.
    const quiet = ['-c', `core.hooksPath=${noHooks}`, '-c', `core.attributesFile=${noAttributes}`, '-c', 'commit.gpgsign=false'];
    git(out, [...quiet, 'init', '-q', '-b', 'main'], plain);
    git(out, [...quiet, 'add', '-A'], plain);
    const kept = git(out, ['ls-files', '-z']).split('\0').filter(Boolean).sort();
    const expected = tracked.filter((file) => !isPrivate(file)).sort();
    if (kept.join('\0') !== expected.join('\0')) throw new Error('the archive does not hold exactly the tracked public files');
    const who = { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email };
    git(out, [...quiet, 'commit', '-q', '--no-verify', '-m', `exo-compact ${version}`], { env: { ...plain.env, ...who } });
    return { out, files: kept.length, dropped, version, author: `${identity.name} <${identity.email}>` };
  } catch (error) {
    if (existed) for (const entry of fs.readdirSync(out)) fs.rmSync(path.join(out, entry), { recursive: true, force: true });
    else fs.rmSync(out, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** `{ out, ref, author, verify }` from the arguments, or undefined for anything else (an unknown option, a second path). */
function parseArgs(argv) {
  const parsed = { out: undefined, ref: 'HEAD', author: undefined, verify: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verify') parsed.verify = true;
    else if (arg === '--ref' && argv[i + 1] && !argv[i + 1].startsWith('-')) parsed.ref = argv[++i];
    else if (arg === '--author' && argv[i + 1] && !argv[i + 1].startsWith('-')) parsed.author = argv[++i];
    else if (!arg.startsWith('-') && parsed.out === undefined) parsed.out = arg;
    else return undefined;
  }
  return parsed.out === undefined ? undefined : parsed;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write('usage: node tools/public-tree.mjs <out-dir> [--ref <ref>] [--author "Name <email>"] [--verify]\n');
    process.exit(2);
  }
  const { out, ref, author } = args;
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = buildPublicTree({ source, out, ref, author });
  process.stdout.write(`${result.out}: exo-compact ${result.version}, ${result.files} files in one commit by ${result.author}, ${result.dropped.length} private files left out, no remote.\n`);
  if (args.verify) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    for (const args of [['ci'], ['run', 'typecheck'], ['test']]) execFileSync(npm, args, { cwd: result.out, stdio: 'inherit', shell: process.platform === 'win32' });
    process.stdout.write('verify: npm ci, npm run typecheck and npm test passed in the public tree.\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
