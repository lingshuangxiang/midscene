import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Interface } from 'node:readline';

type RpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code?: number; message?: string };
};

export class CodelyACPClient {
  private nextId = 1;
  private failure?: Error;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
    }
  >();
  private lines: Interface;

  private constructor(
    private child: ChildProcessWithoutNullStreams,
    lines: Interface,
    private onNotification: (message: RpcMessage) => void,
    private record: (event: Record<string, unknown>) => void,
  ) {
    this.lines = lines;
    lines.on('line', (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line);
      } catch {
        // SyntaxError can quote stdout, including unexpected login output.
        this.fail(new Error('Invalid JSON from codely ACP stdout'));
        return;
      }
      try {
        this.receive(message);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    // Drain stderr without exposing login credentials or upstream headers.
    child.stderr.resume();
    child.stdin.on('error', (error) => this.fail(error));
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code, signal) =>
      this.fail(
        new Error(`codely ACP process exited (code=${code}, signal=${signal})`),
      ),
    );
    child.stdout.on('end', () =>
      this.fail(new Error('codely ACP stdout closed')),
    );
  }

  static async start(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    onNotification: (message: RpcMessage) => void,
    record: (event: Record<string, unknown>) => void,
  ) {
    const childProcessModule = 'node:child_process';
    const readlineModule = 'node:readline';
    const { spawn } = await import(childProcessModule);
    const { createInterface } = await import(readlineModule);
    const child = spawn('codely', args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new CodelyACPClient(
      child,
      createInterface({ input: child.stdout }),
      onNotification,
      record,
    );
  }

  private fail(error: Error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }

  notify(method: string, params: Record<string, unknown>) {
    this.send({ method, params });
  }

  private send(message: RpcMessage) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`,
      (error) => {
        if (error) this.fail(error);
      },
    );
  }

  request(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<any> {
    signal.throwIfAborted();
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (callback: (value: any) => void) => (value: any) => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        callback(value);
      };
      const onAbort = () => finish(reject)(signal.reason);
      this.pending.set(id, {
        resolve: finish(resolve),
        reject: finish(reject),
      });
      signal.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs)
        timer = setTimeout(() => {
          finish(reject)(
            new Error(`codely ACP ${method} timed out after ${timeoutMs}ms`),
          );
        }, timeoutMs);
      try {
        this.record({
          type: method === 'session/prompt' ? 'request' : 'chunk',
          ...(method === 'session/prompt'
            ? { request: { url: 'codely://acp' } }
            : {}),
          protocol: { direction: 'client', id, method, params },
        });
        this.send({ id, method, params });
      } catch (error) {
        finish(reject)(error);
      }
    });
  }

  private receive(message: RpcMessage) {
    if (!message || typeof message !== 'object')
      throw new Error('Invalid ACP message');
    if (message.method) {
      if (message.id !== undefined) {
        this.send({
          id: message.id,
          ...(message.method === 'session/request_permission'
            ? { result: { outcome: { outcome: 'cancelled' } } }
            : {
                error: {
                  code: -32601,
                  message: 'Tools are disabled for model inference',
                },
              }),
        });
        this.fail(
          new Error(
            `codely ACP requested a tool or permission: ${message.method}`,
          ),
        );
      } else if (message.method === 'session/update') {
        if (message.params?.update?.sessionUpdate === 'tool_call') {
          this.fail(
            new Error(
              'codely ACP attempted a tool call; model provider must use direct inference',
            ),
          );
          return;
        }
        this.record({
          type: 'chunk',
          protocol: { direction: 'server', ...message },
        });
        this.onNotification(message);
      }
      return;
    }
    const pending =
      message.id === undefined ? undefined : this.pending.get(message.id);
    if (!pending) return;
    // Do not record error payloads: upstream headers may contain credentials.
    this.record({
      type: 'chunk',
      protocol: {
        direction: 'server',
        id: message.id,
        ...(message.error
          ? { errorCode: message.error.code }
          : { result: message.result }),
      },
    });
    if (message.error) {
      pending.reject(
        new Error(
          `codely ACP request failed (code=${message.error.code}). Check Codely login and model access.`,
        ),
      );
    } else if (!Object.hasOwn(message, 'result')) {
      pending.reject(new Error('codely ACP response is missing result'));
    } else {
      pending.resolve(message.result);
    }
  }

  async close() {
    this.fail(new Error('codely ACP connection closed'));
    this.lines.close();
    const child = this.child;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      return;
    await new Promise<void>((resolve) => {
      const terminate = setTimeout(() => {
        child.kill('SIGTERM');
      }, 200);
      const kill = setTimeout(() => {
        child.kill('SIGKILL');
      }, 1200);
      child.once('exit', () => {
        clearTimeout(terminate);
        clearTimeout(kill);
        resolve();
      });
      child.stdin.end();
    });
  }
}
