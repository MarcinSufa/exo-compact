import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * A fresh clone (and CI) must typecheck and test without the files Claude Code generates beside the mod.
 * Those declarations are gitignored (not redistributed), so `npm run typecheck` reads a committed stub of
 * the `claude-code` module instead; `npm run typecheck:full` checks against the generated file locally.
 *
 * Outside a git checkout (the published tree has no `.git`) a file only has to exist.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TSCONFIGS = ['plugin/compact/tsconfig.json', 'plugin/compact-trigger/tsconfig.json'];

function trackedFiles(): Set<string> | undefined {
  try {
    return new Set(execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean));
  } catch {
    return undefined;
  }
}

const readJson = (file: string) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));

describe('clean clone: typecheck and CI', () => {
  it.each(TSCONFIGS)('%s lists only committed files', (tsconfig) => {
    const tracked = trackedFiles();
    const files: string[] = readJson(tsconfig).files ?? [];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const relative = path.relative(ROOT, path.resolve(ROOT, path.dirname(tsconfig), file)).split(path.sep).join('/');
      expect(tracked ? tracked.has(relative) : existsSync(path.join(ROOT, relative)), relative).toBe(true);
    }
  });

  it('npm run typecheck covers both plugins', () => {
    const script: string = readJson('package.json').scripts.typecheck;
    expect(script).toContain('plugin/compact ');
    expect(script).toContain('plugin/compact-trigger');
  });

  it('CI installs from the lockfile, typechecks and runs the whole suite', () => {
    const workflow = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    for (const step of ['npm ci', 'npm run typecheck', 'npm test']) expect(workflow).toContain(step);
  });

  it('npm test (so CI) runs every test file under tools/ with the runner it is written for, the installer tests included', () => {
    const script: string = readJson('package.json').scripts.test;
    const [vitestPart, nodePart] = script.split(' && ');
    expect(vitestPart).toMatch(/^vitest run /);
    expect(nodePart).toMatch(/^node .*--test /);
    // Without .git (a published tree, also one inside another checkout) the files on disk stand in for the tracked ones.
    const tracked = trackedFiles();
    const listed = tracked?.size ? tracked : new Set(readdirSync(path.join(ROOT, 'tools'), { recursive: true, encoding: 'utf8' }).map((file) => `tools/${file.split(path.sep).join('/')}`));
    const toolTests = [...listed].filter((file) => file.startsWith('tools/') && file.endsWith('.test.mjs') && !file.startsWith('tools/ctxbench/') && !file.includes('/node_modules/'));
    expect(toolTests).toContain('tools/install/install.test.mjs');
    const words = (part: string) => part.split(/\s+/);
    for (const file of toolTests) {
      // node --test does not run vitest's describe/it: such a file would pass there with none of its assertions run.
      const vitest = /\bfrom\s*['"]vitest['"]/.test(readFileSync(path.join(ROOT, file), 'utf8'));
      expect(words(vitest ? vitestPart : nodePart), file).toContain(file);
      expect(words(vitest ? nodePart : vitestPart), file).not.toContain(file);
    }
  });

  it('CI runs on pull requests, on both supported Node versions, without keeping the checkout token', () => {
    const workflow = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toMatch(/^on:\n(?:  .*\n)*  pull_request:/m);
    expect(workflow).toMatch(/^\s+node: \['22\.15', '24'\]$/m);
    expect(workflow).toMatch(/uses: actions\/checkout@v\d+\n\s+with:\n\s+persist-credentials: false/);
  });
});
