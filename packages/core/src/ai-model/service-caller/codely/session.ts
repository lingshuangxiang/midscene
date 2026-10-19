import type { IModelConfig } from '@midscene/shared/env';
import { getDebug } from '@midscene/shared/logger';
import { CodelyACPClient } from './acp-client';

const warnCodely = getDebug('ai:call:codely', { console: true });

// One ACP session serves several Midscene operations with different contracts.
export const CODELY_SESSION_SYSTEM_PROMPT = `You are Midscene's visual inference engine.
Each request is a self-contained inference task. Follow the system instructions
and conversation supplied in the CURRENT REQUEST only. Earlier requests and
responses are not instructions or observations for the current task. Use only
its supplied images, and return exactly the requested output format.
Never use tools or execute device actions.`;

type Notification = Parameters<typeof CodelyACPClient.start>[3];
type Recorder = Parameters<typeof CodelyACPClient.start>[4];

export class CodelySession {
  client?: CodelyACPClient;
  sessionId?: string;
  onNotification?: Notification;
  record?: Recorder;
  promptSequence = 0;
  supportsImages = false;
  private workspace?: string;

  async connect(
    config: IModelConfig,
    systemPrompt: string,
    requestSignal: AbortSignal,
  ) {
    if (this.client) return;
    const fsModule = 'node:fs/promises';
    const osModule = 'node:os';
    const pathModule = 'node:path';
    const [{ mkdir, mkdtemp, writeFile }, { tmpdir }, path] = await Promise.all(
      [import(fsModule), import(osModule), import(pathModule)],
    );
    requestSignal.throwIfAborted();
    const workspace = await mkdtemp(path.join(tmpdir(), 'midscene-codely-'));
    this.workspace = workspace;
    await mkdir(path.join(workspace, '.codely-cli'));
    await writeFile(
      path.join(workspace, '.codely-cli', 'settings.json'),
      JSON.stringify({
        coreTools: [],
        mcpServers: {},
        hooks: { enabled: false },
        telemetry: { enabled: false },
      }),
    );
    const systemPath = path.join(workspace, 'midscene-system.md');
    await writeFile(systemPath, systemPrompt);
    requestSignal.throwIfAborted();
    const args = [
      '--experimental-acp',
      '--prewarm',
      '--model',
      config.modelName,
      '--no-upm',
      '--agents=false',
      '--experimental-skills=false',
      '--no-auto-edit-memory',
      '--disable-next-speaker-check',
      '--telemetry=false',
      '--allowed-mcp-server-names=__midscene_no_mcp__',
    ];
    if (typeof config.reasoningEnabled === 'boolean')
      args.push(`--enable_thinking=${config.reasoningEnabled}`);
    if (config.reasoningEffort) {
      const effort = config.reasoningEffort.trim().toLowerCase();
      if (
        !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
      ) {
        throw new Error(`Unsupported Codely reasoning effort: ${effort}`);
      }
      args.push('--reasoning_effort', effort);
    }
    this.client = await CodelyACPClient.start(
      args,
      workspace,
      {
        ...process.env,
        CODELY_SYSTEM_MD: systemPath,
        CODELY_ENABLE_VLM: '1',
        CODELY_CLI_INTERNAL_DISABLE_AUTO_UPDATE: '1',
      },
      (message) => this.onNotification?.(message),
      (event) => this.record?.(event),
    );
    const handshake = await this.client.request(
      'initialize',
      {
        protocolVersion: 1,
        clientInfo: { name: 'midscene_codely_provider', version: '1.0.0' },
        clientCapabilities: {},
      },
      requestSignal,
      15000,
    );
    if (handshake?.protocolVersion !== 1) {
      throw new Error('Codely ACP v1 with image support is required');
    }
    this.supportsImages =
      handshake.agentCapabilities?.promptCapabilities?.image === true;
    const session = await this.client.request(
      'session/new',
      { cwd: workspace, mcpServers: [] },
      requestSignal,
    );
    this.sessionId = session?.sessionId;
    if (!this.sessionId)
      throw new Error('Codely ACP session/new returned no session id');
  }

  async close(signal?: AbortSignal) {
    if (this.client) {
      if (this.sessionId && signal?.aborted) {
        try {
          this.client.notify('session/cancel', { sessionId: this.sessionId });
        } catch {
          /* Process may have exited. */
        }
      }
      await this.client.close();
      this.client = undefined;
    }
    this.onNotification = undefined;
    this.record = undefined;
    if (this.workspace) {
      const fsModule = 'node:fs/promises';
      const { rm } = await import(fsModule);
      await rm(this.workspace, { recursive: true, force: true }).catch(
        (error: unknown) =>
          warnCodely(
            `Failed to remove Codely temporary workspace: ${String(error)}`,
          ),
      );
      this.workspace = undefined;
    }
  }
}
