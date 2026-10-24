import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRuleSkip, ruleSkipWarning } from '../core/rule-check.js';
import { buildJevRequest, getJevEndpoint, LOCAL_JEV_KEY, makeJevAsk, resolveJevEndpoint, TYPESAFE_URL } from '../host/jev-client.js';
// @ts-expect-error plain ESM module without types
import { jevEndpoint, jevOrigin, LOCAL_KEY, TYPESAFE_URL as SCRIPT_URL } from '../recall/jev-endpoint.mjs';
// @ts-expect-error plain ESM module without types
import { jevConfig, scoreWithJev } from '../recall/jev-rerank.mjs';
// @ts-expect-error plain ESM module without types
import { ruleCheck, ruleCheckConfig, ruleCheckSkipReason } from '../recall/rule-check.mjs';

/**
 * 4.7.5 (CONTRACT S5q): `EXO_JEV_URL` names another address for Jev's `/v1/systemone` endpoint (a server of your own).
 * One rule decides the address and the bearer key for all four callers: the hook (host/jev-client.ts) and the three
 * scripts (recall/jev-endpoint.mjs, used by the rule check, the search ranking and the doctor).
 */
const LOCAL = 'http://127.0.0.1:8080/v1/systemone';
const REMOTE = 'https://jev.example.com/v1/systemone';

const CASES: Array<[string, string | undefined, string | undefined, { url: string; key: string; own: boolean } | 'no_key' | 'bad_url']> = [
  ['no address, a key: TypeSafe', undefined, 'k', { url: TYPESAFE_URL, key: 'k', own: false }],
  ['no address, no key', undefined, undefined, 'no_key'],
  ['empty address and key', '', '', 'no_key'],
  ['an unsubstituted placeholder is no address', '${EXO_JEV_URL:-}', 'k', { url: TYPESAFE_URL, key: 'k', own: false }],
  ['an unsubstituted placeholder is no key', undefined, '${TYPESAFE_API_KEY:-}', 'no_key'],
  ['loopback without a key gets the placeholder key', LOCAL, undefined, { url: LOCAL, key: 'local', own: true }],
  ['localhost counts as loopback', 'http://localhost:8080/v1/systemone', '', { url: 'http://localhost:8080/v1/systemone', key: 'local', own: true }],
  ['IPv6 loopback', 'http://[::1]:8080/v1/systemone', undefined, { url: 'http://[::1]:8080/v1/systemone', key: 'local', own: true }],
  ['any 127.x address', 'http://127.0.0.53/v1/systemone', undefined, { url: 'http://127.0.0.53/v1/systemone', key: 'local', own: true }],
  ['scheme and host in capitals', 'HTTP://LOCALHOST:1/x', undefined, { url: 'HTTP://LOCALHOST:1/x', key: 'local', own: true }],
  ['loopback with a key sends the key', LOCAL, 'k', { url: LOCAL, key: 'k', own: true }],
  ['another machine without a key is not asked', REMOTE, undefined, 'no_key'],
  ['another machine with a key', REMOTE, 'k', { url: REMOTE, key: 'k', own: true }],
  ['spaces around the address are dropped', `  ${LOCAL}  `, undefined, { url: LOCAL, key: 'local', own: true }],
  ['an address without a path gets /v1/systemone', 'http://127.0.0.1:8080', undefined, { url: LOCAL, key: 'local', own: true }],
  ['a bare slash gets /v1/systemone', 'http://127.0.0.1:8080/', undefined, { url: LOCAL, key: 'local', own: true }],
  ['no scheme', '127.0.0.1:8080', 'k', 'bad_url'],
  ['not http', 'ftp://127.0.0.1/x', 'k', 'bad_url'],
  ['no host', 'http://', 'k', 'bad_url'],
  ['a space inside', 'http://127.0.0.1/a b', 'k', 'bad_url'],
  ['user and password in the address', 'http://user:pw@127.0.0.1/x', undefined, 'bad_url'],
  ['a name that only starts like localhost', 'http://localhost.example.com/v1/systemone', undefined, 'no_key'],
  ['a name that only starts like 127.0.0.1', 'http://127.0.0.1.example.com/x', undefined, 'no_key'],
  ['a wrong address never falls back to TypeSafe', 'localhost', 'k', 'bad_url'],
];

