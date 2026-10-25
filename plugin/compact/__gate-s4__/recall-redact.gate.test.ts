import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash, redact, redactAll } from '../recall/shared.mjs';
import { DIM, appendVectors, storedKeys, textKey, vectorFile } from '../recall/vectors.mjs';
import { cpuGrowth, cpuRepetitions } from './fixtures/helpers.js';

// The recall index stores session text, tool output included, so a key read from a .env file lands on disk and comes
// back through search. Samples are assembled from pieces so no full key shape sits in the source.
const body = (n: number) => 'Ab3Cd5Ef7Gh9Jk2Lm4Np6Qr8St1Uv3Wx5Yz7'.repeat(3).slice(0, n);
const secrets: Record<string, string> = {
  anthropic: `sk-${'ant'}-api03-${body(40)}`,
  openaiProject: `sk-${'proj'}-${body(24)}_${body(24)}`,
  openaiService: `sk-${'svcacct'}-${body(40)}`,
  openaiLegacy: `sk-${body(48)}`,
  supabaseSecret: `sb_${'secret'}_${body(32)}`,
  supabasePublishable: `sb_${'publishable'}_${body(32)}`,
  githubClassic: `gh${'p'}_${body(36)}`,
  githubOauth: `gh${'o'}_${body(36)}`,
  githubFineGrained: `github_${'pat'}_${body(22)}_${body(59)}`,
  slackBot: `xox${'b'}-1234567890-1234567890123-${body(24)}`,
  slackApp: `xap${'p'}-1-A0123456789-1234567890123-${body(32)}`,
  slackClient: `xox${'c'}-1234567890-1234567890123-${body(32)}`,
  slackCookie: `xox${'d'}-${body(40)}`,
  slackRefresh: `xox${'e'}-1-${body(40)}`,
  awsAccessKey: `AKI${'A'}${'IOSFODNN7EXAMPLE'}`,
  awsSessionKey: `ASI${'A'}${'IOSFODNN7EXAMPLE'}`,
  google: `AIz${'a'}Sy${body(33)}`,
  stripe: `sk_${'live'}_${body(24)}`,
  stripeWebhook: `whse${'c'}_${body(32)}`,
  huggingFace: `hf${'_'}${body(34)}`,
  npm: `np${'m'}_${body(36)}`,
  gitlab: `glpa${'t'}-${body(20)}`,
  jwt: `ey${'J'}hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ey${'J'}yb2xlIjoic2VydmljZV9yb2xlIn0.${body(43)}`,
};

const oversizedCredentialShapes: Array<[string, (size: number) => string]> = [
  ['OpenAI legacy key', (size) => `sk-${'A'.repeat(size - 3)}`],
  ['Supabase key', (size) => `sb_secret_${'A'.repeat(size - 10)}`],
  ['GitHub classic key', (size) => `ghp_${'A'.repeat(size - 4)}`],
  ['GitHub fine-grained key', (size) => `github_pat_${'A'.repeat(size - 11)}`],
  ['Slack key', (size) => `xoxb-${'A'.repeat(size - 5)}`],
  ['Slack app key', (size) => `xapp-${'A'.repeat(size - 5)}`],
  ['Google key', (size) => `AIza${'A'.repeat(size - 4)}`],
  ['Stripe key', (size) => `sk_live_${'A'.repeat(size - 8)}`],
  ['Stripe webhook key', (size) => `whsec_${'A'.repeat(size - 6)}`],
  ['Hugging Face key', (size) => `hf_${'A'.repeat(size - 3)}`],
  ['npm key', (size) => `npm_${'A'.repeat(size - 4)}`],
  ['GitLab key', (size) => `glpat-${'A'.repeat(size - 6)}`],
  ['repeated Supabase prefix', (size) => 'sb_secret_'.repeat(Math.ceil(size / 10))],
  ['repeated GitHub fine-grained prefix', (size) => 'github_pat_'.repeat(Math.ceil(size / 11))],
  ['repeated Slack prefix', (size) => 'xoxb-'.repeat(Math.ceil(size / 5))],
  ['repeated Slack app prefix', (size) => 'xapp-'.repeat(Math.ceil(size / 5))],
  ['repeated Google prefix', (size) => 'AIza'.repeat(Math.ceil(size / 4))],
  ['repeated GitLab prefix', (size) => 'glpat-'.repeat(Math.ceil(size / 6))],
  ['JWT-shaped run', (size) => 'eyJ'.repeat(Math.ceil(size / 3))],
  ['bearer token', (size) => `bearer ${'A'.repeat(size - 7)}`],
  ['named token value', (size) => `token = ${'A1'.repeat(Math.ceil((size - 8) / 2))}`],
  ['bare _KEY value', (size) => 'A_KEY='.repeat(Math.ceil(size / 6))],
];

