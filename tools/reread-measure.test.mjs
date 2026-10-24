import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bashReads, measure } from './reread-measure.mjs';

test('bashReads resolves cat/sed -n paths against a leading cd', () => {
  assert.deepEqual(bashReads("cd /repo && sed -n 60,260p proxy/src/connect.ts; cat a.json", '/home'), ['/repo/proxy/src/connect.ts', '/repo/a.json']);
  assert.deepEqual(bashReads('git log --oneline -3', '/repo'), []);
});

test('measure counts a post-cut re-read once and skips the host copy of the kept tail', () => {
  const use = (id, file) => JSON.stringify({ type: 'assistant', cwd: '/r', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }] } });
  const result = (id, chars) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(chars) }] } });
  const lines = [
    use('t1', '/r/a.ts'), result('t1', 4000),
    use('t2', '/r/b.ts'), result('t2', 400),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' } }),
    JSON.stringify({ type: 'user', message: { content: '[[exovault:s4-seed:v1]]' } }),
    use('t2', '/r/b.ts'), result('t2', 400),
    use('t3', '/r/a.ts'), result('t3', 4000),
  ];
  const [cut] = measure(lines);
  assert.equal(cut.kind, 's4');
  assert.deepEqual(cut.rereads, ['/r/a.ts']);
  assert.equal(cut.rereadTokens, 1000);
  assert.equal(cut.policies['8k/3k'].savedTokens, 1000);
});
