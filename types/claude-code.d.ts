/**
 * A minimal stand-in for the `claude-code` module, so a fresh clone and CI can typecheck.
 *
 * Claude Code writes its full declarations beside the mod when it loads it
 * (`plugin/compact/.claude-plugin/types/claude-code/index.d.ts`). That file is Claude Code's own and is
 * gitignored, not redistributed. This stub declares only what the two entry points use, in the shapes the
 * generated file gives them: the events they register, the `$` members they call and the event fields they
 * read. A typo in any of those fails `npm run typecheck`. Values the code only passes along stay `unknown`.
 * `npm run typecheck:full` checks against the generated file.
 */
declare module 'claude-code' {
  export type PluginOptions = Readonly<Record<string, string | number | boolean | readonly string[]>>;

  export type ToolUseSummary = { readonly tool_use_id: string; readonly tool: string; readonly input: unknown };
  export type SessionMessage = { readonly role: 'user' | 'assistant'; readonly text: string; readonly toolUses: readonly ToolUseSummary[]; readonly toolResults?: readonly unknown[] };
  export type SessionCompactResult =
    | { messages: readonly SessionMessage[]; tokensBefore?: number; tokensAfter?: number; usage?: unknown; skip?: undefined }
    | { skip: string; messages?: undefined };

  type FsEntry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean };
  type ProcessRunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean };

  type Engine = {
    clock: {
      now(): Promise<number>;
      sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void>;
      after(ms: number, fn: () => void): { cancel(): void };
    };
    env: { get(name: string): Promise<string | undefined> };
    fs: {
      exists(path: string): Promise<boolean>;
      read(path: string): Promise<string>;
      write(path: string, text: string): Promise<void>;
      list(path?: string): Promise<FsEntry[]>;
    };
    http: {
      fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; auth?: string; socketPath?: string }): Promise<{ status: number; ok: boolean; headers: Record<string, string>; text: string }>;
    };
    model: { fork(request: { prompt: string }): Promise<{ isAnswered: true; text: string } | { isAnswered: false; reason: 'nothing-to-fork' }> };
    process: { run(argv: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }): Promise<ProcessRunResult> };
    prompt: {
      fill(args: { text: string; mode?: 'replace' | 'append' | 'insert' }): Promise<{ isFilled: boolean; refusal?: 'no_composer' | 'dialog'; text: string; cursor: number }>;
      submit(args: { text: string; asUser?: true }): Promise<unknown>;
    };
    session: {
      compact(input?: { instructions?: string }): Promise<SessionCompactResult>;
      cwd(): Promise<string>;
      id(): Promise<string>;
      messages(): Promise<SessionMessage[]>;
      root(): Promise<string>;
      surfaces(): Promise<readonly string[]>;
      usage(args?: { breakdown?: 'summary' | 'full' }): Promise<{ startedAt: number; context: { tokens?: number; window: number; percent?: number; breakdown?: { rawMaxTokens: number; maxTokens: number; totalTokens: number } } }>;
      version(): Promise<{ version: string; base?: string; builtAt?: string }>;
    };
    ui: { log(text: string, options?: { to?: 'transcript' | 'debug' }): void; toast(text: string, options?: { timeoutMs?: number }): void };
  };

  type PromptOrigin = { readonly kind: 'auto-continuation' | 'bridge' | 'channel' | 'composer' | 'coordinator' | 'observer' | 'observer-activity' | 'peer' | 'peer-send-message' | 'plugin' | 'projects-relay' | 'scheduled-trigger' | 'sdk' | 'slack-ping' | 'task-notification' | 'unclassified' };
  type ClassicBase = { readonly session_id: string; readonly transcript_path: string; readonly cwd: string; readonly agent_id?: string };
  type ClassicResult = { block?: string; preventContinuation?: true; stopReason?: string; additionalContext?: string[] };
  type Inputs = {
    'session.start': { readonly cwd: string; readonly surface: string | null; readonly isInteractive: boolean };
    'prompt.submit': {
      readonly text: string;
      readonly attachments?: readonly { readonly type: 'audio' | 'image' | 'document'; readonly mediaType?: string; readonly filename?: string }[];
      readonly context?: readonly string[];
      readonly turnId?: string;
      readonly wait: boolean;
      readonly origin: PromptOrigin;
    };
    'session.compact': {
      readonly trigger: 'manual' | 'auto' | 'plugin' | 'precompute';
      readonly agentId?: string;
      readonly instructions?: string;
      readonly messages: readonly SessionMessage[];
    };
    'turn.complete': { readonly answer: string; readonly durationMs: number; readonly isAborted: boolean; readonly turnId: string; readonly agentId?: string }
      & ({ readonly reason: 'refusal'; readonly refusal: { readonly category: string | null; readonly explanation: string | null } } | { readonly reason: 'answer' | 'aborted' | 'error'; readonly refusal?: undefined });
    'classic.PreToolUse': { readonly [argument: string]: unknown; readonly tool: string; readonly tool_use_id: string };
    'classic.PostToolUse': ClassicBase & { readonly hook_event_name: 'PostToolUse'; readonly tool_name: string; readonly tool_input: unknown; readonly tool_response: unknown; readonly tool_use_id: string };
    'classic.Stop': ClassicBase & { readonly hook_event_name: 'Stop'; readonly stop_hook_active: boolean; readonly last_assistant_message?: string };
  };
  type Results = {
    'session.start': { cwd: string };
    'prompt.submit': { text: string; context?: readonly string[]; origin?: PromptOrigin; drop?: undefined } | { drop: string; text?: undefined; context?: undefined; origin?: undefined };
    'session.compact': SessionCompactResult;
    'turn.complete': { text: string; usage?: unknown };
    'classic.PreToolUse': ({ allow: true; ask?: undefined; deny?: undefined } | { ask: string; allow?: undefined; deny?: undefined } | { deny: string; allow?: undefined; ask?: undefined }) & { updatedInput?: Record<string, unknown>; additionalContext?: string[] };
    'classic.PostToolUse': ClassicResult & { updatedToolOutput?: unknown; updatedMCPToolOutput?: unknown };
    'classic.Stop': ClassicResult;
  };
  type EventName = keyof Inputs;
  type Hook<E extends EventName> = ($: Engine, input: Inputs[E], next: (input: Inputs[E]) => Promise<Results[E]>) => Promise<Results[E]> | Results[E];
  export type HookFailure = { readonly kind: 'throw' | 'timeout'; readonly message?: string; readonly budget: number };
  export type CatchHandler<F extends (...args: any[]) => any> = ($: Parameters<F>[0], input: Parameters<F>[1], next: Parameters<F>[2] & { readonly error: HookFailure }) => ReturnType<F> | undefined;
  export type Registration<F extends (...args: any[]) => any> = { readonly catch: (handler: CatchHandler<F>) => void };

  export type On = {
    <E extends EventName>(pattern: E, hook: Hook<E>): Registration<Hook<E>>;
  };
  export type Register = (on: On, options: PluginOptions) => unknown;
}

/** Runtime globals the mod uses: the Claude Code runtime has them, `lib: ES2022` does not. */
interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
  throwIfAborted(): void;
}
declare var AbortSignal: { prototype: AbortSignal; timeout(ms: number): AbortSignal; any(signals: AbortSignal[]): AbortSignal };
interface AbortController { readonly signal: AbortSignal; abort(reason?: unknown): void }
declare var AbortController: { prototype: AbortController; new (): AbortController };
interface TextEncoder { encode(input?: string): Uint8Array }
declare var TextEncoder: { prototype: TextEncoder; new (): TextEncoder };