function withKeyPatternReplaceFailure<T>(failEveryTime: boolean, run: () => T) {
  const nativeReplace = String.prototype.replace;
  let failures = 0;
  String.prototype.replace = function (this: string, search: string | RegExp, replacement: string | ((...args: any[]) => string)) {
    if (search instanceof RegExp && search.source.includes('sk-') && (failEveryTime || failures === 0)) {
      failures++;
      throw new RangeError('forced replace failure');
    }
    return Reflect.apply(nativeReplace, this, [search, replacement]) as string;
  } as typeof String.prototype.replace;
  try { return { output: run(), failures }; }
  finally { String.prototype.replace = nativeReplace; }
}

function bothRedactionResults(input: string) {
  const outputs: string[] = [], errors: string[] = [];
  for (const redactText of [redactAll, redact]) {
    try { outputs.push(redactText(input)); }
    catch (error) { errors.push(`${(error as Error).name}: ${(error as Error).message}`); }
  }
  expect(errors).toEqual([]);
  return outputs;
}

describe('recall redaction of modern key shapes', () => {
  for (const [name, secret] of Object.entries(secrets)) {
    it(`hides a ${name} key in prose and in an assignment`, () => {
      for (const text of [`the key is ${secret} for now`, `KEY_VALUE=${secret}`, `{"value": "${secret}"}`]) {
        const out = redact(text);
        expect(out, text).not.toContain(secret);
        // The whole key goes, not a prefix of it.
        expect(out, text).not.toContain(secret.slice(-10));
        expect(out, text).toContain('[redacted]');
      }
    });
  }

  it('hides values of secret-named variables, env lines and JSON keys', () => {
    const value = `exo_${body(32)}`;
    for (const text of [
      `EXOVAULT_AGENT_KEY=${value}`,
      `export DEEPSEEK_API_KEY="${value}"`,
      `"EXOVAULT_AGENT_KEY": "${value}"`,
      `"apiKey": "${value}"`,
      `SUPABASE_SERVICE_ROLE_KEY=${value}`,
      `DB_PASSWORD='${value}'`,
      `Authorization: Bearer ${value}`,
      `curl -H "Authorization: Basic ${value}"`,
      `postgres://app:${value}@db.internal:5432/main`,
      `MYSQL_PWD=${value}`,
      `STRIPE_KEY=${value}`,
      `"auth_token": "Bearer ${value}"`,
      // Only a whole value that refers to a secret stays; one that merely ends like a reference is a secret.
      `DB_PASSWORD='${value}$TOKEN'`,
      `API_KEY=${value}_process.env.JWT_SECRET`,
      `export EXOVAULT_AGENT_KEY="${value}\${HOME}"`,
      // A quote inside the value does not end it early.
      `"EXOVAULT_AGENT_KEY": "it's-${value}"`,
      `"password": "a \\"quoted\\" ${value}"`,
      // A quoted value may span lines.
      `OPENAI_API_KEY="first-line\n${value}"`,
      `API_KEY="first-line\n${value}"&& echo ok`,
      `API_KEY="first-line\n${value}"|tee out`,
      `token = "${value}"`,
      `api_token: ${value}`,
      `refreshToken: '${value}'`,
      `DB_PASS=${value}`,
      `REDIS_URL=redis://:${value}@cache:6379/0`,
    ]) expect(redact(text), text).not.toContain(value.slice(-10));
  });

  it('keeps ids, hashes, paths and ordinary code that recall needs to find', () => {
    for (const text of [
      'commit 0204a2a3f4c5d6e7f8091a2b3c4d5e6f7a8b9c0d on fix/recall-prepare-cache',
      'sha256 191df0de830f4f70b8cf2a6c324c35ed314f74ce08055c4dbc232a740971f9b4',
      'vault 1ffdabed-c2ec-45ac-a924-64c2bab8a900 and session baf7de50-d2b2-430a-9301-963f05bde9a5',
      'scikit-learn is also called sk-learn in some docs',
      'a sk-learn-compatible-estimator-wrapper class',
      'MAX_TOKENS=4000 and S4_GATE_RETRY_LIMIT=3',
      'EXOVAULT_API_URL=http://localhost:3000',
      'token: string; apiKeyName = config.name',
      'see src/lib/embeddings/resolve-provider.ts at version 3.19.0',
      'the risk-assessment-framework-for-teams document',
      'PWD=/srv/app/exo-compact OLDPWD=/tmp',
      'PRIMARY_KEY=users.id and CACHE_KEY=recall-index',
      'apiKey: string; password?: string | undefined',
      'src/sk-learn-compatible-estimator-wrapper-v1.2.ts',
      'max_token = 4000; token = next(); const token: string = read();',
      'BYPASS=true and SKIP_PASS=1',
      'BUILD_PASS=passed LINT_PASS=failed USE_SECRET=true STORE_PASSWORD=false',
    ]) expect(redact(text), text).toBe(text);
  });

  it('does not let an unclosed quoted value swallow the next line', () => {
    const text = 'a.json:8:  "API_KEY": "${user_config.\na.json:9:  "MODEL": "${user_config.model}",';
    expect(redact(text)).toContain('a.json:9:  "MODEL": "${user_config.model}",');
  });

  it('keeps code that only refers to a secret (templates, env reads, calls)', () => {
    for (const text of [
      "headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }",
      'headers: { "Authorization": `Bearer ${config.key}` }',
      '"TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}"',
      'const apiKey = getTypeSafeApiKey({ env: process.env });',
      'EXOVAULT_AGENT_KEY=$EXOVAULT_AGENT_KEY node server.mjs',
      'const secret = process.env.JWT_SECRET;',
      'const apiKey = await loadKey();',
      'DATABASE_URL=postgres://app:${DB_PASSWORD}@db.internal:5432/main',
    ]) expect(redact(text), text).toBe(text);
  });
});

