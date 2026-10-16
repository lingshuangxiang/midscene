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
import { AIRequestTimeoutError } from '@/ai-model/service-caller/request-timeout';
import type { ModelCallMessages } from '@/ai-model/service-caller/types';
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
  if(mode!=='empty') {update('agent_thought_chunk','thinking');update('agent_message_chunk','hello');update('agent_message_chunk',' world');}
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
    it('routes callAI through ACP, records protocol, streams, and does not invent usage', async () => {
      const fake = await server();
      const chunks: any[] = [];
      const onRequest = rs.fn();
      const response = await callAI(
        messages,
        { ...getModelRuntime(config), onRequest },
        {
          stream: true,
          onChunk: (chunk) => chunks.push(chunk),
        },
      );
      expect(response.content).toBe('hello world');
      expect(response.reasoning_content).toBe('thinking');
      expect(response.usage).toBeUndefined();
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

    it('cancels the active session and reaps the child on abort', async () => {
      const fake = await server('hold');
      const controller = new AbortController();
      const pending = callAI(messages, getModelRuntime(config), {
        abortSignal: controller.signal,
      });
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
    });

    it('enforces callAI hard timeout and cleans up its process', async () => {
      const fake = await server('hold');
      await expect(
        callAI(messages, getModelRuntime({ ...config, timeout: 300 })),
      ).rejects.toBeInstanceOf(AIRequestTimeoutError);
      await waitFor(
        async () => (await readFile(fake.exited, 'utf8')) === 'done',
      );
    });

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
