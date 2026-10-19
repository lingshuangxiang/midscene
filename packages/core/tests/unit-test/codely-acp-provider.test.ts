import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '@/agent';
import { getModelRuntime } from '@/ai-model/models';
import { callAI } from '@/ai-model/service-caller';
import {
  isCodelyACPProvider,
  prepareCodelyCall,
} from '@/ai-model/service-caller/codely/call-codely';
import {
  buildCodelyPrompt,
  normalizeCodelyMessages,
} from '@/ai-model/service-caller/codely/messages';
import {
  CodelySessionScope,
  runWithCodelySessionScope,
} from '@/ai-model/service-caller/codely/session-scope';
import { AIRequestTimeoutError } from '@/ai-model/service-caller/request-timeout';
import type { ModelCallMessages } from '@/ai-model/service-caller/types';
import { collectTestRunReportMetrics } from '@/test-runner/reporting/metrics';
import { createLegacyYamlRuntime } from '@/yaml/legacy-yaml-runtime';
import { ModelConfigManager } from '@midscene/shared/env';
import type { IModelConfig } from '@midscene/shared/env';
import { afterEach, describe, expect, it, rs } from '@rstest/core';

const events = rs.hoisted(() => [] as Record<string, any>[]);
rs.mock('@/ai-model/service-caller/model-call-recorder', () => ({
  isModelCallRecordingEnabled: () => true,
  recordModelCallEvent: (event: Record<string, any>) => {
    events.push(event);
  },
}));

const config: IModelConfig = {
  modelName: 'codely-vl',
  modelFamily: 'codely-vl',
  modelDescription: 'Codely',
  openaiBaseURL: 'codely://acp',
  intent: 'default',
  slot: 'default',
  retryCount: 0,
};
const messages: ModelCallMessages = [
  { role: 'system', content: 'Original system prompt' },
  {
    role: 'user',
    content: [
      { type: 'image', url: 'data:image/png;base64,YQ==' },
      { type: 'text', text: 'Find: TapTap' },
    ],
  },
];
const directories: string[] = [];

async function directory() {
  const result = await mkdtemp(path.join(tmpdir(), 'midscene-acp-test-'));
  directories.push(result);
  return result;
}