describe('recall redaction compatibility with origin/main', () => {
  it('keeps origin/main outputs for every short redaction sample', () => {
    const value = `exo_${body(32)}`;
    const samples: Array<[string, string]> = [
      ...Object.values(secrets).flatMap((secret) => [
        [`the key is ${secret} for now`, 'the key is [redacted] for now'],
        [`KEY_VALUE=${secret}`, 'KEY_VALUE=[redacted]'],
        [`{"value": "${secret}"}`, '{"value": "[redacted]"}'],
      ]),
      [`EXOVAULT_AGENT_KEY=${value}`, '[redacted]'],
      [`export DEEPSEEK_API_KEY="${value}"`, 'export [redacted]'],
      [`"EXOVAULT_AGENT_KEY": "${value}"`, '[redacted]'],
      [`"apiKey": "${value}"`, '[redacted]'],
      [`SUPABASE_SERVICE_ROLE_KEY=${value}`, '[redacted]'],
      [`DB_PASSWORD='${value}'`, '[redacted]'],
      [`Authorization: Bearer ${value}`, 'Authorization: [redacted]'],
      [`curl -H "Authorization: Basic ${value}"`, 'curl -H "[redacted]"'],
      [`postgres://app:${value}@db.internal:5432/main`, '[redacted]'],
      [`MYSQL_PWD=${value}`, '[redacted]'],
      [`STRIPE_KEY=${value}`, '[redacted]'],
      [`"auth_token": "Bearer ${value}"`, '"auth_token": "[redacted]"'],
      [`DB_PASSWORD='${value}$TOKEN'`, '[redacted]'],
      [`API_KEY=${value}_process.env.JWT_SECRET`, '[redacted]'],
      [`export EXOVAULT_AGENT_KEY="${value}\${HOME}"`, 'export [redacted]'],
      [`"EXOVAULT_AGENT_KEY": "it's-${value}"`, '[redacted]'],
      [`"password": "a \\"quoted\\" ${value}"`, '[redacted]'],
      [`OPENAI_API_KEY="first-line\n${value}"`, '[redacted]'],
      [`API_KEY="first-line\n${value}"&& echo ok`, '[redacted]&& echo ok'],
      [`API_KEY="first-line\n${value}"|tee out`, '[redacted]|tee out'],
      [`token = "${value}"`, '[redacted]'],
      [`api_token: ${value}`, '[redacted]'],
      [`refreshToken: '${value}'`, '[redacted]'],
      [`DB_PASS=${value}`, '[redacted]'],
      [`REDIS_URL=redis://:${value}@cache:6379/0`, 'REDIS_URL=[redacted]'],
      [
        'commit 0204a2a3f4c5d6e7f8091a2b3c4d5e6f7a8b9c0d on fix/recall-prepare-cache',
        'commit 0204a2a3f4c5d6e7f8091a2b3c4d5e6f7a8b9c0d on fix/recall-prepare-cache',
      ],
      [
        'sha256 191df0de830f4f70b8cf2a6c324c35ed314f74ce08055c4dbc232a740971f9b4',
        'sha256 191df0de830f4f70b8cf2a6c324c35ed314f74ce08055c4dbc232a740971f9b4',
      ],
      [
        'vault 1ffdabed-c2ec-45ac-a924-64c2bab8a900 and session baf7de50-d2b2-430a-9301-963f05bde9a5',
        'vault 1ffdabed-c2ec-45ac-a924-64c2bab8a900 and session baf7de50-d2b2-430a-9301-963f05bde9a5',
      ],
      ['scikit-learn is also called sk-learn in some docs', 'scikit-learn is also called sk-learn in some docs'],
      ['a sk-learn-compatible-estimator-wrapper class', 'a sk-learn-compatible-estimator-wrapper class'],
      ['MAX_TOKENS=4000 and S4_GATE_RETRY_LIMIT=3', 'MAX_TOKENS=4000 and S4_GATE_RETRY_LIMIT=3'],
      ['EXOVAULT_API_URL=http://localhost:3000', 'EXOVAULT_API_URL=http://localhost:3000'],
      ['token: string; apiKeyName = config.name', 'token: string; apiKeyName = config.name'],
      [
        'see src/lib/embeddings/resolve-provider.ts at version 3.19.0',
        'see src/lib/embeddings/resolve-provider.ts at version 3.19.0',
      ],
      ['the risk-assessment-framework-for-teams document', 'the risk-assessment-framework-for-teams document'],
      ['PWD=/srv/app/exo-compact OLDPWD=/tmp', 'PWD=/srv/app/exo-compact OLDPWD=/tmp'],
      ['PRIMARY_KEY=users.id and CACHE_KEY=recall-index', 'PRIMARY_KEY=users.id and CACHE_KEY=recall-index'],
      ['apiKey: string; password?: string | undefined', 'apiKey: string; password?: string | undefined'],
      ['src/sk-learn-compatible-estimator-wrapper-v1.2.ts', 'src/sk-learn-compatible-estimator-wrapper-v1.2.ts'],
      [
        'max_token = 4000; token = next(); const token: string = read();',
        'max_token = 4000; token = next(); const token: string = read();',
      ],
      ['BYPASS=true and SKIP_PASS=1', 'BYPASS=true and SKIP_PASS=1'],
      [
        'BUILD_PASS=passed LINT_PASS=failed USE_SECRET=true STORE_PASSWORD=false',
        'BUILD_PASS=passed LINT_PASS=failed USE_SECRET=true STORE_PASSWORD=false',
      ],
      [
        'a.json:8:  "API_KEY": "${user_config.\na.json:9:  "MODEL": "${user_config.model}",',
        'a.json:8:  "API_KEY": "${user_config.\na.json:9:  "MODEL": "${user_config.model}",',
      ],
      [
        "headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }",
        "headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }",
      ],
      ['headers: { "Authorization": `Bearer ${config.key}` }', 'headers: { "Authorization": `Bearer ${config.key}` }'],
      ['"TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}"', '"TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}"'],
      [
        'const apiKey = getTypeSafeApiKey({ env: process.env });',
        'const apiKey = getTypeSafeApiKey({ env: process.env });',
      ],
      ['EXOVAULT_AGENT_KEY=$EXOVAULT_AGENT_KEY node server.mjs', 'EXOVAULT_AGENT_KEY=$EXOVAULT_AGENT_KEY node server.mjs'],
      ['const secret = process.env.JWT_SECRET;', 'const secret = process.env.JWT_SECRET;'],
      ['const apiKey = await loadKey();', 'const apiKey = await loadKey();'],
      [
        'DATABASE_URL=postgres://app:${DB_PASSWORD}@db.internal:5432/main',
        'DATABASE_URL=postgres://app:${DB_PASSWORD}@db.internal:5432/main',
      ],
      ['PASSWORD=12345678901234567890', '[redacted]'],
      ['API_KEY=12345678901234567890', '[redacted]'],
      ['password=12345678901234567890', '[redacted]'],
    ];

    expect(samples).toHaveLength(123);
    const joinedInput = samples.map(([input]) => input).join('\n');
    const joinedExpected = samples.map(([, expected]) => expected).join('\n');
    const padding = 'x'.repeat(64 * 1024);
    const input = `${joinedInput}\n${padding}`, expected = `${joinedExpected}\n${padding}`;
    expect(input.length).toBeGreaterThan(64 * 1024);
    expect(input.split(/\r\n|\r|\n|\u2028|\u2029/).every((line) => line.length <= 64 * 1024)).toBe(true);
    expect(redactAll(input)).toBe(expected);
    for (const [input, expected] of samples) {
      expect(redactAll(input), input).toBe(expected);
      expect(redact(input), input).toBe(expected);
    }
  });
});

