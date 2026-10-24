import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildJevRequest } from '../host/jev-client.js';
import { defaultJevCriteria, JEV_OPTIONS, resolvesRequestedModel } from '../core/select-j.js';
// @ts-expect-error plain ESM module without types
import * as doctor from '../doctor.mjs';

const CANARY = 'sk-canary-4f1d9e-never-print';
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));

type Response = { status: number; ok: boolean; text: () => Promise<string> };
const reply = (status: number, body: string): Response => ({ status, ok: status >= 200 && status < 300, text: async () => body });

function deps(overrides: Record<string, unknown> = {}) {
  const fetchCalls: unknown[][] = [];
  const envReads: string[] = [];
  const env = new Proxy({ TYPESAFE_API_KEY: CANARY } as Record<string, string>, {
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
      ...overrides,
    },
  };
}

async function run(overrides: Record<string, unknown> = {}) {
  const d = deps(overrides);
  const result = await doctor.runDoctor(d.value);
  const output = `${doctor.formatReport(result)}\n${JSON.stringify(result)}`;
  expect(output).not.toContain(CANARY);
  return { ...d, result, code: doctor.exitCode(result), output };
}

describe('doctor checks', () => {
  it('Jev off: all ok, exit 0, never reads the key or calls the API', async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.result.jev).toBe('off');
    expect(r.fetchCalls).toEqual([]);
    expect(r.envReads).not.toContain('TYPESAFE_API_KEY');
    expect(r.output).toContain('Jev: off (optional)');
  });

  it('Jev on and the API answers: exit 0', async () => {
    const r = await run({ jev: true });
    expect(r.result.jev).toBe('ok');
    expect(r.code).toBe(0);
    expect(r.fetchCalls).toHaveLength(1);
  });

  it('Jev on without a key: no_key, exit 3, tells how to set it in both shells', async () => {
    const r = await run({ jev: true, env: {} });
    expect(r.result.jev).toBe('no_key');
    expect(r.code).toBe(3);
    expect(r.fetchCalls).toEqual([]);
    expect(r.output).toContain('export TYPESAFE_API_KEY=');
    expect(r.output).toContain('$env:TYPESAFE_API_KEY');
  });

  it.each([[401, 'bad_key'], [403, 'bad_key'], [500, 'api_down'], [503, 'api_down']])('HTTP %i maps to %s', async (status, jev) => {
    const r = await run({ jev: true, fetch: async () => reply(status as number, '') });
    expect(r.result.jev).toBe(jev);
    expect(r.code).toBe(3);
  });

  it('network error, timeout and malformed payloads map to api_down', async () => {
    const network = await run({ jev: true, fetch: async () => { throw new TypeError('fetch failed'); } });
    expect(network.result.jev).toBe('api_down');
    const hang = (_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
    const timeout = await run({ jev: true, fetch: hang, timeoutMs: 20 });
    expect(timeout.result.jev).toBe('api_down');
    expect(timeout.output).toContain('no answer in');
    for (const body of ['not json', '{"answers":{}}', '{"model":"x"}']) {
      expect((await run({ jev: true, fetch: async () => reply(200, body) })).result.jev).toBe('api_down');
    }
  });

  it('old Node and old Claude Code are hard failures (exit 1), even with Jev broken', async () => {
    expect((await run({ nodeVersion: '22.14.9' })).code).toBe(1);
    const oldClaude = await run({ claudeVersion: async () => '2.1.273 (Claude Code)', jev: true, env: {} });
    expect(oldClaude.code).toBe(1);
    expect(oldClaude.output).toContain('claude update');
  });

  it('claude missing or unreadable is only a warning', async () => {
    expect((await run({ claudeVersion: async () => null })).code).toBe(0);
    expect((await run({ claudeVersion: async () => 'weird' })).result.checks.find((c: { id: string }) => c.id === 'claude').status).toBe('warn');
  });

  it('a missing recall file is a hard failure naming it', async () => {
    const r = await run({ fileExists: (file: string) => !file.endsWith('mcp-server.mjs') });
    expect(r.code).toBe(1);
    expect(r.output).toContain('recall/mcp-server.mjs');
  });
});

