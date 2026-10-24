import { describe, it, expect, vi } from 'vitest';
import { buildJevRequest, makeJevAsk, parseDenseJevResponse, parseJevResponse, TYPESAFE_URL, getTypeSafeApiKey } from '../host/jev-client.js';
import type { JevChoiceQuestion } from '../core/select-j.js';

/**
 * `host/jev-client.ts` is a thin adapter over `$.http.fetch`, not a family under
 * `S4_GATE_IMPL` (no broken/jev-client.ts): the brief's broken variant targets
 * `core/select-j.ts`'s own K4/unsure logic, not this wire-shape layer. These tests inject a fake
 * `HttpLike`; none ever reach the real TypeSafe endpoint or read a real API key.
 */
const SECRET = 'sk-test-do-not-log-this-1234567890';

function question(): Record<string, JevChoiceQuestion> {
  return {
    a: {
      type: 'choice',
      options: ['keep_verbatim', 'pointer', 'drop', 'unsure'],
      criteria: { keep_verbatim: 'k', pointer: 'p', drop: 'd', unsure: 'u' },
      instructions: 'Decide what to do with state.spans.a when compacting this session.',
    },
  };
}

describe('jev-client: request shape (reusing context-gate.ts\'s own POST shape)', () => {
  it('posts to the TypeSafe endpoint with a bearer header and a choice-typed question', () => {
    const request = buildJevRequest(SECRET, 'jev-latest', 'the state', question());
    expect(request.url).toBe(TYPESAFE_URL);
    expect(request.method).toBe('POST');
    expect(request.headers.Authorization).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(request.body);
    expect(body.model).toBe('jev-latest');
    expect(body.state).toBe('the state');
    expect(body.questions.a.type).toBe('choice');
    expect(Array.isArray(body.questions.a.options)).toBe(true);
    expect(typeof body.questions.a.criteria).toBe('object');
    expect(Array.isArray(body.questions.a.criteria)).toBe(false);
  });

  it('sends the per-question instructions string (jev-live-smoke-20260926.md smoke 3, the same wire field context-gate.ts sends)', () => {
    const request = buildJevRequest(SECRET, 'jev-latest', 'the state', question());
    const body = JSON.parse(request.body);
    expect(body.questions.a.instructions).toBe('Decide what to do with state.spans.a when compacting this session.');
  });

  it('the key never appears anywhere except the Authorization header', () => {
    const request = buildJevRequest(SECRET, 'jev-latest', 'the state', question());
    expect(request.body.includes(SECRET)).toBe(false);
    expect(JSON.stringify(request.headers).indexOf(SECRET)).toBeGreaterThanOrEqual(0);
    expect(Object.keys(request.headers)).toEqual(['Authorization', 'Content-Type']);
  });
});

/**
 * The raw JSON the maintainer captured from one real Jev call (jev-live-smoke-20260926.md), used
 * verbatim as `parseJevResponse`'s fixture per the coordinator's instruction. Requested model was
 * the alias `jev-latest`; the real response resolves it to the concrete `jev-1.13.0` (finding 2),
 * spells the answer field `choice` not `option` (finding 1), and every `criteria` key sent in that
 * request (including the old `safety` entry, since-removed) came back as its own `probabilities`
 * key (finding 3) -- this fixture keeps that original 5-key shape exactly as captured, since
 * `parseJevResponse` itself never checks probability-key count or set; only `validateChoiceAnswer`
 * (`core/select-j.ts`, tested against a 4-key, safety-free fixture in `select-j.gate.test.ts`) does,
 * and it now runs against `criteria` with no `safety` key (finding 3's fix).
 */
const RAW_LIVE_SMOKE_RESPONSE = JSON.stringify({
  model: 'jev-1.13.0',
  answers: {
    s1: {
      type: 'choice',
      choice: 'keep_verbatim',
      confidence: 0.15,
      probabilities: { pointer: 0.14, unsure: 0.03, safety: 0.3, keep_verbatim: 0.31, drop: 0.22 },
    },
    s2: {
      type: 'choice',
      choice: 'drop',
      confidence: 0.62,
      probabilities: { pointer: 0.05, unsure: 0.02, safety: 0.01, keep_verbatim: 0.03, drop: 0.89 },
    },
  },
  usage: { input_tokens: 751, output_tokens: 121 },
});