describe('recall redaction of oversized credential runs', () => {
  it.each(oversizedCredentialShapes)('returns strings for a 6 MB %s run', (_name, make) => {
    const outputs = bothRedactionResults(make(6 * 1024 * 1024));
    expect(outputs).toHaveLength(2);
    for (const output of outputs) {
      expect(output).toContain('[redacted]');
      expect(output.length).toBeLessThan(100);
    }
  }, 60_000);

  it('returns strings and hides a 24 MB oversized run', () => {
    const outputs = bothRedactionResults(oversizedCredentialShapes[1][1](24 * 1024 * 1024));
    expect(outputs).toEqual(['[redacted]', '[redacted]']);
  }, 60_000);

  it('hides a real-looking key embedded in 6 MB of each oversized shape', () => {
    const value = secrets.anthropic;
    const errors: string[] = [];
    for (const [name, make] of oversizedCredentialShapes) {
      const filler = make(6 * 1024 * 1024), at = Math.floor(filler.length / 2);
      const input = `${filler.slice(0, at)}${value}${filler.slice(at)}`;
      for (const redactText of [redactAll, redact]) {
        try { expect(redactText(input), name).not.toContain(value); }
        catch (error) { errors.push(`${name}: ${(error as Error).name}: ${(error as Error).message}`); }
      }
    }
    expect(errors).toEqual([]);
  }, 60_000);

  it('keeps every no-key line byte-identical in a large brief', () => {
    const clean = '- A checklist line without a key stays byte-identical';
    const lines = Array.from({ length: 60_000 }, () => clean);
    const longCleanLine = 'ordinary brief text '.repeat(60_000);
    const secretLine = `OPENAI_API_KEY=${secrets.openaiProject}`;
    lines.splice(30_000, 0, longCleanLine, secretLine);
    const output = redactAll(lines.join('\n')).split('\n');
    expect(output).toHaveLength(lines.length);
    for (let i = 0; i < lines.length; i++) {
      expect(output[i], `line ${i}`).toBe(lines[i] === secretLine ? 'OPENAI_API_KEY=[redacted]' : lines[i]);
    }
  }, 60_000);

  it.each([
    ['two spaces', `Authorization: bearer  ${'a1'.repeat(3_000_000)}`],
    ['tab and spaces', `bearer \t  ${'a1'.repeat(3_000_000)}`],
  ])('redacts an oversized bearer value after %s', (_name, input) => {
    const output = redactAll(input);
    expect(output.includes('[redacted]')).toBe(true);
    expect(output.includes('a1'.repeat(32))).toBe(false);
  }, 60_000);

  it('fails closed on oversized named and URL credential values', () => {
    const jsonValue = 'a1'.repeat(3_000_000);
    const urlPassword = 'p'.repeat(6_000_000);
    const largeValue = 'p'.repeat(65 * 1024);
    const cases: Array<[string, string, string]> = [
      ['quoted JSON api key', `"api_key": "${jsonValue}"`, jsonValue],
      ['URL credential password', `https://u:${urlPassword}@h`, urlPassword],
      ['nested URL credential password', `https://user${'x'.repeat(300)}/https://u:${urlPassword}@h`, urlPassword],
      ['password name', `PASSWORD=${largeValue}`, 'p'.repeat(32)],
      ['secret name', `secret: ${largeValue}`, 'p'.repeat(32)],
      ['token name', `token = ${largeValue}`, 'p'.repeat(32)],
      ['bare _KEY name', `CACHE_KEY=${largeValue}`, 'p'.repeat(32)],
      ['bare _PASS name', `DB_PASS=${largeValue}`, 'p'.repeat(32)],
      ['bare _PWD name', `DB_PWD=${largeValue}`, 'p'.repeat(32)],
      ['quoted YAML key', `'api key': '${largeValue}'`, 'p'.repeat(32)],
      ['authorization name', `Authorization: ${largeValue}`, 'p'.repeat(32)],
      ['authorization Basic value', `Authorization: Basic ${largeValue}`, 'p'.repeat(32)],
    ];
    const failed: string[] = [];
    for (const [label, input, value] of cases) {
      const output = redactAll(input);
      if (!output.includes('[redacted]') || output.includes(value)) failed.push(label);
    }
    expect(failed).toEqual([]);
  }, 60_000);

  it('keeps a large minified lock file unchanged when credential words are in short-valued keys', () => {
    const lock = JSON.stringify({ name: 'x', password_min_length: 8, packages: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => ['pkg' + i, { version: '1.0.' + i, resolved: 'https://registry.npmjs.org/pkg' + i }])) });
    expect(lock.length).toBeGreaterThan(200_000);
    expect(redactAll(lock)).toBe(lock);
  });

  it('hides an oversized quoted JSON password value', () => {
    const input = JSON.stringify({ password: 'p'.repeat(70_000) });
    const output = redactAll(input);
    expect(output).toBe('{"password":[redacted]}');
    expect(output).not.toContain('p'.repeat(32));
  });

  it('keeps minified JSON token counters unchanged without whitespace', () => {
    const input = '"token_count":5,' + '"a":1,'.repeat(20_000);
    expect(redactAll(input)).toBe(input);
  });

  it('does not treat quoted keys as credential names beyond regex marker bounds', () => {
    const key = 'a'.repeat(41) + 'password';
    const input = JSON.stringify({ [key]: 'p'.repeat(70_000) });
    const output = redactAll(input);
    expect(output.length).toBe(input.length);
    expect(output.startsWith(`{"${key}":"pppp`)).toBe(true);
  });

  it('does not treat password_min_length as a password assignment', () => {
    const input = 'password_min_length=8;' + 'x'.repeat(70_000);
    expect(redactAll(input)).toBe(input);
  });

  it('keeps oversized numeric values excluded by uppercase named patterns', () => {
    const input = 'MAX_TOKENS=' + '4'.repeat(70_000);
    expect(redactAll(input)).toBe(input);
  });

  it('redacts short all-digit password and API key values like origin/main', () => {
    for (const input of ['PASSWORD=12345678901234567890', 'API_KEY=12345678901234567890']) {
      expect(redactAll(input), input).toBe('[redacted]');
      expect(redact(input), input).toBe('[redacted]');
    }
  });

  it('redacts quoted credential keys at the full regex bound', () => {
    const key = 'a'.repeat(40) + 'credentials' + 'b'.repeat(40);
    const input = `{"${key}":"${'p'.repeat(65_537)}"}`;
    expect(redactAll(input)).toBe(`{"${key}":[redacted]}`);
  });

  it('hides an oversized unterminated quoted credential value through EOF', () => {
    const value = 'p'.repeat(65_537);
    const input = `{"password":"${value}`;
    expect(redactAll(input)).toBe('{"password":[redacted]');
    expect(redact(input)).toBe('{"password":[redacted]');
    expect(redactAll(`{"password":"${value}\nMODEL=public`)).toBe('{"password":[redacted]\nMODEL=public');
  });

  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])('keeps an oversized unterminated quoted value line ending %j', (ending) => {
    const value = 'p'.repeat(65_537);
    const input = `{"password":"${value}${ending}MODEL=public`;
    expect(redactAll(input)).toBe(`{"password":[redacted]${ending}MODEL=public`);
  });

  it('redacts an oversized quoted value that closes after a line ending', () => {
    const input = `{"password":"${'p'.repeat(65_537)}\n${'q'.repeat(20)}"}`;
    expect(redactAll(input)).toBe('{"password":[redacted]}');
  });

  it('starts oversized-key redaction at the credential candidate', () => {
    const input = `prefix-sk-${'A'.repeat(65_536)} suffix`;
    expect(redactAll(input)).toBe('prefix-[redacted] suffix');
    expect(redact(input)).toBe('prefix-[redacted] suffix');
  });

  it('matches origin/main whitespace semantics for an oversized uppercase named value', () => {
    const input = 'DB_PASSWORD=' + 'p'.repeat(70_000) + ';echo ok';
    expect(redactAll(input)).toBe('DB_PASSWORD=[redacted] ok');
  });

  it('does not let an oversized redaction exemption preserve a later password value', () => {
    const input = "PASSWORD=[redacted];password=hunter2\nsk-" + 'A'.repeat(65_536);
    expect(redactAll(input)).toBe('[redacted]\n[redacted]');
  });

  it('does not treat a bare oversized eyJ prefix as a JWT', () => {
    const input = 'eyJ' + 'A'.repeat(65_537);
    expect(redactAll(input)).toBe(input);
  });

  it('keeps text after the character class matched by an oversized provider key', () => {
    const input = 'sk-' + 'A'.repeat(65_537) + '-notes and keep me';
    expect(redactAll(input)).toBe('[redacted]-notes and keep me');
  });

  it('keeps the unquoted name pattern value-to-whitespace boundary', () => {
    const input = 'password=' + 'p'.repeat(70_000) + ';echo ok';
    expect(redactAll(input)).toBe('password=[redacted] ok');
  });

  it('keeps unquoted values after a quoted authorization key fail closed', () => {
    const input = '"authorization": bearer ' + 'p'.repeat(70_000);
    expect(redactAll(input)).toBe('"authorization": bearer [redacted]');
  });

  it('matches origin/main for realistic minified JSON with short credential-word values', () => {
    const input = JSON.stringify({ name: 'sample', password_min_length: 8, token_count: 5, public_key: 42, packages: Object.fromEntries(Array.from({ length: 2500 }, (_, i) => ['pkg' + i, { version: '1.0.' + i, resolved: 'https://registry.npmjs.org/pkg' + i }])) });
    expect(input.length).toBeGreaterThan(190_000);
    expect(input.length).toBeLessThan(210_000);
    // origin/main's named patterns leave this under-bound minified lock data byte-identical.
    expect(redactAll(input)).toBe(input);
  });

  it('handles megabytes of bearer separator whitespace in one pass', () => {
    const input = `bearer ${' \t'.repeat(500_000)}${'a1'.repeat(3_000_000)}`;
    const output = redactAll(input);
    expect(output.endsWith('[redacted]')).toBe(true);
    expect(output.includes('a1'.repeat(32))).toBe(false);
  }, 60_000);

  it('leaves credential values between the existing bounds and 64 KiB unchanged', () => {
    const jsonValue = 'a1'.repeat(2_500);
    const urlPassword = 'p'.repeat(1_024);
    const input = `"api_key": "${jsonValue}"\nhttps://u:${urlPassword}@h`;
    expect(redactAll(input)).toBe(input);
  });

  it('retries a key pattern after its replace throws RangeError', () => {
    const result = withKeyPatternReplaceFailure(false, () => redactAll('sk-' + 'A'.repeat(24)));
    expect(result.failures).toBe(1);
    expect(result.output).toBe('[redacted]');
  });

  it('fails closed when a key pattern still throws after the oversized-run pass', () => {
    const input = `safe line\n${'Z'.repeat(65 * 1024)}\nanother safe line`;
    const result = withKeyPatternReplaceFailure(true, () => redactAll(input));
    expect(result.failures).toBeGreaterThanOrEqual(2);
    expect(result.output).toBe('safe line\n[redacted]\nanother safe line');
  });
});

