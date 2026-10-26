/**
 * 4.9.2 (CONTRACT S5w): how the hook starts the plugin's own Node scripts (harden.mjs, doctor.mjs, recall/*.mjs).
 *
 * A project's `.claude/settings.json` (or `settings.local.json`) `env` block reaches every process the session starts
 * (measured on Claude Code 2.1.292: `NODE_OPTIONS=--require=<repo file>` and a `PATH` with the repository's own `node`
 * first both reach a `$.process.run(['node', ...])` child, and the fake `node` ran). The hook has no `process` of its
 * own (Claude Code is a single binary), so `process.execPath` is not there to use, and `CLAUDE_CODE_EXECPATH` is just
 * as settable from a project. Two defences:
 *
 * - The Node binary comes from the `nodePath` option when it is a safe absolute path that exists. The option lives in
 *   the user's own settings (`pluginConfigs`, which a project's settings do not override); install.sh and install.ps1
 *   record the Node that ran them. Without it the hook falls back to `node` on PATH.
 * - Every child gets `SCRUBBED_ENV` over its environment: the variables that make Node or the dynamic loader run code
 *   that is not the script's own are set empty, which both Node and the loader read as unset. The children inherit
 *   that environment, so recall/brief.mjs and the workers it starts are scrubbed too.
 *
 * `run` is a closure spelled `(argv, init) => $.process.run(argv, init)` at each call site (the `$` spelling rule keeps
 * `$` out of imports). Callers keep `'node'` as argv[0]; it is the only argv[0] this wrapper replaces.
 */
import { isSafeAbsolute } from './plugin-root.js';

export const SCRUBBED_ENV: Readonly<Record<string, string>> = Object.freeze({
  NODE_OPTIONS: '',
  NODE_PATH: '',
  NODE_REPL_EXTERNAL_MODULE: '',
  NODE_V8_COVERAGE: '',
  NODE_EXTRA_CA_CERTS: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '',
  LD_PRELOAD: '',
  LD_AUDIT: '',
  LD_LIBRARY_PATH: '',
  DYLD_INSERT_LIBRARIES: '',
  DYLD_LIBRARY_PATH: '',
});

export interface NodeRunInit {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

/** The Node binary for the plugin's scripts: the `nodePath` option when it is safe and exists, else `node`. */
export async function trustedNode(option: string, exists: (path: string) => Promise<boolean>): Promise<string> {
  if (!isSafeAbsolute(option)) return 'node';
  try { return (await exists(option)) ? option : 'node'; } catch { return 'node'; }
}

/** `init` with `SCRUBBED_ENV` laid over its `env`; a caller's own value for a scrubbed name never wins. */
export function scrubbedInit<I extends NodeRunInit>(init: I): I & { env: Record<string, string> } {
  return { ...init, env: { ...(init.env ?? {}), ...SCRUBBED_ENV } };
}

/** A `run` that starts `'node'` argv as the trusted binary and every child with a scrubbed environment. */
export function nodeRunner<I extends NodeRunInit, R>(
  run: (argv: string[], init: I & { env: Record<string, string> }) => Promise<R>,
  option: string,
  exists: (path: string) => Promise<boolean>,
): (argv: string[], init: I) => Promise<R> {
  return async (argv, init) => {
    const binary = argv[0] === 'node' ? await trustedNode(option, exists) : argv[0];
    return run([binary ?? 'node', ...argv.slice(1)], scrubbedInit(init));
  };
}
