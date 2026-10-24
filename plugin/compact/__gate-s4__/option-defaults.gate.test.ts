// A native install passes only what Claude Code stores. Its typings say the options reach `register` "with defaults
// filled in" from the manifest, but the code fallbacks must not depend on that: every `optionBoolean/String/Number`
// call in the hook module and its helpers has to fall back to the manifest default, so both paths run the same plugin.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')) as { userConfig: Record<string, { default?: unknown }> };

function sources(): string[] {
  const files = [path.join(root, 'compact.ts')];
  for (const dir of ['core', 'host']) {
    for (const entry of readdirSync(path.join(root, dir))) if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) files.push(path.join(root, dir, entry));
  }
  return files.map((file) => readFileSync(file, 'utf8'));
}

function constants(texts: string[]): Map<string, unknown> {
  const found = new Map<string, unknown>();
  for (const text of texts) {
    for (const match of text.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*(-?\d+(?:_\d+)*|'[^']*'|true|false)\s*;/g)) {
      found.set(match[1], literal(match[2], new Map()));
    }
  }
  return found;
}

function literal(text: string, names: Map<string, unknown>): unknown {
  const value = text.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?[\d_]+$/.test(value)) return Number(value.replace(/_/g, ''));
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1);
  if (names.has(value)) return names.get(value);
  // `flag ? A : B`: the first branch is the one that matches the manifest default of the flag.
  const ternary = /^[A-Za-z]+\s*\?\s*([^:]+?)\s*:\s*(.+)$/.exec(value);
  if (ternary) return literal(ternary[1], names);
  throw new Error(`cannot read the fallback ${value}`);
}

describe('option fallbacks in code equal the manifest defaults', () => {
  const texts = sources();
  const names = constants(texts);
  const calls: { name: string; fallback: unknown; text: string }[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(/option(?:Boolean|String|Number)\(options,\s*'([A-Za-z]+)',\s*([^;\n]*?)\)(?=[\s,;)}\]&|?:]|$)/gm)) {
      // The fallback is everything up to the call's closing parenthesis; strip a trailing `)` that belongs to the caller.
      const raw = match[2];
      let depth = 0;
      let end = raw.length;
      for (let i = 0; i < raw.length; i += 1) {
        if (raw[i] === '(') depth += 1;
        else if (raw[i] === ')') { if (depth === 0) { end = i; break; } depth -= 1; }
      }
      calls.push({ name: match[1], fallback: literal(raw.slice(0, end), names), text: raw });
    }
  }

  it('finds the calls', () => {
    expect(calls.length).toBeGreaterThan(40);
    for (const name of ['recallEnabled', 'interactiveOnly', 'briefPush', 'briefCheck']) expect(calls.some((call) => call.name === name)).toBe(true);
  });

  it('every fallback equals the manifest default of that option', () => {
    const mismatches = calls
      .filter((call) => manifest.userConfig[call.name] !== undefined && manifest.userConfig[call.name].default !== call.fallback)
      .map((call) => `${call.name}: code ${JSON.stringify(call.fallback)} vs manifest ${JSON.stringify(manifest.userConfig[call.name].default)}`);
    expect([...new Set(mismatches)]).toEqual([]);
  });

  it('every option read through a helper is declared in the manifest', () => {
    expect(calls.filter((call) => manifest.userConfig[call.name] === undefined).map((call) => call.name)).toEqual([]);
  });
});
