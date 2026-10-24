import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { armMemory, loadCuts } from '../real-replay/quiz.mjs';

describe('s4tree quiz arm', () => {
  it('keeps the S4 seed and adds the matching cut view in a Session tree section', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's4tree-arm-'));
    const previous = process.env.QUIZ_TREE_DIR;
    try {
      fs.writeFileSync(path.join(dir, 'cut-c1.view.txt'), '[t1-0-2 L1 mixed] earlier work');
      process.env.QUIZ_TREE_DIR = dir;
      const cut = {
        id: 'c1', sessionId: 'S1',
        s4Full: '## Key facts\n- changed timeout\n\n## Transcript\n/home/u/old.jsonl',
      };
      const memory = armMemory(cut, 's4tree', '/tmp/q/S1.jsonl');
      expect(memory).toContain('## Key facts\n- changed timeout');
      expect(memory).toContain('## Transcript\n/tmp/q/S1.jsonl\n\n');
      expect(memory).toContain('## Session tree\n[t1-0-2 L1 mixed] earlier work');
      expect(memory).toContain('search_session');
    } finally {
      if (previous === undefined) delete process.env.QUIZ_TREE_DIR;
      else process.env.QUIZ_TREE_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets S4-only arms load a real cut even when no native summary exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's4tree-plan-'));
    const dump = path.join(dir, 'dump');
    fs.mkdirSync(dump);
    try {
      fs.writeFileSync(path.join(dump, 'cut-c1.json'), JSON.stringify({
        id: 'c1', source: path.join(dir, 'session.jsonl'), boundaryLine: 1, sessionId: 'S1', s4Full: 'seed',
      }));
      expect(loadCuts(dump, ['c1'], ['s4', 's4tree'])).toHaveLength(1);
      expect(loadCuts(dump, ['c1'], ['native', 's4'])).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
