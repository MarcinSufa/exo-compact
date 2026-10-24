import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM module without types
import * as doctor from '../doctor.mjs';

const CANARY = 'sk-canary-4f1d9e-never-print';
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

type Response = { status: number; ok: boolean; text: () => Promise<string> };
const reply = (status: number, body: string): Response => ({ status, ok: status >= 200 && status < 300, text: async () => body });

function deps(overrides: Record<string, unknown> = {}) {
  return {
    env: { TYPESAFE_API_KEY: CANARY },
    nodeVersion: '22.23.2',
    claudeVersion: async () => '2.1.283 (Claude Code)',
    fileExists: () => true,
    fetch: async () => reply(200, JSON.stringify({ model: 'jev-1', answers: {} })),
    jev: false,
    pluginRoot: '/plugin',
    ...overrides,
  };
}

async function run(overrides: Record<string, unknown> = {}) {
  const result = await doctor.runDoctor(deps(overrides));
  const output = `${doctor.formatReport(result)}\n${JSON.stringify(result)}`;
  expect(output).not.toContain(CANARY);
  return { result, code: doctor.exitCode(result), output };
}

function repoText(name: string): string {
  return readFileSync(path.join(repoRoot, name), 'utf8');
}

function changelog475(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('## 4.7.6'));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => line.startsWith('## '));
  return (next < 0 ? rest : rest.slice(0, next)).join('\n');
}

function hostSupport(text: string): string {
  const marker = '**Host support.**';
  const start = text.indexOf(marker);
  if (start < 0) return '';
  const rest = text.slice(start);
  const blank = rest.search(/\r?\n\r?\n/);
  return blank < 0 ? rest : rest.slice(0, blank);
}

describe('minimum Claude Code', () => {
  it('M1 doctor.MIN_CLAUDE equals 2.1.278', () => {
    expect(doctor.MIN_CLAUDE).toBe('2.1.278');
  });

  it('M2 Claude Code 2.1.277 is below the minimum', async () => {
    const r = await run({ claudeVersion: async () => '2.1.277 (Claude Code)' });
    expect(r.code).toBe(1);
    expect(r.output).toContain('need >= 2.1.278');
    expect(r.output).toContain('claude update');
  });

  it('M3 Claude Code 2.1.278 passes the claude check', async () => {
    const r = await run({ claudeVersion: async () => '2.1.278 (Claude Code)' });
    expect(r.result.checks.find((check: { id: string }) => check.id === 'claude').status).toBe('ok');
  });

  it('M4 Claude Code 2.1.274 is a hard failure', async () => {
    const r = await run({ claudeVersion: async () => '2.1.274 (Claude Code)' });
    expect(r.code).toBe(1);
  });

  it('M5 README drops 2.1.274 and names 2.1.278', () => {
    const readme = repoText('README.md');
    expect(readme).not.toContain('2.1.274');
    expect(readme).toContain('%E2%89%A5%202.1.278');
    expect(readme).toMatch(/Claude Code (≥ )?2\.1\.278/);
  });

  // 2026-10-19: 2.1.278 and 2.1.284 load the plugin without the hooks flag, so the old "needed on 2.1.278 to 2.1.286" is gone.
  it('M6 configuration says the hooks flag is not needed from the minimum 2.1.278 on', () => {
    const doc = repoText('docs/configuration.md');
    expect(doc).toContain('checked on 2.1.278');
    expect(doc).not.toContain('2.1.278 to 2.1.286');
    expect(doc).not.toContain('2.1.274');
  });

  it('M7 changelog 4.7.6 states the new minimum', () => {
    const section = changelog475(repoText('CHANGELOG.md'));
    expect(section).toContain('minimum');
    expect(section).toContain('2.1.278');
    expect(section).not.toContain('unverified');
    expect(section).toContain('rises from 2.1.274 to 2.1.278');
    expect(section).toContain('claude update');
  });

  it('M8 contract host support names MIN_CLAUDE 2.1.278', () => {
    const paragraph = hostSupport(repoText('plugin/compact/CONTRACT.md'));
    expect(paragraph.startsWith('**Host support.**')).toBe(true);
    expect(paragraph).toContain('`MIN_CLAUDE` is 2.1.278');
    expect(paragraph).not.toContain('are unchanged');
  });
});
