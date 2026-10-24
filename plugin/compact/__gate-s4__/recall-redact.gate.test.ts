import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash, redact } from '../recall/shared.mjs';

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

describe('recall redaction cost', () => {
  // Every indexed row goes through redact(); a pattern with super-linear backtracking would stall a build.
  it('redacts adversarial 48 KB inputs in bounded time', () => {
    for (const text of [
      'sk-'.repeat(16000), 'sk-a'.repeat(12000), 'password="'.repeat(4800), '"token": "'.repeat(4800), 'A_KEY='.repeat(8000),
      'x://:'.repeat(9600), 'eyJ'.repeat(16000), 'authorization: '.repeat(3200), 'xoxb-'.repeat(9600), 'token = a1'.repeat(4800),
    ]) {
      const started = performance.now();
      redact(text);
      expect(performance.now() - started, text.slice(0, 20)).toBeLessThan(150);
    }
  });
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
