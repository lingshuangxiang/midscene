import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AcpClient } from './client.mjs';
import { buildMidsceneLocate } from './midscene-locate.mjs';

const { values } = parseArgs({
  options: {
    image: { type: 'string' },
    target: { type: 'string' },
    model: { type: 'string', default: 'codely-vl' },
    output: { type: 'string' },
    'timeout-ms': { type: 'string', default: '90000' },
  },
});
if (!values.image || !values.target) {
  throw new Error(
    'Usage: locate.mjs --image SCREENSHOT.png --target "TapTap 应用图标" [--output DIR]',
  );
}
const timeoutMs = Number(values['timeout-ms']);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
  throw new Error('Invalid timeout');
const image = await readFile(values.image);
if (
  !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
) {
  throw new Error('Expected a PNG screenshot');
}
const size = { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
if (!size.width || !size.height)
  throw new Error('Invalid screenshot dimensions');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.resolve(
  values.output ??
    path.join(root, 'midscene_run', 'codely-acp', `locate-${Date.now()}`),
);
await mkdir(output, { recursive: true });
const workspace = await mkdtemp(path.join(tmpdir(), 'midscene-codely-locate-'));
const trace = [];
const chunks = [];
const started = Date.now();
const summary = {
  passed: false,
  model: values.model,
  target: values.target,
  size,
  imageSha256: createHash('sha256').update(image).digest('hex'),
  output,
};
let client;
let sessionId;
try {
  const prompt = await buildMidsceneLocate(values.target);
  await writeFile(path.join(output, 'system-prompt.txt'), prompt.systemPrompt);
  await writeFile(path.join(output, 'user-prompt.txt'), prompt.userPrompt);
  await writeFile(
    path.join(output, 'source-manifest.json'),
    JSON.stringify(
      {
        sources: prompt.sources,
        format: prompt.format,
        language: 'Chinese',
        jsonRepair: false,
        imagePreprocessing: 'none',
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(output, 'input.png'), image);
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
  await writeFile(systemPath, prompt.systemPrompt);
  client = new AcpClient(
    'codely',
    [
      '--experimental-acp',
      '--prewarm',
      '--model',
      values.model,
      '--no-upm',
      '--agents=false',
      '--experimental-skills=false',
      '--no-auto-edit-memory',
      '--disable-next-speaker-check',
      '--telemetry=false',
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        CODELY_SYSTEM_MD: systemPath,
        CODELY_ENABLE_VLM: '1',
        CODELY_CLI_INTERNAL_DISABLE_AUTO_UPDATE: '1',
      },
      onEvent(event) {
        trace.push({ elapsedMs: Date.now() - started, ...event });
        if (event.sessionId === sessionId && event.text)
          chunks.push(event.text);
      },
    },
  );
  const handshake = await client.request(
    'initialize',
    {
      protocolVersion: 1,
      clientInfo: { name: 'midscene-codely-locate', version: '0.1.0' },
      clientCapabilities: {},
    },
    Math.min(timeoutMs, 15000),
  );
  summary.agentInfo = handshake.agentInfo;
  if (
    handshake.protocolVersion !== 1 ||
    !handshake.agentCapabilities?.promptCapabilities?.image
  ) {
    throw new Error('Expected ACP v1 with image support');
  }
  const session = await client.request(
    'session/new',
    { cwd: workspace, mcpServers: [] },
    timeoutMs,
  );
  sessionId = session?.sessionId;
  if (!sessionId) throw new Error('Missing ACP sessionId');
  const inferenceStarted = Date.now();
  const result = await client.request(
    'session/prompt',
    {
      sessionId,
      prompt: [
        {
          type: 'image',
          mimeType: 'image/png',
          data: image.toString('base64'),
        },
        { type: 'text', text: prompt.userPrompt },
      ],
    },
    timeoutMs,
  );
  summary.inferenceMs = Date.now() - inferenceStarted;
  summary.stopReason = result?.stopReason;
  if (result?.stopReason !== 'end_turn')
    throw new Error(`Unexpected stopReason: ${result?.stopReason}`);
  summary.location = prompt.parseResponse(chunks.join(''), size);
  summary.passed = true;
  console.log(
    JSON.stringify({
      passed: true,
      ...summary.location,
      inferenceMs: summary.inferenceMs,
    }),
  );
} catch (error) {
  summary.error = error.message;
  process.exitCode = 1;
  console.error(`FAIL ${error.message}`);
} finally {
  if (client) {
    if (sessionId && !summary.passed && !client.failure) {
      client.send({ method: 'session/cancel', params: { sessionId } });
    }
    await client.close();
    summary.stderr = {
      bytes: client.stderrBytes,
      diagnostics: [...client.stderrDiagnostics],
    };
  }
  summary.durationMs = Date.now() - started;
  await writeFile(path.join(output, 'response.txt'), chunks.join(''));
  await writeFile(
    path.join(output, 'summary.json'),
    JSON.stringify(summary, null, 2),
  );
  await writeFile(
    path.join(output, 'protocol.jsonl'),
    trace.map((event) => JSON.stringify(event)).join('\n'),
  );
  await rm(workspace, { recursive: true, force: true });
  console.log(`Evidence: ${output}`);
}
