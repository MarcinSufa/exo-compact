// 4.7.5 (CONTRACT S5q): where Jev is asked. `EXO_JEV_URL` names another address for the `/v1/systemone` endpoint
// (a server of your own); without it the address is TypeSafe's. Used by the rule check, the search ranking and the
// doctor; host/jev-client.ts decides the same way for the hook (jev-own-address.gate.test.ts keeps the two in step).

export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
/** The bearer key sent to a loopback address when TYPESAFE_API_KEY is not set. */
export const LOCAL_KEY = 'local';

const ADDRESS = /^(https?:\/\/)(\[[0-9a-f:.]+\]|[^\s/:?#@[\]]+)(:\d+)?([/?#]\S*)?$/i;
const LOOPBACK = /^(?:localhost|\[::1\]|127(?:\.\d{1,3}){3})$/i;

// A value still spelled `${...}` is a placeholder Claude Code did not substitute, never a setting.
const clean = (value) => { const v = String(value ?? '').trim(); return v.startsWith('${') ? '' : v; };

/**
 * `{ url, key, own }`, or why Jev must not be asked: 'bad_url' (EXO_JEV_URL is not an http or https address; it
 * never falls back to TypeSafe) or 'no_key' (no TYPESAFE_API_KEY, and the address is not on this machine).
 */
export function resolveJevEndpoint(customUrl, apiKey) {
  const custom = clean(customUrl);
  const key = clean(apiKey);
  if (!custom) return key ? { url: TYPESAFE_URL, key, own: false } : 'no_key';
  const match = ADDRESS.exec(custom);
  if (!match) return 'bad_url';
  const [, scheme, host, port = '', rest = ''] = match;
  const url = rest === '' || rest === '/' ? `${scheme}${host}${port}/v1/systemone` : custom;
  if (key) return { url, key, own: true };
  return LOOPBACK.test(host) ? { url, key: LOCAL_KEY, own: true } : 'no_key';
}

export function jevEndpoint(env = process.env) {
  return resolveJevEndpoint(env.EXO_JEV_URL, env.TYPESAFE_API_KEY);
}

/** Scheme, host and port of an address, for messages: its path and query are never printed. */
export function jevOrigin(url) {
  return /^https?:\/\/[^/?#]+/i.exec(String(url))?.[0] ?? '';
}
