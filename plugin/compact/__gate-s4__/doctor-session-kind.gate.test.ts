import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM module without types
import * as doctor from '../doctor.mjs';

const CANARY = 'sk-canary-4f1d9e-never-print';

type Response = { status: number; ok: boolean; text: () => Promise<string> };
const reply = (status: number, body: string): Response => ({ status, ok: status >= 200 && status < 300, text: async () => body });

function norm(file: string): string {
  const slashed = String(file).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/\/+/g, '/');
  return slashed.length > 1 ? slashed.replace(/\/$/, '') : slashed;
}

function deps(overrides: Record<string, unknown> = {}) {
  const fetchCalls: unknown[][] = [];
  const envReads: string[] = [];
  const { env: envOverride, ...rest } = overrides;
  const env = new Proxy({ TYPESAFE_API_KEY: CANARY, ...(envOverride as Record<string, string | undefined> | undefined) } as Record<string, string | undefined>, {
    get: (target, name) => { envReads.push(String(name)); return target[String(name)]; },
  });
  return {
    fetchCalls,
    envReads,
    value: {
      env,
      nodeVersion: '22.23.2',
      claudeVersion: async () => '2.1.283 (Claude Code)',
      fileExists: () => true,
      fetch: async (...args: unknown[]) => { fetchCalls.push(args); return reply(200, JSON.stringify({ model: 'jev-1', answers: {} })); },
      jev: false,
      pluginRoot: '/plugin',
      cwd: '/work/proj',
      home: '/users/me',
      readFile: () => { throw new Error('ENOENT'); },
      ...rest,
    },
  };
}

function io(options: { flags?: string[]; files?: Record<string, string> } = {}) {
  const flags = new Set((options.flags ?? []).map(norm));
  const files = new Map(Object.entries(options.files ?? {}).map(([file, text]) => [norm(file), text]));
  return {
    readFile: (file: string) => {
      const key = norm(file);
      if (files.has(key)) return files.get(key)!;
      if (flags.has(key)) return '1';
      throw new Error(`ENOENT ${key}`);
    },
    fileExists: (file: string) => {
      const key = norm(file);
      if (key.includes('/.exovault/s4-compact-')) return flags.has(key);
      if (key.endsWith('/settings.json') || key.endsWith('/settings.local.json')) return files.has(key);
      return true;
    },
  };
}

type Check = { id: string; status: string; message: string };

async function run(overrides: Record<string, unknown> = {}) {
  const d = deps(overrides);
  const result = await doctor.runDoctor(d.value);
  const output = `${doctor.formatReport(result)}\n${JSON.stringify(result)}`;
  expect(output).not.toContain(CANARY);
  return { ...d, result, code: doctor.exitCode(result), output };
}

function check(result: { checks: Check[] }, id: string): Check {
  const found = result.checks.find((item) => item.id === id);
  expect(found, `missing check ${id}`).toBeTruthy();
  return found!;
}

const CWD = '/work/proj';
const HOME = '/users/me';
const INTERACTIVE_ONLY_HINT = 'To use S4 in -p and SDK runs too (for example a benchmark): claude plugin install exo-compact@exo-compact --config interactiveOnly=false';
const active = (dir: string) => `${dir}/.exovault/s4-compact-active`;
const off = (dir: string) => `${dir}/.exovault/s4-compact-off`;

function settings(interactiveOnly: boolean, key = 'exo-compact@exo-compact') {
  return JSON.stringify({ pluginConfigs: { [key]: { options: { interactiveOnly } } } });
}

function folded(message: string) {
  return message.replace(/\\/g, '/');
}

