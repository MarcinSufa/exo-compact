import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bigFixtureFiles, COMPACT_PROMPT, coreRan, PROBE_FIXTURES, report, runClaudeStream, s4Stood } from './lib.mjs';

const fixture = PROBE_FIXTURES.G2;
const extensionFiles = bigFixtureFiles(fixture.names, fixture.repeat, fixture.extra);
const extensionFirstTurn = `Read files ${fixture.names.map((name) => `${name}.txt`).join(', ')}. Compare their contents, then say one short sentence.`;
const extensionEnv = {
  CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_AGENT_SDK_VERSION: '0.3.296',
};

function exovaultAbove(dir) {
  const found = [];
  let current = path.resolve(dir);
  while (true) {
    if (existsSync(path.join(current, '.exovault'))) found.push(current);
    const parent = path.dirname(current);
    if (parent === current) return found;
    current = parent;
  }
}

function outsideForms(dir) {
  const resolved = path.resolve(dir);
  const slash = resolved.replace(/\\/g, '/');
  const forms = [resolved, slash];
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(resolved);
  if (drive) forms.push(`/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`);
  return forms;
}

function textHasOutside(text, forms) {
  const raw = String(text ?? '');
  const folded = raw.toLowerCase().replace(/\\/g, '/');
  return forms.some((form) => raw.includes(form) || folded.includes(form.toLowerCase().replace(/\\/g, '/')));
}

function collectToolResultText(value, out) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectToolResultText(item, out);
    return;
  }
  if (value.type === 'tool_result') {
    if (typeof value.content === 'string') out.push(value.content);
    else if (Array.isArray(value.content)) {
      for (const part of value.content) {
        if (typeof part === 'string') out.push(part);
        else if (part && typeof part.text === 'string') out.push(part.text);
      }
    } else if (value.content != null) out.push(JSON.stringify(value.content));
  }
  for (const key of Object.keys(value)) collectToolResultText(value[key], out);
}

function allowTool(event) {
  const request = event.request ?? {};
  const updatedInput = request.input;
  const toolUseID = request.tool_use_id;
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: event.request_id,
      response: {
        behavior: 'allow',
        ...(updatedInput === undefined ? {} : { updatedInput }),
        ...(toolUseID ? { toolUseID } : {}),
      },
    },
  };
}

async function captureStamp(dir) {
  let names = [];
  try { names = await readdir(dir); } catch { return { names: [], newest: 0, files: 0 }; }
  let newest = 0;
  let files = 0;
  for (const name of names) {
    const info = await stat(path.join(dir, name));
    if (!info.isFile()) continue;
    files += 1;
    if (info.mtimeMs > newest) newest = info.mtimeMs;
  }
  return { names, newest, files };
}

function decisiveLines(debugLog) {
  return debugLog.split('\n').filter((line) => line.includes('compact.fallback=') || /session\.compact \(/.test(line)).slice(0, 16);
}

let outside = '';
try {
  // A drive root on Windows (the 4.7.5 case: the shell left the project for another drive), the temp dir elsewhere.
  outside = await mkdtemp(path.join(process.platform === 'win32' ? 'C:\\' : tmpdir(), 's4-gate-outside-'));
  const blocked = exovaultAbove(outside);
  if (blocked.length) {
    console.log(`[G10] INCONCLUSIVE: .exovault exists above the outside directory (${blocked.join(', ')})`);
    console.log('[G10] INCONCLUSIVE overall');
  } else {
    const forms = outsideForms(outside);
    const promptPath = path.resolve(outside).replace(/\\/g, '/');
    const cdTurn = `Run exactly one Bash command: cd "${promptPath}" && pwd\nReply with one word.`;
    const seenTypes = [];
    const controlSubtypes = [];
    let toolText = '';
    let cdSeenAt = 0;
    let resultsSeen = 0;
    const run = await runClaudeStream({
      turns: [extensionFirstTurn, cdTurn, COMPACT_PROMPT],
      files: extensionFiles,
      options: { interactiveOnly: true },
      settings: { permissions: { allow: ['Bash', 'Read', 'Bash(*)', 'Read(*)'] } },
      timeoutMs: 300000,
      envOverrides: extensionEnv,
      extraArgs: ['--permission-prompt-tool=stdio', '--add-dir', outside],
      initialize: true,
      onEvent(event, write) {
        if (seenTypes.length < 30) seenTypes.push(String(event?.type ?? '?'));
        if (event?.type === 'control_request') {
          const subtype = String(event.request?.subtype ?? '');
          controlSubtypes.push(subtype);
          if (subtype === 'can_use_tool') write(allowTool(event));
        }
        if (event?.type === 'result') resultsSeen += 1;
        const chunks = [];
        collectToolResultText(event, chunks);
        if (chunks.length) {
          toolText += `\n${chunks.join('\n')}`;
          if (cdSeenAt === 0 && textHasOutside(toolText, forms)) cdSeenAt = Date.now();
        }
      },
    });
    try {
      const moved = textHasOutside(toolText, forms);
      if (!moved) {
        console.log('[G10] INCONCLUSIVE: the Bash tool result did not show the outside directory, so the later checks were not scored');
        console.log(`[G10] INCONCLUSIVE detail outside=${promptPath} results=${resultsSeen} types=${seenTypes.join(',')} controls=${controlSubtypes.join(',') || 'none'} toolText=${JSON.stringify(toolText).slice(0, 400)}`);
        console.log('[G10] INCONCLUSIVE overall');
      } else {
        const sessionId = (run.results ?? []).map((event) => event.session_id).find(Boolean);
        const captureDir = sessionId ? path.join(run.cwd, '.exovault', 's4-capture', String(sessionId)) : '';
        const stamp = captureDir ? await captureStamp(captureDir) : { names: [], newest: 0, files: 0 };
        const decided = decisiveLines(run.debugLog ?? '');
        const stood = s4Stood(run.debugLog ?? '');
        const coreDidRun = coreRan(run.debugLog ?? '');
        const notEnabled = (run.debugLog ?? '').includes('compact.fallback=not_enabled');
        report('G10', [
          { name: 'bash cd moved the shell to the outside directory', pass: true, detail: `outside=${promptPath}` },
          { name: 'debug log has no compact.fallback=not_enabled', pass: !notEnabled, detail: decided.join(' | ') || 'no compact.fallback or session.compact line' },
          { name: 'S4 compaction stood (core never ran)', pass: stood && !coreDidRun, detail: `stood=${stood} coreRan=${coreDidRun} ${decided.join(' | ')}` },
          { name: 'project capture dir has a record written after the cd', pass: Boolean(sessionId) && stamp.files > 0 && stamp.newest > cdSeenAt, detail: `session=${sessionId ?? 'missing'} files=${stamp.files} newest=${stamp.newest} cdSeenAt=${cdSeenAt} names=${stamp.names.join(',') || 'none'}` },
        ]);
      }
    } finally {
      await run.dispose();
    }
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.log(`[G10] FAIL: the probe did not reach its checks (${detail})`);
  console.log('[G10] FAIL overall');
  process.exitCode = 1;
} finally {
  if (outside) await rm(outside, { recursive: true, force: true });
}
