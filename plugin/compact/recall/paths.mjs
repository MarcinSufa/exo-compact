// 4.7.0 (CONTRACT S5i): where the recall node processes look, kept in step with host/home-dir.ts (the hook side).
// Home: HOME, else USERPROFILE, else HOMEDRIVE + HOMEPATH, else '.', the same chain the hook uses, so the writer
// (hook and workers) and the reader (the MCP server) agree on Windows and Linux. The plugin's own store stays at
// <home>/.claude/exovault/recall whatever CLAUDE_CONFIG_DIR says; only Claude Code's own files (projects/,
// plugins/installed_plugins.json) follow CLAUDE_CONFIG_DIR.
import path from 'node:path';

export function homeDir(env = process.env) {
  if (env.HOME) return env.HOME;
  if (env.USERPROFILE) return env.USERPROFILE;
  if (env.HOMEDRIVE && env.HOMEPATH) return `${env.HOMEDRIVE}${env.HOMEPATH}`;
  return '.';
}

/** Claude Code's config directory: CLAUDE_CONFIG_DIR when set and non-empty, else <home>/.claude. */
export function claudeConfigDir(env = process.env, home = homeDir(env)) {
  return env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude');
}

export function claudeProjectsDir(env = process.env, home = homeDir(env)) {
  return path.join(claudeConfigDir(env, home), 'projects');
}

export function recallRootDir(env = process.env, home = homeDir(env)) {
  return path.join(home, '.claude', 'exovault', 'recall');
}
