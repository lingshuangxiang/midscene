import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AcpClient } from './client.mjs';
import {
  createFixturePng,
  fixtureSize,
  parseLocateResponse,
  targetBounds,
} from './fixture.mjs';

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'codely-vl' },
    'timeout-ms': { type: 'string', default: '90000' },
    output: { type: 'string' },
    'handshake-only': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (values.help) {
  console.log(
    'Usage: node scripts/codely-acp/probe.mjs [--model codely-vl] [--timeout-ms 90000] [--output DIR] [--handshake-only]',
  );
  process.exit(0);
}
const timeoutMs = Number(values['timeout-ms']);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  throw new Error('--timeout-ms must be a positive integer');
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.resolve(
  values.output ??
    path.join(
      root,
      'midscene_run',
      'codely-acp',
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`,
    ),
);
await mkdir(output, { recursive: true });
const workspace = await mkdtemp(path.join(tmpdir(), 'midscene-codely-acp-'));
const trace = [];
const summary = {
  passed: false,
  model: values.model,
  output,
  checks: [],
  fixture: { ...fixtureSize, targetBounds },
  limitations: [
    'Standalone ACP probe; not a Midscene provider or device integration.',
    'Synthetic image only; strict pixel JSON contract is not a model-family codec.',
    'No latency or reliability claim from a single run; usage is not inferred.',
  ],
};
let client;
let activeSession;
let activeText;
let interrupted = false;
const save = (name, data) =>
  writeFile(path.join(output, name), `${JSON.stringify(data, null, 2)}\n`);
const cancel = () => {
  interrupted = true;
  if (client && activeSession) {
    try {
      client.send({
        method: 'session/cancel',
        params: { sessionId: activeSession },
      });
    } catch {
      /* The child may already be gone. */
    }
  }
  client?.fail(new Error('Probe interrupted'));
};
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
const started = Date.now();
try {
  await mkdir(path.join(workspace, '.codely-cli'));
  await writeFile(
    path.join(workspace, '.codely-cli', 'settings.json'),
    JSON.stringify({
      coreTools: [],
      mcpServers: {},
      hooks: { enabled: false },
      excludeMCPServers: [],
      telemetry: { enabled: false },
    }),
  );
  const systemPath = path.join(workspace, 'vision-system.md');
  await writeFile(
    systemPath,
    'You are a visual locator. Inspect the attached image and return only the requested JSON object. Do not use tools, read files, or delegate. Do not add explanations or Markdown.\n',
  );
  const image = createFixturePng();
  await writeFile(path.join(output, 'fixture.png'), image);
  summary.fixture.sha256 = createHash('sha256').update(image).digest('hex');
  const args = [
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
  ];
  summary.command = ['codely', ...args];
  client = new AcpClient('codely', args, {
    cwd: workspace,
    env: {
      ...process.env,
      CODELY_SYSTEM_MD: systemPath,
      CODELY_ENABLE_VLM: '1',
      CODELY_CLI_INTERNAL_DISABLE_AUTO_UPDATE: '1',
    },
    onEvent(event) {
      trace.push({ elapsedMs: Date.now() - started, ...event });
      if (event.sessionId === activeSession && event.text && activeText) {
        activeText.push(event.text);
      }
    },
  });
  const handshakeStart = Date.now();
  const handshake = await client.request(
    'initialize',
    {
      protocolVersion: 1,
      clientInfo: { name: 'midscene-codely-vision-probe', version: '0.1.0' },
      clientCapabilities: {},
    },
    Math.min(timeoutMs, 15000),
  );
  summary.agentInfo = handshake.agentInfo;
  summary.capabilities = handshake.agentCapabilities;
  if (
    handshake.protocolVersion !== 1 ||
    !handshake.agentCapabilities?.promptCapabilities?.image
  ) {
    throw new Error('ACP protocol v1 with image input is required');
  }
  summary.checks.push({
    name: 'handshake',
    passed: true,
    durationMs: Date.now() - handshakeStart,
  });
  console.log('PASS ACP handshake; image input advertised');

  if (!values['handshake-only']) {
    for (const [name, target, expectedFound] of [
      ['locate', 'the red rectangular button', true],
      ['absent', 'a purple triangle', false],
    ]) {
      const check = { name, passed: false };
      summary.checks.push(check);
      const checkStarted = Date.now();
      try {
        const session = await client.request(
          'session/new',
          { cwd: workspace, mcpServers: [] },
          timeoutMs,
        );
        if (!session?.sessionId)
          throw new Error('session/new returned no sessionId');
        activeSession = session.sessionId;
        activeText = [];
        const prompt = `Inspect this ${fixtureSize.width}x${fixtureSize.height} screenshot. Locate ${target}. Use original image pixel coordinates, not a 0-1000 scale. Return exactly one JSON object with these keys: {"found":boolean,"coordinateSystem":"pixels","bbox":[left,top,right,bottom],"center":[x,y]}. If the target does not exist, use found=false, bbox=null and center=null. Otherwise use found=true and the bounding rectangle and its center. No other text or tools.`;
        await save(`${name}-request.json`, {
          prompt,
          image: {
            mimeType: 'image/png',
            bytes: image.length,
            sha256: summary.fixture.sha256,
          },
        });
        const promptStarted = Date.now();
        const result = await client.request(
          'session/prompt',
          {
            sessionId: activeSession,
            prompt: [
              { type: 'text', text: prompt },
              {
                type: 'image',
                mimeType: 'image/png',
                data: image.toString('base64'),
              },
            ],
          },
          timeoutMs,
        );
        check.inferenceMs = Date.now() - promptStarted;
        check.stopReason = result?.stopReason;
        await writeFile(
          path.join(output, `${name}-response.txt`),
          activeText.join(''),
        );
        if (result?.stopReason !== 'end_turn') {
          throw new Error(`Unexpected ACP stopReason: ${result?.stopReason}`);
        }
        check.result = parseLocateResponse(activeText.join(''), expectedFound);
        check.passed = true;
      } catch (error) {
        if (activeText)
          await writeFile(
            path.join(output, `${name}-response.txt`),
            activeText.join(''),
          );
        throw error;
      } finally {
        check.durationMs = Date.now() - checkStarted;
      }
      console.log(`PASS ${name} (${check.inferenceMs}ms inference)`);
      activeSession = undefined;
      activeText = undefined;
    }
  }
  summary.passed = true;
} catch (error) {
  summary.error = error.message;
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  if (activeSession && client && !client.failure) {
    client.send({
      method: 'session/cancel',
      params: { sessionId: activeSession },
    });
  }
  if (client) {
    await client.close();
    summary.stderr = {
      bytes: client.stderrBytes,
      diagnostics: [...client.stderrDiagnostics],
    };
  }
  summary.interrupted = interrupted;
  summary.durationMs = Date.now() - started;
  await save('summary.json', summary);
  await writeFile(
    path.join(output, 'protocol.jsonl'),
    trace.map((e) => JSON.stringify(e)).join('\n'),
  );
  await rm(workspace, { recursive: true, force: true });
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
  console.log(`Evidence: ${output}`);
}
