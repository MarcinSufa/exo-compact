import { isSecretLikePath, redactCapturedText, redactHostPath, shouldSkipToolOutput } from './extractor.js';
import type { SessionMessage, TokenCounter } from './types.js';
import { WORK_STATE_BUDGET_TOKENS } from './budgets.js';
import { isSeedMessage } from './sentinel.js';

export type WorkEvent =
  | { type: 'cwd_snapshot'; path: string }
  | { type: 'cwd_unknown' }
  | { type: 'cd'; path: string }
  | { type: 'worktree_add'; path: string; branch?: string; repo?: string }
  | { type: 'worktree_remove'; path: string; repo?: string }
  | { type: 'clone'; url: string; dir?: string }
  | { type: 'branch'; name: string; repo?: string; created?: boolean }
  | { type: 'push'; branch: string; repo?: string }
  | { type: 'commit'; branch: string; sha: string; subject: string }
  | { type: 'pr'; url: string }
  | { type: 'bg_start'; id?: string; tool_use_id?: string; via: 'bash' | 'agent'; label: string }
  | { type: 'bg_end'; id: string; status: string; summary?: string }
  | { type: 'todos'; items: Array<{ content: string; status: string }> }
  | { type: 'task'; id: string; subject?: string; status?: string };

export interface WorkState {
  sessionCwd: string;
  directory: string;
  worktrees: Array<{ path: string; branch?: string }>;
  clones: Array<{ dir?: string; url: string }>;
  branches: Array<{ name: string; repo: string; created?: boolean }>;
  pushes: Array<{ branch: string; repo: string }>;
  commits: Array<{ branch: string; sha: string; subject: string }>;
  prs: string[];
  todos: Array<{ content: string; status: string }>;
  tasks: Map<string, { id: string; subject?: string; status?: string }>;
  backgrounds: Array<{ id: string; via: 'bash' | 'agent'; label: string; status?: string; summary?: string }>;
}

export interface WorkStateProbe {
  directory?: string;
  git?: string;
  worktrees?: Array<{ path: string; branch?: string }>;
}

const MAX_STRING = 200;
const MAX_COMMAND = 4096;
const URL_CREDENTIALS = /(https?:\/\/)(?:[^\s/@]+@)/gi;
const PR_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;
const CLONE_OPTIONS_WITH_VALUES = new Set(['-b', '--branch', '-o', '--origin', '-c', '--config', '--depth', '--shallow-since', '--shallow-exclude', '--reference', '--reference-if-able', '--separate-git-dir', '--upload-pack', '--filter', '--server-option', '--bundle-uri', '--revision', '--template', '--jobs', '-j']);
const PUSH_OPTIONS_WITH_VALUES = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
const PUSH_FLAGS = new Set(['-u', '--set-upstream', '-f', '--force', '--tags', '-n', '--dry-run', '--no-verify']);

function clean(value: string): string {
  return redactCapturedText(value).replace(URL_CREDENTIALS, '$1').slice(0, MAX_STRING);
}

function cleanLine(value: string): string {
  return clean(value).replace(/[\r\n\t]+/g, ' ').trim();
}

type ShellCommand = string[];