describe('4.7.5 (S5o) a Jev option that is on without a working key is named', () => {
  it('Jev off: a warning that the rule check does not run, with the key and the option to turn on', async () => {
    const r = await run();
    const row = r.result.checks.find((c: { id: string }) => c.id === 'jev');
    expect(row.status).toBe('warn');
    expect(row.message).toContain('Jev: off (optional), so the rule check does not run.');
    expect(row.message).toContain('TYPESAFE_API_KEY');
    expect(row.message).toContain('--config ruleCheck=true');
    expect(row.message).toContain('docs/install.md, "Optional: Jev rule check"');
    expect(r.code).toBe(0);
  });

  it('reads which Jev options are on from the Claude Code settings text', () => {
    const settings = (options: unknown, key = 'exo-compact@exo-compact') => JSON.stringify({ pluginConfigs: { [key]: { options }, 'other@x': { options: { ruleCheck: true } } } });
    expect(doctor.jevOptionsOn(settings({ ruleCheck: true, jevEnabled: 'true', recallEnabled: true }))).toEqual(['ruleCheck', 'jevEnabled']);
    expect(doctor.jevOptionsOn(settings({ ruleCheck: true }, 'exo-compact'))).toEqual(['ruleCheck']);
    expect(doctor.jevOptionsOn(settings({ ruleCheck: false, jevEnabled: 'false' }))).toEqual([]);
    expect(doctor.jevOptionsOn(JSON.stringify({ pluginConfigs: { 'other@x': { options: { ruleCheck: true } } } }))).toEqual([]);
    for (const text of [null, undefined, '', '{', '[]', '{"pluginConfigs":7}', '{"pluginConfigs":{"exo-compact@exo-compact":null}}']) expect(doctor.jevOptionsOn(text)).toEqual([]);
  });

  it('an option on without a key: a warning that names the option and the key, exit 0, no API call', async () => {
    const r = await run({ jevOptions: ['ruleCheck'], env: {} });
    expect(r.result.jev).toBe('no_key');
    expect(r.code).toBe(0);
    expect(r.fetchCalls).toEqual([]);
    expect(r.output).toContain('WARN Jev: ruleCheck is on in the plugin options but TYPESAFE_API_KEY is not set, so it does nothing.');
    expect(r.output).toContain('export TYPESAFE_API_KEY=');
    expect(r.output).toContain('$env:TYPESAFE_API_KEY');
    expect(r.output).toContain('claude plugin install exo-compact@exo-compact --config ruleCheck=false');
    const both = await run({ jevOptions: ['ruleCheck', 'jevEnabled'], env: {} });
    expect(both.output).toContain('Jev: ruleCheck and jevEnabled are on in the plugin options but TYPESAFE_API_KEY is not set, so they do nothing.');
    expect(both.output).toContain('--config ruleCheck=false --config jevEnabled=false');
  });

  it('an option on with a key: the key is probed, and a rejected key is a warning with exit 0', async () => {
    const ok = await run({ jevOptions: ['ruleCheck'] });
    expect(ok.result.jev).toBe('ok');
    expect(ok.code).toBe(0);
    expect(ok.fetchCalls).toHaveLength(1);
    const bad = await run({ jevOptions: ['ruleCheck'], fetch: async () => reply(401, '') });
    expect(bad.result.jev).toBe('bad_key');
    expect(bad.code).toBe(0);
    expect(bad.output).toContain('WARN Jev: TypeSafe rejected the key');
  });

  it('HTTP 402 is named as an account without credit, not as an unreachable API', async () => {
    const r = await run({ jevOptions: ['ruleCheck'], fetch: async () => reply(402, '{"detail":{"error_type":"billing_error"}}') });
    expect(r.result.jev).toBe('no_credit');
    expect(r.code).toBe(0);
    expect(r.output).toContain('WARN Jev: TypeSafe answered HTTP 402 (payment required): the account has no credit, so Jev does nothing until it is topped up.');
    expect((await run({ jev: true, fetch: async () => reply(402, '') })).code).toBe(3);
  });

  it('--jev keeps its exit 3 even when an option is on too', async () => {
    const r = await run({ jev: true, jevOptions: ['ruleCheck'], env: {} });
    expect(r.code).toBe(3);
    expect(r.output).toContain('Jev: enabled but TYPESAFE_API_KEY is not set.');
  });

  it('the CLI reads settings.json under CLAUDE_CONFIG_DIR', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'doctor-settings-'));
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ pluginConfigs: { 'exo-compact@exo-compact': { options: { ruleCheck: true } } } }));
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: dir };
    delete env.TYPESAFE_API_KEY;
    const ran = spawnSync(process.execPath, [path.join(pluginRoot, 'doctor.mjs')], { encoding: 'utf8', env });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('WARN Jev: ruleCheck is on in the plugin options but TYPESAFE_API_KEY is not set');
    const none = spawnSync(process.execPath, [path.join(pluginRoot, 'doctor.mjs')], { encoding: 'utf8', env: { ...env, CLAUDE_CONFIG_DIR: path.join(dir, 'missing') } });
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('Jev: off (optional)');
  });
});

