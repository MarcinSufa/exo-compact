/**
 * Session push (3.42.0, CONTRACT S4zn). The ContextBench pilot tasks (wai-org.com/blog/clm) add knowledge during
 * the session and ask about it later; after a cut the agent does not search for it. So on a user prompt the plugin
 * runs recall/session-push.mjs, which searches the session index line by line and returns the transcript lines a
 * compaction removed that share a rare term with the prompt; they go to the model with the prompt as context.
 * Each line once per cut (state file below); nothing before the first cut.
 */
export const SESSION_PUSH_FILE = 's4-session-push.json';
export const SESSION_PUSH_TIMEOUT_MS = 3000;
/**
 * 4.8.2 (CONTRACT S5s): the recall MCP server of a session answers the same request over a local socket, named in
 * this file in the session's recall index directory (recall/push-server.mjs). A server that has not answered in
 * this time is given up for the prompt.
 */
export const SESSION_PUSH_POINTER = 'push-server.json';
export const SESSION_PUSH_SERVER_TIMEOUT_MS = 1500;
/** 4.9.1: the server stops before the hook's session-push timer expires. */
export const SESSION_PUSH_SERVER_DEADLINE_MARGIN_MS = 200;

export type PushPointer = { socket: string; token: string };

/** The pointer's socket and token, or undefined when it is not an absolute socket path or a named pipe with a token. */
export function parsePushPointer(text: string): PushPointer | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!value || typeof value !== 'object') return undefined;
  const { socket, token } = value as Partial<PushPointer>;
  if (typeof socket !== 'string' || typeof token !== 'string' || !token) return undefined;
  if (!socket.startsWith('/') && !socket.startsWith('\\\\.\\pipe\\')) return undefined;
  return { socket, token };
}

export type SessionPushFound = {
  cuts: number;
  lines: readonly { segment: number; text: string; key?: string }[];
  text: string;
};

export function parseSessionPush(stdout: string): SessionPushFound | undefined {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return undefined; }
  if (!value || typeof value !== 'object') return undefined;
  const found = value as Partial<SessionPushFound>;
  if (typeof found.text !== 'string' || !found.text || !Array.isArray(found.lines) || !found.lines.length) return undefined;
  if (!found.lines.every((line) => line !== null && typeof line === 'object' && typeof line.text === 'string' && Number.isFinite(line.segment) && (line.key === undefined || typeof line.key === 'string'))) return undefined;
  return { cuts: Number(found.cuts) || 0, lines: found.lines, text: found.text };
}

/** The note the model reads with the prompt: where the lines come from and that later lines override earlier ones. */
export function renderSessionPush(found: SessionPushFound): string {
  return [
    'Earlier in this session (removed from context by a compaction), lines that share names, ids or codes with this message, [segment = compactions before it]:',
    found.text,
    'Use them if the message is about them. A later segment, or a correction still in context, overrides an earlier line; search_session finds more.',
  ].join('\n');
}