describe('EXO_JEV_URL: one rule for the address and the key', () => {
  it.each(CASES)('%s', (_name, url, key, expected) => {
    expect(resolveJevEndpoint(url, key)).toEqual(expected);
    const env: Record<string, string> = {};
    if (url !== undefined) env.EXO_JEV_URL = url;
    if (key !== undefined) env.TYPESAFE_API_KEY = key;
    expect(jevEndpoint(env), 'the scripts decide exactly as the hook does').toEqual(expected);
  });

  it('the hook and the scripts share the default address and the placeholder key', () => {
    expect(SCRIPT_URL).toBe(TYPESAFE_URL);
    expect(LOCAL_KEY).toBe(LOCAL_JEV_KEY);
    expect(LOCAL_KEY).toBe('local');
  });

  it('getJevEndpoint reads both values through the niladic closures', async () => {
    expect(await getJevEndpoint({ getTypeSafeApiKey: async () => 'k' })).toEqual({ url: TYPESAFE_URL, key: 'k', own: false });
    expect(await getJevEndpoint({ getTypeSafeApiKey: async () => undefined, getJevUrl: async () => LOCAL })).toEqual({ url: LOCAL, key: 'local', own: true });
    expect(await getJevEndpoint({ getTypeSafeApiKey: async () => undefined, getJevUrl: async () => undefined })).toBe('no_key');
    expect(await getJevEndpoint({ getTypeSafeApiKey: async () => 'k', getJevUrl: async () => 'nonsense' })).toBe('bad_url');
  });

  it('jevOrigin names the server without its path or query', () => {
    expect(jevOrigin('http://127.0.0.1:8080/v1/systemone?token=abc')).toBe('http://127.0.0.1:8080');
    expect(jevOrigin(REMOTE)).toBe('https://jev.example.com');
  });
});

