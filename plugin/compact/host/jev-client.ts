import type { JevAsk, JevBatchResponse, JevChoiceAnswer, JevChoiceQuestion } from '../core/select-j.js';

/**
 * The network primitive selector J is built over: `$.http.fetch` narrowed to the fields
 * `core/select-j.ts` needs, matching `types/cc.d.ts`'s `HttpResponse` shape (status, ok, text).
 * `core/` itself never imports this file or `$`; `compact.ts` closes over `$.http.fetch` into
 * this shape at the call site, the same convention as its existing `fsLike`/`transcriptPathHost`
 * closures.
 */
export interface HttpLike {
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    status: number;
    ok: boolean;
    text: string;
  }>;
}

export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';

/** The bearer key sent to a loopback address when TYPESAFE_API_KEY is not set. */
export const LOCAL_JEV_KEY = 'local';

/** Where Jev is asked and with which bearer key; `own` is true when `EXO_JEV_URL` named the address. */
export interface JevEndpoint { url: string; key: string; own: boolean }
/** Why Jev must not be asked: no usable key, or an `EXO_JEV_URL` that is not an http or https address. */
export type JevEndpointOff = 'no_key' | 'bad_url';

// No `URL` here: the hook runtime has no DOM and no Node globals, so the address is read with a pattern.
const JEV_ADDRESS = /^(https?:\/\/)(\[[0-9a-f:.]+\]|[^\s/:?#@[\]]+)(:\d+)?([/?#]\S*)?$/i;
const JEV_LOOPBACK = /^(?:localhost|\[::1\]|127(?:\.\d{1,3}){3})$/i;
// A value still spelled `${...}` is a placeholder Claude Code did not substitute, never a setting.
const cleanSetting = (value: string | undefined): string => { const v = String(value ?? '').trim(); return v.startsWith('${') ? '' : v; };

/**
 * 4.7.5 (CONTRACT S5q): `EXO_JEV_URL` names another address for the `/v1/systemone` endpoint (a server of your
 * own); without it the address is TypeSafe's. An address with no path gets `/v1/systemone`. A loopback address needs
 * no key (`local` is sent); any other address needs TYPESAFE_API_KEY, which is sent to it as the bearer key. A value
 * that is not an http or https address is 'bad_url' and never falls back to TypeSafe. recall/jev-endpoint.mjs decides
 * the same way for the scripts (jev-own-address.gate.test.ts keeps the two in step).
 */
export function resolveJevEndpoint(customUrl: string | undefined, apiKey: string | undefined): JevEndpoint | JevEndpointOff {
  const custom = cleanSetting(customUrl);
  const key = cleanSetting(apiKey);
  if (!custom) return key ? { url: TYPESAFE_URL, key, own: false } : 'no_key';
  const match = JEV_ADDRESS.exec(custom);
  if (!match) return 'bad_url';
  const [, scheme, host, port = '', rest = ''] = match;
  const url = rest === '' || rest === '/' ? `${scheme}${host}${port}/v1/systemone` : custom;
  if (key) return { url, key, own: true };
  return JEV_LOOPBACK.test(host) ? { url, key: LOCAL_JEV_KEY, own: true } : 'no_key';
}

export interface JevNoulAnswer { type: 'noul'; noul: number }
export interface JevNoulBatchResponse { model: string; answers: Record<string, JevNoulAnswer>; usage?: { input_tokens: number } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseChoiceAnswer(value: unknown): JevChoiceAnswer | undefined {
  if (!isRecord(value) || value.type !== 'choice' || typeof value.choice !== 'string') return undefined;
  if (!isRecord(value.probabilities)) return undefined;
  const probabilities: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value.probabilities)) {
    if (typeof probability !== 'number') return undefined;
    probabilities[key] = probability;
  }
  return { type: 'choice', choice: value.choice, probabilities };
}

/**
 * Parses the TypeSafe response body (reusing `src/lib/hooks/context-gate.ts`'s own
 * `askJevDetailed` shape: `{ model, answers: { [id]: answer } }`), adapted from `type: "noul"` to
 * `type: "choice"`. Throws on any shape it does not recognize; `core/select-j.ts`'s `selectJ`
 * treats a thrown `JevAsk` the same as a timeout for that batch (K4: "any violation maps to D").
 * The API key never appears in the response and this function never logs the request or
 * response body, so it cannot leak the key either.
 */
export function parseJevResponse(status: number, ok: boolean, text: string): JevBatchResponse {
  if (!ok) throw new Error(`jev http ${status}`);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('jev malformed json');
  }
  if (!isRecord(payload) || typeof payload.model !== 'string' || !isRecord(payload.answers)) {
    throw new Error('jev malformed payload');
  }
  const answers: Record<string, JevChoiceAnswer> = {};
  for (const [id, value] of Object.entries(payload.answers)) {
    const answer = parseChoiceAnswer(value);
    if (answer) answers[id] = answer;
  }
  const result: JevBatchResponse = { model: payload.model, answers };
  // jev-live-smoke-20260926.md finding 4: the real payload carries a top-level `usage.input_tokens`
  // (a measured count `selectJ` prefers over its own pre-call estimate). Parsed defensively: only a
  // finite, non-negative number is passed through, and a missing or malformed `usage` never throws
  // here, it just leaves `result.usage` undefined so `selectJ` falls back to its own estimate.
  if (isRecord(payload.usage) && typeof payload.usage.input_tokens === 'number' && Number.isFinite(payload.usage.input_tokens) && payload.usage.input_tokens >= 0) {
    result.usage = { input_tokens: payload.usage.input_tokens };
  }
  return result;
}