function shellCommands(command: string): ShellCommand[] {
  const out: ShellCommand[] = [];
  let args: string[] = [];
  let word = '';
  const pendingHeredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
  let quote = '';
  let escaped = false;
  let i = 0;
  const flushWord = (): void => { if (word) args.push(word); word = ''; };
  const flushCommand = (): void => { flushWord(); if (args.length) out.push(args); args = []; };
  const skipNested = (open: string, close: string, start: number): number => {
    let depth = 1;
    let q = '';
    let esc = false;
    for (let j = start; j < command.length; j += 1) {
      const c = command[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (q) { if (c === q) q = ''; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === open) depth += 1;
      else if (c === close && --depth === 0) return j + 1;
    }
    return command.length;
  };
  while (i < command.length) {
    const c = command[i];
    if (escaped) { word += c; escaped = false; i += 1; continue; }
    if (c === '\\') { escaped = true; i += 1; continue; }
    if (quote) {
      if (quote === '"' && c === '$' && command[i + 1] === '(') { word += '\u0000'; i = skipNested('(', ')', i + 2); continue; }
      if (quote === '"' && c === '`') { word += '\u0000'; i += 1; while (i < command.length) { if (command[i] === '\\') { i += 2; continue; } if (command[i++] === '`') break; } continue; }
      if (c === quote) quote = ''; else word += c;
      i += 1; continue;
    }
    if (c === '"' || c === "'") { quote = c; i += 1; continue; }
    if (c === '`') { word += '\u0000'; i += 1; while (i < command.length) { if (command[i] === '\\') { i += 2; continue; } if (command[i++] === '`') break; } continue; }
    if (c === '$' && command[i + 1] === '(') { word += '\u0000'; i = skipNested('(', ')', i + 2); continue; }
    if (c === '(') { flushWord(); i = skipNested('(', ')', i + 1); continue; }
    // Heredoc bodies are data, not shell commands. Delimiters may be quoted and <<- strips tabs.
    if (c === '<' && command[i + 1] === '<' && command[i + 2] === '<') {
      flushWord(); i += 3;
      while (command[i] === ' ' || command[i] === '\t') i += 1;
      if (command[i] === '"' || command[i] === "'") { const q = command[i++]; while (i < command.length && command[i] !== q) { if (command[i] === '\\') i += 1; i += 1; } if (command[i] === q) i += 1; }
      else while (i < command.length && !/\s/.test(command[i]) && !';|&'.includes(command[i])) i += 1;
      continue;
    }
    if (c === '<' && command[i + 1] === '<') {
      flushWord();
      const stripTabs = command[i + 2] === '-';
      i += stripTabs ? 3 : 2;
      while (command[i] === ' ' || command[i] === '\t') i += 1;
      let delimiter = '';
      let q = '';
      while (i < command.length && command[i] !== '\n' && !/\s/.test(command[i])) {
        const h = command[i++];
        if ((h === '"' || h === "'") && !q) q = h;
        else if (h === q) q = '';
        else delimiter += h;
      }
      pendingHeredocs.push({ delimiter, stripTabs });
      continue;
    }
    // Remove ordinary redirections and their target word (including fd-prefixed forms).
    let redirEnd = i;
    if (!word) while (redirEnd < command.length && /[0-9]/.test(command[redirEnd] ?? '')) redirEnd += 1;
    if (command[redirEnd] === '&' && command[redirEnd + 1] === '>') redirEnd += 2;
    else if (command[redirEnd] === '>' || command[redirEnd] === '<') {
      const operator = command[redirEnd];
      redirEnd += 1;
      if (command[redirEnd] === operator || (operator === '>' && command[redirEnd] === '&')) redirEnd += 1;
    } else redirEnd = i;
    if (redirEnd > i) {
      flushWord(); i = redirEnd;
      while (command[i] === ' ' || command[i] === '\t') i += 1;
      if (command[i] === '"' || command[i] === "'") { const q = command[i++]; while (i < command.length && command[i] !== q) { if (command[i] === '\\') i += 1; i += 1; } if (command[i] === q) i += 1; }
      else while (i < command.length && !/\s/.test(command[i]) && !';|&'.includes(command[i])) i += 1;
      continue;
    }
    if (c === '\n') {
      flushCommand(); i += 1;
      for (const heredoc of pendingHeredocs.splice(0)) {
        while (i < command.length) {
          const end = command.indexOf('\n', i), stop = end < 0 ? command.length : end;
          const line = command.slice(i, stop);
          if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) { i = end < 0 ? stop : end + 1; break; }
          i = end < 0 ? stop : end + 1;
        }
      }
      continue;
    }
    if (c === '#' && !word) { const end = command.indexOf('\n', i); i = end < 0 ? command.length : end; continue; }
    if (c === ';' || (c === '&' && command[i + 1] !== '>') || c === '|') {
      flushCommand();
      if ((c === '&' || c === '|') && command[i + 1] === c) i += 1;
      else if (c === '|' && command[i + 1] === '&') i += 1;
      i += 1; continue;
    }
    if (/\s/.test(c)) { flushWord(); i += 1; continue; }
    word += c; i += 1;
  }
  flushCommand();
  return out;
}

