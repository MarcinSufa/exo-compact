import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * 4.8.1: the installers install a release tag, not main, so every place that names the version has to name the same
 * one. A version bump that misses one of them would install another release than the manifest says, or none.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const VERSION: string = JSON.parse(read('package.json')).version;
const TAG = `v${VERSION}`;

describe('release: one version everywhere', () => {
  it('the version is plain x.y.z', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('plugin.json has the package version', () => {
    expect(JSON.parse(read('plugin/compact/.claude-plugin/plugin.json')).version).toBe(VERSION);
  });

  it('package-lock.json has the package version', () => {
    const lock = JSON.parse(read('package-lock.json'));
    expect(lock.version).toBe(VERSION);
    expect(lock.packages[''].version).toBe(VERSION);
  });

  it('the README badge shows it', () => {
    expect(read('README.md')).toContain(`badge/version-${VERSION}-blue`);
  });

  it('the first CHANGELOG section is this version, with a date, after at most one Unreleased section', () => {
    const sections = [...read('CHANGELOG.md').matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    const released = sections[0] === 'Unreleased' ? sections.slice(1) : sections;
    expect(released[0]).toMatch(new RegExp(`^${VERSION.replaceAll('.', '\\.')} - \\d{4}-\\d{2}-\\d{2}$`));
    expect(released).not.toContain('Unreleased');
  });

  it('install.sh installs the release tag by default', () => {
    expect(read('install.sh')).toContain(`local ref="\${EXO_COMPACT_REF:-${TAG}}"`);
  });

  it('install.ps1 installs the release tag by default', () => {
    expect(read('install.ps1')).toContain(`$ref = if ($env:EXO_COMPACT_REF) { $env:EXO_COMPACT_REF } else { '${TAG}' }`);
  });
});
