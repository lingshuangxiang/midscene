import { getDebug } from '@midscene/shared/logger';
import { ifInBrowser, ifInWorker } from '@midscene/shared/utils';
import type { ModelCallContext, ModelCallResult } from '../types';
import { CodelyACPClient } from './acp-client';
import { buildCodelyPrompt, normalizeCodelyMessages } from './messages';

const warnCodely = getDebug('ai:call:codely', { console: true });

export function isCodelyACPProvider(baseURL?: string) {
  return baseURL?.trim().toLowerCase().startsWith('codely://') ?? false;
}

export function prepareCodelyCall({
  messages,
  modelRuntime,
}: Pick<ModelCallContext, 'messages' | 'modelRuntime'>) {
  if (ifInBrowser || ifInWorker)
    throw new Error('Codely ACP requires a Node.js runtime');
  if (
    modelRuntime.config.openaiBaseURL?.trim().toLowerCase() !== 'codely://acp'
  ) {
    throw new Error('Unsupported Codely endpoint; use codely://acp');
  }
  return normalizeCodelyMessages(messages);
}

export async function callCodely(
  { modelRuntime, options, recordEvent, requestSignal }: ModelCallContext,
  prepared: ReturnType<typeof prepareCodelyCall>,
): Promise<ModelCallResult> {
  const fsModule = 'node:fs/promises';
  const osModule = 'node:os';
  const pathModule = 'node:path';
  const [{ mkdir, mkdtemp, writeFile, rm }, { tmpdir }, path] =
    await Promise.all([import(fsModule), import(osModule), import(pathModule)]);
  requestSignal.throwIfAborted();
  const started = Date.now();
  const workspace = await mkdtemp(path.join(tmpdir(), 'midscene-codely-'));
  const { config } = modelRuntime;
  let client: CodelyACPClient | undefined;
  let sessionId: string | undefined;
  let content = '';
  let reasoning = '';
  let sequence = 0;
  const isStreamed = options?.stream === true && !!options.onChunk;
  const record = (event: Record<string, unknown>) =>
    recordEvent?.({
      ...event,
      provider: 'codely-acp',
      sequence: ++sequence,
    });
  const emit = (delta: string, thought: string, isComplete = false) => {
    if (isStreamed)
      options?.onChunk?.({
        content: delta,
        reasoning_content: thought,
        accumulated: content,
        isComplete,
      });
  };
  try {
    const prompt = await buildCodelyPrompt(prepared.turns, requestSignal);
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
    await writeFile(systemPath, prepared.systemPrompt);
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
    client = await CodelyACPClient.start(
      args,
      workspace,
      {
        ...process.env,
        CODELY_SYSTEM_MD: systemPath,
        CODELY_ENABLE_VLM: '1',
        CODELY_CLI_INTERNAL_DISABLE_AUTO_UPDATE: '1',
      },
      (message) => {
        if (message.params?.sessionId !== sessionId || requestSignal.aborted)
          return;
        const update = message.params?.update;
        if (
          update?.content?.type !== 'text' ||
          typeof update.content.text !== 'string'
        )
          return;
        if (update.sessionUpdate === 'agent_message_chunk') {
          content += update.content.text;
          emit(update.content.text, '');
        } else if (update.sessionUpdate === 'agent_thought_chunk') {
          reasoning += update.content.text;
          emit('', update.content.text);
        }
      },
      record,
    );
    const handshake = await client.request(
      'initialize',
      {
        protocolVersion: 1,
        clientInfo: { name: 'midscene_codely_provider', version: '1.0.0' },
        clientCapabilities: {},
      },
      requestSignal,
      15000,
    );
    if (
      handshake?.protocolVersion !== 1 ||
      (prompt.some((part) => part.type === 'image') &&
        handshake.agentCapabilities?.promptCapabilities?.image !== true)
    ) {
      throw new Error('Codely ACP v1 with image support is required');
    }
    const session = await client.request(
      'session/new',
      { cwd: workspace, mcpServers: [] },
      requestSignal,
    );
    sessionId = session?.sessionId;
    if (!sessionId)
      throw new Error('Codely ACP session/new returned no session id');
    const result = await client.request(
      'session/prompt',
      { sessionId, prompt },
      requestSignal,
    );
    requestSignal.throwIfAborted();
    if (result?.stopReason !== 'end_turn')
      throw new Error(
        `Codely ACP ended with ${result?.stopReason ?? 'unknown status'}`,
      );
    if (!content.trim())
      throw new Error('Codely ACP returned an empty response');
    const timeCost = Date.now() - started;
    emit('', '', true);
    record({
      type: 'response',
      final: {
        content,
        reasoningContent: reasoning || undefined,
        timeCost,
        protocol: {
          transport: 'acp',
          sessionId,
          stopReason: result.stopReason,
        },
      },
    });
    // ACP context_usage_update is context occupancy, not billable token usage.
    return {
      content,
      reasoning_content: reasoning || undefined,
      isStreamed,
      timeCost,
      requestId: sessionId,
    };
  } catch (error) {
    record({
      type: 'error',
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : String(error),
    });
    throw error;
  } finally {
    if (client) {
      if (sessionId && requestSignal.aborted) {
        try {
          client.notify('session/cancel', { sessionId });
        } catch {
          /* Process may have exited. */
        }
      }
      await client.close();
    }
    await rm(workspace, { recursive: true, force: true }).catch(
      (error: unknown) =>
        warnCodely(
          `Failed to remove Codely temporary workspace: ${String(error)}`,
        ),
    );
  }
}
