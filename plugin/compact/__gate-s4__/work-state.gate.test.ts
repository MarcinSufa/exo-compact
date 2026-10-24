import { describe, expect, it } from 'vitest';
import { foldWorkState, parseTaskNotifications, renderWorkState, workEvents } from '../core/work-state.js';
import { reconcile } from '../core/extractor.js';
import { humanPrompt, assistantCall, toolResultsMessage, sha256, countTokens } from './fixtures/helpers.js';
import type { SessionMessage } from '../core/types.js';

let bashId = 0;
const bash = (command: string, result = '', extra: Record<string, unknown> = {}): SessionMessage[] => {
  const id = `b${++bashId}`;
  const use = assistantCall('Bash', { tool_use_id: id, input: { command, ...extra } });
  return [use, ...(result ? [toolResultsMessage([{ toolUseId: id, options: { text: result } }])] : [])];
};

describe('S4q work state capture', () => {
  it('captures navigation and git state commands with credentials removed', () => {
    bashId = 0;
    const events = workEvents([
      ...bash('cd a && git -C /r worktree add -b feat/x ../wt main'),
      ...bash('git clone https://user:tok@github.com/o/r.git dir'),
      ...bash('git clone --branch main --depth 1 https://github.com/o/r2.git repo'),
      ...bash('git checkout src/file.ts'),
      ...bash('git switch -c x'),
      ...bash('git checkout -b checkout-branch'),
      ...bash('git checkout -B y'),
      ...bash('git switch z'),
      ...bash('git push -u origin feat/x', 'To https://github.com/o/r/pull/14'),
      ...bash('git worktree remove -f ../wt'),
      ...bash('gh pr list', 'https://github.com/o/r/pull/13'),
    ]);
    expect(events).toEqual(expect.arrayContaining([
      { type: 'cd', path: 'a' },
      { type: 'worktree_add', path: '../wt', branch: 'feat/x', repo: '/r' },
      { type: 'clone', url: 'https://github.com/o/r.git', dir: 'dir' },
      { type: 'clone', url: 'https://github.com/o/r2.git', dir: 'repo' },
      { type: 'branch', name: 'x', created: true },
      { type: 'branch', name: 'checkout-branch', created: true },
      { type: 'branch', name: 'y', created: true },
      { type: 'branch', name: 'z', created: false },
      { type: 'push', branch: 'feat/x' },
      { type: 'worktree_remove', path: '../wt' },
      { type: 'pr', url: 'https://github.com/o/r/pull/13' },
      { type: 'pr', url: 'https://github.com/o/r/pull/14' },
    ]));
    expect(events.filter((event) => event.type === 'branch')).toHaveLength(4);
  });

  it('skips sensitive commands and secret-like paths', () => {
    bashId = 0;
    expect(workEvents([...bash('cd ~/.ssh && ls'), ...bash('cat .env'), ...bash('cd .ssh')])).toEqual([]);
  });

  it('drops redirects, skips option words, and resolves push refspec destinations', () => {
    bashId = 0;
    const events = workEvents([
      ...bash('git clone https://github.com/o/r.git 2>&1 | tail -1'),
      ...bash('git clone https://github.com/o/r.git >&2'),
      ...bash('git clone https://github.com/o/r.git 2>/dev/null'),
      ...bash('git clone https://github.com/o/r.git >> out'),
      ...bash('git clone https://github.com/o/r.git < in'),
      ...bash('git clone https://github.com/o/r.git <<< word'),
      ...bash('git clone https://github.com/o/r.git &>out'),
      ...bash('git clone https://github.com/o/r.git 1>x'),
      ...bash('git clone https://github.com/o/r.git 2> x'),
      ...bash('git clone https://github.com/o/r.git |& tail'),
      ...bash('git push -u origin feat/x 2>&1 | tail -2'),
      ...bash('git push 2>&1'),
      ...bash('git worktree add --detach ../wt HEAD'),
      ...bash('git worktree add ../wt -b feat/x'),
      ...bash('git worktree add --detach -f --force --checkout --lock --orphan --track --no-track -q ../flags HEAD'),
      ...bash('git -C /r push origin src:dst'),
      ...bash('git push --force-with-lease --tags -n --dry-run --no-verify -o trace origin src:dst'),
    ]);
    expect(events).toEqual(expect.arrayContaining([
      { type: 'clone', url: 'https://github.com/o/r.git' },
      { type: 'push', branch: 'feat/x' },
      { type: 'worktree_add', path: '../wt' },
      { type: 'worktree_add', path: '../wt', branch: 'feat/x' },
      { type: 'worktree_add', path: '../flags' },
      { type: 'push', branch: 'dst', repo: '/r' },
      { type: 'push', branch: 'dst' },
    ]));
    expect(events.filter((event) => event.type === 'clone')).toHaveLength(10);
    expect(events.filter((event) => event.type === 'push')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'worktree_add')).toHaveLength(3);
  });

  it('ignores heredoc bodies, quoted command text, substitutions, unsafe words, and unresolved dollar paths', () => {
    bashId = 0;
    const command = [
      "cat > note.md <<'EOF'",
      'cd ~/work/project/C:\\path\\to\\project',
      'EOF',
      'printf "%s" "cd ~/quoted/project"',
      'cd $(pwd)',
      '$(cd /tmp)',
      '`cd /tmp`',
      '(cd /tmp)',
      'cd $D',
      'cd "$WORK/x"',
      'git worktree add --detach ../wt HEAD',
      'git clone https://github.com/o/r.git > out',
    ].join('\n');
    expect(workEvents(bash(command)).filter((event) => event.type !== 'cwd_unknown')).toEqual([{ type: 'worktree_add', path: '../wt' }, { type: 'clone', url: 'https://github.com/o/r.git' }]);
  });

  it('applies the command cap before scanning large heredoc and quoted payloads', () => {
    bashId = 0;
    const heredocPrefix = 'cat <<EOF\ncd /should-not-appear\n';
    const heredocSuffix = '\nEOF';
    const heredoc = heredocPrefix + 'x'.repeat(4096 - heredocPrefix.length - heredocSuffix.length) + heredocSuffix;
    const quotedPrefix = 'echo "';
    const quotedSuffix = '"';
    const quotedContent = ' cd /should-not-appear';
    const quoted = quotedPrefix + 'x'.repeat(4096 - quotedPrefix.length - quotedSuffix.length - quotedContent.length) + quotedContent + quotedSuffix;
    expect(heredoc).toHaveLength(4096);
    expect(quoted).toHaveLength(4096);
    expect(workEvents([...bash(heredoc), ...bash(quoted)])).toEqual([]);
  });

  it('does not use words joined to substitutions as paths and skips heredoc bodies even with trailing operators', () => {
    bashId = 0;
    const command = [
      'cd "$(git rev-parse --show-toplevel)/plugin/compact"',
      'cd $(git rev-parse --show-toplevel)/plugin',
      'cd `pwd`/sub',
      'git worktree add "$(mktemp -d)/wt"',
      'git -C "$(pwd)/r" checkout -b feat',
      "cat <<'EOF' > notes.md",
      'cd /evil/dir',
      'EOF',
      "python3 - <<'PY' 2>&1 | tail",
      'cd /evil',
      'PY',
      'cat > f <<A && echo hi <<B',
      'cd /evil/a', 'A', 'cd /evil/b', 'B',
    ].join('\n');
    const events = workEvents(bash(command));
    expect(events.every((event) => event.type === 'cwd_unknown')).toBe(true);
  });

  it('parses global git options, switch creation, normalized push refs and comments', () => {
    bashId = 0;
    const events = workEvents([...bash('git --no-pager -C /srv/repo -c core.quotepath=false switch --create feature/x'), ...bash('git checkout -q -b other'), ...bash('git -P --git-dir /r/.git --work-tree /r switch main'), ...bash('git push origin HEAD:refs/heads/feat/x'), ...bash('git push origin +feat/x'), ...bash('git push origin refs/heads/x'), ...bash('# git switch fake\ngit switch main')]);
    expect(events).toContainEqual({ type: 'branch', name: 'feature/x', created: true, repo: '/srv/repo' });
    expect(events).toContainEqual({ type: 'push', branch: 'feat/x' });
    expect(events).toContainEqual({ type: 'push', branch: 'x' });
    expect(events).toContainEqual({ type: 'branch', name: 'main', created: false });
    expect(events.filter((event) => event.type === 'branch' && event.name === 'main')).toHaveLength(2);
    expect(events.some((event) => event.type === 'branch' && event.name === 'fake')).toBe(false);
  });

  it('captures commits, PRs, background work and task events', () => {
    bashId = 0;
    const messages = [
      ...bash('git commit -m x', '[main abc1234] Fix login'),
      ...bash('git commit -m init', '[main (root-commit) def5678] First commit'),
      ...bash('git commit -m delayed', 'warning before commit\n[feat/x c0ffee1] Commit on later line'),
      ...bash('gh pr create', 'https://github.com/o/r/pull/12'),
      ...bash('sleep 1', 'command running with ID: b80ze853k', { run_in_background: true, description: 'Wait' }),
      assistantCall('Agent', { tool_use_id: 'a1', input: { description: 'Review', run_in_background: true } }),
      toolResultsMessage([{ toolUseId: 'a1', options: { text: 'agentId: worker-2' } }]),
      assistantCall('Task', { tool_use_id: 'a2', input: { description: 'No id, still in background', run_in_background: true } }),
      humanPrompt('<task-notification><task-id>b80ze853k</task-id><status>completed</status><summary>Done</summary></task-notification>'),
      assistantCall('TodoWrite', { input: { todos: [{ content: 'Fix login', status: 'in_progress' }] } }),
      assistantCall('TaskCreate', { tool_use_id: 't1', input: { subject: 'Write tests' } }),
      toolResultsMessage([{ toolUseId: 't1', options: { text: 'Task #12 created successfully: Write tests' } }]),
      assistantCall('TaskUpdate', { input: { taskId: '12', status: 'deleted' } }),
      assistantCall('TaskUpdate', { input: { taskId: '99', status: 'in_progress', subject: 'Review output' } }),
      ...bash('true'),
    ];
    expect(workEvents(messages)).toEqual(expect.arrayContaining([
      { type: 'commit', branch: 'main', sha: 'abc1234', subject: 'Fix login' },
      { type: 'commit', branch: 'main', sha: 'def5678', subject: 'First commit' },
      { type: 'commit', branch: 'feat/x', sha: 'c0ffee1', subject: 'Commit on later line' },
      { type: 'pr', url: 'https://github.com/o/r/pull/12' },
      expect.objectContaining({ type: 'bg_start', id: 'b80ze853k', via: 'bash', label: 'Wait' }),
      expect.objectContaining({ type: 'bg_start', id: 'worker-2', via: 'agent', label: 'Review' }),
      expect.objectContaining({ type: 'bg_start', tool_use_id: 'a2', via: 'agent', label: 'No id, still in background' }),
      expect.objectContaining({ type: 'bg_end', id: 'b80ze853k', status: 'completed' }),
      { type: 'todos', items: [{ content: 'Fix login', status: 'in_progress' }] },
      { type: 'task', id: '12', status: 'pending', subject: 'Write tests' },
      { type: 'task', id: '12', status: 'deleted' },
      { type: 'task', id: '99', status: 'in_progress', subject: 'Review output' },
    ]));
  });

  it('caps pull request URLs extracted from one tool result at five', () => {
    const urls = Array.from({ length: 7 }, (_, i) => `https://github.com/o/r/pull/${i}`).join('\n');
    const events = workEvents(bash('gh pr list', urls));
    expect(events.filter((event) => event.type === 'pr')).toHaveLength(5);
  });

  it('captures only real background Agent jobs, strips ID punctuation, and applies shell cwd reset', () => {
    const messages = [
      ...bash('git push 2>&1', 'Shell cwd was reset to /project/root'),
      assistantCall('Agent', { tool_use_id: 'fg', input: { description: 'Foreground' } }),
      toolResultsMessage([{ toolUseId: 'fg', options: { text: 'agentId: foreground-id' } }]),
      assistantCall('Agent', { tool_use_id: 'bg', input: { description: 'Background', run_in_background: true } }),
      toolResultsMessage([{ toolUseId: 'bg', options: { text: 'Async agent launched; agentId: worker-2' } }]),
      ...bash('sleep 1', 'command running with ID: bzch9qgap.', { run_in_background: true }),
      ...bash('cd /background-only && sleep 2', 'command running with ID: background-cd\nShell cwd was reset to /background-only', { run_in_background: true }),
    ];
    const events = workEvents(messages);
    expect(events).toContainEqual({ type: 'cd', path: '/project/root' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'bg_start', id: 'worker-2' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'bg_start', id: 'bzch9qgap' }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'bg_start', id: 'foreground-id' }));
    expect(events.some((event) => event.type === 'cd' && event.path === '/background-only')).toBe(false);
  });

  it('hides labels for sensitive background Bash commands', () => {
    bashId = 0;
    expect(workEvents(bash('cat .env', 'command running with ID: secret-job', { run_in_background: true, description: 'cat .env' })))
      .toContainEqual({ type: 'bg_start', id: 'secret-job', via: 'bash', label: '(command hidden)' });
  });
});

