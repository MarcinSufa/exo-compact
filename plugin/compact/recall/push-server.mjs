// 4.8.2 (CONTRACT S5s): session push through the recall MCP server. The hook used to start session-push.mjs on every
// prompt: a fresh node process that reads and prepares the whole session index each time (measured on a 22.8k-row
// index: 1.4 s wall, 2.1 s CPU, 580 MB, against a 3 s timeout). The MCP server already lives as long as the session
// and caches the prepared index (rank.mjs), so it answers the same request over a local socket instead: an HTTP
// Unix socket (a named pipe on Windows), which the hook reaches with $.http.fetch's socketPath. $.mcp.call cannot be
// used: it reaches only listed tools (the model would see one) and asks for a permission.
//
// The server writes <recallRoot>/<sha(session)>/push-server.json { socket, token, pid } for the session in
// CLAUDE_CODE_SESSION_ID. A request carries that token. The socket goes in a short owner-only directory (a Unix socket
// path is limited to about 107 bytes, and the index directory name alone is 64). Claude Code starts a stdio server
// twice (a version probe, then the real one), so each process has its own socket and removes the pointer only while
// it still names its socket. Any failure here leaves the hook on session-push.mjs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pushForPrompt } from './session-push.mjs';
import { hash } from './shared.mjs';

export const PUSH_POINTER = 'push-server.json';
/** The hook's state file name (core/session-push.ts SESSION_PUSH_FILE): read to skip prior lines, then committed by the hook. */
export const PUSH_STATE_FILE = 's4-session-push.json';
const REASSERT_MS = 10_000;
const MAX_BODY_BYTES = 1024 * 1024;
const SOCKET_MAX_BYTES = 100;

export function defaultSocketDir() {
  return path.join(os.tmpdir(), `exo-recall-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`);
}

/** `dir`, made owner-only when missing; null when it is not a private directory of this user. */
function privateDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return null; }
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) return null;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null;
    return (stat.mode & 0o077) === 0 ? dir : null;
  } catch { return null; }
}

/** A fresh, unguessable temp name created exclusively (never through a planted file or symlink), then renamed. */
function writeAtomic(file, text) {
  const temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try { fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); } catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
}

/** Sockets an earlier server of this session left when it was killed: its pid is gone. */
function removeStale(dir, prefix) {
  for (const name of (() => { try { return fs.readdirSync(dir); } catch { return []; } })()) {
    const match = name.startsWith(`${prefix}-`) && /-(\d+)\.sock$/.exec(name);
    if (!match) continue;
    try { process.kill(Number(match[1]), 0); } catch (error) { if (error?.code === 'ESRCH') try { fs.unlinkSync(path.join(dir, name)); } catch {} }
  }
}

/**
 * The socket of one server. 4.9.2: a Windows pipe name is global to the machine and a pid is easy to guess, so the
 * name carries 128 random bits; only the owner reads it, from the pointer. A Unix socket sits in an owner-only
 * directory and keeps a short name for the 107-byte limit.
 */
export function socketPath({ platform = process.platform, socketDir, prefix, instance }) {
  if (platform === 'win32') return `\\\\.\\pipe\\exo-recall-${prefix}-${instance}-${crypto.randomBytes(16).toString('hex')}`;
  return path.join(socketDir, `${prefix}-${instance}.sock`);
}

/**
 * Starts the push server of `sessionId`, or resolves null (no session, no private socket directory, a path too long,
 * a listen or pointer failure). `instance` names the socket (the pid; tests run two in one process).
 * Returns { socket, pointer, assert, close, closeSync }: `assert` writes the pointer again when it names another socket,
 * which it also does every `reassertMs`: an older server of the session (the version probe) may take the pointer over
 * and remove it when it closes.
 */
export async function startPushServer({ recallRoot, sessionId, socketDir = defaultSocketDir(), instance = process.pid, rare, platform = process.platform, reassertMs = REASSERT_MS } = {}) {
  if (!sessionId || !recallRoot) return null;
  const session = String(sessionId);
  const prefix = hash(session).slice(0, 16);
  const windows = platform === 'win32';
  const socket = socketPath({ platform, socketDir, prefix, instance });
  if (!windows && (Buffer.byteLength(socket) > SOCKET_MAX_BYTES || !privateDir(socketDir))) return null;
  if (!windows) { removeStale(socketDir, prefix); try { fs.unlinkSync(socket); } catch {} }
  const token = crypto.randomBytes(24).toString('hex');
  const indexDir = path.join(recallRoot, hash(session));
  const pointer = path.join(indexDir, PUSH_POINTER);

  const server = http.createServer((req, res) => {
    const reply = (status, body) => { if (!res.writableEnded) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); } };
    if (req.method !== 'POST' || req.url !== '/session-push') { req.resume(); return reply(404, 'null'); }
    const given = Buffer.from(String(req.headers['x-exo-token'] ?? ''));
    if (given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) { req.resume(); return reply(403, 'null'); }
    let body = '', size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) { reply(413, 'null'); req.destroy(); } else body += chunk;
    });
    req.on('end', () => {
      let input;
      try { input = JSON.parse(body); } catch { return reply(400, 'null'); }
      // A server answers for its own session only: after /clear the hook's session has no server, and spawns.
      if (input?.session !== session) return reply(409, 'null');
      if (typeof input.prompt !== 'string') return reply(400, 'null');
      // The hook reads and commits this file: only an absolute path to the hook's state file name.
      if (input.stateFile !== undefined && (typeof input.stateFile !== 'string' || !path.isAbsolute(input.stateFile) || path.basename(input.stateFile) !== PUSH_STATE_FILE)) return reply(400, 'null');
      const deadline = typeof input.deadline === 'number' && Number.isFinite(input.deadline) ? input.deadline : Infinity;
      try { reply(200, JSON.stringify(pushForPrompt(recallRoot, session, input.prompt, input.stateFile, rare, deadline, false))); } catch { reply(500, 'null'); }
    });
  });
  const listening = await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(socket, () => resolve(true));
  });
  if (!listening) return null;
  // The stdio connection decides when the server process ends, never this socket.
  server.unref();
  if (!windows) try { fs.chmodSync(socket, 0o600); } catch {}

  const names = () => { try { return JSON.parse(fs.readFileSync(pointer, 'utf8')).socket === socket; } catch { return false; } };
  const assert = () => {
    if (names()) return true;
    try { fs.mkdirSync(indexDir, { recursive: true, mode: 0o700 }); writeAtomic(pointer, JSON.stringify({ socket, token, pid: process.pid })); return true; } catch { return false; }
  };
  let closed = false;
  const reassert = setInterval(() => { if (!closed) assert(); }, reassertMs);
  reassert.unref();
  const closeSync = () => {
    if (closed) return;
    closed = true;
    clearInterval(reassert);
    try { server.close(); } catch {}
    if (!windows) try { fs.unlinkSync(socket); } catch {}
    if (names()) try { fs.unlinkSync(pointer); } catch {}
  };
  if (!assert()) { closeSync(); return null; }
  return { socket, pointer, assert, closeSync, close: async () => closeSync() };
}
