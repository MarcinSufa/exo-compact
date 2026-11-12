import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCompactOutcome, isCompactBoundary, isDry, runClaudeStream } from './lib.mjs';
import { EXTENSION_LAUNCH } from './g12-launch.mjs';

const CLAUDE_BIN = ['', 'home', 'agent', '.cursor-server', 'extensions', 'anthropic.claude-code-2.1.312-linux-x64', 'resources', 'native-binary', 'claude'].join('/');
const LIVE_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPACT_ROOT = path.resolve(LIVE_DIR, '../..');
const RECORD_FILE = 'g12-records.jsonl';
const PROJECT_PREFIX = 's4-gate-project-';
const isHelp = process.argv.includes('--help') || process.argv.includes('-h');
const sdkEnv = {
  ...EXTENSION_LAUNCH.env,
  NODE_OPTIONS: undefined,
  DEBUG: process.env.DEBUG_CLAUDE_AGENT_SDK ? '1' : undefined,
};

if (isHelp) {
  console.log('G12 tests $.session.compact() in an extension-shaped stream-json session and a -p control.');
  console.log('Run with --dry to print the two commands and temporary probe plugin paths.');
  console.log(`Set S4_GATE_CLAUDE_BIN=${CLAUDE_BIN} for a live run.`);
  process.exit(0);
}

if (!isDry() && !process.env.S4_GATE_CLAUDE_BIN) {
  throw new Error(`Set S4_GATE_CLAUDE_BIN=${CLAUDE_BIN} before a live G12 run.`);
}

if (isDry()) {
  console.log(`[G12] SDK argv=${JSON.stringify([...EXTENSION_LAUNCH.streamArgs, ...EXTENSION_LAUNCH.args])}`);
  console.log(`[G12] extension setting sources=${JSON.stringify(EXTENSION_LAUNCH.settingSourcesArg)}; harness launch uses --setting-sources project`);
  console.log(`[G12] SDK env keys=${Object.keys(EXTENSION_LAUNCH.env).join(',')}`);
}