describe('4.7.5 (S5q) EXO_JEV_URL: Jev at an address of your own', () => {
  const LOCAL = 'http://127.0.0.1:8080/v1/systemone';
  const REMOTE = 'https://jev.example.com/v1/systemone';
  function server(status: number, body: string) {
    const calls: Array<{ url: string; auth: string }> = [];
    const fetch = async (url: string, init: { headers: Record<string, string> }) => { calls.push({ url, auth: init.headers.Authorization }); return reply(status, body); };
    return { calls, fetch };
  }
  const answer = (model: string) => JSON.stringify({ model, answers: {} });

  it('a loopback address needs no key: the probe goes there, and the line names the server and how long it took', async () => {
    const s = server(200, answer('jev-0.1'));
    let clock = 1000;
    const r = await run({ jev: true, env: { EXO_JEV_URL: `${LOCAL}?secret=abc` }, fetch: s.fetch, now: () => (clock += 250) });
    expect(r.result.jev).toBe('ok');
    expect(r.code).toBe(0);
    expect(s.calls).toEqual([{ url: `${LOCAL}?secret=abc`, auth: 'Bearer local' }]);
    expect(r.output).toContain('ok   Jev: your own server http://127.0.0.1:8080 (EXO_JEV_URL) answered in 250 ms (model jev-0.1)');
    expect(r.output, 'the path and query of the address are never printed').not.toContain('secret=abc');
    expect(r.output).not.toContain('TypeSafe');
    expect(r.output).not.toContain('names its model');
  });

  it('an address without a path is asked at /v1/systemone', async () => {
    const s = server(200, answer('jev-0.1'));
    await run({ jev: true, env: { EXO_JEV_URL: 'http://127.0.0.1:8080' }, fetch: s.fetch });
    expect(s.calls[0]!.url).toBe(LOCAL);
  });

  it('a model name that span selection would reject is pointed out, with the fix', async () => {
    const r = await run({ jev: true, env: { EXO_JEV_URL: LOCAL }, fetch: server(200, answer('/models/Kev-4B-Q4_K_M.gguf')).fetch });
    expect(r.result.jev).toBe('ok');
    expect(r.output).toContain('The server names its model "/models/Kev-4B-Q4_K_M.gguf", which is not what jevModel "jev-latest" asks for');
    expect(r.output).toContain('--alias jev-0.1');
    const exact = await run({ jev: true, jevModel: 'kev-4b', env: { EXO_JEV_URL: LOCAL }, fetch: server(200, answer('kev-4b')).fetch });
    expect(exact.output).not.toContain('names its model');
  });

  it('the doctor reads a model name the way the hook does', () => {
    for (const [asked, reported] of [['jev-latest', 'jev-1.13.0'], ['jev-latest', 'jev-0.1'], ['jev-latest', 'jev-1'], ['jev-latest', 'jev-latest'], ['jev-latest', 'jev-mini-0.1'], ['jev-latest', '/m/x.gguf'], ['kev-4b', 'kev-4b'], ['kev-4b', 'kev-4b-q4'], ['-latest', '-1'], ['a.b-latest', 'aXb-1']] as const) {
      expect(doctor.resolvesModel(asked, reported), `${asked} / ${reported}`).toBe(resolvesRequestedModel(asked, reported));
    }
  });

  it('no answer from your own server: a warning that names it, exit 3 with --jev', async () => {
    const r = await run({ jev: true, env: { EXO_JEV_URL: LOCAL }, fetch: async () => { throw new Error('ECONNREFUSED'); } });
    expect(r.result.jev).toBe('api_down');
    expect(r.code).toBe(3);
    expect(r.output).toContain('WARN Jev: no answer from your own server http://127.0.0.1:8080 (EXO_JEV_URL) (network error). Start it, or unset EXO_JEV_URL.');
    expect(r.output).not.toContain('TypeSafe');
  });

  it('an address that is no address: Jev is not asked anywhere, TypeSafe included', async () => {
    const r = await run({ jevOptions: ['ruleCheck'], env: { EXO_JEV_URL: 'localhost:8080', TYPESAFE_API_KEY: CANARY } });
    expect(r.result.jev).toBe('bad_url');
    expect(r.code).toBe(0);
    expect(r.fetchCalls).toEqual([]);
    expect(r.output).toContain('WARN Jev: EXO_JEV_URL is set but is not an http or https address, so Jev is not asked.');
    expect(r.output).toContain('http://127.0.0.1:8080/v1/systemone');
    expect((await run({ jev: true, env: { EXO_JEV_URL: 'localhost:8080', TYPESAFE_API_KEY: CANARY } })).code).toBe(3);
  });

  it('another machine without a key is not asked', async () => {
    const r = await run({ jev: true, env: { EXO_JEV_URL: REMOTE } });
    expect(r.result.jev).toBe('no_key');
    expect(r.fetchCalls).toEqual([]);
    expect(r.output).toContain('WARN Jev: EXO_JEV_URL names https://jev.example.com, which is not this machine, and TYPESAFE_API_KEY is not set, so Jev is not asked.');
  });

  it('another machine with a key gets the key, and a rejected key is named for that server', async () => {
    const s = server(401, '');
    const r = await run({ jevOptions: ['ruleCheck'], env: { EXO_JEV_URL: REMOTE, TYPESAFE_API_KEY: CANARY }, fetch: s.fetch });
    expect(s.calls).toEqual([{ url: REMOTE, auth: `Bearer ${CANARY}` }]);
    expect(r.result.jev).toBe('bad_key');
    expect(r.code).toBe(0);
    expect(r.output).toContain('WARN Jev: your own server https://jev.example.com (EXO_JEV_URL) rejected the key (HTTP 401). It is sent TYPESAFE_API_KEY as the bearer key.');
    expect(r.output).not.toContain('TypeSafe rejected');
  });

  it('with Jev off the address changes nothing', async () => {
    const r = await run({ env: { EXO_JEV_URL: LOCAL } });
    expect(r.result.jev).toBe('off');
    expect(r.fetchCalls).toEqual([]);
  });

  it('the shared address rule is one of the files the doctor requires', async () => {
    const r = await run({ fileExists: (file: string) => !file.replace(/\\/g, '/').endsWith('recall/jev-endpoint.mjs') });
    expect(r.code).toBe(1);
    expect(r.output).toContain('recall files missing: recall/jev-endpoint.mjs');
  });

  it('the CLI asks the address in EXO_JEV_URL', () => {
    const env: Record<string, string | undefined> = { ...process.env, EXO_JEV_URL: 'http://127.0.0.1:1/v1/systemone' };
    delete env.TYPESAFE_API_KEY;
    const ran = spawnSync(process.execPath, [path.join(pluginRoot, 'doctor.mjs'), '--jev', '--preflight'], { encoding: 'utf8', env });
    expect(ran.status).toBe(3);
    expect(ran.stdout).toContain('WARN Jev: no answer from your own server http://127.0.0.1:1 (EXO_JEV_URL)');
  });
});