describe('EXO_JEV_URL: every caller asks that address', () => {
  it('the hook client builds its request for the given address, TypeSafe by default', async () => {
    const questions = { a: { type: 'choice' as const, options: ['keep_verbatim', 'pointer', 'drop', 'unsure'], criteria: { keep_verbatim: 'k', pointer: 'p', drop: 'd', unsure: 'u' }, instructions: 'i' } };
    expect(buildJevRequest('k', 'jev-latest', 's', questions).url).toBe(TYPESAFE_URL);
    expect(buildJevRequest('k', 'jev-latest', 's', questions, LOCAL).url).toBe(LOCAL);
    const urls: string[] = [];
    const http = { fetch: async (url: string) => { urls.push(url); return { status: 200, ok: true, text: JSON.stringify({ model: 'jev-0.1', answers: {} }) }; } };
    await makeJevAsk(http, 'local', 'jev-latest', LOCAL)('s', questions);
    await makeJevAsk(http, 'k', 'jev-latest')('s', questions);
    expect(urls).toEqual([LOCAL, TYPESAFE_URL]);
  });

  it('the search ranking takes the address from the environment', async () => {
    expect(jevConfig({ EXO_JEV_ENABLED: 'true', EXO_JEV_URL: LOCAL }, '/w/p')).toEqual({ key: 'local', url: LOCAL, model: 'jev-latest', timeoutMs: 4000, denyList: [] });
    expect(jevConfig({ EXO_JEV_ENABLED: 'true', EXO_JEV_URL: REMOTE }, '/w/p')).toBeUndefined();
    expect(jevConfig({ EXO_JEV_ENABLED: 'true', EXO_JEV_URL: 'nonsense', TYPESAFE_API_KEY: 'k' }, '/w/p')).toBeUndefined();
    expect(jevConfig({ EXO_JEV_URL: LOCAL }, '/w/p'), 'jevEnabled still has to be on').toBeUndefined();
    const calls: Array<{ url: string; auth: string }> = [];
    const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, auth: init.headers.Authorization });
      return { ok: true, json: async () => ({ model: 'jev-0.1', answers: { c0: { type: 'noul', noul: 0.9 } } }) };
    };
    expect(await scoreWithJev('which port?', ['a'], jevConfig({ EXO_JEV_ENABLED: 'true', EXO_JEV_URL: LOCAL }, '/w/p'), fetchImpl)).toEqual([0.9]);
    expect(calls).toEqual([{ url: LOCAL, auth: 'Bearer local' }]);
  });

  it('the rule check takes the address from the environment', async () => {
    expect(ruleCheckSkipReason({ EXO_JEV_URL: LOCAL }, '/w/p')).toBeUndefined();
    expect(ruleCheckSkipReason({ EXO_JEV_URL: REMOTE }, '/w/p')).toBe('no_key');
    expect(ruleCheckSkipReason({ EXO_JEV_URL: 'nonsense', TYPESAFE_API_KEY: 'k' }, '/w/p')).toBe('bad_url');
    expect(ruleCheckSkipReason({ EXO_JEV_URL: LOCAL, EXO_JEV_DENY_LIST: 'client-a' }, '/w/client-a/x'), 'the deny list holds for an own server too').toBe('denied');
    expect(ruleCheckConfig({ EXO_JEV_URL: LOCAL }, '/w/p')).toEqual({ key: 'local', url: LOCAL, model: 'jev-latest', timeoutMs: 6000 });
    expect(ruleCheckConfig({ TYPESAFE_API_KEY: 'k' }, '/w/p')).toEqual({ key: 'k', url: TYPESAFE_URL, model: 'jev-latest', timeoutMs: 6000 });
    const calls: Array<{ url: string; auth: string }> = [];
    const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, auth: init.headers.Authorization });
      const body = JSON.parse(init.body) as { questions: Record<string, unknown> };
      return { ok: true, status: 200, json: async () => ({ model: 'jev-0.1', answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0 }])) }) };
    };
    await ruleCheck({ rules: ['Line 1 is SLICE r2 DONE'], report: 'hello' }, ruleCheckConfig({ EXO_JEV_URL: LOCAL }, '/w/p'), '', fetchImpl);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toEqual({ url: LOCAL, auth: 'Bearer local' });
  });

  it('run with an address that is no address, the rule check prints the reason and asks nobody', () => {
    const env: Record<string, string | undefined> = { ...process.env, EXO_JEV_URL: 'localhost:8080', TYPESAFE_API_KEY: 'k' };
    const script = fileURLToPath(new URL('../recall/rule-check.mjs', import.meta.url));
    const out = execFileSync(process.execPath, [script, os.tmpdir()], { input: JSON.stringify({ card: '# Task card\n## Rules\n- Reply in Polish.\n', report: 'done' }), encoding: 'utf8', env });
    expect(out).toBe('{"skipped":"bad_url"}');
  });

  it('the session is told once when the address is wrong', () => {
    expect(parseRuleSkip('{"skipped":"bad_url"}')).toBe('bad_url');
    expect(ruleSkipWarning('bad_url')).toBe('rule_check.off=bad_url ruleCheck is on but EXO_JEV_URL is not an http or https address, so no rule is checked. Fix it and restart Claude Code, or turn ruleCheck off.');
  });

  it('the recall server is given the address', () => {
    const mcp = JSON.parse(readFileSync(fileURLToPath(new URL('../.mcp.json', import.meta.url)), 'utf8'));
    expect(mcp.mcpServers.recall.env.EXO_JEV_URL).toBe('${EXO_JEV_URL:-}');
  });

  it('compact.ts reads EXO_JEV_URL by its literal name and never fetches the TypeSafe address directly', () => {
    const source = readFileSync(new URL('../compact.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/\$\.env\.get\(\s*'EXO_JEV_URL'\s*\)/);
    expect(source, 'every hook request goes to the resolved endpoint').not.toMatch(/TYPESAFE_URL/);
  });
});