it('ignores tool results with no matching use in the message list', () => {
  const result = toolResultsMessage([{ toolUseId: 'missing', options: { text: 'Task #4 created successfully: Hidden task' } }]);
  expect(workEvents([result])).toEqual([]);
});

describe('S4q work state fold and render', () => {
  it('resolves relative directory chains and keeps removed worktrees out', () => {
    const state = foldWorkState([
      { type: 'cd', path: 'a' },
      { type: 'cd', path: '../b' },
      { type: 'worktree_add', path: '../wt', branch: 'feat/x' },
      { type: 'worktree_remove', path: '../wt' },
    ], '/repo');
    expect(state.directory).toBe('/repo/b');
    expect(state.worktrees).toEqual([]);
  });

  it('uses the last TodoWrite and folds background completion by id', () => {
    const state = foldWorkState([
      { type: 'todos', items: [{ content: 'old', status: 'pending' }] },
      { type: 'todos', items: [{ content: 'new', status: 'in_progress' }, { content: 'Update docs', status: 'completed' }] },
      { type: 'bg_start', id: 'one', via: 'bash', label: 'first' },
      { type: 'bg_end', id: 'one', status: 'completed', summary: 'ok' },
      { type: 'bg_start', id: 'two', via: 'agent', label: 'second' },
    ], '/repo');
    expect(state.todos).toEqual([{ content: 'new', status: 'in_progress' }, { content: 'Update docs', status: 'completed' }]);
    expect(state.backgrounds.find((job) => job.id === 'one')?.status).toBe('completed');
    expect(state.backgrounds.find((job) => job.id === 'two')?.status).toBeUndefined();
    expect(renderWorkState(state, undefined, 700, countTokens)).toContain('1 completed (last: Update docs)');
  });

  it('renders stable reference lines and preserves mandatory details under budget', () => {
    const state = foldWorkState([{ type: 'cd', path: '/repo' }, { type: 'bg_start', id: 'job', via: 'bash', label: 'build' }, { type: 'task', id: '1', subject: 'Fix login', status: 'in_progress' }], '/start');
    const rendered = renderWorkState(state, { git: '/repo: ## main; 2 changed files', worktrees: [] }, 700, countTokens);
    expect(rendered).toContain('Directory: /repo (session started in /start)');
    expect(rendered).toContain('Git at the cut: /repo: ## main; 2 changed files');
    expect(rendered).toContain('Background: started job "build"');
    expect(rendered).toContain('Tasks: [in_progress] Fix login');
    expect(renderWorkState(foldWorkState([], '/repo'), undefined, 700, countTokens)).toBe('');
  });

  it('drops old optional history first while retaining directory, cut Git, started jobs and open tasks', () => {
    const events = [
      ...Array.from({ length: 8 }, (_, index) => ({ type: 'clone' as const, url: `https://github.com/o/r${index}`, dir: `/tmp/clone${index}` })),
      ...Array.from({ length: 8 }, (_, index) => ({ type: 'pr' as const, url: `https://github.com/o/r/pull/${index}` })),
      ...Array.from({ length: 5 }, (_, index) => ({ type: 'commit' as const, branch: 'main', sha: `sha${index}`, subject: `commit ${index}` })),
      ...Array.from({ length: 8 }, (_, index) => ({ type: 'bg_start' as const, id: `done${index}`, via: 'bash' as const, label: `finished ${index}` })),
      ...Array.from({ length: 8 }, (_, index) => ({ type: 'bg_end' as const, id: `done${index}`, status: 'completed' })),
      { type: 'bg_start' as const, id: 'live', via: 'agent' as const, label: 'Keep me running' },
      { type: 'task' as const, id: 'open', subject: 'Keep this task', status: 'in_progress' },
    ];
    const rendered = renderWorkState(foldWorkState(events, '/repo'), { git: '/repo: ## main; 2 changed files' }, 300, (text) => text.length);
    expect(rendered).toContain('Directory: /repo');
    expect(rendered).toContain('Git at the cut: /repo: ## main; 2 changed files');
    expect(rendered).toContain('started live "Keep me running"');
    expect(rendered).toContain('[in_progress] Keep this task');
    expect(rendered).not.toContain('/tmp/clone0');
    expect(rendered).not.toContain('pull/0');
  });

  it('matches the compact line format for a small work trail', () => {
    const state = foldWorkState([
      { type: 'cd', path: '/repo' },
      { type: 'worktree_add', path: '/tmp/wt', branch: 'feat/x' },
      { type: 'clone', url: 'https://github.com/o/r', dir: '/tmp/r' },
      { type: 'branch', name: 'feat/x', repo: '/repo' },
      { type: 'push', branch: 'feat/x', repo: '/repo' },
      { type: 'commit', branch: 'feat/x', sha: '1b15b71', subject: 'Replay summary' },
      { type: 'pr', url: 'https://github.com/o/r/pull/12' },
    ], '/start');
    expect(renderWorkState(state, undefined, 700, countTokens)).toBe([
      'Directory: /repo (session started in /start)',
      'Worktrees: /tmp/wt [feat/x]',
      'Cloned: /tmp/r <- https://github.com/o/r',
      'Branches: created feat/x in /repo; pushed feat/x',
      'Commits (newest last): 1b15b71 Replay summary',
      'PRs: https://github.com/o/r/pull/12',
    ].join('\n'));
  });

  it('deduplicates rendered lists by text, keeps the newest occurrence, and applies list caps', () => {
    const events = [
      { type: 'clone' as const, url: 'https://github.com/o/old', dir: '/tmp/old' },
      { type: 'clone' as const, url: 'https://github.com/o/repeated', dir: '/tmp/repeated' },
      { type: 'clone' as const, url: 'https://github.com/o/new', dir: '/tmp/new' },
      { type: 'clone' as const, url: 'https://github.com/o/repeated', dir: '/tmp/repeated' },
      ...Array.from({ length: 5 }, (_, index) => ({ type: 'pr' as const, url: `https://github.com/o/r/pull/${index}` })),
      { type: 'push' as const, branch: 'feat/x', repo: '/repo' },
      { type: 'push' as const, branch: 'feat/y', repo: '/repo' },
      { type: 'push' as const, branch: 'feat/x', repo: '/repo' },
    ];
    const rendered = renderWorkState(foldWorkState(events, '/repo'), undefined, 700, countTokens);
    expect(rendered).toContain('Cloned: /tmp/new <- https://github.com/o/new; /tmp/repeated <- https://github.com/o/repeated');
    expect(rendered).toContain('PRs: https://github.com/o/r/pull/2; https://github.com/o/r/pull/3; https://github.com/o/r/pull/4');
    expect(rendered).toContain('Branches: pushed feat/y; pushed feat/x');
    expect(rendered).not.toContain('pull/0');
  });
});