describe('recall redaction cost', () => {
  // Every indexed row goes through redact(); a pattern with super-linear backtracking would stall a build.
  // 4.9.1: Check each input's CPU growth independently so one backtracking shape cannot hide in the aggregate.
  it('redacts each adversarial 48 KB input with linear CPU growth', () => {
    const shapes = [
      (scale: number) => 'sk-'.repeat(16000 * scale), (scale: number) => 'sk-a'.repeat(12000 * scale),
      (scale: number) => 'password="'.repeat(4800 * scale), (scale: number) => '"token": "'.repeat(4800 * scale),
      (scale: number) => 'A_KEY='.repeat(8000 * scale), (scale: number) => 'x://:'.repeat(9600 * scale),
      (scale: number) => 'eyJ'.repeat(16000 * scale), (scale: number) => 'authorization: '.repeat(3200 * scale),
      (scale: number) => 'xoxb-'.repeat(9600 * scale), (scale: number) => 'token = a1'.repeat(4800 * scale),
    ];
    for (const shape of shapes) {
      const label = shape(1).slice(0, 20);
      // Start at four and double per shape until the fastest of three 48 KB samples uses 20 ms of CPU (cap 1024);
      // both input sizes use this count.
      const base = shape(1);
      const runs = cpuRepetitions(() => redact(base));
      expect(cpuGrowth((scale) => {
        const text = shape(scale);
        for (let run = 0; run < runs; run++) redact(text);
      }, undefined, 1), label).toBeLessThan(8);
    }
  }, 60_000);

  it('keeps separator-heavy inputs within linear CPU growth', () => {
    const shapes: Array<[string, (megabytes: number) => string]> = [
      ['equals', (megabytes) => '='.repeat(megabytes * 1024 * 1024)],
      ['colons', (megabytes) => ':'.repeat(megabytes * 1024 * 1024)],
      ['letter and equals', (megabytes) => 'a='.repeat(megabytes * 1024 * 1024 / 2)],
      ['quoted key and colon', (megabytes) => '"a":'.repeat(megabytes * 1024 * 1024 / 4)],
    ];
    for (const [name, shape] of shapes) {
      const runs = cpuRepetitions(() => redact(shape(1)));
      expect(cpuGrowth((megabytes) => {
        const input = shape(megabytes);
        for (let run = 0; run < runs; run++) redact(input);
      }, undefined, 1), name).toBeLessThan(8);
    }
  }, 120_000);
});

