import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

export class AcpClient {
  constructor(command, args, { cwd, env, onEvent = () => {} }) {
    this.pending = new Map();
    this.nextId = 1;
    this.onEvent = onEvent;
    this.stderrBytes = 0;
    this.stderrDiagnostics = new Set();
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      try {
        this.receive(JSON.parse(line));
      } catch (error) {
        this.fail(error);
      }
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderrBytes += chunk.length;
      const text = chunk.toString();
      // Do not persist raw CLI stderr: authentication failures can contain secrets.
      for (const [category, pattern] of [
        ['filesystem-permission', /EACCES|EPERM|permission denied/i],
        ['network', /ENOTFOUND|ECONNREFUSED|fetch failed|network error/i],
        [
          'authentication',
          /unauthorized|authentication failed|not authenticated/i,
        ],
      ]) {
        if (pattern.test(text)) this.stderrDiagnostics.add(category);
      }
    });
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => {
      this.fail(
        new Error(`ACP process exited: code=${code}, signal=${signal}`),
      );
    });
  }

  fail(error) {
    this.failure ??= error;
    for (const { reject } of this.pending.values()) reject(this.failure);
    this.pending.clear();
  }

  send(message) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`,
    );
  }

  request(method, params, timeoutMs) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const finish = (callback) => (value) => {
        clearTimeout(timer);
        callback(value);
      };
      this.pending.set(id, {
        method,
        resolve: finish(resolve),
        reject: finish(reject),
      });
      try {
        this.onEvent({ direction: 'client', method, id });
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  receive(message) {
    if (message.method) {
      if (message.id !== undefined) {
        this.onEvent({
          direction: 'server',
          method: message.method,
          denied: true,
        });
        this.send({
          id: message.id,
          ...(message.method === 'session/request_permission'
            ? { result: { outcome: { outcome: 'cancelled' } } }
            : {
                error: {
                  code: -32601,
                  message: 'Tools disabled in vision probe',
                },
              }),
        });
        return;
      }
      if (message.method === 'session/update') {
        const { sessionId, update } = message.params ?? {};
        const event = {
          direction: 'server',
          method: message.method,
          sessionId,
          updateType: update?.sessionUpdate,
        };
        if (
          update?.sessionUpdate === 'agent_message_chunk' &&
          update.content?.type === 'text'
        )
          event.text = update.content.text;
        this.onEvent(event);
        if (update?.sessionUpdate === 'tool_call') {
          this.fail(
            new Error(
              'Unexpected tool call: direct vision probe requires no tools',
            ),
          );
        }
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    this.onEvent({
      direction: 'server',
      method: pending.method,
      id: message.id,
      errorCode: message.error?.code,
    });
    if (message.error) {
      // Error data/message may contain upstream request headers. Persist only code.
      pending.reject(
        new Error(`ACP ${pending.method} failed (code=${message.error.code})`),
      );
    } else if (!Object.hasOwn(message, 'result')) {
      pending.reject(new Error(`ACP ${pending.method} response has no result`));
    } else {
      pending.resolve(message.result);
    }
  }

  async close() {
    this.fail(new Error('ACP client closed'));
    this.lines.close();
    if (
      !this.child.pid ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return;
    const exited = once(this.child, 'exit').catch(() => {});
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
