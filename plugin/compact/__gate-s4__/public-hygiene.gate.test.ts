import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PRIVATE_PATHS } from '../../../tools/public-tree.mjs';

/**
 * Public-release hygiene. The repository is published in English, without the names, paths and
 * addresses of the project it was built in. Every tracked file is scanned line by line.
 *
 * Left out of the scan:
 * - three paths that stay in the private repository and are dropped when the public tree is built
 *   (PRIVATE_PATHS, from tools/public-tree.mjs, which builds that tree);
 * - this file, which has to spell the banned patterns;
 * - the functional Polish cue lines (POLISH_CUE_LINES): the plugin deliberately understands rules,
 *   questions and facts written in Polish, and its tests feed it Polish input.
 *
 * Binary files (a NUL byte in the first 8000 bytes, the rule git uses; the README images are PNG) are
 * scanned for the banned patterns only: their bytes decode to random letters, Polish ones included.
 *
 * Outside a git checkout (the published tree has no `.git`) the scan walks the directory instead.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SELF = 'plugin/compact/__gate-s4__/public-hygiene.gate.test.ts';

/** Polish diacritics, including `ó`, which the Polish cue lists use too. */
const DIACRITICS = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;

/**
 * File -> inclusive [first, last] line ranges that may hold Polish. Each range is a Polish cue list
 * the product reads (core/*, recall/rank.mjs, tools/real-replay), its test input, or a doc line that quotes
 * those cues with an English gloss. Any other line with a Polish letter fails the scan.
 */
const POLISH_CUE_LINES: Record<string, Array<[number, number]>> = {
  'plugin/compact/CONTRACT.md': [[305, 305], [1530, 1530], [2303, 2303], [2309, 2309], [2333, 2333], [2538, 2538]],
  'plugin/compact/__gate-s4__/adopted.gate.test.ts': [[19, 19], [21, 21], [100, 100], [121, 121], [128, 128]],
  'plugin/compact/__gate-s4__/broken/constraints.ts': [[5, 5], [8, 8]],
  'plugin/compact/__gate-s4__/broken/key-facts.ts': [[8, 8], [13, 13]],
  'plugin/compact/__gate-s4__/compact.gate.test.ts': [[891, 893], [899, 899], [902, 902], [941, 941]],
  'plugin/compact/__gate-s4__/constraints.gate.test.ts': [[74, 74], [87, 87], [90, 90], [131, 131], [434, 435]],
  'plugin/compact/__gate-s4__/key-facts.gate.test.ts': [[109, 109], [113, 113], [115, 115], [603, 603], [608, 609], [619, 619], [625, 625]],
  'plugin/compact/__gate-s4__/labels.gate.test.ts': [[58, 59], [61, 61]],
  'plugin/compact/__gate-s4__/live-cut-fixes.gate.test.ts': [[26, 28], [30, 31]],
  'plugin/compact/__gate-s4__/review-r1-fixes.gate.test.ts': [[26, 27], [29, 30]],
  'plugin/compact/__gate-s4__/state-updates.gate.test.ts': [[18, 19]],
  'plugin/compact/core/adopted.ts': [[20, 20], [22, 22], [24, 25]],
  'plugin/compact/core/constraints.ts': [[18, 18], [25, 25], [109, 109], [152, 152]],
  'plugin/compact/core/dense.ts': [[19, 20]],
  'plugin/compact/core/key-facts.ts': [[51, 51], [69, 69], [203, 203]],
  'plugin/compact/core/labels.ts': [[51, 51], [55, 55]],
  'plugin/compact/core/state-updates.ts': [[33, 33], [37, 37], [39, 39]],
  'plugin/compact/recall/rank.mjs': [[20, 21]],
  'tools/real-replay/real-replay.mjs': [[378, 378]],
};

/**
 * Patterns that must not appear anywhere. Names are matched case-insensitively and as whole words,
 * so the functional `exovault` names stay allowed.
 */
const BANNED: Array<{ name: string; pattern: RegExp }> = [
  { name: 'private home path', pattern: /home[\/-]agent\b/i },
  { name: 'internal name', pattern: /\b(?:fractal|cockpit|luna|astra|exoloop|exo-vault-codex|conduct-s4|ctx-s4[a-z]|ab-w17)\b/i },
  { name: 'personal mail address', pattern: /sufa\.marcin@/i },
  { name: 'fictional owner name from the old fixtures', pattern: /zaleska/i },
  { name: 'first name of the maintainer outside the author line', pattern: /\bMarcin\b(?! Sufa)/ },
];