describe('recall index built before this redaction', () => {
  const worker = path.join(fileURLToPath(new URL('..', import.meta.url)), 'recall/build-worker.mjs');
  const event = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
  const latest = (dir: string) => {
    const generation = Number(readFileSync(path.join(dir, 'CURRENT'), 'utf8').trim());
    const base = path.join(dir, `generation-${String(generation).padStart(8, '0')}`);
    return { base, generation, rows: JSON.parse(readFileSync(path.join(base, 'records.json'), 'utf8')) as Array<{ text: string }> };
  };

  it('redacts rows carried over from an older generation on the next build', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 's4-recall-redact-'));
    try {
      const transcript = path.join(temp, 's.jsonl'), index = path.join(temp, 'index'), dir = path.join(index, hash('s'));
      writeFileSync(transcript, event('First message about the deploy key.'));
      spawnSync(process.execPath, [worker, transcript, index, 's', String(statSync(transcript).size)], { encoding: 'utf8' });
      // An index written by an older redactor still holds the key verbatim.
      const old = latest(dir);
      old.rows[0].text = `First message: the key is ${secrets.openaiProject}`;
      writeFileSync(path.join(old.base, 'records.json'), JSON.stringify(old.rows));

      appendFileSync(transcript, event('Second message after more work.'));
      spawnSync(process.execPath, [worker, transcript, index, 's', String(statSync(transcript).size)], { encoding: 'utf8' });
      const next = latest(dir);
      expect(next.generation).toBe(old.generation + 1);
      expect(JSON.stringify(next.rows)).not.toContain(secrets.openaiProject);
      expect(next.rows[0].text).toContain('[redacted]');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('drops vectors for carried-over rows redacted by the next build and keeps unchanged row vectors', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 's4-recall-redact-vectors-'));
    try {
      const transcript = path.join(temp, 's.jsonl'), index = path.join(temp, 'index'), dir = path.join(index, hash('s'));
      writeFileSync(transcript, `${event('First message about the deploy key.')}${event('A clean row that stays unchanged.')}`);
      const first = spawnSync(process.execPath, [worker, transcript, index, 's', String(statSync(transcript).size)], { encoding: 'utf8' });
      expect(first.status, first.stderr).toBe(0);
      const old = latest(dir);
      old.rows[0].text = `First message: the key is ${secrets.openaiProject}`;
      writeFileSync(path.join(old.base, 'records.json'), JSON.stringify(old.rows));
      const oldKey = textKey(old.rows[0].text), cleanKey = textKey(old.rows[1].text);
      const axis = (n: number) => { const value = new Float32Array(DIM); value[n] = 1; return value; };
      appendVectors(vectorFile(dir), [{ key: oldKey, vector: axis(0) }, { key: cleanKey, vector: axis(1) }]);

      appendFileSync(transcript, event('Second message after more work.'));
      const nextBuild = spawnSync(process.execPath, [worker, transcript, index, 's', String(statSync(transcript).size)], { encoding: 'utf8' });
      expect(nextBuild.status, nextBuild.stderr).toBe(0);
      const next = latest(dir);
      expect(next.rows[0].text).toContain('[redacted]');
      expect(storedKeys(vectorFile(dir))).not.toContain(oldKey);
      expect(storedKeys(vectorFile(dir))).toContain(cleanKey);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('redacts rows carried over from a parent session index into a forked session', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 's4-recall-redact-'));
    try {
      const index = path.join(temp, 'index'), parentFile = path.join(temp, 'p.jsonl'), childFile = path.join(temp, 'c.jsonl');
      const line = (sessionId: string, uuid: string, text: string, parentUuid?: string) => JSON.stringify({
        type: 'user', sessionId, uuid, ...(parentUuid ? { parentUuid } : {}), message: { role: 'user', content: [{ type: 'text', text }] },
      }) + '\n';
      writeFileSync(parentFile, line('p', 'u1', 'Parent message about the deploy key.'));
      const built = spawnSync(process.execPath, [worker, parentFile, index, 'p', String(statSync(parentFile).size), temp], { encoding: 'utf8' });
      expect(built.status, built.stderr).toBe(0);
      // The parent index was written by an older redactor and still holds the key verbatim.
      const old = latest(path.join(index, hash('p')));
      old.rows[0].text = `Parent message: the key is ${secrets.anthropic}`;
      writeFileSync(path.join(old.base, 'records.json'), JSON.stringify(old.rows));

      writeFileSync(childFile, line('c', 'u2', 'Child message after the fork.', 'u1'));
      const forked = spawnSync(process.execPath, [worker, childFile, index, 'c', String(statSync(childFile).size), temp], { encoding: 'utf8' });
      expect(forked.status, forked.stderr).toBe(0);
      const child = latest(path.join(index, hash('c')));
      expect(child.rows.some((row) => row.text.startsWith('Parent message'))).toBe(true);
      expect(JSON.stringify(child.rows)).not.toContain(secrets.anthropic.slice(-10));
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
