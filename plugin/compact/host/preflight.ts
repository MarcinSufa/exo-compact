/**
 * 4.8.0: the SessionStart preflight. A plugin installed natively (`claude plugin install exo-compact@exo-compact`) runs
 * no installer, so nothing has checked the Node and Claude Code versions the hooks and the recall workers need. This asks
 * `doctor.mjs --versions` (the only place the minimum versions are written down) and returns its one warning line.
 * Every failure to run the check counts as fine: the preflight may only ever make the plugin quieter, never break a session.
 *
 * `$` never enters this file (the hook compiler's rule): the hook builds a PreflightHost of closures over its own `$`.
 */
export interface PreflightHost {
  /** `$.session.version()`: the release (`base`) or the full version string. */
  claudeVersion: () => Promise<string | undefined>;
  /** The plugin directory (option `recallPluginRoot`, else CLAUDE_PLUGIN_ROOT). */
  pluginRoot: () => Promise<string | undefined>;
  run: (argv: string[], init: { timeoutMs: number }) => Promise<{ exitCode: number; stdout: string }>;
}

export interface PreflightResult {
  ok: boolean;
  /** One plain-English line, present only when `ok` is false. */
  warning?: string;
}

export const PREFLIGHT_TIMEOUT_MS = 10_000;

const NODE_TOO_OLD_TO_CHECK = 'exo-compact: the node on PATH is too old to run its check, update Node (see README). It stays off for this session and Claude Code uses its native compaction.';

export async function runPreflight(host: PreflightHost): Promise<PreflightResult> {
  try {
    const pluginRoot = await host.pluginRoot();
    if (!pluginRoot) return { ok: true };
    const claude = await host.claudeVersion();
    const argv = ['node', `${pluginRoot}/doctor.mjs`, '--versions', ...(claude ? ['--claude', claude] : [])];
    const ran = await host.run(argv, { timeoutMs: PREFLIGHT_TIMEOUT_MS });
    if (ran.exitCode === 0) return { ok: true };
    if (ran.exitCode !== 1) return { ok: true };
    const line = String(ran.stdout).trim().split('\n')[0] ?? '';
    return { ok: false, warning: line.startsWith('exo-compact:') ? line : NODE_TOO_OLD_TO_CHECK };
  } catch {
    return { ok: true };
  }
}
