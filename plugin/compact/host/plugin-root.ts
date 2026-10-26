/**
 * 4.9.2 (CONTRACT S5t): the directory the hook runs the plugin's own scripts from (recall/launch.mjs, brief.mjs,
 * brief-push.mjs, session-push.mjs, rule-check.mjs, doctor.mjs).
 *
 * Claude Code reports it itself as `$.plugin.root`, the directory it loaded this hooks module from; no settings file
 * can change it. Before 4.9.2 the hook took the `recallPluginRoot` option and then the `CLAUDE_PLUGIN_ROOT` variable,
 * and a project's `.claude/settings.json` (or `settings.local.json`) sets that variable for the whole session with its
 * `env` block (measured on Claude Code 2.1.292: `$.env.get('CLAUDE_PLUGIN_ROOT')` answers the project's value). A cloned
 * repository could so point the hook at a script of its own. The variable is no longer read.
 *
 * `engineRoot` is spelled `() => $.plugin.root` at each call site (the `$` spelling rule keeps `$` out of imports).
 * The `recallPluginRoot` option is used only when the host has no `$.plugin.root`: it comes from the user's own
 * settings (`pluginConfigs`, which a project's settings do not override) and must be an absolute path without `..`.
 */
export function trustedPluginRoot(engineRoot: () => unknown, option: string): string | undefined {
  let engine: unknown;
  try { engine = engineRoot(); } catch { engine = undefined; }
  if (typeof engine === 'string' && isSafeAbsolute(engine)) return trimSeparators(engine);
  return isSafeAbsolute(option) ? trimSeparators(option) : undefined;
}

/** An absolute POSIX or drive-letter path, with no `..` segment and no control character. */
export function isSafeAbsolute(path: string): boolean {
  if (typeof path !== 'string' || path === '' || /[\u0000-\u001f]/.test(path)) return false;
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) return false;
  return !path.split(/[\\/]/).includes('..');
}

function trimSeparators(path: string): string {
  return path.replace(/(?<=.)[\\/]+$/, '');
}