it('reconcile persists work_event records', () => {
  const messages = bash('cd /tmp');
  expect(reconcile(messages, null, { hash: sha256 }).records.some((record) => record.kind === 'work_event')).toBe(true);
});

  it('scans a 64 KB segmented command in bounded time', () => {
  const command = 'a && '.repeat(13_000);
  const start = performance.now();
  workEvents(bash(command));
  expect(performance.now() - start).toBeLessThan(100);
});

describe('S4q render details (fix 1 follow-up)', () => {
  it('names the directory git clone creates when none is given', () => {
    const state = foldWorkState([
      { type: 'cd', path: '/home/u/work' },
      { type: 'clone', url: 'https://github.com/o/claude-watch-video.git' },
      { type: 'clone', url: 'git@github.com:o/other-repo' },
    ], '/home/u');
    const rendered = renderWorkState(state, undefined, 700, countTokens);
    expect(rendered).toContain('Cloned: /home/u/work/claude-watch-video <- https://github.com/o/claude-watch-video.git; /home/u/work/other-repo <- git@github.com:o/other-repo');
    expect(rendered).not.toContain('default directory');
  });

  it('tokenizes long digit runs and mixed shell syntax within the scan budget', () => {
    const digitRun = `${'9'.repeat(3900)} && cd /tmp`;
    const mixed = `echo "${'x'.repeat(3600)}" ${'$(echo x) '.repeat(30)} <<'E' && cd /tmp\nE`;
    const start = performance.now();
    workEvents([...bash(digitRun), ...bash(mixed)]);
    expect(performance.now() - start).toBeLessThan(100);
  });

  it('bounds task notification scans and ignores unclosed bodies', () => {
    const start = performance.now();
    expect(parseTaskNotifications(`<task-notification>${'x'.repeat(380_000)}`)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(100);
  });

  it('prints each job status once and keeps jobs still waiting over finished ones', () => {
    const events = [
      { type: 'bg_start', id: 'old1', via: 'bash', label: 'still waiting 1' },
      ...Array.from({ length: 6 }, (_, i) => ({ type: 'bg_start', id: `done${i}`, via: 'agent', label: `finished ${i}` })),
      { type: 'bg_start', id: 'fail', via: 'bash', label: 'broke' },
      { type: 'bg_start', id: 'new1', via: 'bash', label: 'still waiting 2' },
      ...Array.from({ length: 6 }, (_, i) => ({ type: 'bg_end', id: `done${i}`, status: 'completed' })),
      { type: 'bg_end', id: 'fail', status: 'failed' },
    ] as Parameters<typeof foldWorkState>[0];
    const rendered = renderWorkState(foldWorkState(events, '/s'), undefined, 700, countTokens);
    expect(rendered).toContain('Background: started old1 "still waiting 1"; completed done4 "finished 4"; completed done5 "finished 5"; failed fail "broke"; started new1 "still waiting 2"');
    expect(rendered).not.toMatch(/\((completed|failed)\)/);
  });

  it('drops finished jobs before started ones when over budget', () => {
    const events = [
      { type: 'cd', path: '/r' },
      { type: 'bg_start', id: 'wait', via: 'bash', label: 'x'.repeat(40) },
      { type: 'bg_start', id: 'done', via: 'bash', label: 'y'.repeat(40) },
      { type: 'bg_end', id: 'done', status: 'failed' },
    ] as Parameters<typeof foldWorkState>[0];
    const state = foldWorkState(events, '/s');
    const full = renderWorkState(state, undefined, 700, countTokens);
    const tight = renderWorkState(state, undefined, countTokens(full) - 5, countTokens);
    expect(tight).toContain('started wait');
    expect(tight).not.toContain('failed done');
  });

  it('caps large task state and always stays within its token budget', () => {
    const events = [
      ...Array.from({ length: 120 }, (_, i) => ({ type: 'task' as const, id: `task-${i}`, subject: `task ${i} ${'x'.repeat(160)}`, status: 'pending' })),
      { type: 'todos' as const, items: Array.from({ length: 30 }, (_, i) => ({ content: `todo ${i} ${'y'.repeat(160)}`, status: 'pending' })) },
      ...Array.from({ length: 12 }, (_, i) => ({ type: 'bg_start' as const, id: `job-${i}`, via: 'bash' as const, label: 'z'.repeat(150) })),
    ];
    const rendered = renderWorkState(foldWorkState(events, '/repo'), undefined, 700, countTokens);
    expect(countTokens(rendered)).toBeLessThanOrEqual(700);
    expect(rendered).toContain('Directory: /repo');
  });

  it('uses an absolute cwd snapshot and resolves worktree paths relative to git -C repo', () => {
    const state = foldWorkState([
      { type: 'cwd_snapshot', path: '/p' }, { type: 'cd', path: 'sub' },
      { type: 'cwd_snapshot', path: '/p/sub' }, { type: 'worktree_add', path: '../wt', repo: '/srv/repo', branch: 'feat/x' },
    ], '/');
    expect(state.directory).toBe('/p/sub');
    expect(state.sessionCwd).toBe('/p');
    expect(state.worktrees).toEqual([{ path: '/srv/wt', branch: 'feat/x' }]);
    expect(renderWorkState(state, undefined, 700, countTokens, '/p/sub')).toContain('Directory: /p/sub (session started in /p)');
  });

  it('keeps relative paths unresolved after unknown cd until an absolute path or snapshot', () => {
    const state = foldWorkState([
      { type: 'cwd_unknown' }, { type: 'worktree_add', path: '../lost' },
      { type: 'cd', path: '/known' }, { type: 'worktree_add', path: '../kept' },
    ], '/stale');
    expect(state.worktrees).toEqual([{ path: '/kept' }]);
    expect(state.directory).toBe('/known');
  });

  it('prioritizes the probed worktree and event-created worktrees, and preserves random host temp paths', () => {
    const randomCwd = '/tmp/tmp.Xk9fQ2';
    const state = foldWorkState([{ type: 'worktree_add', path: '/event-created', branch: 'feat' }, { type: 'branch', name: 'main' }], randomCwd);
    const probe = { directory: '/probe', worktrees: [
      { path: '/probe', branch: 'main' }, { path: '/probe/w1' }, { path: '/probe/w2' },
      { path: '/event-created', branch: 'feat' }, { path: '/probe/w3' }, { path: '/probe/w4' }, { path: '/probe/w5' },
    ] };
    const rendered = renderWorkState(state, probe, 700, countTokens, randomCwd);
    expect(rendered).toContain('Directory: /tmp/tmp.Xk9fQ2');
    expect(rendered).toContain('Worktrees: /probe [main]; /event-created [feat]; /probe/w1; /probe/w2; /probe/w3; /probe/w4');
    expect(rendered).not.toContain('/probe/w5');
  });
});