/** Noul response sibling used by dense-note reranking; Choice parsing above remains unchanged. */
export function parseDenseJevResponse(status: number, ok: boolean, text: string): JevNoulBatchResponse {
  if (!ok) throw new Error(`jev http ${status}`);
  let payload: unknown;
  try { payload = JSON.parse(text); }
  catch { throw new Error('jev malformed json'); }
  if (!isRecord(payload) || typeof payload.model !== 'string' || !isRecord(payload.answers)) throw new Error('jev malformed payload');
  const answers: Record<string, JevNoulAnswer> = {};
  for (const [id, value] of Object.entries(payload.answers)) {
    if (isRecord(value) && value.type === 'noul' && typeof value.noul === 'number') answers[id] = { type: 'noul', noul: value.noul };
  }
  const result: JevNoulBatchResponse = { model: payload.model, answers };
  if (isRecord(payload.usage) && typeof payload.usage.input_tokens === 'number' && Number.isFinite(payload.usage.input_tokens) && payload.usage.input_tokens >= 0) {
    result.usage = { input_tokens: payload.usage.input_tokens };
  }
  return result;
}

/**
 * Builds the wire request (reusing `context-gate.ts`'s own POST shape: `Authorization: Bearer
 * <key>`, JSON body `{model, state, questions}`), with each question sent as `{type: "choice",
 * options, criteria, instructions}` per spec §3.3 ("criteria as a dict, never an array, which
 * returns 422") and jev-live-smoke-20260926.md smoke 3 (a per-question `instructions` string,
 * naming the span id the question is about, the same wire field `context-gate.ts`'s own
 * `askJevDetailed` sends per question for its `noul` type). The key is interpolated straight into
 * the header and nowhere else; nothing here returns or logs it.
 */
export function buildJevRequest(
  apiKey: string,
  model: string,
  state: string,
  questions: Record<string, JevChoiceQuestion>,
  url: string = TYPESAFE_URL,
): { url: string; method: 'POST'; headers: Record<string, string>; body: string } {
  return {
    url,
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      state,
      questions: Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [
          id,
          { type: 'choice', options: question.options, criteria: question.criteria, instructions: question.instructions },
        ]),
      ),
    }),
  };
}

/** Builds the injected `JevAsk` (`core/select-j.ts`) over an `HttpLike`, never over raw `$`. */
export function makeJevAsk(http: HttpLike, apiKey: string, model: string, url: string = TYPESAFE_URL): JevAsk {
  return async (state, questions) => {
    const request = buildJevRequest(apiKey, model, state, questions, url);
    const response = await http.fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
    return parseJevResponse(response.status, response.ok, response.text);
  };
}

/**
 * A niladic closure over `$.env.get('TYPESAFE_API_KEY')`, not a general `get(name)` seam
 * (review-opus-s4b.md B1): `$.env.get` requires its argument to be a string literal at the call
 * site (types/cc.d.ts:2805-2814), because the host statically scans the module's own source text
 * for that literal spelling to decide what a module is allowed to read. A `get(name: string)`
 * shape lets the call site forward a variable, which type-checks but is refused at runtime (the
 * scan never sees a literal). Taking no argument at all removes the possibility.
 */
export interface EnvLike {
  getTypeSafeApiKey(): Promise<string | undefined>;
  /** `$.env.get('EXO_JEV_URL')`, the same niladic shape; absent means TypeSafe's address. */
  getJevUrl?(): Promise<string | undefined>;
}

/** Reads the key only from the environment (spec §3.3: "the TYPESAFE_API_KEY key, never logged"). */
export async function getTypeSafeApiKey(env: EnvLike): Promise<string | undefined> {
  const key = await env.getTypeSafeApiKey();
  return key && key.length > 0 ? key : undefined;
}

/** The address and key for this call, read from the environment only (`resolveJevEndpoint`). */
export async function getJevEndpoint(env: EnvLike): Promise<JevEndpoint | JevEndpointOff> {
  return resolveJevEndpoint(await env.getJevUrl?.(), await env.getTypeSafeApiKey());
}
