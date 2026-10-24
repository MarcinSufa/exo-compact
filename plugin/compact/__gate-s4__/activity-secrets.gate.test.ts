import { describe, expect, it } from 'vitest';
import { isHighEntropyFragment, isSecretLikePath, reconcile } from '../core/extractor.js';
import type { SessionMessage } from '../core/types.js';

// S4o review (3.15.2): every leak the review confirmed, as a fixture that must never reach a record.
const activityFor = (tool: string, input: Record<string, unknown>): { text: string; all: string } => {
  const message: SessionMessage = { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'tool-x', tool, input }] };
  const records = reconcile([message], null, { hash: (value) => `hash:${value}` }).records;
  return { text: String(records.find((record) => record.kind === 'tool_activity')?.body.text ?? ''), all: JSON.stringify(records) };
};

describe('tool activity keeps no secrets', () => {
  it.each([
    ['curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJl" https://api.x.dev', 'eyJhbGciOiJIUzI1NiJ9'],
    ['curl -H "x-api-key: nothing" -H "Authorization: Bearer sk-ant-api03-AbCdEfGhIjKlMnOp" https://api.x.dev', 'AbCdEfGhIjKlMnOp'],
    ['GITHUB_TOKEN=gho_AbCdEfGhIjKlMnOpQrStUvWx12 gh pr list', 'gho_AbCdEf'],
    ['export OPENAI_TOKEN=abcdefghij12345 && run', 'abcdefghij12345'],
    ['deploy --password hunter2secret --token Tk_9f8e7d6c5b4a3210ZZyy', 'hunter2secret'],
    ['deploy --password hunter2secret --token Tk_9f8e7d6c5b4a3210ZZyy', 'Tk_9f8e7d6c5b4a3210ZZyy'],
    ['mysql -u root -pHunter2Secret app', 'Hunter2Secret'],
    ['curl -u admin:Sup3rS3cret https://x.dev', 'Sup3rS3cret'],
    ['stripe --api-key sk_live_51HxYzAbCdEfGhIjKl charges', 'sk_live_51HxYz'],
    ['echo wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLE > /dev/null', 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLE'],
  ])('Bash %s drops the secret', (command, secret) => {
    const { all } = activityFor('Bash', { command });
    expect(all).not.toContain(secret);
  });

  it('redacts the whole command before cutting it to 200 characters', () => {
    const command = `${'x'.repeat(170)} psql postgres://admin:hunter2superlongpassword@db.internal:5432/app`;
    const { all } = activityFor('Bash', { command });
    expect(all).not.toContain('hunter2super');
  });

  it('keeps ordinary command lines readable', () => {
    expect(activityFor('Bash', { command: 'npx vitest run plugin --reporter=dot && git log --oneline -3 1cdea02' }).text)
      .toBe('$ npx vitest run plugin --reporter=dot && git log --oneline -3 1cdea02');
    expect(activityFor('Bash', { command: 'JEV_QUERY_MAX_TOKENS=4000 node run.mjs' }).text).toContain('JEV_QUERY_MAX_TOKENS=4000');
  });

  it('a Grep for a leaked key does not store the key', () => {
    const { all, text } = activityFor('Grep', { pattern: 'sk-ant-api03-AbCdEfGhIjKlMnOp', path: '/repo' });
    expect(all).not.toContain('AbCdEfGhIjKlMnOp');
    expect(text).toContain('in /repo');
  });

  it.each([
    ['src/stripe.ts', 'export const client = new Stripe("sk_live_51HxYzAbCdEfGhIjKl");', 'sk_live'],
    ['src/config.ts', 'export const config = { apiToken: "a1b2c3d4e5f6a7b8c9d0", clientSecretValue: "Zq9ReallySecretValue" };', 'Zq9ReallySecretValue'],
    ['src/config.ts', 'export const config = { apiToken: "a1b2c3d4e5f6a7b8c9d0" };', 'a1b2c3d4e5f6a7b8c9d0'],
    ['config/prod.yaml', 'jwt: eyJhbGciOiJIUzI1NiJ9.abcDEF123456\nkey: Zq9ReallySecretValue\n', 'Zq9ReallySecretValue'],
  ])('a code or config edit of %s keeps no literal values', (file_path, content, secret) => {
    const { all } = activityFor('Write', { file_path, content });
    expect(all).not.toContain(secret);
  });

  it('a code edit keeps the names it declares', () => {
    const { text } = activityFor('Edit', { file_path: 'src/pay.ts', old_string: '', new_string: 'export async function chargeCustomer(id: string) {\n  return stripe.charges.create({ key: "sk_live_51HxYzAbCdEfGhIjKl" });\n}\nclass PaymentQueue {}' });
    expect(text).toBe('edit src/pay.ts: chargeCustomer PaymentQueue');
  });

  it.each(['/srv/acme/tokens.json', '/home/u/.aws/config', '/home/u/.kube/config', '/home/u/.docker/config.json', '/home/u/.config/gh/hosts.yml', 'C:\\Users\\u\\.ssh\\known_hosts'])('%s is a secret-looking path', (filePath) => {
    expect(isSecretLikePath(filePath)).toBe(true);
    const { text, all } = activityFor('Write', { file_path: filePath, content: 'aws_session_token = IQoJb3JpZ2luX2VjEJrSomethingLong' });
    expect(text).toBe(`edit ${filePath}`);
    expect(all).not.toContain('IQoJb3JpZ2lu');
  });

  it.each(['src/tokenizer.ts', 'docs/token-budget.md', 'src/settings-panel.tsx'])('%s is not a secret-looking path', (filePath) => {
    expect(isSecretLikePath(filePath)).toBe(false);
  });

  it('NotebookEdit reads notebook_path and new_source, and denies secret paths', () => {
    expect(activityFor('NotebookEdit', { notebook_path: 'nb/analysis.ipynb', new_source: 'def load_frames(path):\n    return path' }).text).toBe('edit nb/analysis.ipynb: load_frames');
    expect(activityFor('NotebookEdit', { notebook_path: '/home/u/.aws/nb.ipynb', new_source: 'def leak(): pass' }).text).toBe('edit /home/u/.aws/nb.ipynb');
  });

  it('Read records the path only', () => {
    expect(activityFor('Read', { file_path: 'src/core/dense.ts' }).text).toBe('read src/core/dense.ts');
  });

  it.each([
    ['wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLE', true], ['f0e1d2c3b4a5968778695a4b3c2d1e0f', true], ['51HxYzAbCdEfGhIjKl', true],
    ['handleOAuth2CallbackRequest', false], ['createClientWithRetry2', false], ['mergeCodexHooksIntoGroups', false],
    ['1cdea02', false], ['996cdf8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e', false], ['SEED_BUDGET_TOKENS', false],
  ])('isHighEntropyFragment(%s) is %s', (fragment, expected) => {
    expect(isHighEntropyFragment(fragment)).toBe(expected);
  });

  it('a config file write is not captured as a file_write fact', () => {
    const message: SessionMessage = { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'tool-y', tool: 'Write', input: { file_path: 'deploy/values.yaml', content: 'image: app\nkey: Zq9ReallySecretValue\n' } }] };
    const records = reconcile([message], null, { hash: (value) => `hash:${value}` }).records;
    expect(records.filter((record) => record.kind === 'file_write')).toHaveLength(0);
    expect(JSON.stringify(records)).not.toContain('Zq9ReallySecretValue');
  });

  it('a shapeless random key is dropped from Grep patterns, prose edits and file_write facts alike', () => {
    const key = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLE';
    expect(activityFor('Grep', { pattern: key, path: '/repo' }).all).not.toContain(key);
    const prose = activityFor('Write', { file_path: 'notes/staging.md', content: `The staging key is ${key} for src/app.ts.` });
    expect(prose.all).not.toContain(key);
    expect(prose.text).toContain('src/app.ts');
  });

  it('keeps ids that are not secrets: full commit hashes, UUIDs, short hashes', () => {
    const text = 'commit 996cdf8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e task 0bfb309f-7cfe-451f-847e-3217e660905e short 1cdea02';
    const message: SessionMessage = { role: 'assistant', text, toolUses: [] };
    const all = JSON.stringify(reconcile([message], null, { hash: (value) => `hash:${value}` }).records);
    for (const id of ['996cdf8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e', '0bfb309f-7cfe-451f-847e-3217e660905e', '1cdea02']) expect(all).toContain(id);
  });
});
