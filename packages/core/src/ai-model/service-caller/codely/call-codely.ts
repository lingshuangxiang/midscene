import { ifInBrowser, ifInWorker } from '@midscene/shared/utils';
import type {
  ModelCallContext,
  ModelCallMessages,
  ModelCallResult,
} from '../types';
import { buildCodelyPrompt, normalizeCodelyMessages } from './messages';
import { CODELY_SESSION_SYSTEM_PROMPT, CodelySession } from './session';
import { currentCodelySessionScope } from './session-scope';

export function isCodelyACPProvider(baseURL?: string) {
  return baseURL?.trim().toLowerCase().startsWith('codely://') ?? false;
}

export function prepareCodelyCall({
  messages,
  modelRuntime,
}: Pick<ModelCallContext, 'modelRuntime'> & { messages: ModelCallMessages }) {
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
  context: ModelCallContext,
  prepared: ReturnType<typeof prepareCodelyCall>,
): Promise<ModelCallResult> {
  const scope =
    currentCodelySessionScope() ?? context.modelRuntime.codelySessionScope;
  const run = (session: CodelySession) =>
    callInSession(context, prepared, session, !!scope);
  if (scope)
    return scope.run(context.modelRuntime.config, context.requestSignal, run);
  const session = new CodelySession();
  try {
    return await run(session);
  } finally {
    await session.close(context.requestSignal);
  }
}

async function callInSession(
  { modelRuntime, options, recordEvent, requestSignal }: ModelCallContext,
  prepared: ReturnType<typeof prepareCodelyCall>,
  session: CodelySession,
  reused: boolean,
): Promise<ModelCallResult> {
  requestSignal.throwIfAborted();
  const started = Date.now();
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
    session.record = record;
    session.onNotification = (message) => {
      if (
        message.params?.sessionId !== session.sessionId ||
        requestSignal.aborted
      )
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
    };
    await session.connect(
      modelRuntime.config,
      reused ? CODELY_SESSION_SYSTEM_PROMPT : prepared.systemPrompt,
      requestSignal,
    );
    if (prompt.some((part) => part.type === 'image') && !session.supportsImages)
      throw new Error('Codely ACP v1 with image support is required');
    if (reused)
      prompt.unshift({
        type: 'text',
        text: `CURRENT REQUEST\n[SYSTEM INSTRUCTIONS]\n${prepared.systemPrompt}\n[CONVERSATION]\n`,
      });
    const { client, sessionId } = session;
    if (!client || !sessionId)
      throw new Error('Codely session is not connected');
    const requestId = `${sessionId}:${++session.promptSequence}`;
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
    // Use zero placeholders for unsupported per-request token counts in reports.
    return {
      content,
      reasoning_content: reasoning || undefined,
      isStreamed,
      timeCost,
      requestId,
      rawUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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
    session.onNotification = undefined;
    session.record = undefined;
  }
}