describe('doctor probe stays in step with the plugin Jev client', () => {
  it('uses the same URL, headers and question shape as buildJevRequest', () => {
    const probe = doctor.buildProbeRequest(CANARY, 'jev-latest');
    const real = buildJevRequest(CANARY, 'jev-latest', 's', { q: { type: 'choice', options: JEV_OPTIONS, criteria: defaultJevCriteria(), instructions: 'i' } });
    expect(probe.url).toBe(real.url);
    expect(probe.method).toBe(real.method);
    expect(probe.headers).toEqual(real.headers);
    const probeQuestion = Object.values(JSON.parse(probe.body).questions)[0];
    const realQuestion = Object.values(JSON.parse(real.body).questions)[0] as Record<string, unknown>;
    expect(probeQuestion).toEqual({ ...realQuestion, instructions: expect.any(String) });
    expect(Object.keys(JSON.parse(probe.body))).toEqual(Object.keys(JSON.parse(real.body)));
    const own = 'http://127.0.0.1:8080/v1/systemone';
    expect(doctor.buildProbeRequest(CANARY, 'jev-latest', own).url).toBe(buildJevRequest(CANARY, 'jev-latest', 's', {}, own).url);
  });
});

describe('doctor CLI', () => {
  it('runs through setup.cjs doctor and reports JSON with exit 0 when Jev is off', () => {
    // 4.7.5: an empty config directory, so the options of whoever runs the test do not turn the key check on.
    const env = { ...process.env, CLAUDE_CONFIG_DIR: mkdtempSync(path.join(tmpdir(), 'doctor-empty-')) };
    const out = execFileSync(process.execPath, [path.join(pluginRoot, 'setup.cjs'), 'doctor', '--json'], { encoding: 'utf8', env });
    expect(JSON.parse(out).jev).toBe('off');
  });

  it('exits 3 with --jev and no key', () => {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    const run = spawnSync(process.execPath, [path.join(pluginRoot, 'doctor.mjs'), '--jev', '--json'], { encoding: 'utf8', env });
    expect(run.status).toBe(3);
    expect(JSON.parse(run.stdout).jev).toBe('no_key');
  });
});

