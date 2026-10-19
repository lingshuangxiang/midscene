import type { IModelConfig } from '@midscene/shared/env';
import { createExecutionContext } from '#yaml-execution-context';
import { CodelySession } from './session';

/** Owns connections for one script (or one SDK Agent until destroy). */
export class CodelySessionScope {
  private sessions = new Map<string, CodelySession>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;

  run<T>(
    config: IModelConfig,
    signal: AbortSignal,
    callback: (session: CodelySession) => Promise<T>,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error('Codely session scope is closed'));
    // These options configure the CLI process. Intent and system instructions
    // vary per inference and must not create extra sessions for the same model.
    const key = JSON.stringify([
      config.modelName,
      config.reasoningEnabled,
      config.reasoningEffort?.trim().toLowerCase(),
    ]);
    const result = this.tail.then(async () => {
      signal.throwIfAborted();
      let session = this.sessions.get(key);
      if (!session) {
        session = new CodelySession();
        this.sessions.set(key, session);
      }
      try {
        return await callback(session);
      } catch (error) {
        // A failed/aborted turn may leave ambiguous remote history. The normal
        // callAI retry boundary can establish a fresh session on its next try.
        this.sessions.delete(key);
        await session.close(signal);
        throw error;
      }
    });
    // Serialize prompts and their streaming/recording callbacks, even when
    // callers issue concurrent inferences inside the same script.
    this.tail = result.catch(() => {});
    return result;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.tail.then(async () => {
      await Promise.all(
        [...this.sessions.values()].map((session) => session.close()),
      );
      this.sessions.clear();
    });
    return this.closing;
  }
}

// Keep scopes shared across the package's CJS and ESM entry points.
const stateKey = Symbol.for('@midscene/core/codely-session-scope/v1');
const host = globalThis as typeof globalThis & {
  [stateKey]?: ReturnType<typeof createExecutionContext<CodelySessionScope>>;
};
host[stateKey] ??= createExecutionContext<CodelySessionScope>();
const context = host[stateKey];

export const currentCodelySessionScope = () => context.getStore();

export async function runWithCodelySessionScope<T>(
  callback: () => Promise<T>,
): Promise<T> {
  if (context.getStore()) return callback();
  const scope = new CodelySessionScope();
  return context.run(scope, async () => {
    try {
      return await callback();
    } finally {
      await scope.close();
    }
  });
}