function isPrivate(file: string): boolean {
  return PRIVATE_PATHS.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(dir, rel))) {
    if (name === 'node_modules' || name === '.git') continue;
    const next = rel ? `${rel}/${name}` : name;
    if (statSync(path.join(dir, next)).isDirectory()) out.push(...walk(dir, next));
    else out.push(next);
  }
  return out;
}

function trackedFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter(Boolean);
  } catch {
    return walk(ROOT);
  }
}

function scannedFiles(): string[] {
  return trackedFiles().filter((file) => !isPrivate(file) && file !== SELF && file !== 'package-lock.json');
}

function allowed(file: string, line: number): boolean {
  return (POLISH_CUE_LINES[file] ?? []).some(([first, last]) => line >= first && line <= last);
}

function scan(): { banned: string[]; polish: string[] } {
  const banned: string[] = [];
  const polish: string[] = [];
  for (const file of scannedFiles()) {
    let text: string;
    try {
      text = readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    const binary = text.slice(0, 8000).includes('\0');
    const lines = text.split('\n');
    lines.forEach((content, index) => {
      const line = index + 1;
      for (const { name, pattern } of BANNED) {
        if (pattern.test(content)) banned.push(`${file}:${line} ${name}: ${content.trim().slice(0, 100)}`);
      }
      if (!binary && DIACRITICS.test(content) && !allowed(file, line)) polish.push(`${file}:${line} ${content.trim().slice(0, 100)}`);
    });
  }
  return { banned, polish };
}

describe('public release hygiene', () => {
  const result = scan();

  it('no internal project name, private path, personal address or fictional owner name in any shipped file', () => {
    expect(result.banned).toEqual([]);
  });

  it('no Polish letter outside the functional Polish cue lines', () => {
    expect(result.polish).toEqual([]);
  });

  it('every allowed Polish cue range still holds a Polish letter, so the allowlist cannot go stale', () => {
    const stale: string[] = [];
    for (const [file, ranges] of Object.entries(POLISH_CUE_LINES)) {
      let lines: string[] = [];
      try {
        lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n');
      } catch {
        stale.push(`${file} is missing`);
        continue;
      }
      for (const [first, last] of ranges) {
        if (!lines.slice(first - 1, last).some((content) => DIACRITICS.test(content))) stale.push(`${file}:${first}-${last}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('the scan skips only the three private paths, this file and the lockfile', () => {
    expect(PRIVATE_PATHS).toEqual(['docs/ctx-s4/', 'tools/ctxbench/', 'plugin/compact/__gate-s4__/GATE.md']);
    const scanned = new Set(scannedFiles());
    const skipped = trackedFiles().filter((file) => !scanned.has(file));
    const unexpected = skipped.filter(
      (file) =>
        !file.startsWith('docs/ctx-s4/') &&
        !file.startsWith('tools/ctxbench/') &&
        file !== 'plugin/compact/__gate-s4__/GATE.md' &&
        file !== SELF &&
        file !== 'package-lock.json',
    );
    expect(unexpected).toEqual([]);
    for (const file of ['README.md', 'CHANGELOG.md', 'docs/how-it-works.md', 'plugin/compact/compact.ts', 'plugin/compact/CONTRACT.md', 'tools/status.mjs']) {
      expect(scanned.has(file), file).toBe(true);
    }
  });

  it('the banned patterns catch the spellings that slipped through before', () => {
    const hit = (text: string): boolean => BANNED.some(({ pattern }) => pattern.test(text));
    for (const text of ['/home/agent/work', '-tmp-claude-1001--home-agent', 'ctx-s4b', 'feat/ctx-s4c-x', 'Fractal', '@fractal/cockpit']) {
      expect(hit(text), text).toBe(true);
    }
    for (const text of ['docs/ctx-s4/briefs', '__gate-s4__', '.exovault/s4-capture', 'exovault-s4-compact', '/home/user1/work', 'Marcin Sufa']) {
      expect(hit(text), text).toBe(false);
    }
  });
});