describe('4.7.5 doctor before a folder is turned on', () => {
  it('names the setup.cjs of this install in the enable hint', async () => {
    const r = await run({ pluginRoot: '/opt/exo/plugin/compact', cwd: '/work/proj', home: '/users/me', fileExists: (file: string) => !file.includes('.exovault') || file.replace(/\\/g, '/').endsWith('/work/proj/.exovault/s4-compact-off'), readFile: () => { throw new Error('ENOENT'); } });
    const flag = r.result.checks.find((check: { id: string }) => check.id === 'capture-flag');
    expect(flag.status).toBe('warn'); // 4.8.0: the hint now comes with an opt-out; a folder with no marker is on
    expect(flag.message.replace(/\\/g, '/')).toContain('node "/opt/exo/plugin/compact/setup.cjs" enable <dir>');
  });

  it('--preflight leaves out the two checks that describe a session in the current directory', () => {
    // The installer runs the doctor before it turns a folder on, so "S4 is not enabled" there would mislead.
    const dir = mkdtempSync(path.join(tmpdir(), 'doctor-preflight-'));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
    const ids = (args: string[]): string[] => {
      const ran = spawnSync(process.execPath, [path.join(pluginRoot, 'doctor.mjs'), '--json', ...args], { encoding: 'utf8', env, cwd: dir });
      return (JSON.parse(ran.stdout).checks as { id: string }[]).map((check) => check.id);
    };
    expect(ids([])).toEqual(expect.arrayContaining(['capture-flag', 'interactive-only']));
    const preflight = ids(['--preflight']);
    expect(preflight).not.toContain('capture-flag');
    expect(preflight).not.toContain('interactive-only');
    expect(preflight).toEqual(expect.arrayContaining(['recall', 'jev']));
  });
});

