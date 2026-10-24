import { describe, expect, it } from 'vitest';
import { condenseUserHistory, condenseUserMessage, HISTORY_MAX_CHARS, HISTORY_MAX_MESSAGES } from '../core/history.js';
import { SEED_SENTINEL } from '../core/sentinel.js';

describe('3.13.0 (S4m) user history for the seed', () => {
  it('keeps what the user typed and strips harness blocks', () => {
    expect(condenseUserMessage('run the tests\n<system-reminder>\nlong reminder\n</system-reminder>')).toBe('run the tests');
    expect(condenseUserMessage('<task-notification>\n<task-id>a</task-id>\n<status>completed</status>\n</task-notification>')).toBeUndefined();
  });

  it('drops seeds, native summaries, interruptions and stop notices whole', () => {
    for (const text of [`${SEED_SENTINEL}\n## Constraints`, 'This session is being continued from a previous conversation that ran out of context.', '[Request interrupted by user for tool use]', 'Your response above was stopped by a safeguard.'])
      expect(condenseUserMessage(text), text.slice(0, 20)).toBeUndefined();
  });

  it('shows a paste as its size and head only', () => {
    const paste = `line one of the paste ${'z'.repeat(5000)}`;
    const out = condenseUserMessage(`look at this:\n<pasted_content id="995c">\n${paste}\n</pasted_content id="995c">\nwhat broke?`)!;
    expect(out).toMatch(/^look at this:\n\[pasted 50\d\d chars: line one of the paste z+…\]\nwhat broke\?$/);
    expect(out.length).toBeLessThan(HISTORY_MAX_CHARS + 80);
  });

  it('caps a long message keeping both ends, so a request after an inline paste survives', () => {
    const out = condenseUserMessage(`log:\n${'ERR line\n'.repeat(200)}please fix the null check in auth.ts`)!;
    expect(out.length).toBeLessThanOrEqual(HISTORY_MAX_CHARS + 60);
    expect(out).toMatch(/^log:\nERR line/);
    expect(out).toContain('chars, full text in the transcript…]');
    expect(out).toMatch(/please fix the null check in auth\.ts$/);
  });

  it('renders a slash command as /name args', () => {
    expect(condenseUserMessage('<command-message>code-review</command-message>\n<command-name>/code-review</command-name>\n<command-args>high, only the auth module</command-args>')).toBe('/code-review high, only the auth module');
    expect(condenseUserMessage('<command-name>/clear</command-name>')).toBe('/clear');
  });

  it('never leaves half of a surrogate pair at a cut', () => {
    const lone = (s: string): boolean => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
    for (let pad = 190; pad <= 410; pad += 1) {
      const out = condenseUserMessage(`${'a'.repeat(pad)}${'😀'.repeat(300)}`)!;
      expect(lone(out), `pad ${pad}`).toBe(false);
    }
    const paste = condenseUserMessage(`<pasted_content>${'b'.repeat(119)}😀😀</pasted_content>`)!;
    expect(lone(paste)).toBe(false);
  });

  it('strips nested harness blocks whole and keeps text after an unclosed tag', () => {
    expect(condenseUserMessage('<system-reminder>a<system-reminder>b</system-reminder>c</system-reminder>real')).toBe('real');
    expect(condenseUserMessage('keep <system-reminder>this stays')).toBe('keep this stays');
  });

  it('stays fast on huge and adversarial input (round 15: the hook runs synchronously)', () => {
    const inputs = [
      `a${' \u00a0'.repeat(500000)}b`,
      '<system-reminder>x'.repeat(50000),
      `${'<system-reminder>'.repeat(20000)}${'</system-reminder>'.repeat(20000)}tail`,
      `${'<pasted_content>'.repeat(30000)}x`,
      '\r\n'.repeat(400000),
    ];
    for (const input of inputs) {
      const started = performance.now();
      condenseUserMessage(input);
      expect(performance.now() - started, input.slice(0, 20)).toBeLessThan(250);
    }
  });

  it('keeps only the newest messages, drops immediate repeats, reports what it left out', () => {
    const texts = Array.from({ length: 30 }, (_, i) => `message ${i}`);
    texts.push('message 29', '<task-notification><status>x</status></task-notification>');
    const { messages, omittedCount } = condenseUserHistory(texts);
    expect(messages).toHaveLength(HISTORY_MAX_MESSAGES);
    expect(messages[messages.length - 1]).toBe('message 29');
    expect(messages[0]).toBe(`message ${30 - HISTORY_MAX_MESSAGES}`);
    expect(omittedCount).toBe(30 - HISTORY_MAX_MESSAGES);
  });
});

describe('3.13.0 (S4m) user history, review round 2', () => {
  it('a harness block cut by the 64 KB window never leaves its body behind', () => {
    const out = condenseUserMessage(`<system-reminder>${'REMINDER '.repeat(5000)}</system-reminder>${'paste '.repeat(9000)}real ask at end`)!;
    expect(out).not.toContain('REMINDER');
    expect(out).toMatch(/real ask at end$/);
  });

  it('strips any number of harness blocks', () => {
    expect(condenseUserMessage(`${'<system-reminder>r</system-reminder>'.repeat(5000)}real ask`)).toBe('real ask');
  });

  it('command tags inside a paste are not a slash command; a bare command-message is dropped', () => {
    expect(condenseUserMessage('fix this <pasted_content>log <command-name>/x</command-name> tail</pasted_content> please')).toBe('fix this\n[pasted 40 chars: log <command-name>/x</command-name> tail]\nplease');
    expect(condenseUserMessage('<command-message>foo is running</command-message>')).toBeUndefined();
  });

  it('a tag-like word in typed text is text, and a longer closing name is not a close', () => {
    expect(condenseUserMessage('the tag <system-reminder is odd; also a > b means greater')).toBe('the tag <system-reminder is odd; also a > b means greater');
    expect(condenseUserMessage('<system-reminder>a</system-reminder-extra> typed</system-reminder>more')).toBe('more');
  });

  it('stays fast on tag floods without > or newlines', () => {
    for (const input of ['<system-reminder '.repeat(60000), '</system-reminder '.repeat(60000), `<system-reminder>${'</system-reminder-x>'.repeat(40000)}`, `${'<pasted_content '.repeat(4000)}${'x'.repeat(100)}`]) {
      const started = performance.now();
      condenseUserMessage(input);
      expect(performance.now() - started, input.slice(0, 20)).toBeLessThan(250);
    }
  });
});
