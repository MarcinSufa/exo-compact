import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash } from '../recall/shared.mjs';
import { cleanup, plan, pruneOld } from '../recall/cleanup.mjs';
import { saveBrief } from '../recall/brief.mjs';
import { DIM, appendVectors, readyStamp, storedKeys, textKey, vectorFile } from '../recall/vectors.mjs';
import { CAPTURE_GITIGNORE, ensureCaptureGitignore } from '../host/capture-path.js';

// Stored indexes, briefs and captures written before a redactor learned a key shape keep that key on disk; the
// cleanup command re-redacts them once (after a backup) and drops the data of sessions nobody touched for N days.
// Samples are assembled from pieces so no full key shape sits in the source.
const here = path.dirname(fileURLToPath(import.meta.url));
const CLEANUP = path.join(here, '..', 'recall', 'cleanup.mjs');
const BUILD_WORKER = path.join(here, '..', 'recall', 'build-worker.mjs');
const SETUP = path.join(here, '..', 'setup.cjs');
const body = (n: number) => 'Ab3Cd5Ef7Gh9Jk2Lm4Np6Qr8St1Uv3Wx5Yz7'.repeat(3).slice(0, n);
const KEY = `sk-${'ant'}-api03-${body(40)}`;
const DAY = 24 * 60 * 60 * 1000;

interface Summary {
  apply: boolean;
  days: number;
  redact: { files: number; rows: number; briefs: number; indexes: number; captures: number; skipped: number; vectors: number };
  recentCaptures: number;
  prune: { indexes: number; captures: number; bytes: number; tombstones: { restored: number; deleted: number; left: number; skipped: number } };
  busy: number;
  cutoffs: { resumed: number; dropped: number; pending: number };
  backup: { file: string; files: number } | null;
}

function tempHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'exo-cleanup-'));
}
function processAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
async function stopProcess(pid: number) {
  const wait = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (processAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    return !processAlive(pid);
  };
  if (await wait(5000)) return;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  if (await wait(1000)) return;
  try { process.kill(pid, 'SIGKILL'); } catch {}
  await wait(1000);
}

/** Sets the mtime of `dir` and everything below it to `ms`. */
function age(dir: string, ms: number): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) age(full, ms); else utimesSync(full, ms / 1000, ms / 1000);
  }
  utimesSync(dir, ms / 1000, ms / 1000);
}

function writeIndex(home: string, sessionId: string, rows: string[], generations = [1, 2]): string {
  const dir = path.join(home, '.claude', 'exovault', 'recall', hash(sessionId));
  for (const generation of generations) {
    const gen = path.join(dir, `generation-${String(generation).padStart(8, '0')}`);
    mkdirSync(gen, { recursive: true });
    writeFileSync(path.join(gen, 'records.json'), JSON.stringify(rows.map((text, i) => ({ sourceId: `r${i}`, sourceSessionId: sessionId, position: i, turn: i, segment: 0, role: 'user', text }))));
    writeFileSync(path.join(gen, 'manifest.json'), JSON.stringify({ sessionId, generation, cutoffPosition: 10, chunkCount: rows.length }));
  }
  writeFileSync(path.join(dir, 'CURRENT'), `${generations.at(-1)}\n`);
  writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ cutoffPosition: 10, segments: [{ segment: 0, asks: [`use ${KEY} for the call`, 'plain ask'] }] }));
  writeFileSync(path.join(dir, 'search-calls.jsonl'), `${JSON.stringify({ at: 'x', query: `where is ${KEY}`, scope: 'session', hits: [] })}\n${JSON.stringify({ at: 'y', query: 'plain', scope: 'session', hits: [] })}\n`);
  return dir;
}

function writeBrief(dir: string, text: string): void {
  const briefs = path.join(dir, 'briefs');
  mkdirSync(briefs, { recursive: true });
  writeFileSync(path.join(briefs, 'aaaaaaaaaaaa.md'), text);
  writeFileSync(path.join(briefs, 'aaaaaaaaaaaa.digest.md'), `- key: ${KEY}\n`);
  writeFileSync(path.join(briefs, 'briefs.json'), JSON.stringify([{ id: 'aaaaaaaaaaaa', path: path.join(briefs, 'aaaaaaaaaaaa.md'), chars: text.length, at: 'x', firstLine: text.split('\n')[0] }]));
}

function writeCapture(root: string, sessionId: string): string {
  const dir = path.join(root, '.exovault', 's4-capture', sessionId);
  mkdirSync(path.join(dir, 'scratch'), { recursive: true });
  writeFileSync(path.join(dir, 'segment-000001.json'), '[]');
  writeFileSync(path.join(dir, 'scratch', 'note.txt'), 'x');
  return dir;
}

function writeTombstone(home: string, sessionId: string, files: Record<string, string>, { pid = 2147483647, namedAt = Date.now(), oldAt }: { pid?: number; namedAt?: number; oldAt?: number } = {}): { dir: string; canonical: string } {
  const captureRoot = path.join(home, '.exovault', 's4-capture');
  const dir = path.join(home, '.exovault', `.${sessionId}.retention-${pid}-${namedAt}-1`);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  if (oldAt !== undefined) age(dir, oldAt);
  return { dir, canonical: path.join(captureRoot, sessionId) };
}

function run(home: string, args: string[] = [], sessionEnv = ''): { summary: Summary; stdout: string; status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [CLEANUP, '--json', ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sessionEnv } });
  let summary: Summary;
  try { summary = JSON.parse(result.stdout) as Summary; } catch { summary = undefined as unknown as Summary; }
  return { summary, stdout: result.stdout, status: result.status, stderr: result.stderr };
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full); else out[path.relative(dir, full)] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