describe('doctor capture-flag', () => {
  it('is ok when no flag is found, because an installed plugin is enabled', async () => {
    const r = await run({ cwd: CWD, home: HOME, ...io() });
    const flag = check(r.result, 'capture-flag');
    expect(flag.status).toBe('ok');
    expect(flag.message).toContain('installed');
    expect(folded(flag.message)).toContain(CWD);
    expect(r.code).toBe(0);
  });

  it('warns when no flag is found and no home directory can be resolved', async () => {
    const r = await run({ cwd: CWD, home: '', ...io() });
    expect(check(r.result, 'capture-flag').status).toBe('warn');
  });

  it('warns when the home directory opts out and no nearer file decides', async () => {
    const r = await run({ cwd: CWD, home: HOME, ...io({ flags: [off(HOME)] }) });
    const flag = check(r.result, 'capture-flag');
    expect(flag.status).toBe('warn');
    expect(folded(flag.message)).toContain(CWD);
  });

  it('is ok when the cwd holds s4-compact-active', async () => {
    const r = await run({ cwd: CWD, home: HOME, ...io({ flags: [active(CWD)] }) });
    expect(check(r.result, 'capture-flag').status).toBe('ok');
  });

  it('is ok when a parent holds s4-compact-active', async () => {
    const r = await run({ cwd: CWD, home: HOME, ...io({ flags: [active('/work')] }) });
    expect(check(r.result, 'capture-flag').status).toBe('ok');
  });

  it('warns when the nearest directory opts out, even if a parent is active', async () => {
    const r = await run({ cwd: CWD, home: HOME, ...io({ flags: [off(CWD), active('/work')] }) });
    const flag = check(r.result, 'capture-flag');
    expect(flag.status).toBe('warn');
    expect(flag.message).toContain('not enabled');
    expect(folded(flag.message)).toContain(CWD);
  });

  it('is ok when both flag files sit in one directory, because active wins', async () => {
    const r = await run({ cwd: CWD, home: HOME, ...io({ flags: [active(CWD), off(CWD)] }) });
    expect(check(r.result, 'capture-flag').status).toBe('ok');
  });

  it('treats a flag in the home directory like any other directory above the cwd', async () => {
    const r = await run({ cwd: '/elsewhere/proj', home: HOME, ...io({ flags: [active(HOME)] }) });
    const flag = check(r.result, 'capture-flag');
    expect(flag.status).toBe('ok');
    expect(flag.message).not.toContain(HOME);
  });
});

