import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCuts } from './quiz.mjs';

const dirs = [];
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
const dumpWith = (id) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutid-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'cut-a.json'), JSON.stringify({ id, source: '/x.jsonl', s4Full: 's', native: 'n' }));
  return dir;
};

describe('loadCuts rejects path-escaping cut ids', () => {
  it('accepts a plain id', () => {
    assert.equal(loadCuts(dumpWith('abc-1.2_x'), undefined).length, 1);
  });
  for (const bad of ['cut-x/../../tmp/evil', '../evil', 'a/b', '..', '', 'a b']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => loadCuts(dumpWith(bad), undefined), /unsafe cut id/);
    });
  }
});