describe('jev-client: real live response shape (jev-live-smoke-20260926.md, raw fixture)', () => {
  it('parses the choice field (finding 1), the concrete resolved model (finding 2), and drops the unmodeled confidence field', () => {
    const parsed = parseJevResponse(200, true, RAW_LIVE_SMOKE_RESPONSE);
    expect(parsed.model).toBe('jev-1.13.0');
    expect(parsed.answers.s1.choice).toBe('keep_verbatim');
    expect(parsed.answers.s2.choice).toBe('drop');
    expect((parsed.answers.s1 as Record<string, unknown>).confidence).toBeUndefined();
  });

  it('passes through every criteria-key-turned-probability-key untouched, including the since-removed safety key (finding 3)', () => {
    const parsed = parseJevResponse(200, true, RAW_LIVE_SMOKE_RESPONSE);
    expect(Object.keys(parsed.answers.s1.probabilities).sort()).toEqual(['drop', 'keep_verbatim', 'pointer', 'safety', 'unsure']);
  });

  it('parses usage.input_tokens (finding 4), and leaves output_tokens unread', () => {
    const parsed = parseJevResponse(200, true, RAW_LIVE_SMOKE_RESPONSE);
    expect(parsed.usage).toEqual({ input_tokens: 751 });
  });

  it('leaves usage undefined when the payload has none, rather than throwing', () => {
    const parsed = parseJevResponse(200, true, JSON.stringify({ model: 'jev-1.13.0', answers: {} }));
    expect(parsed.usage).toBeUndefined();
  });

  it('leaves usage undefined on a malformed usage object instead of throwing', () => {
    const parsed = parseJevResponse(200, true, JSON.stringify({ model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 'lots' } }));
    expect(parsed.usage).toBeUndefined();
  });
});

describe('jev-client: response parsing', () => {
  it('parses a well-formed choice response', () => {
    const text = JSON.stringify({ model: 'jev-latest', answers: { a: { type: 'choice', choice: 'drop', probabilities: { keep_verbatim: 0.1, pointer: 0.1, drop: 0.7, unsure: 0.1 } } } });
    const parsed = parseJevResponse(200, true, text);
    expect(parsed.model).toBe('jev-latest');
    expect(parsed.answers.a.choice).toBe('drop');
  });

  it('parses Noul answers through its sibling parser without changing Choice responses', () => {
    const parsed = parseDenseJevResponse(200, true, JSON.stringify({ model: 'jev-latest', answers: { n0: { type: 'noul', noul: 0.7 }, n1: { type: 'choice', choice: 'drop' } }, usage: { input_tokens: 99 } }));
    expect(parsed.answers.n0).toEqual({ type: 'noul', noul: 0.7 });
    expect(parsed.answers.n1).toBeUndefined();
    expect(parsed.usage).toEqual({ input_tokens: 99 });
  });

  it('throws (never returns a value) on a non-ok status, with no secret in the message', () => {
    expect(() => parseJevResponse(500, false, 'ignored')).toThrowError();
    try {
      parseJevResponse(401, false, SECRET);
    } catch (error) {
      expect(String((error as Error).message).includes(SECRET)).toBe(false);
    }
  });

  it('throws on malformed JSON instead of returning a partial result', () => {
    expect(() => parseJevResponse(200, true, 'not json')).toThrowError();
  });

  it('throws when the payload is missing model or answers', () => {
    expect(() => parseJevResponse(200, true, JSON.stringify({ answers: {} }))).toThrowError();
    expect(() => parseJevResponse(200, true, JSON.stringify({ model: 'jev-latest' }))).toThrowError();
  });
});

describe('jev-client: makeJevAsk over a fake HttpLike (no real network)', () => {
  it('resolves with the parsed answers when the fake http responds ok', async () => {
    const fetch = vi.fn(async () => ({ status: 200, ok: true, text: JSON.stringify({ model: 'jev-latest', answers: { a: { type: 'choice', choice: 'pointer', probabilities: { keep_verbatim: 0.1, pointer: 0.7, drop: 0.1, unsure: 0.1 } } } }) }));
    const ask = makeJevAsk({ fetch }, SECRET, 'jev-latest');
    const result = await ask('the state', question());
    expect(result.answers.a.choice).toBe('pointer');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0];
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(`Bearer ${SECRET}`);
  });

  it('rejects (does not throw a value that embeds the key) when the fake http reports non-ok', async () => {
    const fetch = vi.fn(async () => ({ status: 429, ok: false, text: '' }));
    const ask = makeJevAsk({ fetch }, SECRET, 'jev-latest');
    await expect(ask('the state', question())).rejects.toThrow();
  });
});

describe('jev-client: the API key is read only from the environment (spec §3.3, "never logged")', () => {
  // review-opus-s4b.md B1: EnvLike.getTypeSafeApiKey takes no argument at all, so the only call
  // site left in compact.ts (`$.env.get('TYPESAFE_API_KEY')`) can only ever spell the one literal
  // name; there is no `name` parameter here to inject a different key by.
  it('returns the env value when set', async () => {
    const key = await getTypeSafeApiKey({ getTypeSafeApiKey: async () => SECRET });
    expect(key).toBe(SECRET);
  });

  it('returns undefined when unset or blank, never a placeholder string', async () => {
    expect(await getTypeSafeApiKey({ getTypeSafeApiKey: async () => undefined })).toBeUndefined();
    expect(await getTypeSafeApiKey({ getTypeSafeApiKey: async () => '' })).toBeUndefined();
  });
});