// The launcher is for Linux and macOS; its sandbox PATH is POSIX (/usr/bin:/bin).
describe.skipIf(process.platform === 'win32' || spawnSync('bash', ['-c', 'true']).status !== 0)('bash launcher', () => {
  const launcher = fileURLToPath(new URL('../../../launch/exo-compact.sh', import.meta.url));

  function sandbox(doctorExit: number | null, installedGlobal: boolean | string = false) {
    const root = mkdtempSync(path.join(tmpdir(), 'exo-launch-'));
    const bin = path.join(root, 'bin');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    for (const dir of [bin, home, project]) mkdirSync(dir, { recursive: true });
    const argsFile = path.join(root, 'claude-args');
    writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argsFile}'\n`);
    chmodSync(path.join(bin, 'claude'), 0o755);
    const doctorLog = path.join(root, 'doctor-args');
    if (doctorExit !== null) {
      // A node shim that fakes only the doctor and forwards everything else (setup.cjs enable).
      writeFileSync(path.join(bin, 'node'), `#!/usr/bin/env bash\nif [[ "$1" == *doctor.mjs ]]; then shift; printf '%s\\n' "$@" > '${doctorLog}'; exit ${doctorExit}; fi\nexec '${process.execPath}' "$@"\n`);
      chmodSync(path.join(bin, 'node'), 0o755);
    }
    if (installedGlobal) {
      mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
      writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), `{"plugins":{"${installedGlobal === true ? 'exo-compact' : installedGlobal}@exo-compact":[]}}`);
    }
    const env: Record<string, string> = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home };
    const launch = (extra: Record<string, string> = {}) => spawnSync('bash', [launcher, '--resume'], { cwd: project, env: { ...env, ...extra }, encoding: 'utf8', input: '' });
    const args = () => { try { return readFileSync(argsFile, 'utf8').trim().split('\n'); } catch { return null; } };
    const doctorArgs = () => { try { return readFileSync(doctorLog, 'utf8').trim(); } catch { return null; } };
    return { launch, args, doctorArgs, project };
  }
  const options = (args: string[]) => {
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    return Object.values(settings.pluginConfigs as Record<string, { options: Record<string, unknown> }>)[0].options;
  };

  it('doctor exit 1 stops before claude', () => {
    const s = sandbox(1);
    expect(s.launch().status).toBe(1);
    expect(s.args()).toBeNull();
  });

  it('doctor exit 3 without a terminal starts claude with Jev off', () => {
    const s = sandbox(3);
    const run = s.launch({ S4_JEV: '1' });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('starting without it');
    expect(s.doctorArgs()).toBe('--jev');
    expect(options(s.args()!).jevEnabled).toBe(false);
  });

  it('S4_JEV=1 with a working doctor passes jevEnabled true and --plugin-dir', () => {
    const s = sandbox(0);
    s.launch({ S4_JEV: '1' });
    const args = s.args()!;
    expect(args).toContain('--plugin-dir');
    expect(options(args).jevEnabled).toBe(true);
    expect(args[args.length - 1]).toBe('--resume');
  });

  it('S4_SKIP_DOCTOR=1 never runs the doctor', () => {
    const s = sandbox(1);
    expect(s.launch({ S4_SKIP_DOCTOR: '1' }).status).toBe(0);
    expect(s.doctorArgs()).toBeNull();
    expect(s.args()).not.toBeNull();
  });

  it('with a global install it does not load a second copy', () => {
    const s = sandbox(0, true);
    s.launch();
    const args = s.args()!;
    expect(args).not.toContain('--plugin-dir');
    expect(Object.keys(JSON.parse(args[args.indexOf('--settings') + 1]).pluginConfigs)).toEqual(['exo-compact@exo-compact']);
    expect(options(args)).toMatchObject({ recallEnabled: true, interactiveOnly: true, jevEnabled: false });
  });

  it('4.0.0: an install under the old plugin id stops the launch with the reinstall command', () => {
    const s = sandbox(0, 'exovault-s4-compact');
    const run = s.launch();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('claude plugin uninstall exovault-s4-compact@exo-compact');
    expect(s.args()).toBeNull();
  });

  it('runs the real doctor end to end when not faked', () => {
    const s = sandbox(null);
    const run = s.launch();
    expect(run.stderr).toContain('Jev: off (optional)');
    expect(s.args()).not.toBeNull();
  });
});

describe('no hooks-flag check', () => {
  // The Windows retest (2026-10-19) ran the compaction hook on 2.1.284 with no CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, and
  // 2.1.278 loads the module the same with and without it, so a warning about the flag would be wrong on every supported version.
  it('says nothing about CLAUDE_CODE_ENABLE_FUNCTION_HOOKS on 2.1.278 or 2.1.284', async () => {
    for (const version of ['2.1.278', '2.1.284']) {
      const r = await run({ claudeVersion: async () => `${version} (Claude Code)`, cwd: '/work/repo', home: '/home/u', readFile: () => { throw new Error('ENOENT'); } });
      expect(r.output).not.toContain('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS');
    }
  });
});

describe('claude --version on Windows', () => {
  it('runs one command string through the shell, so Node 24 raises no DEP0190', () => {
    expect(doctor.claudeVersionCommand('win32')).toEqual({ command: 'claude --version', args: [], options: { timeout: 15_000, shell: true } });
    expect(doctor.claudeVersionCommand('linux')).toEqual({ command: 'claude', args: ['--version'], options: { timeout: 15_000, shell: false } });
  });
});
