export interface TranscriptPathHost {
  cwd: () => Promise<string>;
  home: () => Promise<string | undefined>;
}

/**
 * Mutation-proof defect: the `"/" -> "-"` cwd sanitization is dropped, so a derived path embeds
 * raw slashes from the cwd as extra directory segments instead of the flat, single-segment name
 * Claude Code's real layout uses. Everything else matches `host/transcript-path.ts`'s working copy.
 */
export async function derivedTranscriptPath(host: TranscriptPathHost, sessionId: string): Promise<string | null> {
  const home = await host.home();
  if (!home) return null;
  const cwd = await host.cwd();
  return `${home}/.claude/projects/${cwd}/${sessionId}.jsonl`;
}
