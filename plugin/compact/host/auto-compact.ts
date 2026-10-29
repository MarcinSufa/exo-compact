/**
 * 4.10.0 (CONTRACT S5x): the SessionStart step that sets Claude Code's auto-compact window and turns auto-compact on
 * (`auto-compact.mjs apply <window> <enabled>`). A native install runs no installer, so this is where a user first
 * hears what the plugin changed in their settings. It returns the lines to show; every failure to run is one warning
 * line, never an exception, so a session start is never held up beyond the timeout or broken.
 *
 * `$` never enters this file (the hook compiler's rule): the hook builds an AutoCompactHost of closures over its own `$`.
 */
export interface AutoCompactHost {
  /** The plugin directory (host/plugin-root.ts trustedPluginRoot). */
  pluginRoot: () => Promise<string | undefined>;
  /** host/node-run.ts nodeRunner over `$.process.run`. */
  run: (argv: string[], init: { timeoutMs: number }) => Promise<{ exitCode: number; stdout: string }>;
  /** The `autoCompactWindow` option (0 leaves the setting alone). */
  window: number;
  /** The `autoCompact` option (false leaves the setting alone). */
  enabled: boolean;
  /** host/home-dir.ts resolveHomeDir over the hook's own environment. */
  home: () => Promise<string | undefined>;
  /** CLAUDE_CONFIG_DIR from the hook's own environment. */
  configDir: () => Promise<string | undefined>;
}

export const AUTO_COMPACT_TIMEOUT_MS = 3000;

export async function runAutoCompact(host: AutoCompactHost): Promise<string[]> {
  try {
    const pluginRoot = await host.pluginRoot();
    if (!pluginRoot) return [];
    // The script takes its paths from these arguments, never from its own environment: a project settings `env`
    // block reaches the child, so a CLAUDE_CONFIG_DIR or HOME there could point the write at another directory.
    const home = await host.home();
    const configDir = await host.configDir();
    if (!home && !configDir) return ['exo-compact: auto-compact settings not checked (no home directory).'];
    const dirs = [...(home ? ['--home', home] : []), ...(configDir ? ['--config-dir', configDir] : [])];
    const ran = await host.run(['node', `${pluginRoot}/auto-compact.mjs`, 'apply', String(host.window), String(host.enabled), ...dirs], { timeoutMs: AUTO_COMPACT_TIMEOUT_MS });
    const lines = String(ran.stdout ?? '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('exo-compact:'));
    if (lines.length > 0 || ran.exitCode === 0) return lines;
    return [`exo-compact: auto-compact settings not checked (exit ${ran.exitCode}).`];
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(-120);
    return [`exo-compact: auto-compact settings not checked (${reason}).`];
  }
}