async function server(mode = 'ok') {
  const bin = await directory();
  const log = path.join(bin, 'requests.jsonl');
  const exited = path.join(bin, 'exited');
  const executable = path.join(bin, 'codely');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline').createInterface({input:process.stdin});
const send = (m) => process.stdout.write(JSON.stringify(m)+'\\n');
const log = ${JSON.stringify(log)};
const mode = ${JSON.stringify(mode)};
const update = (kind,text) => send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:kind,content:{type:'text',text}}}});
process.on('SIGTERM',()=>process.exit(0));
process.on('exit',()=>{try{fs.writeFileSync(${JSON.stringify(exited)},'done')}catch{}});
readline.on('line',line=>{
 const m=JSON.parse(line); fs.appendFileSync(log,JSON.stringify(m)+'\\n');
 if(m.method==='initialize') {
  fs.writeFileSync(path.join(${JSON.stringify(bin)},'environment.json'), JSON.stringify({
   system:fs.readFileSync(process.env.CODELY_SYSTEM_MD,'utf8'),
   settings:JSON.parse(fs.readFileSync(path.join(process.cwd(),'.codely-cli/settings.json'),'utf8')),
   args:process.argv.slice(2), cwd:process.cwd()
  }));
  send({id:m.id,result:{protocolVersion:1,agentCapabilities:{promptCapabilities:{image:mode!=='no-images'}}}});
 } else if(m.method==='session/new') send({id:m.id,result:{sessionId:'s'}});
 else if(m.method==='session/prompt') {
  if(mode==='exit') return process.exit(7);
  if(mode==='hold') return;
  if(mode==='tool') return send({id:99,method:'session/request_permission',params:{}});
  if(mode==='tool-call') return send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'tool_call'}}});
  if(mode==='error') return send({id:m.id,error:{code:-32000,message:'secret-token-do-not-record',data:{authorization:'secret'}}});
  if(mode==='retry'&&!fs.existsSync(path.join(${JSON.stringify(bin)},'retried'))) {
   fs.writeFileSync(path.join(${JSON.stringify(bin)},'retried'),'yes');
   return send({id:m.id,error:{code:-32000}});
  }
  if(mode==='extract') update('agent_message_chunk','<data-json>{"text":"hello"}</data-json>');
  else if(mode!=='empty') {update('agent_thought_chunk','thinking');update('agent_message_chunk','hello');update('agent_message_chunk',' world');}
  send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'context_usage_update',usedTokens:999,modelTokenLimit:10000}}});
  send({id:m.id,result:{stopReason:mode==='cancelled'?'cancelled':'end_turn'}});
 }
});
`,
  );
  await chmod(executable, 0o755);
  rs.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  return { bin, log, exited };
}

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for fake ACP process');
}

afterEach(async () => {
  events.length = 0;
  rs.unstubAllEnvs();
  rs.unstubAllGlobals();
  rs.restoreAllMocks();
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe('Codely ACP preparation', () => {
  it('accepts configured model family without an API key', () => {
    const manager = new ModelConfigManager({
      MIDSCENE_MODEL_BASE_URL: 'codely://acp',
      MIDSCENE_MODEL_NAME: 'codely-vl',
      MIDSCENE_MODEL_FAMILY: 'codely-vl',
    });
    const parsed = manager.getModelConfig('default');
    expect(parsed.openaiApiKey).toBeUndefined();
    const adapter = getModelRuntime(parsed).adapter;
    expect(adapter.locate.kind).toBe('standard');
    if (adapter.locate.kind === 'standard') {
      expect(
        adapter.locate.element.resultCodec.promptSpec.resultValueDescription,
      ).toContain('normalized to 0-1000');
    }
    expect(isCodelyACPProvider(' CODELY://ACP ')).toBe(true);
    expect(isCodelyACPProvider('https://example.com')).toBe(false);
    expect(() =>
      prepareCodelyCall({
        messages,
        modelRuntime: getModelRuntime({
          ...config,
          openaiBaseURL: 'codely://other',
        }),
      }),
    ).toThrow('Unsupported Codely endpoint');
  });

  it('preserves the original system, image-first user prompt, and history order', async () => {
    const prepared = normalizeCodelyMessages(messages);
    expect(prepared.systemPrompt).toBe('Original system prompt');
    expect(
      await buildCodelyPrompt(prepared.turns, new AbortController().signal),
    ).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'YQ==' },
      { type: 'text', text: 'Find: TapTap' },
    ]);
    const history = normalizeCodelyMessages([
      ...messages,
      {
        type: 'model-output',
        output: {
          type: 'chat-completion',
          rawValue: { role: 'assistant', content: 'previous', refusal: null },
        },
      },
      { role: 'user', content: 'try again' },
    ]);
    const input = await buildCodelyPrompt(
      history.turns,
      new AbortController().signal,
    );
    expect(
      input.map((part) => (part.type === 'text' ? part.text : 'IMAGE')),
    ).toEqual([
      '[USER]',
      'IMAGE',
      'Find: TapTap',
      '[ASSISTANT]',
      'previous',
      '[USER]',
      'try again',
    ]);
    expect(() =>
      normalizeCodelyMessages([
        { type: 'model-output', output: { type: 'responses', rawValue: [] } },
      ]),
    ).toThrow('Cannot replay Responses');
  });

  it('loads local PNGs and rejects unsupported or malformed images', async () => {
    const dir = await directory();
    const file = path.join(dir, 'a.png');
    await writeFile(file, 'a');
    const signal = new AbortController().signal;
    expect(
      await buildCodelyPrompt(
        [{ role: 'user', content: [{ type: 'image', url: file }] }],
        signal,
      ),
    ).toEqual([{ type: 'image', mimeType: 'image/png', data: 'YQ==' }]);
    for (const url of [
      'data:image/png;base64,???',
      'data:text/plain;base64,YQ==',
      '/tmp/not-image.txt',
    ]) {
      await expect(
        buildCodelyPrompt(
          [{ role: 'user', content: [{ type: 'image', url }] }],
          signal,
        ),
      ).rejects.toThrow();
    }
  });

  it('loads HTTP images with the request signal and bounds the response size', async () => {
    const signal = new AbortController().signal;
    const fetchImage = rs
      .fn()
      .mockResolvedValue(
        new Response('a', { headers: { 'content-type': 'image/png' } }),
      );
    rs.stubGlobal('fetch', fetchImage);
    const turns = [
      {
        role: 'user' as const,
        content: [
          { type: 'image' as const, url: 'https://example.com/shot.png' },
        ],
      },
    ];
    expect(await buildCodelyPrompt(turns, signal)).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'YQ==' },
    ]);
    expect(fetchImage).toHaveBeenCalledWith('https://example.com/shot.png', {
      signal,
    });
    fetchImage.mockResolvedValue(
      new Response(new Uint8Array(20 * 1024 * 1024 + 1), {
        headers: { 'content-type': 'image/png' },
      }),
    );
    await expect(buildCodelyPrompt(turns, signal)).rejects.toThrow(
      'exceeds 20 MiB',
    );
  });
});

// npm's Windows .cmd shim is not a native executable; transport tests here
// exercise the POSIX CLI available in the verified macOS/Linux deployment.
describe.skipIf(process.platform === 'win32')(
  'Codely ACP process integration',
  () => {
    it('reports a missing CLI as an ordinary model error without hanging', async () => {
      rs.stubEnv('PATH', await directory());
      await expect(callAI(messages, getModelRuntime(config))).rejects.toThrow(
        'ENOENT',
      );
    });
    it('routes callAI through ACP, records timing, and uses zero token placeholders', async () => {
      const fake = await server();
      const chunks: any[] = [];
      const onRequest = rs.fn();
      const onUsage = rs.fn();
      const response = await callAI(
        messages,
        { ...getModelRuntime(config), onRequest, onUsage },
        {
          stream: true,
          onChunk: (chunk) => chunks.push(chunk),
        },
      );
      expect(response.content).toBe('hello world');
      expect(response.reasoning_content).toBe('thinking');
      expect(response.usage).toMatchObject({
        api_protocol: 'codely-acp',
        model_name: 'codely-vl',
        time_cost: expect.any(Number),
        request_id: 's:1',
        _midscene_call_id: expect.any(String),
      });
      expect(response.usage?.prompt_tokens).toBe(0);
      expect(response.usage?.completion_tokens).toBe(0);
      expect(response.usage?.total_tokens).toBe(0);
      expect(response.usage?.cached_input).toBe(0);
      expect(onUsage).toHaveBeenCalledExactlyOnceWith(response.usage);
      expect(
        collectTestRunReportMetrics({
          executions: [
            {
              name: 'ACP',
              logTime: 0,
              tasks: [
                {
                  taskId: 'planning',
                  type: 'Planning',
                  status: 'finished',
                  executor: async () => {},
                  timing: { start: 0, callAiStart: 0 },
                  usage: response.usage,
                },
              ],
            },
          ],
        }),
      ).toMatchObject({
        modelCallCount: 1,
        modelTimeMs: response.usage?.time_cost,
        totalTokens: 0,
        collection: {
          status: 'complete',
          fields: {
            modelCallCount: 'complete',
            modelTimeMs: 'complete',
            totalTokens: 'complete',
          },
          reasons: [],
        },
      });
      expect(chunks.at(-1)).toMatchObject({
        accumulated: 'hello world',
        isComplete: true,
      });
      expect(onRequest).toHaveBeenCalledTimes(1);
      expect(onRequest).toHaveBeenCalledWith('codely://acp');
      const environment = JSON.parse(
        await readFile(path.join(fake.bin, 'environment.json'), 'utf8'),
      );
      expect(environment.system).toBe('Original system prompt');
      expect(environment.settings.coreTools).toEqual([]);
      expect(environment.args).toContain('--model');
      expect(environment.args).toContain('codely-vl');
      expect(
        events.some(
          (event) =>
            event.type === 'response' && event.provider === 'codely-acp',
        ),
      ).toBe(true);
      await expect(stat(environment.cwd)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it.each([
      'no-images',
      'empty',
      'cancelled',
      'tool',
      'tool-call',
      'exit',
      'error',
    ])(
      'rejects %s instead of returning a successful model result',
      async (mode) => {
        await server(mode);
        await expect(
          callAI(messages, getModelRuntime(config)),
        ).rejects.toThrow();
        expect(JSON.stringify(events)).not.toContain(
          'secret-token-do-not-record',
        );
      },
    );

    it('uses the existing retry boundary and starts a fresh process per attempt', async () => {
      const fake = await server('retry');
      expect(
        (
          await callAI(
            messages,
            getModelRuntime({ ...config, retryCount: 1, retryInterval: 0 }),
          )
        ).content,
      ).toBe('hello world');
      const requests = (await readFile(fake.log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        requests.filter((request) => request.method === 'initialize'),
      ).toHaveLength(2);
      expect(
        events
          .filter((event) => event.type === 'request')
          .map((event) => event.attempt),
      ).toEqual([1, 2]);
    });

    const requests = async (log: string) =>
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));

    it('reuses one process/session across a script and isolates the next execution', async () => {
      const fake = await server();
      const runtime = createLegacyYamlRuntime({
        agent: {
          evaluateJavaScript: () => callAI(messages, getModelRuntime(config)),
          dump: { executions: [] },
        } as any,
        actionSpace: [],
        setResult: () => {},
      });
      const script = {
        tasks: [
          { name: 'first', flow: [{ javascript: 'first()' }] },
          { name: 'second', flow: [{ javascript: 'second()' }] },
        ],
      };
      for (let run = 1; run <= 2; run++) {
        const result = await runtime.runScript(script);
        expect(result.cases.map((item) => item.status)).toEqual([
          'success',
          'success',
        ]);
        const calls = await requests(fake.log);
        expect(
          calls.filter((item) => item.method === 'initialize'),
        ).toHaveLength(run);
        expect(
          calls.filter((item) => item.method === 'session/new'),
        ).toHaveLength(run);
        expect(
          calls.filter((item) => item.method === 'session/prompt'),
        ).toHaveLength(run * 2);
        const environment = JSON.parse(
          await readFile(path.join(fake.bin, 'environment.json'), 'utf8'),
        );
        await expect(stat(environment.cwd)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
    });

    it('uses current instructions and recording callbacks for each serialized prompt', async () => {
      const fake = await server();
      const firstChunks: any[] = [];
      const secondChunks: any[] = [];
      const onFirstRequest = rs.fn();
      const onSecondRequest = rs.fn();
      await runWithCodelySessionScope(async () => {
        const [first, second] = await Promise.all([
          callAI(
            messages,
            { ...getModelRuntime(config), onRequest: onFirstRequest },
            {
              stream: true,
              onChunk: (chunk) => firstChunks.push(chunk),
            },
          ),
          callAI(
            [
              { role: 'system', content: 'Return an assertion JSON' },
              { role: 'user', content: 'Assert current screenshot' },
            ],
            { ...getModelRuntime(config), onRequest: onSecondRequest },
            {
              stream: true,
              onChunk: (chunk) => secondChunks.push(chunk),
            },
          ),
        ]);
        expect(first.content).toBe('hello world');
        expect(second.content).toBe('hello world');
        expect(first.usage?.request_id).toBe('s:1');
        expect(second.usage?.request_id).toBe('s:2');
        expect(firstChunks.at(-1).accumulated).toBe('hello world');
        expect(secondChunks.at(-1).accumulated).toBe('hello world');
        expect(firstChunks).toHaveLength(secondChunks.length);
        expect(onFirstRequest).toHaveBeenCalledTimes(1);
        expect(onSecondRequest).toHaveBeenCalledTimes(1);
        const calls = await requests(fake.log);
        const prompts = calls.filter(
          (item) => item.method === 'session/prompt',
        );
        expect(
          calls.filter((item) => item.method === 'session/new'),
        ).toHaveLength(1);
        expect(prompts[0].params.prompt[0].text).toContain(
          'Original system prompt',
        );
        expect(prompts[1].params.prompt[0].text).toContain(
          'Return an assertion JSON',
        );
        expect(JSON.stringify(prompts[1])).not.toContain('Find: TapTap');
        const responses = events.filter((event) => event.type === 'response');
        expect(responses).toHaveLength(2);
        expect(responses[0].callId).not.toBe(responses[1].callId);
        await expect(stat(fake.exited)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      });
      await expect(stat(fake.exited)).resolves.toBeDefined();
    });

    it('keeps independent overlapping script executions isolated', async () => {
      const fake = await server();
      await Promise.all(
        [1, 2].map(() =>
          runWithCodelySessionScope(async () => {
            await callAI(messages, getModelRuntime(config));
            await callAI(messages, getModelRuntime(config));
          }),
        ),
      );
      const calls = await requests(fake.log);
      expect(
        calls.filter((item) => item.method === 'session/new'),
      ).toHaveLength(2);
      expect(
        calls.filter((item) => item.method === 'session/prompt'),
      ).toHaveLength(4);
    });

    it('reuses matching CLI settings and separates different models', async () => {
      const fake = await server();
      await runWithCodelySessionScope(async () => {
        for (const modelName of ['codely-vl', 'other', 'codely-vl']) {
          await callAI(messages, getModelRuntime({ ...config, modelName }));
        }
      });
      const calls = await requests(fake.log);
      expect(
        calls.filter((item) => item.method === 'session/new'),
      ).toHaveLength(2);
      expect(
        calls.filter((item) => item.method === 'session/prompt'),
      ).toHaveLength(3);
    });

    it('evicts a failed session, retries, then reuses the recovered session', async () => {
      const fake = await server('retry');
      await runWithCodelySessionScope(async () => {
        await callAI(
          messages,
          getModelRuntime({ ...config, retryCount: 1, retryInterval: 0 }),
        );
        await callAI(messages, getModelRuntime(config));
      });
      const calls = await requests(fake.log);
      expect(
        calls.filter((item) => item.method === 'session/new'),
      ).toHaveLength(2);
      expect(
        calls.filter((item) => item.method === 'session/prompt'),
      ).toHaveLength(3);
    });

    it('closes SDK-owned sessions explicitly and rejects calls after close', async () => {
      const fake = await server();
      const scope = new CodelySessionScope();
      const runtime = { ...getModelRuntime(config), codelySessionScope: scope };
      try {
        await callAI(messages, runtime);
        await callAI(messages, runtime);
        expect(
          (await requests(fake.log)).filter(
            (item) => item.method === 'session/new',
          ),
        ).toHaveLength(1);
      } finally {
        await scope.close();
      }
      await expect(callAI(messages, runtime)).rejects.toThrow(
        'scope is closed',
      );
      await expect(stat(fake.exited)).resolves.toBeDefined();
    });

    it('reuses sessions through Agent APIs, counts each inference, and closes on destroy', async () => {
      const fake = await server('extract');
      const destroy = rs.fn();
      const agent = new Agent(
        {
          interfaceType: 'puppeteer',
          actionSpace: () => [],
          describe: () => 'test page',
          size: async () => ({ width: 1, height: 1 }),
          screenshotBase64: async () =>
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
          destroy,
        } as any,
        {
          generateReport: false,
          modelConfig: {
            MIDSCENE_MODEL_NAME: 'codely-vl',
            MIDSCENE_MODEL_FAMILY: 'codely-vl',
            MIDSCENE_MODEL_BASE_URL: 'codely://acp',
            MIDSCENE_MODEL_RETRY_COUNT: 0,
          },
        },
      );
      try {
        for (let index = 0; index < 2; index++) {
          expect(await agent.aiQuery('{text: string}')).toEqual({
            text: 'hello',
          });
        }
        expect(agent.metrics.calls).toBe(2);
        expect(
          (await requests(fake.log)).filter(
            (item) => item.method === 'session/new',
          ),
        ).toHaveLength(1);
        await expect(stat(fake.exited)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await agent.destroy();
      }
      expect(destroy).toHaveBeenCalledTimes(1);
      await expect(stat(fake.exited)).resolves.toBeDefined();
    });

    it('does not submit an aborted queued inference or create another session', async () => {
      const fake = await server('hold');
      await runWithCodelySessionScope(async () => {
        const active = new AbortController();
        const queued = new AbortController();
        const first = callAI(messages, getModelRuntime(config), {
          abortSignal: active.signal,
        });
        void first.catch(() => {});
        await waitFor(async () =>
          (await readFile(fake.log, 'utf8')).includes('session/prompt'),
        );
        const second = callAI(messages, getModelRuntime(config), {
          abortSignal: queued.signal,
        });
        queued.abort(new Error('queued cancelled'));
        await expect(second).rejects.toThrow('queued cancelled');
        active.abort(new Error('active cancelled'));
        await expect(first).rejects.toThrow('active cancelled');
      });
      const calls = await requests(fake.log);
      expect(
        calls.filter((item) => item.method === 'session/new'),
      ).toHaveLength(1);
      expect(
        calls.filter((item) => item.method === 'session/prompt'),
      ).toHaveLength(1);
    });

    it('closes a reused session when the script throws', async () => {
      const fake = await server();
      await expect(
        runWithCodelySessionScope(async () => {
          await callAI(messages, getModelRuntime(config));
          throw new Error('script failed');
        }),
      ).rejects.toThrow('script failed');
      await expect(stat(fake.exited)).resolves.toBeDefined();
    });

    it.each([false, true])(
      'cancels the active session and reaps the child on abort (scoped: %s)',
      async (scoped) => {
        const fake = await server('hold');
        const controller = new AbortController();
        const run = () =>
          callAI(messages, getModelRuntime(config), {
            abortSignal: controller.signal,
          });
        const pending = scoped ? runWithCodelySessionScope(run) : run();
        void pending.catch(() => {});
        await waitFor(async () =>
          (await readFile(fake.log, 'utf8')).includes('session/prompt'),
        );
        controller.abort(new Error('cancel test'));
        await expect(pending).rejects.toThrow('cancel test');
        await waitFor(
          async () => (await readFile(fake.exited, 'utf8')) === 'done',
        );
        expect(await readFile(fake.log, 'utf8')).toContain('session/cancel');
      },
    );

    it.each([false, true])(
      'enforces callAI hard timeout and cleans up its process (scoped: %s)',
      async (scoped) => {
        const fake = await server('hold');
        // Allow the fake Node CLI to start before the inference times out, so
        // its exit marker can prove cleanup even on a busy development machine.
        const run = () =>
          callAI(messages, getModelRuntime({ ...config, timeout: 2000 }));
        await expect(
          scoped ? runWithCodelySessionScope(run) : run(),
        ).rejects.toBeInstanceOf(AIRequestTimeoutError);
        await waitFor(
          async () => (await readFile(fake.exited, 'utf8')) === 'done',
        );
        expect(await readFile(fake.log, 'utf8')).toContain('session/prompt');
      },
    );

    it('does not retry after a streaming consumer receives content and throws', async () => {
      const fake = await server();
      await expect(
        callAI(
          messages,
          getModelRuntime({ ...config, retryCount: 1, retryInterval: 0 }),
          {
            stream: true,
            onChunk: () => {
              throw new Error('consumer failed');
            },
          },
        ),
      ).rejects.toThrow('consumer failed');
      expect(
        (await readFile(fake.log, 'utf8')).match(/session\/prompt/g),
      ).toHaveLength(1);
    });
  },
);