describe('doctor interactive-only', () => {
  const user = `${HOME}/.claude/settings.json`;
  const project = `${CWD}/.claude/settings.json`;
  const local = `${CWD}/.claude/settings.local.json`;

  async function session(files: Record<string, string>, env: Record<string, string | undefined> = {}) {
    return run({ cwd: CWD, home: HOME, env, ...io({ flags: [active(CWD)], files }) });
  }

  it('defaults to on when the option is absent', async () => {
    const absent = await session({});
    const absentRow = check(absent.result, 'interactive-only');
    expect(absentRow.status).toBe('ok');
    expect(absentRow.message).toContain('interactiveOnly: on');
    expect(absentRow.message).toContain('-p');
    expect(absentRow.message).toContain('SDK runs stay on native compaction');
    expect(absentRow.message.endsWith(` ${INTERACTIVE_ONLY_HINT}`)).toBe(true);
  });

  it('warns when the option is absent and the entrypoint is sdk-cli', async () => {
    const absent = await session({}, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
    const absentRow = check(absent.result, 'interactive-only');
    expect(absentRow.status).toBe('warn');
    expect(absentRow.message).toContain('interactiveOnly');
    expect(absentRow.message).toContain('sdk-cli');
    expect(absentRow.message).toContain('native');
    expect(absentRow.message.endsWith(` ${INTERACTIVE_ONLY_HINT}`)).toBe(true);
  });

  it('is ok when the option is explicitly false everywhere', async () => {
    const explicit = await session({ [user]: settings(false), [project]: settings(false), [local]: settings(false) });
    const explicitRow = check(explicit.result, 'interactive-only');
    expect(explicitRow.status).toBe('ok');
    expect(explicitRow.message).toBe('interactiveOnly: off, every session kind uses S4');
    expect(explicitRow.message).not.toContain(INTERACTIVE_ONLY_HINT);
  });

  it.each(['cli', 'claude-vscode'])('is ok when the option is true and the entrypoint is %s', async (entrypoint) => {
    const r = await session({ [local]: settings(true) }, { CLAUDE_CODE_ENTRYPOINT: entrypoint });
    const row = check(r.result, 'interactive-only');
    expect(row.status).toBe('ok');
    expect(row.message).toBe(`interactiveOnly: on, a ${entrypoint} session uses S4`);
    expect(row.message).not.toContain(INTERACTIVE_ONLY_HINT);
  });

  it.each(['sdk-cli', 'claude-desktop'])('warns when the option is true and the entrypoint is %s', async (entrypoint) => {
    const r = await session({ [local]: settings(true) }, { CLAUDE_CODE_ENTRYPOINT: entrypoint });
    const row = check(r.result, 'interactive-only');
    expect(row.status).toBe('warn');
    expect(row.message).toContain('interactiveOnly');
    expect(row.message).toContain(entrypoint);
    expect(row.message).toContain('native');
    expect(row.message.endsWith(` ${INTERACTIVE_ONLY_HINT}`)).toBe(true);
  });

  it('is ok when the option is true and the entrypoint is unset, and says which runs stay native', async () => {
    const r = await session({ [local]: settings(true) });
    const row = check(r.result, 'interactive-only');
    expect(row.status).toBe('ok');
    expect(row.message).toContain('-p');
    expect(row.message).toContain('SDK runs stay on native compaction');
    expect(row.message.endsWith(` ${INTERACTIVE_ONLY_HINT}`)).toBe(true);
  });

  it('lets a higher-precedence false override a lower true', async () => {
    const r = await session({
      [user]: settings(true),
      [project]: settings(true),
      [local]: settings(false),
    }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
    const row = check(r.result, 'interactive-only');
    expect(row.status).toBe('ok');
    expect(row.message).not.toContain(INTERACTIVE_ONLY_HINT);
  });

  it('lets a higher-precedence true override a lower false', async () => {
    const projectBeatsUser = await session({
      [user]: settings(false),
      [project]: settings(true),
    }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
    expect(check(projectBeatsUser.result, 'interactive-only').status).toBe('warn');
    const localBeatsProject = await session({
      [user]: settings(false),
      [project]: settings(false),
      [local]: settings(true),
    }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
    expect(check(localBeatsProject.result, 'interactive-only').status).toBe('warn');
  });

  it('reads the exact exo-compact key and an exo-compact@ key, and ignores other keys', async () => {
    const exact = await session({ [local]: settings(true, 'exo-compact') }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
    expect(check(exact.result, 'interactive-only').status).toBe('warn');
    const scoped = await session({ [project]: settings(true, 'exo-compact@exo-compact') }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
    expect(check(scoped.result, 'interactive-only').status).toBe('warn');
    const ignored = await session({
      [local]: JSON.stringify({
        pluginConfigs: {
          other: { options: { interactiveOnly: false } },
          'exo-compact-extra': { options: { interactiveOnly: false } },
        },
      }),
    }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
    expect(check(ignored.result, 'interactive-only').status).toBe('warn');
  });

  it('skips a missing or unparsable settings file and keeps the rest', async () => {
    const r = await session({
      [user]: '{',
      [project]: 'not json',
      [local]: settings(true),
    }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
    expect(check(r.result, 'interactive-only').status).toBe('warn');
    const onlyBroken = await session({ [user]: '{', [project]: 'not json' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
    expect(check(onlyBroken.result, 'interactive-only').status).toBe('warn');
  });

  it('reads user settings from CLAUDE_CONFIG_DIR when that is set', async () => {
    const fromConfig = await session({
      '/cfg/settings.json': settings(true),
    }, { CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
    expect(check(fromConfig.result, 'interactive-only').status).toBe('warn');
    const homeIgnored = await session({
      [user]: settings(false),
    }, { CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
    expect(check(homeIgnored.result, 'interactive-only').status).toBe('warn');
  });
});

describe('doctor exit code ignores the new checks', () => {
  it('stays 1 when Node is too old, and the new checks are not failures', async () => {
    const r = await run({ nodeVersion: '22.14.9', cwd: CWD, home: HOME, ...io() });
    expect(r.code).toBe(1);
    expect(check(r.result, 'capture-flag').status).not.toBe('fail');
    expect(check(r.result, 'interactive-only').status).not.toBe('fail');
  });

  it('stays 3 when Jev has no key, and the new checks are not failures', async () => {
    const r = await run({
      jev: true,
      env: { TYPESAFE_API_KEY: undefined, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
      cwd: CWD,
      home: HOME,
      ...io({ files: { [`${CWD}/.claude/settings.local.json`]: settings(true) } }),
    });
    expect(r.code).toBe(3);
    expect(check(r.result, 'capture-flag').status).toBe('ok');
    expect(check(r.result, 'interactive-only').status).toBe('warn');
  });
});

describe('doctor auto-compact (S5x)', () => {
  const user = `${HOME}/.claude/settings.json`;
  const project = `${CWD}/.claude/settings.json`;
  const legacy = `${HOME}/.claude.json`;
  const json = (value: unknown) => JSON.stringify(value);
  const doctorFor = (files: Record<string, string>, env: Record<string, string | undefined> = {}) => run({ cwd: CWD, home: HOME, env, ...io({ files }) });

  it('is ok at 200000 or below with auto-compact on, and names where the window comes from', async () => {
    const r = await doctorFor({ [user]: json({ autoCompactWindow: 200000 }) });
    const row = check(r.result, 'auto-compact');
    expect(row.status).toBe('ok');
    expect(row.message).toContain('200000');
    expect(folded(row.message)).toContain(user);
    expect(r.code).toBe(0);
  });

  it('reads a settings file that starts with a byte order mark', async () => {
    const row = check((await doctorFor({ [user]: `\uFEFF${json({ autoCompactWindow: 200000 })}`, [legacy]: `\uFEFF${json({ autoCompactEnabled: true })}` })).result, 'auto-compact');
    expect(row.status).toBe('ok');
    expect(row.message).not.toMatch(/not valid JSON/);
  });

  it('warns when the window is unset, with the fix', async () => {
    const row = check((await doctorFor({})).result, 'auto-compact');
    expect(row.status).toBe('warn');
    expect(row.message).toMatch(/model default/);
    expect(folded(row.message)).toContain(`"autoCompactWindow": 200000 in ${user}`);
  });

  it('warns above 200000; a project file beats the user file', async () => {
    const row = check((await doctorFor({ [user]: json({ autoCompactWindow: 150000 }), [project]: json({ autoCompactWindow: 500000 }) })).result, 'auto-compact');
    expect(row.status).toBe('warn');
    expect(row.message).toContain('500000');
  });

  it('the environment variable wins over the settings', async () => {
    const over = check((await doctorFor({ [user]: json({ autoCompactWindow: 200000 }) }, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000' })).result, 'auto-compact');
    expect(over.status).toBe('warn');
    expect(over.message).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=900000');
    const under = check((await doctorFor({}, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '180000' })).result, 'auto-compact');
    expect(under.status).toBe('ok');
  });

  it('warns when auto-compact is off: environment first, then settings, then the legacy config', async () => {
    const window = { [user]: json({ autoCompactWindow: 200000 }) };
    const byEnv = check((await doctorFor({ [user]: json({ autoCompactWindow: 200000, autoCompactEnabled: true }) }, { DISABLE_COMPACT: '1' })).result, 'auto-compact');
    expect(byEnv.status).toBe('warn');
    expect(byEnv.message).toContain('DISABLE_COMPACT');
    const bySettings = check((await doctorFor({ [user]: json({ autoCompactWindow: 200000, autoCompactEnabled: false }), [legacy]: json({ autoCompactEnabled: true }) })).result, 'auto-compact');
    expect(bySettings.status).toBe('warn');
    expect(bySettings.message).toMatch(/off/);
    const byLegacy = check((await doctorFor({ ...window, [legacy]: json({ autoCompactEnabled: false, primaryApiKey: 'sk-legacy-canary' }) })).result, 'auto-compact');
    expect(byLegacy.status).toBe('warn');
    expect(byLegacy.message).not.toContain('sk-legacy-canary');
    const settingsWin = check((await doctorFor({ [user]: json({ autoCompactWindow: 200000, autoCompactEnabled: true }), [legacy]: json({ autoCompactEnabled: false }) })).result, 'auto-compact');
    expect(settingsWin.status).toBe('ok');
  });

  it('never fails the doctor, and is left out of --preflight (no cwd)', async () => {
    const broken = await doctorFor({ [user]: '{ not json' });
    expect(check(broken.result, 'auto-compact').status).toBe('warn');
    expect(broken.code).toBe(0);
    const preflight = await run({ cwd: undefined });
    expect(preflight.result.checks.some((item: Check) => item.id === 'auto-compact')).toBe(false);
  });
});
