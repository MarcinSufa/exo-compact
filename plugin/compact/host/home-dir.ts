/**
 * 4.7.0 (CONTRACT S5i): the one rule for "the user's home directory" in the hook module. Windows usually has no
 * HOME, so the data would otherwise land in `./.claude` under the session's working directory. The same chain, in
 * the same order, is in recall/paths.mjs for the node processes the hook starts (a test pins both).
 * Empty strings count as unset. Returns undefined when nothing resolves; callers then use `.`.
 */
export interface HomeEnv {
  home?: string | undefined;
  userProfile?: string | undefined;
  homeDrive?: string | undefined;
  homePath?: string | undefined;
}

export function pickHomeDir(env: HomeEnv): string | undefined {
  if (env.home) return env.home;
  if (env.userProfile) return env.userProfile;
  if (env.homeDrive && env.homePath) return `${env.homeDrive}${env.homePath}`;
  return undefined;
}

/** What each hook builds over its own `$` (the hook compiler's $ rule): four literal env reads, one answer. */
export interface HomeHost {
  home: () => Promise<string | undefined>;
  userProfile: () => Promise<string | undefined>;
  homeDrive: () => Promise<string | undefined>;
  homePath: () => Promise<string | undefined>;
}

export async function resolveHomeDir(host: HomeHost): Promise<string | undefined> {
  const home = await host.home();
  if (home) return home;
  return pickHomeDir({ userProfile: await host.userProfile(), homeDrive: await host.homeDrive(), homePath: await host.homePath() });
}