const unsafeShellWord = (word: string): boolean => !word || word.startsWith('-') || /[<>|&$*?‹›`\u0000]/.test(word);
const safeValue = (word: string | undefined): word is string => Boolean(word && !unsafeShellWord(word));

function positionalArgs(args: readonly string[], valuedOptions: ReadonlySet<string>): string[] {
  const positional: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (options && arg === '--') { options = false; continue; }
    if (options && arg.startsWith('-')) {
      if (!arg.includes('=') && valuedOptions.has(arg)) i += 1;
      continue;
    }
    positional.push(arg);
  }
  return positional;
}

function pathEvent(type: 'cd' | 'worktree_add' | 'worktree_remove', value: string, extra: Record<string, string> = {}): WorkEvent | undefined {
  if (isSecretLikePath(value)) return undefined;
  const path = clean(value);
  if (type === 'cd') return { type, path };
  return { type, path, ...extra } as WorkEvent;
}

function commandEvents(command: string, parsed: readonly ShellCommand[]): WorkEvent[] {
  if (command.length > MAX_COMMAND) return [];
  if (parsed.some((args) => args.some((word) => /(?:^|\/)\.(?:ssh|aws|kube|docker|gnupg)(?:\/|$)/i.test(word)))) return [];
  const result: WorkEvent[] = [];
  for (const w of parsed) {
    if (!w.length) continue;
    if (w[0] === 'cd') {
      if (!w[1] || w[1] === '-' || /^~[^/]/.test(w[1]) || !safeValue(w[1])) { result.push({ type: 'cwd_unknown' }); continue; }
      const event = pathEvent('cd', w[1]);
      if (event) result.push(event);
      continue;
    }
    let i = w[0] === 'sudo' ? 1 : 0;
    if (w[i] !== 'git') continue;
    i += 1;
    let repo: string | undefined;
    let taintedRepo = false;
    while (i < w.length) {
      if (['--no-pager', '-P'].includes(w[i])) { i += 1; continue; }
      if (['-C', '-c', '--git-dir', '--work-tree'].includes(w[i]) && w[i + 1]) {
        if (w[i] === '-C') { if (safeValue(w[i + 1])) repo = clean(w[i + 1]); else taintedRepo = true; }
        i += 2; continue;
      }
      if (/^(?:--git-dir|--work-tree|--config-env)=/.test(w[i])) { i += 1; continue; }
      break;
    }
    if (taintedRepo) continue;
    if (repo && isSecretLikePath(repo)) continue;
    const sub = w[i++];
    if (sub === 'worktree' && w[i] === 'add') {
      i += 1;
      let branch: string | undefined;
      const positional: string[] = [];
      while (i < w.length) {
        const word = w[i++];
        if (word === '-b' || word === '-B') { if (safeValue(w[i])) branch = clean(w[i++]); continue; }
        if (word.startsWith('-')) continue;
        positional.push(word);
      }
      if (safeValue(positional[0])) {
        const event = pathEvent('worktree_add', positional[0], { ...(branch ? { branch } : {}), ...(repo ? { repo } : {}) });
        if (event) result.push(event);
      }
    } else if (sub === 'worktree' && w[i] === 'remove') {
      const target = w.slice(i + 1).find((word) => !word.startsWith('-'));
      const event = safeValue(target) ? pathEvent('worktree_remove', target, repo ? { repo } : {}) : undefined;
      if (event) result.push(event);
    } else if (sub === 'clone') {
      const args = positionalArgs(w.slice(i), CLONE_OPTIONS_WITH_VALUES);
      if (safeValue(args[0])) {
        const url = clean(args[0].replace(URL_CREDENTIALS, '$1'));
        const dir = args[1];
        if ((!dir || safeValue(dir)) && (!dir || !isSecretLikePath(dir))) result.push({ type: 'clone', url, ...(dir ? { dir: clean(dir) } : {}) });
      }
    } else if (sub === 'checkout' || sub === 'switch') {
      let name: string | undefined;
      let created = false;
      const createIndex = w.slice(i).findIndex((arg) => ['-b', '-B', '-c', '-C', '--create', '--force-create'].includes(arg));
      if (createIndex >= 0 && safeValue(w[i + createIndex + 1])) { name = w[i + createIndex + 1]; created = true; }
      else if (sub === 'switch') name = w.slice(i).find((arg) => arg && !arg.startsWith('-'));
      if (safeValue(name) && !isSecretLikePath(name)) result.push({ type: 'branch', name: clean(name), created, ...(repo ? { repo } : {}) });
    } else if (sub === 'push') {
      const args: string[] = [];
      const raw = w.slice(i);
      for (let p = 0; p < raw.length; p += 1) {
        const word = raw[p];
        if (PUSH_FLAGS.has(word) || /^--force-with-lease(?:=.*)?$/.test(word)) continue;
        if (PUSH_OPTIONS_WITH_VALUES.has(word)) { p += 1; continue; }
        if (word.startsWith('-')) continue;
        args.push(word);
      }
      const refspec = args.length > 1 ? args[1] : undefined;
      let branch = refspec?.includes(':') ? refspec.slice(refspec.indexOf(':') + 1) : refspec;
      if (branch?.startsWith('+')) branch = branch.slice(1);
      if (branch?.startsWith('refs/heads/')) branch = branch.slice('refs/heads/'.length);
      if (branch !== 'HEAD' && safeValue(branch) && !isSecretLikePath(branch)) result.push({ type: 'push', branch: clean(branch), ...(repo ? { repo } : {}) });
    }
  }
  return result;
}

function resultEvents(messages: readonly SessionMessage[]): Map<number, WorkEvent[]> {
  const byId = new Map<string, { messageIndex: number; tool: string; input: Record<string, unknown> }>();
  const resultById = new Map<string, string>();
  const commandSegmentsById = new Map<string, ShellCommand[]>();
  messages.forEach((message, messageIndex) => {
    if (isSeedMessage(message)) return;
    message.toolUses.forEach((use) => {
      const input = (use.input ?? {}) as Record<string, unknown>;
      byId.set(use.tool_use_id, { messageIndex, tool: use.tool, input });
      if (use.tool === 'Bash' && typeof input.command === 'string' && input.command.length <= MAX_COMMAND && !shouldSkipToolOutput(input.command)) commandSegmentsById.set(use.tool_use_id, shellCommands(input.command));
    });
    for (const result of message.toolResults ?? []) if (!resultById.has(result.tool_use_id)) resultById.set(result.tool_use_id, result.text);
  });
  const out = new Map<number, WorkEvent[]>();
  const add = (index: number, event: WorkEvent): void => { const events = out.get(index); if (events) events.push(event); else out.set(index, [event]); };
  messages.forEach((message, messageIndex) => {
    if (isSeedMessage(message)) return;
    for (const use of message.toolUses) {
      const input = (use.input ?? {}) as Record<string, unknown>;
      if (use.tool === 'Bash' && typeof input.command === 'string') {
        for (const event of commandEvents(input.command, commandSegmentsById.get(use.tool_use_id) ?? [])) if (!(input.run_in_background === true && event.type === 'cd')) add(messageIndex, event);
        if (input.run_in_background === true) {
          const result = resultById.get(use.tool_use_id) ?? '';
          const id = /with ID:\s*([A-Za-z0-9_-]+)/.exec(result)?.[1];
          if (id) add(messageIndex, { type: 'bg_start', id: cleanLine(id), via: 'bash', label: shouldSkipToolOutput(String(input.command)) ? '(command hidden)' : cleanLine(typeof input.description === 'string' ? input.description : String(input.command).slice(0, 120)) });
        }
      }
      if (use.tool === 'EnterWorktree' || use.tool === 'ExitWorktree') add(messageIndex, { type: 'cwd_unknown' });
      if (use.tool === 'Agent' || use.tool === 'Task') {
        const text = resultById.get(use.tool_use_id) ?? '';
        const id = /agentId:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1];
        if (input.run_in_background === true || /Async agent launched/i.test(text)) add(messageIndex, { type: 'bg_start', ...(id ? { id: cleanLine(id) } : { tool_use_id: cleanLine(use.tool_use_id) }), via: 'agent', label: cleanLine(typeof input.description === 'string' ? input.description : use.tool_use_id) });
      }
      if (use.tool === 'TodoWrite' && Array.isArray(input.todos)) {
        const items = input.todos.slice(0, 30).flatMap((todo) => {
          if (!todo || typeof todo !== 'object') return [];
          const item = todo as Record<string, unknown>;
          if (typeof item.content !== 'string' || typeof item.status !== 'string') return [];
          return [{ content: cleanLine(item.content).slice(0, 120), status: cleanLine(item.status) }];
        });
        add(messageIndex, { type: 'todos', items });
      }
      if (use.tool === 'TaskUpdate' && (typeof input.taskId === 'string' || typeof input.taskId === 'number')) add(messageIndex, { type: 'task', id: cleanLine(String(input.taskId)), ...(typeof input.status === 'string' ? { status: cleanLine(input.status) } : {}), ...(typeof input.subject === 'string' ? { subject: cleanLine(input.subject) } : {}) });
    }
    for (const result of message.toolResults ?? []) {
      const use = byId.get(result.tool_use_id);
      if (!use) continue;
      const commandSegments = use.tool === 'Bash' && typeof use.input.command === 'string' ? commandSegmentsById.get(result.tool_use_id) ?? [] : [];
      const isPullRequestCommand = commandSegments.some((args) => args[0] === 'gh' && args[1] === 'pr' && ['create', 'view', 'list'].includes(args[2]));
      const isPushCommand = commandSegments.some((args) => args[0] === 'git' && (args[1] === 'push' || (args[1] === '-C' && args[3] === 'push')));
      if (use.tool === 'Bash' && (isPullRequestCommand || isPushCommand)) {
        let prCount = 0;
        for (const pr of result.text.matchAll(PR_URL)) { if (prCount++ >= 5) break; add(messageIndex, { type: 'pr', url: clean(pr[0]) }); }
      }
      const isCommitCommand = commandSegments.some((args) => args[0] === 'git' && (args[1] === 'commit' || (args[1] === '-C' && args[3] === 'commit')));
      if (use.tool === 'Bash' && isCommitCommand) {
        const match = result.text.split(/\r?\n/).map((line) => /^\[([^\s]+)(?:\s+\(root-commit\))?\s+([0-9a-f]+)\]\s*(.*)$/.exec(line)).find(Boolean);
        if (match) add(messageIndex, { type: 'commit', branch: clean(match[1]), sha: clean(match[2]), subject: clean(match[3]) });
      }
      if (use.tool === 'Bash' && use.input.run_in_background !== true) {
        for (const reset of result.text.matchAll(/Shell cwd was reset to ([^\r\n]+)/g)) {
          const event = pathEvent('cd', reset[1].trim());
          if (event?.type === 'cd' && event.path.startsWith('/')) add(messageIndex, event);
        }
      }
      if (use.tool === 'TaskCreate') {
        const match = /Task #([^\s]+) created successfully:\s*(.*)/.exec(result.text);
        const subject = match?.[2] || (typeof use.input.subject === 'string' ? use.input.subject : undefined);
        if (match && subject) add(messageIndex, { type: 'task', id: cleanLine(match[1]), status: 'pending', subject: cleanLine(subject) });
      }
    }
    if (message.role === 'user') {
      for (const notification of parseTaskNotifications(message.text)) add(messageIndex, notification);
    }
  });
  return out;
}

function indexedEvents(messages: readonly SessionMessage[]): Array<{ messageIndex: number; event: WorkEvent }> {
  const byMessage = resultEvents(messages);
  return [...byMessage.entries()].flatMap(([messageIndex, events]) => events.map((event) => ({ messageIndex, event })));
}

export function workEvents(messages: readonly SessionMessage[]): WorkEvent[] {
  return indexedEvents(messages).map(({ event }) => event);
}

export function parseTaskNotifications(text: string): Extract<WorkEvent, { type: 'bg_end' }>[] {
  const events: Extract<WorkEvent, { type: 'bg_end' }>[] = [];
  const bounded = text.slice(0, 64 * 1024);
  let cursor = 0;
  while (cursor < bounded.length) {
    const start = bounded.indexOf('<task-notification>', cursor);
    if (start < 0) break;
    const bodyStart = start + '<task-notification>'.length;
    const end = bounded.indexOf('</task-notification>', bodyStart);
    if (end < 0) break;
    const body = bounded.slice(bodyStart, end);
    const field = (name: string): string | undefined => {
      const open = `<${name}>`, close = `</${name}>`, a = body.indexOf(open);
      if (a < 0) return undefined;
      const b = body.indexOf(close, a + open.length);
      return b < 0 ? undefined : body.slice(a + open.length, b).trim();
    };
    const id = field('task-id');
    const status = field('status');
    const summary = field('summary');
    if (id && status) events.push({ type: 'bg_end', id: cleanLine(id), status: cleanLine(status), ...(summary ? { summary: cleanLine(summary) } : {}) });
    cursor = end + '</task-notification>'.length;
  }
  return events;
}

export function workEventsByMessage(messages: readonly SessionMessage[]): Array<{ messageIndex: number; event: WorkEvent }> {
  return indexedEvents(messages);
}

function resolvePath(value: string, cwd: string): string {
  if (value === '~' || value.startsWith('~/')) return value;
  if (value.startsWith('/')) return value;
  const tilde = cwd === '~' || cwd.startsWith('~/');
  const base = tilde ? cwd.slice(1) : cwd;
  const parts = `${base}/${value}`.split('/');
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop(); else normalized.push(part);
  }
  return `${tilde ? '~' : ''}/${normalized.join('/')}`;
}

export function foldWorkState(events: readonly WorkEvent[], sessionCwd: string): WorkState {
  const state: WorkState = { sessionCwd, directory: sessionCwd, worktrees: [], clones: [], branches: [], pushes: [], commits: [], prs: [], todos: [], tasks: new Map(), backgrounds: [] };
  let directoryKnown = true;
  let sawSnapshot = false;
  for (const event of events) {
    if (event.type === 'cwd_snapshot') { state.directory = event.path; if (!sawSnapshot) state.sessionCwd = event.path; sawSnapshot = true; directoryKnown = true; }
    else if (event.type === 'cwd_unknown') directoryKnown = false;
    else if (event.type === 'cd') {
      if (event.path.startsWith('/')) { state.directory = event.path; directoryKnown = true; }
      else if (directoryKnown && event.path && event.path !== '-' && event.path !== '~' && !/^~[^/]/.test(event.path)) state.directory = resolvePath(event.path, state.directory);
      else directoryKnown = false;
    }
    else if (event.type === 'worktree_add') {
      if (!directoryKnown && !event.path.startsWith('/') && !(event.repo?.startsWith('/'))) continue;
      const base = event.repo ? resolvePath(event.repo, directoryKnown ? state.directory : sessionCwd) : state.directory;
      const path = resolvePath(event.path, base);
      state.worktrees = state.worktrees.filter((item) => item.path !== path);
      state.worktrees.push({ path, ...(event.branch ? { branch: event.branch } : {}) });
    } else if (event.type === 'worktree_remove') {
      if (!directoryKnown && !event.path.startsWith('/') && !(event.repo?.startsWith('/'))) continue;
      const base = event.repo ? resolvePath(event.repo, directoryKnown ? state.directory : sessionCwd) : state.directory;
      state.worktrees = state.worktrees.filter((item) => item.path !== resolvePath(event.path, base));
    }
    else if (event.type === 'clone') {
      // Without a directory argument git clones into the URL's last segment, minus `.git`.
      if (!directoryKnown && event.dir && !event.dir.startsWith('/')) continue;
      const dir = event.dir ?? event.url.replace(/[/:]+$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '');
      state.clones.push({ ...(dir ? { dir: resolvePath(dir, state.directory) } : {}), url: event.url });
    }
    else if (event.type === 'branch') { if (directoryKnown || event.repo?.startsWith('/')) state.branches.push({ name: event.name, created: event.created, repo: event.repo ? resolvePath(event.repo, directoryKnown ? state.directory : sessionCwd) : state.directory }); }
    else if (event.type === 'push') { if (directoryKnown || event.repo?.startsWith('/')) state.pushes.push({ branch: event.branch, repo: event.repo ? resolvePath(event.repo, directoryKnown ? state.directory : sessionCwd) : state.directory }); }
    else if (event.type === 'commit') { state.commits.push(event); state.commits = state.commits.slice(-3); }
    else if (event.type === 'pr') { state.prs = [...state.prs.filter((url) => url !== event.url), event.url].slice(-5); }
    else if (event.type === 'todos') state.todos = event.items;
    else if (event.type === 'task') {
      const prior = state.tasks.get(event.id);
      if (event.status === 'deleted') state.tasks.delete(event.id);
      else state.tasks.set(event.id, { ...prior, ...event });
    } else if (event.type === 'bg_start') {
      const id = event.id ?? event.tool_use_id ?? `tool-${state.backgrounds.length + 1}`;
      state.backgrounds = [...state.backgrounds.filter((job) => job.id !== id), { ...event, id }].slice(-BACKGROUND_KEPT);
    } else if (event.type === 'bg_end') {
      const job = state.backgrounds.find((item) => item.id === event.id);
      if (job) { job.status = event.status; job.summary = event.summary; }
    }
  }
  return state;
}

/** Background jobs the fold remembers, and how many started / finished ones the section shows. */
const BACKGROUND_KEPT = 12;
const BACKGROUND_SHOWN_STARTED = 4;
const BACKGROUND_SHOWN_FINISHED = 3;

function neutralize(text: string): string {
  return text.replace(/(?:<|\uFF1C|\uFE64|&lt;|&#0*60;|&#x0*3c;)(\/?[A-Za-z][\w-]*)/gi, '‹$1');
}

function uniqueLast<T>(items: readonly T[], render: (item: T) => string, limit: number): T[] {
  const seen = new Set<string>();
  const reversed: T[] = [];
  for (let i = items.length - 1; i >= 0 && reversed.length < limit; i -= 1) {
    const key = render(items[i]);
    if (seen.has(key)) continue;
    seen.add(key);
    reversed.push(items[i]);
  }
  return reversed.reverse();
}

export function renderWorkState(state: WorkState, probe: WorkStateProbe | undefined, budgetTokens: number, countTokens: TokenCounter, hostCwd = state.directory): string {
  const lines: string[] = [];
  const cwd = redactHostPath(hostCwd).slice(0, MAX_STRING);
  const sessionCwd = redactHostPath(state.sessionCwd).slice(0, MAX_STRING);
  const directoryLine = `Directory: ${cwd}${cwd !== sessionCwd ? ` (session started in ${sessionCwd})` : ''}`;
  lines.push(directoryLine);
  if (probe?.git) lines.push(`Git at the cut: ${redactHostPath(probe.git).slice(0, MAX_STRING)}`);
  const eventTrees = state.worktrees.filter((tree) => !isSecretLikePath(tree.path)).map((tree) => ({ path: clean(tree.path), ...(tree.branch ? { branch: clean(tree.branch) } : {}) }));
  const probeTrees = (probe?.worktrees ?? []).filter((tree) => !isSecretLikePath(tree.path)).map((tree) => ({ path: redactHostPath(tree.path).slice(0, MAX_STRING), ...(tree.branch ? { branch: clean(tree.branch) } : {}) }));
  const ownPath = probe?.directory ? redactHostPath(probe.directory).slice(0, MAX_STRING) : cwd;
  const own = probeTrees.filter((tree) => tree.path === ownPath);
  const eventPaths = new Set(eventTrees.map((tree) => tree.path));
  const created = probeTrees.filter((tree) => eventPaths.has(tree.path) && tree.path !== cwd);
  const selected = [...own, ...created, ...probeTrees.filter((tree) => tree.path !== ownPath && !eventPaths.has(tree.path))].slice(0, 6);
  const shownTrees = uniqueLast(probe?.worktrees ? selected : eventTrees, (tree) => `${tree.path}${tree.branch ? ` [${tree.branch}]` : ''}`, probe?.worktrees ? 6 : 4);
  if (shownTrees.length) lines.push(`Worktrees: ${shownTrees.map((tree) => `${tree.path}${tree.branch ? ` [${tree.branch}]` : ''}`).join('; ')}`);
  const clones = uniqueLast(state.clones, (clone) => `${clone.dir ?? '(default directory)'} <- ${clone.url}`, 2);
  if (clones.length) lines.push(`Cloned: ${clones.map((clone) => `${clone.dir ?? '(default directory)'} <- ${clone.url}`).join('; ')}`);
  const branches = uniqueLast([...state.branches.map((item) => `${item.created !== false ? 'created' : 'switched to'} ${item.name} in ${item.repo}`), ...state.pushes.map((item) => `pushed ${item.branch}`)], (item) => item, 3);
  if (branches.length) lines.push(`Branches: ${branches.join('; ')}`);
  const commits = uniqueLast(state.commits, (item) => `${item.sha} ${item.subject}`, 3);
  if (commits.length) lines.push(`Commits (newest last): ${commits.map((item) => `${item.sha} ${item.subject}`).join('; ')}`);
  const prs = uniqueLast(state.prs, (item) => item, 3);
  if (prs.length) lines.push(`PRs: ${prs.join('; ')}`);
  const taskValues = [...state.tasks.values()];
  const open = taskValues.filter((item) => item.status !== 'completed' && item.status !== 'done');
  const completed = taskValues.filter((item) => item.status === 'completed' || item.status === 'done');
  const completedTodos = state.todos.filter((item) => item.status === 'completed' || item.status === 'done');
  const openTodos = state.todos.filter((item) => item.status !== 'completed' && item.status !== 'done');
  const visibleTodos = uniqueLast(openTodos, (item) => `${item.status}:${item.content}`, 10);
  const visibleTasks = uniqueLast(open, (item) => item.id, 10);
  const taskParts = [...visibleTodos.map((item) => `[${item.status}] ${item.content.slice(0, 120)}`), ...visibleTasks.map((item) => `[${item.status ?? 'pending'}] ${(item.subject ?? item.id).slice(0, 120)}`)];
  if (openTodos.length > visibleTodos.length) taskParts.unshift(`${openTodos.length - visibleTodos.length} more`);
  if (open.length > visibleTasks.length) taskParts.unshift(`${open.length - visibleTasks.length} more open`);
  const completedCount = completed.length + completedTodos.length;
  const lastCompleted = (completedTodos.at(-1)?.content ?? completed.at(-1)?.subject)?.slice(0, 120);
  if (completedCount) taskParts.push(`${completedCount} completed${lastCompleted ? ` (last: ${lastCompleted})` : ''}`);
  if (taskParts.length) lines.push(`Tasks: ${taskParts.join('; ')}`);
  // Jobs with no completion seen come first in priority (the model may still be waiting on them);
  // finished ones only fill the rest. Shown in start order either way.
  const jobs = uniqueLast(state.backgrounds, (job) => `${job.id} ${job.label}`, BACKGROUND_KEPT);
  const startedJobs = new Set(jobs.filter((job) => !job.status).slice(-BACKGROUND_SHOWN_STARTED));
  const finishedJobs = new Set(jobs.filter((job) => job.status).slice(-BACKGROUND_SHOWN_FINISHED));
  const backgrounds = jobs.filter((job) => startedJobs.has(job) || finishedJobs.has(job));
  const bgParts = backgrounds.map((job) => `${job.status ? clean(job.status) : 'started'} ${job.id} "${job.label}"`);
  if (bgParts.length) lines.push(`Background: ${bgParts.join('; ')}`);
  if (lines.length === 1 && cwd === state.sessionCwd) return '';
  let rendered = neutralize(lines.join('\n'));
  if (countTokens(rendered) <= budgetTokens) return rendered;
  const optionalOrder = ['Commits', 'Cloned', 'PRs', 'Branches', 'Background', 'Worktrees', 'Tasks'];
  for (const prefix of optionalOrder) {
    let index = lines.findIndex((line) => line.startsWith(`${prefix}:`) || line.startsWith(`${prefix} (`));
    while (index >= 0 && countTokens(rendered) > budgetTokens) {
      const line = lines[index];
      const entries = line.slice(line.indexOf(':') + 1).trim().split('; ');
      if (prefix === 'Background') {
        const completed = entries.findIndex((entry) => !entry.startsWith('started '));
        if (completed >= 0) entries.splice(completed, 1);
        else break;
      } else if (prefix === 'Tasks') {
        const completed = entries.findIndex((entry) => /^\d+ completed/.test(entry));
        if (completed >= 0) entries.splice(completed, 1);
        else break;
      } else entries.shift();
      if (!entries.length) lines.splice(index, 1);
      else lines[index] = `${prefix === 'Commits' ? 'Commits (newest last)' : prefix}: ${entries.join('; ')}`;
      rendered = neutralize(lines.join('\n'));
      index = lines.findIndex((item) => item.startsWith(`${prefix}:`) || item.startsWith(`${prefix} (`));
    }
    if (countTokens(rendered) <= budgetTokens) return rendered;
  }
  // Preserve the first line (the directory anchor) and trim complete lowest-priority lines first.
  while (countTokens(rendered) > budgetTokens && lines.length > 1) {
    lines.pop();
    rendered = neutralize(lines.join('\n'));
  }
  if (countTokens(rendered) > budgetTokens) {
    const prefix = `${lines[0].slice(0, 1)}`;
    let low = 0, high = lines[0].length;
    while (low < high) { const mid = Math.ceil((low + high) / 2); lines[0] = prefix + lines[0].slice(1, mid); if (countTokens(neutralize(lines[0])) <= budgetTokens) low = mid; else high = mid - 1; }
    lines[0] = prefix + lines[0].slice(1, low);
    rendered = neutralize(lines[0]);
  }
  return rendered;
}

export { WORK_STATE_BUDGET_TOKENS };

export function validWorkEvent(value: unknown): value is WorkEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  const stringFields: Record<string, string[]> = {
    cwd_snapshot: ['path'], cd: ['path'], worktree_add: ['path'], worktree_remove: ['path'], clone: ['url'],
    branch: ['name'], push: ['branch'], commit: ['branch', 'sha', 'subject'], pr: ['url'],
    bg_start: ['via', 'label'], bg_end: ['id', 'status'], task: ['id'], cwd_unknown: [],
  };
  if (event.type === 'todos') return Array.isArray(event.items) && event.items.every((item) => !!item && typeof item === 'object' && typeof (item as Record<string, unknown>).content === 'string' && typeof (item as Record<string, unknown>).status === 'string');
  const required = stringFields[String(event.type)];
  if (!required || !required.every((field) => typeof event[field] === 'string')) return false;
  for (const optional of ['repo', 'branch', 'dir', 'id', 'tool_use_id', 'subject', 'status', 'summary']) if (event[optional] !== undefined && typeof event[optional] !== 'string') return false;
  if (event.created !== undefined && typeof event.created !== 'boolean') return false;
  return true;
}