const realManifest = JSON.parse(await readFile(path.join(COMPACT_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
const realHooks = JSON.parse(await readFile(path.join(COMPACT_ROOT, 'hooks', 'hooks.json'), 'utf8'));

const hookModule = `import { appendFile } from 'node:fs/promises';
import path from 'node:path';

const recordFile = 'g12-records.jsonl';
const insideTurn = (text) => text.includes('a turn is running') || text.includes('this hook is holding');

async function record($, value) {
  const target = path.join(await $.session.cwd(), recordFile);
  await appendFile(target, JSON.stringify(value) + '\\n', 'utf8');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function register(on) {
  on('prompt.submit', async ($) => {
    const surfaces = await $.session.surfaces();
    const entrypoint = await $.env.get('CLAUDE_CODE_ENTRYPOINT');
    await record($, { kind: 'session', surfaces, entrypoint });

    let immediate;
    try {
      const result = await $.session.compact();
      immediate = { status: 'resolved', ...(result && 'skip' in result && result.skip !== undefined ? { skip: result.skip } : {}) };
    } catch (error) {
      immediate = { status: 'rejected', message: errorMessage(error) };
    }
    await record($, { kind: 'outcome', phase: 'immediate', ...immediate });

    setTimeout(() => {
      void (async () => {
        let deferred;
        for (let attempt = 1; attempt <= 20; attempt += 1) {
          try {
            const result = await $.session.compact();
            deferred = { status: 'resolved', attempt, ...(result && 'skip' in result && result.skip !== undefined ? { skip: result.skip } : {}) };
            break;
          } catch (error) {
            const message = errorMessage(error);
            deferred = { status: 'rejected', attempt, message };
            if (!insideTurn(message) || attempt === 20) break;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
        await record($, { kind: 'outcome', phase: 'deferred', ...deferred });
      })().catch(async (error) => {
        try { await record($, { kind: 'outcome', phase: 'deferred', status: 'rejected', message: errorMessage(error) }); } catch {}
      });
    }, 0);

    return { text: 'probe' };
  });

  on('session.compact', async ($, event, next) => {
    try { await record($, { kind: 'session.compact', trigger: event.trigger }); } catch {}
    return next(event);
  });
}
`;

async function createProbePlugin(cwd) {
  const pluginDir = path.join(cwd, 'g12-probe-plugin');
  const metadataDir = path.join(pluginDir, '.claude-plugin');
  const hooksDir = path.join(pluginDir, 'hooks');
  await mkdir(metadataDir, { recursive: true });
  await mkdir(hooksDir, { recursive: true });
  await writeFile(path.join(metadataDir, 'plugin.json'), JSON.stringify({
    name: 'g12-extension-compact-probe',
    version: realManifest.version,
    description: 'Temporary plugin for the G12 compact availability probe.',
  }, null, 2));
  await writeFile(path.join(hooksDir, 'hooks.json'), JSON.stringify({ ...realHooks, modules: ['../hooks.mjs'] }, null, 2));
  await writeFile(path.join(pluginDir, 'hooks.mjs'), hookModule);
  return pluginDir;
}

async function deferredRecordExists(cwd) {
  try {
    const lines = (await readFile(path.join(cwd, RECORD_FILE), 'utf8')).split('\n');
    return lines.some((line) => {
      if (!line.trim()) return false;
      try {
        const record = JSON.parse(line);
        return record.kind === 'outcome' && record.phase === 'deferred';
      } catch { return false; }
    });
  } catch { return false; }
}

async function recordsFrom(cwd) {
  try {
    return (await readFile(path.join(cwd, RECORD_FILE), 'utf8')).split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch { return []; }
}

async function runArm(name, printMode) {
  let probePluginDir;
  const events = [];
  await rm(path.join(G12_PROJECT_DIR, RECORD_FILE), { force: true });
  const run = await runClaudeStream({
    turns: ['Run the compact availability probe.'],
    setup: false,
    timeoutMs: 70000,
    projectDir: G12_PROJECT_DIR,
    initialize: true,
    printMode,
    // --model pins a deterministic model and does not select the CLI transport mode.
    // --debug-file only changes where diagnostics are written.
    // --strict-mcp-config and --mcp-config isolate MCP servers from the host profile.
    // --setting-sources project replaces the extension's user/project/local scope to isolate this probe; source scope does not select headless mode.
    // --settings contains only this run's probe plugin configuration.
    // --plugin-dir loads only the temporary probe hook; it does not identify a UI client.
    // These inputs and diagnostics do not select or clear the CLI's SDK/headless transport mode.
    includeExoCompact: false,
    // lib.mjs adds CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 for this probe hook in both arms.
    envOverrides: sdkEnv,
    removeEnvKeys: EXTENSION_LAUNCH.removedEnvKeys,
    streamArgs: EXTENSION_LAUNCH.streamArgs,
    extraArgs: EXTENSION_LAUNCH.args,
    prepareProject: async ({ cwd }) => {
      probePluginDir = await createProbePlugin(cwd);
      return { extraPluginDirs: [probePluginDir] };
    },
    keepStdinOpenUntil: { predicate: deferredRecordExists, timeoutMs: 60000, intervalMs: 100 },
    onEvent: (event) => events.push(event),
  });

  console.log(`[G12:${name}] probe plugin path=${probePluginDir}`);
  try {
    if (isDry()) {
      console.log(`[G12:${name}] DRY: command constructed; Claude was not started`);
      return { name, dry: true };
    }

    const records = await recordsFrom(run.cwd);
    const session = records.find((record) => record.kind === 'session');
    const immediate = records.find((record) => record.kind === 'outcome' && record.phase === 'immediate');
    const deferred = records.find((record) => record.kind === 'outcome' && record.phase === 'deferred');
    const triggers = records.filter((record) => record.kind === 'session.compact').map((record) => record.trigger);
    const compactBoundary = events.some(isCompactBoundary);
    console.log(`[G12:${name}] surfaces=${JSON.stringify(session?.surfaces ?? null)} entrypoint=${JSON.stringify(session?.entrypoint ?? null)}`);
    console.log(`[G12:${name}] immediate=${JSON.stringify(immediate ?? null)} deferred=${JSON.stringify(deferred ?? null)}`);
    console.log(`[G12:${name}] verdict immediate=${classifyCompactOutcome(immediate)} deferred=${classifyCompactOutcome(deferred)}`);
    console.log(`[G12:${name}] session.compact fired=${triggers.length > 0} trigger=${triggers.join(',') || 'none'}`);
    console.log(`[G12:${name}] compact_boundary=${compactBoundary} exit=${run.code}`);
    return { name, immediate, deferred, triggers, compactBoundary };
  } finally {
    await run.dispose();
  }
}

const G12_PROJECT_DIR = await mkdtemp(path.join(tmpdir(), PROJECT_PREFIX));
try {
  const extension = await runArm('extension', false);
  const print = await runArm('print-control', true);
  if (isDry()) console.log('[G12] DRY: both stream-json arms are prepared; no Claude process was started');
  else console.log(`[G12] RESULT extension_immediate=${classifyCompactOutcome(extension.immediate)} extension_deferred=${classifyCompactOutcome(extension.deferred)} print_immediate=${classifyCompactOutcome(print.immediate)} print_deferred=${classifyCompactOutcome(print.deferred)}`);
} finally {
  if (process.env.S4_GATE_KEEP !== '1') await rm(G12_PROJECT_DIR, { recursive: true, force: true });
}