describe('cleanup command: re-redact stored data', () => {
  it('reports stale vectors in a dry run and backs them up before dropping every old-text record', () => {
    const home = tempHome();
    try {
      const dir = writeIndex(home, 'vector-redact', [`token ${KEY}`, 'nothing secret here']);
      const oldKey = textKey(`token ${KEY}`), cleanKey = textKey('nothing secret here');
      const axis = (n: number) => { const value = new Float32Array(DIM); value[n] = 1; return value; };
      appendVectors(vectorFile(dir), [
        { key: oldKey, vector: axis(0) }, { key: oldKey, vector: axis(0) }, { key: cleanKey, vector: axis(1) },
      ]);
      const dry = run(home).summary;
      expect(dry.redact.vectors).toBe(2);
      const human = spawnSync(process.execPath, [CLEANUP], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
      expect(human.status, human.stderr).toBe(0);
      expect(human.stdout).toContain('2 stale vector records would be dropped');
      expect(storedKeys(vectorFile(dir))).toEqual(new Set([oldKey, cleanKey]));

      const applied = run(home, ['--apply']).summary;
      expect(applied.redact.vectors).toBe(2);
      expect(storedKeys(vectorFile(dir))).toEqual(new Set([cleanKey]));
      expect(statSync(vectorFile(dir)).size).toBe(8 + DIM);
      expect(applied.backup?.files).toBe(applied.redact.files + 1);
      const listed = spawnSync('tar', ['-tzf', applied.backup!.file], { encoding: 'utf8' }).stdout;
      expect(listed).toContain('vectors-e5-small-q8.bin');
      const restore = mkdtempSync(path.join(os.tmpdir(), 'exo-restore-vectors-'));
      spawnSync('tar', ['-xzf', applied.backup!.file, '-C', restore]);
      expect(storedKeys(path.join(restore, path.relative(home, vectorFile(dir))))).toEqual(new Set([oldKey, cleanKey]));
      rmSync(restore, { recursive: true, force: true });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a dry run (the default) reports the numbers and changes nothing', () => {
    const home = tempHome();
    try {
      const dir = writeIndex(home, 'session-a', [`token ${KEY}`, 'nothing secret here', `again ${KEY}`]);
      writeBrief(dir, `Use ${KEY} in the deploy step\nsecond line`);
      writeIndex(home, 'session-b', ['clean row']);
      const before = snapshot(home);
      const { summary, status, stderr } = run(home);
      expect(status, stderr).toBe(0);
      expect(summary.apply).toBe(false);
      // Two generations x two secret rows; records + timeline + search-calls + brief + digest + briefs.json in session-a,
      // and only the generic timeline/search-calls key in session-b.
      expect(summary.redact.rows).toBe(4);
      expect(summary.redact.briefs).toBe(1);
      expect(summary.redact.indexes).toBe(2);
      expect(summary.redact.files).toBe(2 + 2 + 3 + 2);
      expect(summary.backup).toBeNull();
      expect(snapshot(home)).toEqual(before);
      expect(existsSync(path.join(home, '.exovault'))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('the human-readable dry run says that nothing changed and how to apply', () => {
    const home = tempHome();
    try {
      writeIndex(home, 'session-a', [`token ${KEY}`]);
      const result = spawnSync(process.execPath, [CLEANUP], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/dry run/);
      expect(result.stdout).toMatch(/--apply/);
      expect(result.stdout).toMatch(/2 rows/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('--apply backs up the original files first, then redacts every generation, brief and log', () => {
    const home = tempHome();
    try {
      const dir = writeIndex(home, 'session-a', [`token ${KEY}`, 'nothing secret here']);
      writeBrief(dir, `Use ${KEY} in the deploy step\nsecond line`);
      const { summary, status, stderr } = run(home, ['--apply']);
      expect(status, stderr).toBe(0);
      expect(summary.apply).toBe(true);
      const date = new Date().toISOString().slice(0, 10);
      expect(summary.backup?.file).toBe(path.join(home, '.exovault', `backup-${date}.tar.gz`));
      expect(summary.backup?.files).toBe(summary.redact.files);
      const backup = summary.backup!.file;
      expect(statSync(backup).mode & 0o777).toBe(0o600);
      const listed = spawnSync('tar', ['-tzf', backup], { encoding: 'utf8' }).stdout;
      expect(listed).toMatch(/generation-00000001\/records\.json/);
      expect(listed).toMatch(/briefs\/aaaaaaaaaaaa\.md/);
      // The backup holds the originals (it is the way back), the index no longer does.
      const restore = mkdtempSync(path.join(os.tmpdir(), 'exo-restore-'));
      spawnSync('tar', ['-xzf', backup, '-C', restore]);
      expect(readFileSync(path.join(restore, path.relative(home, dir), 'briefs', 'aaaaaaaaaaaa.md'), 'utf8')).toContain(KEY);
      rmSync(restore, { recursive: true, force: true });
      const after = JSON.stringify(snapshot(dir));
      expect(after).not.toContain(KEY);
      expect(after).toContain('[redacted]');
      const rows = JSON.parse(readFileSync(path.join(dir, 'generation-00000002', 'records.json'), 'utf8')) as { text: string; sourceId: string }[];
      expect(rows.map((row) => row.text)).toEqual(['token [redacted]', 'nothing secret here']);
      expect(rows[0].sourceId).toBe('r0');
      expect(statSync(path.join(dir, 'generation-00000002', 'records.json')).mode & 0o777).toBe(0o600);
      expect(readFileSync(path.join(dir, 'briefs', 'aaaaaaaaaaaa.md'), 'utf8')).toBe('Use [redacted] in the deploy step\nsecond line');
      expect(readFileSync(path.join(dir, 'search-calls.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
      // A second run finds nothing left to do and writes no second backup.
      const again = run(home, ['--apply']).summary;
      expect(again.redact.files).toBe(0);
      expect(again.backup).toBeNull();
      expect(readdirSync(path.join(home, '.exovault')).filter((name) => name.startsWith('backup-'))).toHaveLength(1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('never overwrites an earlier backup of the same day', () => {
    const home = tempHome();
    try {
      writeIndex(home, 'session-a', [`token ${KEY}`]);
      const date = new Date().toISOString().slice(0, 10);
      mkdirSync(path.join(home, '.exovault'), { recursive: true });
      writeFileSync(path.join(home, '.exovault', `backup-${date}.tar.gz`), 'older backup');
      const { summary } = run(home, ['--apply']);
      expect(summary.backup?.file).not.toBe(path.join(home, '.exovault', `backup-${date}.tar.gz`));
      expect(readFileSync(path.join(home, '.exovault', `backup-${date}.tar.gz`), 'utf8')).toBe('older backup');
      expect(existsSync(summary.backup!.file)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('skips a session whose build holds its lock, in the dry run and on apply', () => {
    const home = tempHome();
    try {
      const dir = writeIndex(home, 'session-a', [`token ${KEY}`]);
      writeFileSync(path.join(dir, 'BUILD_LOCK'), String(process.pid));
      const dry = run(home).summary;
      expect(dry.busy).toBe(1);
      expect(dry.redact.files).toBe(0);
      run(home, ['--apply']);
      expect(readFileSync(path.join(dir, 'generation-00000002', 'records.json'), 'utf8')).toContain(KEY);
      expect(readFileSync(path.join(dir, 'BUILD_LOCK'), 'utf8')).toBe(String(process.pid));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('takes over a lock whose owner is gone', () => {
    const home = tempHome();
    try {
      const dir = writeIndex(home, 'session-a', [`token ${KEY}`]);
      writeFileSync(path.join(dir, 'BUILD_LOCK'), '999999999');
      const { summary } = run(home, ['--apply']);
      expect(summary.busy).toBe(0);
      expect(readFileSync(path.join(dir, 'generation-00000002', 'records.json'), 'utf8')).not.toContain(KEY);
      expect(existsSync(path.join(dir, 'BUILD_LOCK'))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('starts a vectors-mode build for a cutoff queued while cleanup holds the lock', async () => {
    const home = tempHome();
    let workerPid: number | undefined, buildFinished = false;
    try {
      const id = 'queued-cutoff';
      const index = writeIndex(home, id, ['old row']);
      const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
      const vector = new Float32Array(DIM); vector[0] = 1;
      appendVectors(vectorFile(index), [{ key: textKey('old row'), vector }]);
      const runtime = path.join(path.dirname(recallRoot), 'recall-runtime');
      mkdirSync(runtime, { recursive: true });
      writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
      writeFileSync(path.join(runtime, 'READY'), JSON.stringify(readyStamp()));
      const embedLog = path.join(index, 'embed.log');
      const project = path.join(home, '.claude', 'projects', '-queued');
      mkdirSync(project, { recursive: true });
      const transcript = path.join(project, `${id}.jsonl`);
      const queuedRows = Array.from({ length: 6000 }, (_, i) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: i === 5999 ? 'new cutoff row' : `queued row ${i}` }] } })).join('\n');
      writeFileSync(transcript, `${' '.repeat(20)}\n${queuedRows}\n`);
      const cutoff = statSync(transcript).size;
      const summary = cleanup({
        home, recallRoot, captureDirs: [], days: 0, apply: true,
        afterBackup: () => {
          const queued = spawnSync(process.execPath, [BUILD_WORKER, transcript, recallRoot, id, String(cutoff), project, 'vectors', 'cut', '0'], { encoding: 'utf8' });
          expect(queued.status, queued.stderr).toBe(0);
          expect(readFileSync(path.join(index, 'PENDING_CUTOFF'), 'utf8').trim()).toBe(String(cutoff));
        },
      });
      expect(summary.cutoffs).toEqual({ resumed: 1, dropped: 0, pending: 0 });
      const lock = path.join(index, 'BUILD_LOCK'), until = Date.now() + 30_000;
      let buildPublished = false;
      while (Date.now() < until) {
        // 4.9.1: cleanup resumes the queued build after returning; CURRENT alone does not mark that worker finished.
        try {
          const pid = Number(readFileSync(lock, 'utf8').trim());
          if (Number.isInteger(pid) && pid > 0) workerPid = pid;
        } catch {}
        try {
          const current = Number(readFileSync(path.join(index, 'CURRENT'), 'utf8').trim());
          if (current > 2 && !existsSync(path.join(index, 'PENDING_CUTOFF'))) {
            const rows = JSON.parse(readFileSync(path.join(index, `generation-${String(current).padStart(8, '0')}`, 'records.json'), 'utf8'));
            buildPublished = Array.isArray(rows) && rows.some((row: { text: string }) => row.text === 'new cutoff row');
          }
        } catch {}
        buildFinished = buildPublished && !existsSync(lock) && workerPid !== undefined && !processAlive(workerPid);
        if (buildFinished) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(Number(readFileSync(path.join(index, 'CURRENT'), 'utf8').trim())).toBe(3);
      expect(existsSync(path.join(index, 'PENDING_CUTOFF'))).toBe(false);
      expect(workerPid).toBeGreaterThan(0);
      expect(buildFinished).toBe(true);
      const embedUntil = Date.now() + 3000;
      while (!existsSync(embedLog) && Date.now() < embedUntil) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(existsSync(embedLog)).toBe(true);
      expect(readFileSync(embedLog, 'utf8')).toContain('failed:');
      expect(existsSync(path.join(index, 'EMBED_LOCK'))).toBe(false);
      expect(JSON.parse(readFileSync(path.join(index, 'generation-00000003', 'manifest.json'), 'utf8')).cutoffPosition).toBe(cutoff);
      expect(JSON.parse(readFileSync(path.join(index, 'generation-00000003', 'records.json'), 'utf8')).some((row: { text: string }) => row.text === 'new cutoff row')).toBe(true);
    } finally {
      const index = path.join(home, '.claude', 'exovault', 'recall', hash('queued-cutoff'));
      try {
        const pid = Number(readFileSync(path.join(index, 'BUILD_LOCK'), 'utf8').trim());
        if (Number.isInteger(pid) && pid > 0) workerPid = pid;
      } catch {}
      if (!buildFinished && workerPid && processAlive(workerPid)) {
        await stopProcess(workerPid);
        expect(processAlive(workerPid)).toBe(false);
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      expect(existsSync(home)).toBe(false);
    }
  }, 60_000);

  it('reports a queued cutoff dropped with an index pruned by cleanup', () => {
    const home = tempHome();
    try {
      const id = 'queued-pruned';
      const index = writeIndex(home, id, ['old row']);
      age(index, Date.now() - 40 * DAY);
      const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
      const project = path.join(home, '.claude', 'projects', '-queued');
      mkdirSync(project, { recursive: true });
      const transcript = path.join(project, `${id}.jsonl`);
      writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'new cutoff row' }] } })}\n`);
      const cutoff = statSync(transcript).size;
      const summary = cleanup({ home, recallRoot, captureDirs: [], days: 30, apply: true, afterBackup: () => {
        const queued = spawnSync(process.execPath, [BUILD_WORKER, transcript, recallRoot, id, String(cutoff), project, 'lexical', 'cut', '0'], { encoding: 'utf8' });
        expect(queued.status, queued.stderr).toBe(0);
        const old = Date.now() - 40 * DAY;
        utimesSync(path.join(index, 'ACTIVE'), old / 1000, old / 1000);
        utimesSync(path.join(index, 'PENDING_CUTOFF'), old / 1000, old / 1000);
      } });
      expect(existsSync(index)).toBe(false);
      expect(summary.cutoffs).toEqual({ resumed: 0, dropped: 1, pending: 0 });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('cleanup command: retention', () => {
  it('deletes indexes and captures untouched for longer than --days, keeps fresh ones and foreign directories', () => {
    const home = tempHome();
    try {
      const old = writeIndex(home, 'old-session', ['clean row']);
      const fresh = writeIndex(home, 'fresh-session', ['clean row']);
      const runtime = path.join(home, '.claude', 'exovault', 'recall', 'embed-slots');
      mkdirSync(runtime, { recursive: true });
      const oldCapture = writeCapture(home, 'old-session');
      const freshCapture = writeCapture(home, 'fresh-session');
      const flag = path.join(home, '.exovault', 's4-compact-active');
      writeFileSync(flag, '1');
      const past = Date.now() - 40 * DAY;
      age(old, past); age(oldCapture, past); age(runtime, past);
      utimesSync(flag, past / 1000, past / 1000);
      const dry = run(home, ['--days', '30']).summary;
      expect(dry.prune).toMatchObject({ indexes: 1, captures: 1 });
      expect(dry.prune.bytes).toBeGreaterThan(0);
      expect(existsSync(old)).toBe(true);
      const applied = run(home, ['--apply', '--days', '30']).summary;
      // Both indexes also hold a key in their logs; the deleted one is backed up whole, not redacted first.
      expect(applied.redact.files).toBe(2);
      expect(applied.backup?.files).toBe(2 + 2);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(oldCapture)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(freshCapture)).toBe(true);
      expect(existsSync(runtime)).toBe(true);
      expect(existsSync(flag)).toBe(true);
      const listed = spawnSync('tar', ['-tzf', applied.backup!.file], { encoding: 'utf8' }).stdout;
      expect(listed).toMatch(/s4-capture\/old-session\/segment-000001\.json/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a directory counts as touched when any file below it is recent', () => {
    const home = tempHome();
    try {
      const dir = writeIndex(home, 'session-a', ['clean row']);
      age(dir, Date.now() - 40 * DAY);
      const now = Date.now() / 1000;
      utimesSync(path.join(dir, 'generation-00000002', 'records.json'), now, now);
      expect(run(home, ['--days', '30']).summary.prune.indexes).toBe(0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('--days 0 keeps everything and is the only way to turn retention off', () => {
    const home = tempHome();
    try {
      const dir = writeIndex(home, 'session-a', ['clean row']);
      age(dir, Date.now() - 400 * DAY);
      expect(run(home, ['--days', '0']).summary.prune.indexes).toBe(0);
      expect(run(home).summary.days).toBe(30);
      expect(run(home).summary.prune.indexes).toBe(1);
      const bad = spawnSync(process.execPath, [CLEANUP, '--days', 'soon'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
      expect(bad.status).toBe(2);
      expect(existsSync(dir)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('--capture-root adds a project capture directory', () => {
    const home = tempHome();
    const project = tempHome();
    try {
      const capture = writeCapture(project, 'old-session');
      age(capture, Date.now() - 40 * DAY);
      expect(run(home).summary.prune.captures).toBe(0);
      const applied = run(home, ['--apply', '--capture-root', project]).summary;
      expect(applied.prune.captures).toBe(1);
      expect(existsSync(capture)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
  });
});

describe('automatic retention', () => {
  it('dry-runs a quiet tombstone restore when its canonical capture is planned for pruning', () => {
    const home = tempHome();
    try {
      const now = Date.now();
      const tombstone = writeTombstone(home, 'restore-after-prune', { 'segment-000001.json': 'tombstone capture' }, { namedAt: now, oldAt: now - 2 * 60 * 60 * 1000 });
      mkdirSync(tombstone.canonical, { recursive: true });
      writeFileSync(path.join(tombstone.canonical, 'segment-000001.json'), 'expired canonical capture');
      age(tombstone.canonical, now - 40 * DAY);
      const expectedTree = snapshot(tombstone.dir);

      const dry = cleanup({ home, days: 30, now });
      const applied = cleanup({ home, days: 30, apply: true, now });
      expect(dry.prune.captures).toBe(1);
      expect(applied.prune.tombstones).toEqual({ restored: 1, deleted: 0, left: 0, skipped: 0 });
      expect(dry.prune.tombstones).toEqual(applied.prune.tombstones);
      expect(snapshot(tombstone.canonical)).toEqual(expectedTree);
      expect(existsSync(tombstone.dir)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('plans a worker restore when pruneOld removes the canonical capture', () => {
    const home = tempHome();
    try {
      const now = Date.now();
      const tombstone = writeTombstone(home, 'worker-restore-after-prune', { 'segment-000001.json': 'worker tombstone capture' }, { namedAt: now, oldAt: now - 2 * 60 * 60 * 1000 });
      mkdirSync(tombstone.canonical, { recursive: true });
      writeFileSync(path.join(tombstone.canonical, 'segment-000001.json'), 'expired worker canonical capture');
      age(tombstone.canonical, now - 40 * DAY);
      const expectedTree = snapshot(tombstone.dir);
      const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
      const captureRoot = path.dirname(tombstone.canonical);

      expect(plan({ recallRoot, captureDirs: [captureRoot], days: 30, now, sessionId: 'worker-session', redactData: false }).tombstones)
        .toMatchObject([{ action: 'restore' }]);
      const done = pruneOld({ recallRoot, captureRoots: [captureRoot], days: 30, now, sessionId: 'worker-session' });
      expect(done).toMatchObject({ captures: 1, tombstones: { restored: 1, left: 0 } });
      expect(snapshot(tombstone.canonical)).toEqual(expectedTree);
      expect(existsSync(tombstone.dir)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('dry-runs orphaned tombstone recovery counts and report lines without changing files', () => {
    const home = tempHome();
    try {
      const now = Date.now();
      const restore = writeTombstone(home, 'dry-restore', { 'segment-000001.json': 'fresh' }, { namedAt: now, oldAt: now - 2 * 60 * 60 * 1000 });
      const remove = writeTombstone(home, 'dry-delete', { 'segment-000001.json': 'old' }, { namedAt: now - 40 * DAY, oldAt: now - 40 * DAY });
      const live = writeTombstone(home, 'dry-live', { 'segment-000001.json': 'fresh' }, { pid: process.pid, namedAt: now });
      const occupied = writeTombstone(home, 'dry-occupied', { 'old.txt': 'old copy' }, { namedAt: now });
      mkdirSync(occupied.canonical, { recursive: true });
      writeFileSync(path.join(occupied.canonical, 'current.txt'), 'canonical copy');

      const summary = cleanup({ home, days: 30, now });
      expect(summary.prune.tombstones).toEqual({ restored: 1, deleted: 1, left: 1, skipped: 1 });
      expect(existsSync(restore.dir)).toBe(true);
      expect(existsSync(restore.canonical)).toBe(false);
      expect(existsSync(remove.dir)).toBe(true);
      expect(existsSync(live.dir)).toBe(true);
      expect(existsSync(occupied.dir)).toBe(true);
      const report = spawnSync(process.execPath, [CLEANUP, '--days', '30'], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
      expect(report.status, report.stderr).toBe(0);
      expect(report.stdout).toContain('retention tombstones: 1 tombstone would be restored, 1 tombstone would be deleted, 1 tombstone would be left for later, 1 tombstone would be skipped');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('leaves a non-quiet tombstone untouched when its canonical capture path is free', () => {
    const home = tempHome();
    try {
      const now = Date.now();
      const tombstone = writeTombstone(home, 'restore-fresh', { 'segment-000001.json': 'fresh capture' }, { namedAt: now, oldAt: now - 30 * 60 * 1000 });
      const summary = cleanup({ home, days: 30, apply: true });
      expect(summary.prune.tombstones).toMatchObject({ restored: 0, left: 1 });
      expect(existsSync(tombstone.canonical)).toBe(false);
      expect(readFileSync(path.join(tombstone.dir, 'segment-000001.json'), 'utf8')).toBe('fresh capture');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('restores a quiet tombstone only when its recorded pid is dead', () => {
    const home = tempHome();
    try {
      const now = Date.now();
      const dead = writeTombstone(home, 'restore-quiet-dead', { 'segment-000001.json': 'quiet capture' }, { namedAt: now, oldAt: now - 2 * 60 * 60 * 1000 });
      const alive = writeTombstone(home, 'restore-quiet-live', { 'segment-000001.json': 'still owned' }, { pid: process.pid, namedAt: now - 11 * 60 * 1000, oldAt: now - 2 * 60 * 60 * 1000 });
      const summary = cleanup({ home, days: 30, apply: true, now });
      expect(summary.prune.tombstones).toMatchObject({ restored: 1, left: 1 });
      expect(readFileSync(path.join(dead.canonical, 'segment-000001.json'), 'utf8')).toBe('quiet capture');
      expect(existsSync(dead.dir)).toBe(false);
      expect(existsSync(alive.canonical)).toBe(false);
      expect(readFileSync(path.join(alive.dir, 'segment-000001.json'), 'utf8')).toBe('still owned');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('deletes an old tombstone even when the canonical path is occupied', () => {
    const home = tempHome();
    try {
      const now = Date.now();
      const tombstone = writeTombstone(home, 'delete-old', { 'segment-000001.json': 'old capture' }, { namedAt: now - 40 * DAY, oldAt: now - 40 * DAY });
      mkdirSync(tombstone.canonical, { recursive: true });
      writeFileSync(path.join(tombstone.canonical, 'segment-000001.json'), 'new canonical capture');
      const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
      const done = pruneOld({ recallRoot, captureRoots: [path.dirname(tombstone.canonical)], days: 30, now, sessionId: 'another-session' });
      expect(done?.tombstones).toMatchObject({ deleted: 1 });
      expect(existsSync(tombstone.dir)).toBe(false);
      expect(readFileSync(path.join(tombstone.canonical, 'segment-000001.json'), 'utf8')).toBe('new canonical capture');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('recovers tombstones during the worker retention stamp window', () => {
    const home = tempHome();
    try {
      const now = Date.now();
      const tombstone = writeTombstone(home, 'worker-stamped', { 'segment-000001.json': 'fresh capture' }, { namedAt: now, oldAt: now - 2 * 60 * 60 * 1000 });
      const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
      mkdirSync(recallRoot, { recursive: true });
      writeFileSync(path.join(recallRoot, '.retention-stamp'), String(now));
      const done = pruneOld({ recallRoot, captureRoots: [path.dirname(tombstone.canonical)], days: 30, now: now + 1000, sessionId: 'another-session' });
      expect(done).toMatchObject({ indexes: 0, captures: 0, tombstones: { restored: 1 } });
      expect(readFileSync(path.join(tombstone.canonical, 'segment-000001.json'), 'utf8')).toBe('fresh capture');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('leaves a fresh tombstone untouched while its canonical capture is occupied', () => {
    const home = tempHome();
    try {
      const now = Date.now();
      const record = (sourceHash: string, value: number) => JSON.stringify({
        kind: 'value', origin: 'reconcile', producedBy: 's4-capture', sourceHash, body: { key: 'port', value },
      });
      const tombstone = writeTombstone(home, 'occupied-fresh', {
        'segment-000002.json': `${record('older-port', 3000)}\n`,
        'segment-000003.json': `${JSON.stringify({ kind: 'user', origin: 'turn', producedBy: 's4-capture', sourceHash: 'extra', body: { text: 'extra segment' } })}\n`,
      }, { namedAt: now });
      mkdirSync(tombstone.canonical, { recursive: true });
      writeFileSync(path.join(tombstone.canonical, 'segment-000001.json'), `${record('current-port', 4000)}\n`);
      const before = snapshot(tombstone.canonical);

      const applied = run(home, ['--apply']);
      expect(applied.status, applied.stderr).toBe(0);
      expect(snapshot(tombstone.canonical)).toEqual(before);
      expect(existsSync(tombstone.dir)).toBe(true);
      expect(existsSync(path.join(tombstone.dir, 'segment-000002.json'))).toBe(true);
      expect(existsSync(path.join(tombstone.dir, 'segment-000003.json'))).toBe(true);

      const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
      const workerNow = Date.now();
      const worker = pruneOld({ recallRoot, captureRoots: [path.dirname(tombstone.canonical)], days: 30, now: workerNow, sessionId: 'another-session' });
      expect(worker?.tombstones).toMatchObject({ left: 1 });
      expect(snapshot(tombstone.canonical)).toEqual(before);
      expect(existsSync(tombstone.dir)).toBe(true);

      const expiredNow = Math.max(workerNow, now) + 31 * DAY;
      age(tombstone.canonical, expiredNow);
      const expired = pruneOld({ recallRoot, captureRoots: [path.dirname(tombstone.canonical)], days: 30, now: expiredNow, sessionId: 'another-session' });
      expect(expired?.tombstones).toMatchObject({ deleted: 1 });
      expect(snapshot(tombstone.canonical)).toEqual(before);
      expect(existsSync(tombstone.dir)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('skips a fresh tombstone from a live pid and never processes the running session capture', () => {
    const home = tempHome();
    try {
      const now = Date.now();
      const live = writeTombstone(home, 'live-owner', { 'segment-000001.json': 'keep' }, { pid: process.pid, namedAt: now });
      const own = writeTombstone(home, 'own-session', { 'segment-000001.json': 'keep' }, { namedAt: now });
      const summary = cleanup({ home, days: 30, apply: true, now, sessionId: 'own-session' });
      expect(summary.prune.tombstones).toMatchObject({ skipped: 2 });
      expect(existsSync(live.dir)).toBe(true);
      expect(existsSync(live.canonical)).toBe(false);
      expect(existsSync(own.dir)).toBe(true);
      expect(existsSync(own.canonical)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('recovers a tombstone left when beforeCaptureDelete throws after the rename', () => {
    const home = tempHome();
    try {
      const oldCapture = writeCapture(home, 'crashed-delete');
      age(oldCapture, Date.now() - 40 * DAY);
      const script = `import { cleanup } from ${JSON.stringify(new URL(`file://${CLEANUP}`).href)}; cleanup({ home: process.env.HOME, days: 30, apply: true, beforeCaptureDelete: () => { throw new Error('simulated crash'); } });`;
      const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
      expect(crashed.status).not.toBe(0);
      const orphan = readdirSync(path.join(home, '.exovault')).find((name) => name.startsWith('.crashed-delete.retention-'));
      expect(orphan).toBeDefined();
      const recovered = cleanup({ home, days: 30, apply: true });
      expect(recovered.prune.tombstones).toMatchObject({ deleted: 1 });
      expect(existsSync(path.join(home, '.exovault', orphan!))).toBe(false);
      expect(existsSync(oldCapture)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('does not follow symlinks while scanning tombstones', () => {
    const home = tempHome();
    try {
      const outside = path.join(home, 'outside.txt');
      writeFileSync(outside, 'outside data');
      const tombstone = writeTombstone(home, 'symlink-retention', { 'ordinary.txt': 'keep in tombstone' });
      symlinkSync(outside, path.join(tombstone.dir, 'link.txt'));
      mkdirSync(tombstone.canonical, { recursive: true });
      const summary = cleanup({ home, days: 30, apply: true });
      expect(summary.prune.tombstones).toMatchObject({ left: 1 });
      expect(existsSync(path.join(tombstone.canonical, 'ordinary.txt'))).toBe(false);
      expect(existsSync(path.join(tombstone.dir, 'link.txt'))).toBe(true);
      expect(readFileSync(outside, 'utf8')).toBe('outside data');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('retention renames an old capture before deleting so a writer can recreate its directory', () => {
    for (const worker of [false, true]) {
      const home = tempHome();
      try {
        const id = worker ? 'retention-worker-race' : 'retention-cleanup-race';
        const capture = writeCapture(home, id);
        age(capture, Date.now() - 40 * DAY);
        const file = path.join(capture, 'segment-000002.json');
        const writeDuringDelete = (dir: string) => {
          mkdirSync(dir, { recursive: true });
          writeFileSync(file, JSON.stringify({ body: { text: 'written after the retention check' } }));
        };
        if (worker) {
          const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
          pruneOld({
            recallRoot,
            captureRoots: [path.join(home, '.exovault', 's4-capture')],
            days: 30,
            beforeCaptureDelete: writeDuringDelete,
          });
        } else cleanup({ home, apply: true, days: 30, beforeCaptureDelete: writeDuringDelete });
        expect.soft(existsSync(file)).toBe(true);
        if (existsSync(file)) expect.soft(readFileSync(file, 'utf8')).toContain('written after the retention check');
      } finally { rmSync(home, { recursive: true, force: true }); }
    }
  });

  it('prunes old sessions at most once a day and never the session being built', () => {
    const home = tempHome();
    try {
      const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
      const captureRoot = path.join(home, '.exovault', 's4-capture');
      const old = writeIndex(home, 'old-session', ['clean row']);
      const current = writeIndex(home, 'current-session', ['clean row']);
      const oldCapture = writeCapture(home, 'old-session');
      const currentCapture = writeCapture(home, 'current-session');
      const past = Date.now() - 40 * DAY;
      for (const dir of [old, current, oldCapture, currentCapture]) age(dir, past);
      const now = Date.now();
      expect(pruneOld({ recallRoot, captureRoots: [captureRoot], days: 30, now, sessionId: 'current-session' })).toMatchObject({ indexes: 1, captures: 1 });
      expect(existsSync(old)).toBe(false);
      expect(existsSync(oldCapture)).toBe(false);
      expect(existsSync(current)).toBe(true);
      expect(existsSync(currentCapture)).toBe(true);
      const again = writeIndex(home, 'old-session', ['clean row']);
      age(again, past);
      expect(pruneOld({ recallRoot, captureRoots: [captureRoot], days: 30, now: now + DAY / 2, sessionId: 'x' })).toBeNull();
      expect(existsSync(again)).toBe(true);
      expect(pruneOld({ recallRoot, captureRoots: [captureRoot], days: 30, now: now + DAY + 1, sessionId: 'x' })).toMatchObject({ indexes: 2 });
      expect(pruneOld({ recallRoot, captureRoots: [captureRoot], days: 0, now: now + 3 * DAY, sessionId: 'x' })).toBeNull();
      // A stamp from the future (the clock went back) does not stop retention until that date.
      writeFileSync(path.join(recallRoot, '.retention-stamp'), String(now + 100 * DAY));
      expect(pruneOld({ recallRoot, captureRoots: [captureRoot], days: 30, now: now + 3 * DAY, sessionId: 'x' })).not.toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('the build worker applies the retention days it is given', () => {
    const home = tempHome();
    try {
      const old = writeIndex(home, 'old-session', ['clean row']);
      age(old, Date.now() - 40 * DAY);
      const transcript = path.join(home, 'session.jsonl');
      writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'new-session', message: { role: 'user', content: 'hello there' } })}\n`);
      const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const size = String(statSync(transcript).size);
      spawnSync(process.execPath, [BUILD_WORKER, transcript, recallRoot, 'new-session', size, home, 'lexical', 'cut', '0'], { env });
      expect(existsSync(old)).toBe(true);
      expect(existsSync(path.join(recallRoot, hash('new-session'), 'CURRENT'))).toBe(true);
      rmSync(path.join(recallRoot, '.retention-stamp'), { force: true });
      spawnSync(process.execPath, [BUILD_WORKER, transcript, recallRoot, 'other-session', size, home, 'lexical', 'cut', '30'], { env });
      expect(existsSync(old)).toBe(false);
      expect(existsSync(path.join(recallRoot, hash('new-session')))).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('new data is redacted when written', () => {
  it('a saved brief keeps its id but stores the redacted text', () => {
    const root = tempHome();
    try {
      const text = `Deploy with ${KEY}\nthen run the tests`;
      const plain = saveBrief(root, 's', 'Deploy with nothing\nthen run the tests');
      const saved = saveBrief(root, 's', text);
      expect(saved.id).not.toBe(plain.id);
      expect(readFileSync(saved.file, 'utf8')).toBe('Deploy with [redacted]\nthen run the tests');
      expect(readFileSync(path.join(saved.dir, 'briefs.json'), 'utf8')).not.toContain(KEY);
      expect(saveBrief(root, 's', text).id).toBe(saved.id);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('captures stay out of git', () => {
  it('the hook writes .exovault/.gitignore once and never replaces one the user wrote', async () => {
    const files = new Map<string, string>();
    const fs = { exists: async (p: string) => files.has(p), write: async (p: string, text: string) => { files.set(p, text); } };
    await ensureCaptureGitignore(fs, '/project');
    expect(files.get('/project/.exovault/.gitignore')).toBe(CAPTURE_GITIGNORE);
    files.set('/project/.exovault/.gitignore', 'mine\n');
    await ensureCaptureGitignore(fs, '/project');
    expect(files.get('/project/.exovault/.gitignore')).toBe('mine\n');
    await ensureCaptureGitignore(fs, '/home/me/');
    expect(files.has('/home/me/.exovault/.gitignore')).toBe(true);
  });

  it('a write failure is swallowed, capture must not fail on it', async () => {
    const fs = { exists: async () => false, write: async () => { throw new Error('read-only'); } };
    await expect(ensureCaptureGitignore(fs, '/ro')).resolves.toBeUndefined();
  });

  it('setup.cjs enable and optout write the same file, and git then ignores everything under .exovault', () => {
    const project = tempHome();
    try {
      expect(spawnSync('git', ['init', '-q', project]).status).toBe(0);
      expect(spawnSync(process.execPath, [SETUP, 'enable', project], { encoding: 'utf8' }).status).toBe(0);
      expect(readFileSync(path.join(project, '.exovault', '.gitignore'), 'utf8')).toBe(CAPTURE_GITIGNORE);
      writeCapture(project, 'some-session');
      const status = spawnSync('git', ['-C', project, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).stdout;
      expect(status).toBe('');
      rmSync(path.join(project, '.exovault', '.gitignore'));
      spawnSync(process.execPath, [SETUP, 'optout', project]);
      expect(readFileSync(path.join(project, '.exovault', '.gitignore'), 'utf8')).toBe(CAPTURE_GITIGNORE);
      writeFileSync(path.join(project, '.exovault', '.gitignore'), 'mine\n');
      spawnSync(process.execPath, [SETUP, 'enable', project]);
      expect(readFileSync(path.join(project, '.exovault', '.gitignore'), 'utf8')).toBe('mine\n');
    } finally { rmSync(project, { recursive: true, force: true }); }
  });
});

describe('cleanup: names, sizes and activity', () => {
  it("a brief save and edit after cleanup's read survive the rewrite", () => {
    const home = tempHome();
    try {
      const sessionId = 'brief-save-race';
      const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
      const index = writeIndex(home, sessionId, ['clean row']);
      const saved = saveBrief(recallRoot, sessionId, `old brief ${KEY}`);
      const list = path.join(saved.dir, 'briefs.json');
      const entries = JSON.parse(readFileSync(list, 'utf8'));
      entries[0].firstLine = `old brief ${KEY}`;
      writeFileSync(list, JSON.stringify(entries));
      writeFileSync(saved.file, `old brief ${KEY}`);
      let laterId = '';
      const summary = cleanup({
        home,
        apply: true,
        days: 0,
        beforeRewrite: (target: string) => {
          if (target === list) laterId = saveBrief(recallRoot, sessionId, 'new brief saved during cleanup').id;
          if (target === saved.file) writeFileSync(saved.file, 'edited brief saved during cleanup');
        },
      });
      const finalEntries = JSON.parse(readFileSync(list, 'utf8'));
      expect(finalEntries.map((entry: { id: string }) => entry.id)).toContain(laterId);
      expect(readFileSync(saved.file, 'utf8')).toBe('edited brief saved during cleanup');
      expect(summary.redact.skipped).toBeGreaterThanOrEqual(2);
      expect(summary.redact.briefs).toBe(0);
      expect(existsSync(index)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a capture root whose path starts with a dash is archived as a name, never read as a tar option', () => {
    const home = tempHome();
    try {
      const capture = writeCapture(path.join(home, '-v'), 'old-session');
      age(capture, Date.now() - 40 * DAY);
      const applied = run(home, ['--apply', '--capture-root', path.join(home, '-v')]);
      expect(applied.stderr).toBe('');
      expect(applied.summary.prune.captures).toBe(1);
      expect(existsSync(capture)).toBe(false);
      const listed = spawnSync('tar', ['-tzf', applied.summary.backup!.file], { encoding: 'utf8' }).stdout;
      expect(listed).toContain('-v/.exovault/s4-capture/old-session/segment-000001.json');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a brief longer than one index chunk keeps every character but the key', () => {
    const home = tempHome();
    try {
      const long = `Use ${KEY} first\n${'requirement line\n'.repeat(4000)}last requirement`;
      const dir = writeIndex(home, 'long-session', ['clean row']);
      writeBrief(dir, long);
      run(home, ['--apply']);
      const kept = readFileSync(path.join(dir, 'briefs', 'aaaaaaaaaaaa.md'), 'utf8');
      expect(kept).toBe(long.replace(KEY, '[redacted]'));
      const saved = saveBrief(path.join(home, 'saved'), 's', long);
      expect(readFileSync(saved.file, 'utf8')).toBe(long.replace(KEY, '[redacted]'));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a key in a record path is redacted too, also when the row text is clean', () => {
    const home = tempHome();
    try {
      const dir = writeIndex(home, 'path-session', ['clean row'], [1]);
      const records = path.join(dir, 'generation-00000001', 'records.json');
      const rows = JSON.parse(readFileSync(records, 'utf8'));
      rows[0].filePath = `/tmp/${KEY}/notes.md`;
      writeFileSync(records, JSON.stringify(rows));
      expect(run(home).summary.redact.rows).toBe(1);
      run(home, ['--apply']);
      expect(readFileSync(records, 'utf8')).not.toContain(KEY);
      expect(JSON.parse(readFileSync(records, 'utf8'))[0].filePath).toBe('/tmp/[redacted]/notes.md');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('an old index stays while the same session still writes captures', () => {
    const home = tempHome();
    try {
      const id = '0b3f6a52-9d0e-4c41-8a55-7f6f2e1c9a10';
      const index = writeIndex(home, id, ['clean row']);
      age(index, Date.now() - 40 * DAY);
      writeCapture(home, id);
      expect(run(home).summary.prune.indexes).toBe(0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a session id the capture path had to sanitize still links its capture to its index', () => {
    const home = tempHome();
    try {
      const id = 'agent:run/1';
      const index = writeIndex(home, id, ['clean row']);
      age(index, Date.now() - 40 * DAY);
      writeCapture(home, 'agent_run_1');
      expect(run(home).summary.prune.indexes).toBe(0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('an index a turn marks in use after the plan is not deleted by --apply', () => {
    const home = tempHome();
    try {
      const index = writeIndex(home, 'resumed-late', ['clean row']);
      age(index, Date.now() - 40 * DAY);
      const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
      const summary = cleanup({ home, recallRoot, captureDirs: [], days: 30, apply: true, afterBackup: () => writeFileSync(path.join(index, 'ACTIVE'), '') });
      expect(existsSync(index)).toBe(true);
      expect(summary.prune.indexes).toBe(0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a session a turn marks in use after the plan keeps its capture too, though the capture did not change', () => {
    const home = tempHome();
    try {
      const id = 'resumed-pair';
      const index = writeIndex(home, id, ['clean row']);
      const capture = writeCapture(home, id);
      age(index, Date.now() - 40 * DAY);
      age(capture, Date.now() - 40 * DAY);
      const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
      const summary = cleanup({ home, recallRoot, days: 30, apply: true, afterBackup: () => writeFileSync(path.join(index, 'ACTIVE'), '') });
      expect(existsSync(index)).toBe(true);
      expect(existsSync(capture)).toBe(true);
      expect(summary.prune).toMatchObject({ indexes: 0, captures: 0 });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('the capture of a session whose build holds its lock is kept, however old', () => {
    const home = tempHome();
    try {
      const id = 'building-now';
      const index = writeIndex(home, id, ['clean row']);
      const capture = writeCapture(home, id);
      age(index, Date.now() - 40 * DAY);
      age(capture, Date.now() - 40 * DAY);
      writeFileSync(path.join(index, 'BUILD_LOCK'), String(process.pid));
      expect(run(home).summary.prune).toMatchObject({ indexes: 0, captures: 0 });
      run(home, ['--apply']);
      expect(existsSync(capture)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('the capture of a sanitized session id stays while its first build holds the lock, before any manifest', () => {
    const home = tempHome();
    try {
      const id = 'team:job';
      const index = path.join(home, '.claude', 'exovault', 'recall', hash(id));
      mkdirSync(index, { recursive: true });
      writeFileSync(path.join(index, 'ACTIVE'), id);
      const capture = writeCapture(home, 'team_job');
      age(index, Date.now() - 40 * DAY);
      age(capture, Date.now() - 40 * DAY);
      writeFileSync(path.join(index, 'BUILD_LOCK'), String(process.pid));
      expect(run(home).summary.prune.captures).toBe(0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a busy index an older worker marked with an empty ACTIVE, before any manifest, keeps every capture', () => {
    const home = tempHome();
    try {
      const index = path.join(home, '.claude', 'exovault', 'recall', hash('team:job'));
      mkdirSync(index, { recursive: true });
      writeFileSync(path.join(index, 'ACTIVE'), '');
      const capture = writeCapture(home, 'team_job');
      age(index, Date.now() - 40 * DAY);
      age(capture, Date.now() - 40 * DAY);
      writeFileSync(path.join(index, 'BUILD_LOCK'), String(process.pid));
      expect(run(home).summary.prune.captures).toBe(0);
      run(home, ['--apply']);
      expect(existsSync(capture)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.each([['run:a/1', 'run_a_1'], ['run_a_1', 'run:a/1']])('a capture name two session ids share belongs to both: busy %s keeps it', (busyId, staleId) => {
    const home = tempHome();
    try {
      const busyIndex = writeIndex(home, busyId, ['clean row']);
      const staleIndex = writeIndex(home, staleId, ['clean row']);
      const capture = writeCapture(home, 'run_a_1');
      for (const dir of [busyIndex, staleIndex, capture]) age(dir, Date.now() - 40 * DAY);
      writeFileSync(path.join(busyIndex, 'BUILD_LOCK'), String(process.pid));
      expect(run(home).summary.prune).toMatchObject({ indexes: 1, captures: 0 });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('the worker retention keeps a capture whose index a turn marks after the plan', () => {
    const home = tempHome();
    try {
      const id = 'resumed-worker';
      const index = writeIndex(home, id, ['clean row']);
      const capture = writeCapture(home, id);
      age(index, Date.now() - 40 * DAY);
      age(capture, Date.now() - 40 * DAY);
      const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
      const done = pruneOld({ recallRoot, captureRoots: [path.join(home, '.exovault', 's4-capture')], days: 30, afterPlan: () => writeFileSync(path.join(index, 'ACTIVE'), id) });
      expect(done).toMatchObject({ indexes: 0, captures: 0 });
      expect(existsSync(capture)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('the worker retention keeps every capture when an older worker marks an unlinked index after the plan', () => {
    const home = tempHome();
    try {
      const index = path.join(home, '.claude', 'exovault', 'recall', hash('team:job'));
      mkdirSync(index, { recursive: true });
      writeFileSync(path.join(index, 'ACTIVE'), '');
      const capture = writeCapture(home, 'team_job');
      age(index, Date.now() - 40 * DAY);
      age(capture, Date.now() - 40 * DAY);
      const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
      const done = pruneOld({ recallRoot, captureRoots: [path.join(home, '.exovault', 's4-capture')], days: 30, afterPlan: () => writeFileSync(path.join(index, 'ACTIVE'), '') });
      expect(done).toMatchObject({ indexes: 0, captures: 0 });
      expect(existsSync(capture)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('the build worker records the raw session id in ACTIVE', () => {
    const home = tempHome();
    try {
      const transcript = path.join(home, 'session.jsonl');
      writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'team:job', message: { role: 'user', content: 'hello there' } })}\n`);
      const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
      spawnSync(process.execPath, [BUILD_WORKER, transcript, recallRoot, 'team:job', String(statSync(transcript).size), home, 'lexical', 'turn', '0'], { env: { ...process.env, HOME: home, USERPROFILE: home } });
      expect(readFileSync(path.join(recallRoot, hash('team:job'), 'ACTIVE'), 'utf8')).toBe('team:job');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a manifest whose session id does not hash to its index links no capture', () => {
    const home = tempHome();
    try {
      const index = writeIndex(home, 'real-id', ['clean row']);
      for (const gen of ['generation-00000001', 'generation-00000002']) {
        writeFileSync(path.join(index, gen, 'manifest.json'), JSON.stringify({ sessionId: 'other:id', generation: 1, cutoffPosition: 10, chunkCount: 1 }));
      }
      age(index, Date.now() - 40 * DAY);
      writeCapture(home, 'other_id');
      expect(run(home).summary.prune.indexes).toBe(1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a turn that is too small to rebuild still marks the index as in use', () => {
    const home = tempHome();
    try {
      const transcript = path.join(home, 'session.jsonl');
      writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'resumed', message: { role: 'user', content: 'hello there' } })}\n`);
      const recallRoot = path.join(home, '.claude', 'exovault', 'recall');
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const size = String(statSync(transcript).size);
      spawnSync(process.execPath, [BUILD_WORKER, transcript, recallRoot, 'resumed', size, home, 'lexical', 'cut', '0'], { env });
      const index = path.join(recallRoot, hash('resumed'));
      age(index, Date.now() - 40 * DAY);
      spawnSync(process.execPath, [BUILD_WORKER, transcript, recallRoot, 'resumed', size, home, 'lexical', 'turn', '0'], { env });
      expect(pruneOld({ recallRoot, days: 30, sessionId: 'someone-else' })).toMatchObject({ indexes: 0 });
      expect(existsSync(index)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a brief save rewrites an older first line in the brief list redacted', () => {
    const root = tempHome();
    try {
      const first = saveBrief(root, 's', 'first brief');
      const list = path.join(first.dir, 'briefs.json');
      const entries = JSON.parse(readFileSync(list, 'utf8'));
      entries[0].firstLine = `use ${KEY}`;
      writeFileSync(list, JSON.stringify(entries));
      saveBrief(root, 's', 'second brief');
      expect(readFileSync(list, 'utf8')).not.toContain(KEY);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

/** A capture as a session leaves it: segments (JSONL, as fs-adapter writes them), the work log, the task card and notices, each holding the key once. */
function writeKeyedCapture(root: string, sessionId: string, ageMs = 2 * 60 * 60 * 1000): string {
  const dir = path.join(root, '.exovault', 's4-capture', sessionId);
  mkdirSync(path.join(dir, 'adopted'), { recursive: true });
  const record = (text: string) => ({ kind: 'user', origin: 'turn', producedBy: 's4-capture', sourceHash: hash(text), body: { text } });
  writeFileSync(path.join(dir, 'segment-000001.json'), [record(`deploy with ${KEY}`), record('plain row')].map((r) => JSON.stringify(r)).join('\n'));
  writeFileSync(path.join(dir, 'work-events.jsonl'), `${JSON.stringify({ type: 'cmd', text: `curl -H ${KEY}` })}\n${JSON.stringify({ type: 'cmd', text: 'ls' })}\n`);
  writeFileSync(path.join(dir, 'task-card.md'), `# Task card\n- token ${KEY}\n- second line\n`);
  writeFileSync(path.join(dir, 'notices.log'), `notice: ${KEY}\n`);
  writeFileSync(path.join(dir, 'adopted', 'abc.md'), `adopted ${KEY}\n`);
  writeFileSync(path.join(dir, 'watermark.json'), JSON.stringify({ watermark: { identities: [hash('a')] } }));
  age(dir, Date.now() - ageMs);
  return dir;
}

describe('cleanup command: capture directories', () => {
  it('a dry run counts the capture files that hold a key and changes nothing', () => {
    const home = tempHome();
    try {
      writeKeyedCapture(home, 'session-c');
      const before = snapshot(home);
      const { summary, status, stderr } = run(home);
      expect(status, stderr).toBe(0);
      expect(summary.redact.captures).toBe(1);
      expect(summary.redact.indexes).toBe(0);
      // segment, work log, task card, notices and the adopted file; the watermark holds no key.
      expect(summary.redact.files).toBe(5);
      expect(snapshot(home)).toEqual(before);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('--apply backs the capture files up, then redacts them in place, keeping every line, record and hash', () => {
    const home = tempHome();
    try {
      const dir = writeKeyedCapture(home, 'session-c');
      const watermark = readFileSync(path.join(dir, 'watermark.json'), 'utf8');
      const { summary, status, stderr } = run(home, ['--apply']);
      expect(status, stderr).toBe(0);
      expect(summary.backup?.files).toBe(5);
      const listed = spawnSync('tar', ['-tzf', summary.backup!.file], { encoding: 'utf8' }).stdout;
      expect(listed).toMatch(/s4-capture\/session-c\/segment-000001\.json/);
      expect(listed).toMatch(/s4-capture\/session-c\/adopted\/abc\.md/);
      expect(JSON.stringify(snapshot(dir))).not.toContain(KEY);
      const records = readFileSync(path.join(dir, 'segment-000001.json'), 'utf8').split('\n').map((line) => JSON.parse(line) as { sourceHash: string; body: { text: string } });
      expect(records.map((record) => record.body.text)).toEqual(['deploy with [redacted]', 'plain row']);
      // The content identity stays the one the capture was written with, so reconcile does not capture the turn again.
      expect(records[0].sourceHash).toBe(hash(`deploy with ${KEY}`));
      expect(readFileSync(path.join(dir, 'work-events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
      expect(readFileSync(path.join(dir, 'task-card.md'), 'utf8')).toBe('# Task card\n- token [redacted]\n- second line\n');
      expect(readFileSync(path.join(dir, 'watermark.json'), 'utf8')).toBe(watermark);
      expect(run(home, ['--apply']).summary.redact.files).toBe(0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a capture written in the last hour is left for a later run, and the report says so', () => {
    const home = tempHome();
    try {
      const dir = writeKeyedCapture(home, 'session-live', 5 * 60 * 1000);
      const before = snapshot(dir);
      const { summary, status, stderr } = run(home, ['--apply']);
      expect(status, stderr).toBe(0);
      expect(summary.redact.captures).toBe(0);
      expect(summary.recentCaptures).toBe(1);
      expect(snapshot(dir)).toEqual(before);
      const text = spawnSync(process.execPath, [CLEANUP], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } }).stdout;
      expect(text).toMatch(/1 capture directory written in the last hour skipped/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('the capture of a session whose build holds its lock is not redacted', () => {
    const home = tempHome();
    try {
      const id = '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
      const index = writeIndex(home, id, ['clean row']);
      writeFileSync(path.join(index, 'ACTIVE'), id);
      writeFileSync(path.join(index, 'BUILD_LOCK'), String(process.pid));
      const dir = writeKeyedCapture(home, id);
      const before = snapshot(dir);
      const { summary } = run(home, ['--apply', '--days', '0']);
      expect(summary.redact.captures).toBe(0);
      expect(snapshot(dir)).toEqual(before);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a capture a session writes to after the backup is left whole, and the counts say so', () => {
    const home = tempHome();
    try {
      const dir = writeKeyedCapture(home, 'session-c');
      const file = path.join(dir, 'notices.log');
      const summary = cleanup({ home, apply: true, afterBackup: () => writeFileSync(file, `notice: ${KEY}\nnew line from the session\n`) });
      expect(readFileSync(file, 'utf8')).toBe(`notice: ${KEY}\nnew line from the session\n`);
      // The session is live again: none of its files is rewritten, not only the one it wrote.
      expect(readFileSync(path.join(dir, 'task-card.md'), 'utf8')).toContain(KEY);
      expect(summary.redact).toMatchObject({ skipped: 5, files: 0, captures: 0 });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a capture that gains a file after the plan is left whole', () => {
    const home = tempHome();
    try {
      const dir = writeKeyedCapture(home, 'session-c');
      const summary = cleanup({ home, apply: true, afterBackup: () => writeFileSync(path.join(dir, 'segment-000002.json'), JSON.stringify({ body: { text: `new ${KEY}` } })) });
      expect(readFileSync(path.join(dir, 'task-card.md'), 'utf8')).toContain(KEY);
      expect(summary.redact).toMatchObject({ files: 0, captures: 0 });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a write between the redaction and the rename is kept, not replaced by the older text', () => {
    const home = tempHome();
    try {
      const dir = writeKeyedCapture(home, 'session-c');
      const file = path.join(dir, 'task-card.md');
      const later = `# Task card\n- token ${KEY}\n- written by the session\n`;
      const summary = cleanup({ home, apply: true, beforeRewrite: (target: string) => { if (target === file) writeFileSync(file, later); } });
      expect(readFileSync(file, 'utf8')).toBe(later);
      expect(summary.redact.skipped).toBeGreaterThanOrEqual(1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('the capture of the session that runs the command is neither redacted nor deleted', () => {
    const home = tempHome();
    try {
      const quiet = writeKeyedCapture(home, 'session-own');
      const before = snapshot(quiet);
      const { summary, status, stderr } = run(home, ['--apply'], 'session-own');
      expect(status, stderr).toBe(0);
      expect(summary.redact.captures).toBe(0);
      expect(snapshot(quiet)).toEqual(before);
      const old = writeKeyedCapture(home, 'session-old-own', 40 * DAY);
      expect(run(home, ['--apply'], 'session-old-own').summary.prune.captures).toBe(0);
      expect(existsSync(old)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a capture root that is a symlink is not followed', () => {
    const home = tempHome();
    const elsewhere = tempHome();
    try {
      const target = writeKeyedCapture(elsewhere, 'session-x');
      writeKeyedCapture(elsewhere, 'session-old', 40 * DAY);
      mkdirSync(path.join(home, '.exovault'), { recursive: true });
      symlinkSync(path.join(elsewhere, '.exovault', 's4-capture'), path.join(home, '.exovault', 's4-capture'));
      const before = snapshot(path.join(elsewhere, '.exovault'));
      const { summary, status, stderr } = run(home, ['--apply']);
      expect(status, stderr).toBe(0);
      expect(summary.redact.captures).toBe(0);
      expect(summary.prune.captures).toBe(0);
      expect(snapshot(path.join(elsewhere, '.exovault'))).toEqual(before);
      expect(existsSync(target)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
  });

  it('adopted.json keeps the paths its copies are found by, and drops an entry whose path holds a key', () => {
    const home = tempHome();
    try {
      const dir = writeKeyedCapture(home, 'session-c');
      const original = '/work/project/CLAUDE.md';
      const entry = { path: original, savedPath: path.join(dir, 'adopted', 'abc.md'), chars: 10, at: '2026-10-01T00:00:00Z', note: `from ${KEY}` };
      // isSecretLikePath looks at names (.env, keys/), so the hook adopts a rules file under a key-shaped directory.
      const keyed = { path: `/work/${KEY}/CLAUDE.md`, savedPath: path.join(dir, 'adopted', 'def.md'), chars: 10, at: '2026-10-01T00:00:00Z' };
      // Not an entry the hook reads (its path is no string), and no way around the check either.
      const odd = { path: [`/work/${KEY}/CLAUDE.md`], savedPath: path.join(dir, 'adopted', 'ghi.md'), chars: 10, at: '2026-10-01T00:00:00Z' };
      writeFileSync(path.join(dir, 'adopted.json'), JSON.stringify([entry, keyed, odd]));
      age(dir, Date.now() - 2 * 60 * 60 * 1000);
      run(home, ['--apply']);
      const text = readFileSync(path.join(dir, 'adopted.json'), 'utf8');
      expect(text).not.toContain(KEY);
      const kept = JSON.parse(text) as typeof entry[];
      expect(kept).toHaveLength(1);
      expect(kept[0]!.path).toBe(original);
      expect(kept[0]!.savedPath).toBe(entry.savedPath);
      expect(kept[0]!.note).toBe('from [redacted]');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a key used as a property name is redacted too (a segment record, a single-object adopted.json)', () => {
    const home = tempHome();
    try {
      const dir = writeKeyedCapture(home, 'session-k');
      writeFileSync(path.join(dir, 'segment-000002.json'), JSON.stringify({ kind: 'tool', body: { env: { [KEY]: 'set' } } }));
      writeFileSync(path.join(dir, 'adopted.json'), JSON.stringify({ path: { [KEY]: 'x' }, savedPath: 'y', chars: 1, at: 'z' }));
      age(dir, Date.now() - 2 * 60 * 60 * 1000);
      run(home, ['--apply']);
      for (const name of ['segment-000002.json', 'adopted.json']) expect(readFileSync(path.join(dir, name), 'utf8')).not.toContain(KEY);
      expect(JSON.parse(readFileSync(path.join(dir, 'segment-000002.json'), 'utf8')).body.env).toEqual({ '[redacted]': 'set' });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a value named as a secret by its property is redacted, the JSON stays whole', () => {
    const home = tempHome();
    try {
      const dir = writeKeyedCapture(home, 'session-n');
      writeFileSync(path.join(dir, 'segment-000002.json'), JSON.stringify({ kind: 'tool', body: { apiKey: 'hunter2', headers: { Authorization: 'Bearer abc.def' }, note: 'ok', retries: 3 } }));
      const entry = { path: '/work/project/CLAUDE.md', savedPath: path.join(dir, 'adopted', 'abc.md'), chars: 10, at: '2026-10-01T00:00:00Z', password: 'p@ss w0rd!' };
      writeFileSync(path.join(dir, 'adopted.json'), JSON.stringify([entry]));
      age(dir, Date.now() - 2 * 60 * 60 * 1000);
      run(home, ['--apply']);
      const body = JSON.parse(readFileSync(path.join(dir, 'segment-000002.json'), 'utf8')).body;
      expect(body).toEqual({ apiKey: '[redacted]', headers: { Authorization: '[redacted]' }, note: 'ok', retries: 3 });
      const [kept] = JSON.parse(readFileSync(path.join(dir, 'adopted.json'), 'utf8'));
      expect(kept).toEqual({ ...entry, password: '[redacted]' });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a list or object named as a secret by its property is redacted in every string below it', () => {
    const home = tempHome();
    try {
      const dir = writeKeyedCapture(home, 'session-o');
      writeFileSync(path.join(dir, 'segment-000002.json'), JSON.stringify({ kind: 'tool', body: { apiKey: ['hunter2'], credentials: { user: 'me', pass: 'p@ss w0rd!', n: 3 }, note: ['ok'] } }));
      const entry = { path: '/work/project/CLAUDE.md', savedPath: path.join(dir, 'adopted', 'abc.md'), chars: 10, at: '2026-10-01T00:00:00Z', password: ['p@ss w0rd!'] };
      writeFileSync(path.join(dir, 'adopted.json'), JSON.stringify([entry]));
      age(dir, Date.now() - 2 * 60 * 60 * 1000);
      run(home, ['--apply']);
      const body = JSON.parse(readFileSync(path.join(dir, 'segment-000002.json'), 'utf8')).body;
      expect(body).toEqual({ apiKey: ['[redacted]'], credentials: { user: '[redacted]', pass: '[redacted]', n: 3 }, note: ['ok'] });
      const [kept] = JSON.parse(readFileSync(path.join(dir, 'adopted.json'), 'utf8'));
      expect(kept).toEqual({ ...entry, password: ['[redacted]'] });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a capture old enough for retention is deleted, not redacted, and --capture-root captures are redacted too', () => {
    const home = tempHome();
    const project = mkdtempSync(path.join(os.tmpdir(), 'exo-project-'));
    try {
      writeKeyedCapture(home, 'session-old', 40 * DAY);
      const projectCapture = writeKeyedCapture(project, 'session-p');
      const { summary } = run(home, ['--apply', '--capture-root', project]);
      expect(summary.prune.captures).toBe(1);
      expect(summary.redact.captures).toBe(1);
      expect(JSON.stringify(snapshot(projectCapture))).not.toContain(KEY);
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
  });
});
