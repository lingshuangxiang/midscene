// Exercises the built Midscene entry points, with no source stripping or ACP
// client supplied by the probe. Load model settings through normal env config.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const {
  AiLocateElement,
  ScreenshotItem,
} = require('../../packages/core/dist/lib/index.js');
const {
  callAI,
  getModelRuntime,
} = require('../../packages/core/dist/lib/ai-model/index.js');
const {
  globalModelConfigManager,
} = require('../../packages/shared/dist/lib/env/index.js');
const { values } = parseArgs({
  options: {
    image: { type: 'string' },
    target: { type: 'string', default: 'TapTap 应用图标' },
    output: {
      type: 'string',
      default: `midscene_run/codely-acp/provider-${Date.now()}`,
    },
  },
});
assert(values.image, 'Pass --image SCREENSHOT.png');
const config = globalModelConfigManager.getModelConfig('default');
assert.equal(config.openaiBaseURL, 'codely://acp');
const output = path.resolve(values.output);
await mkdir(output, { recursive: true });
const result = {
  passed: false,
  provider: config.openaiBaseURL,
  modelName: config.modelName,
  modelFamily: config.modelFamily,
  checks: [],
};
try {
  const runtime = getModelRuntime(config);
  const started = Date.now();
  const chunks = [];
  const text = await callAI(
    [
      {
        role: 'system',
        content:
          'Reply with exactly the token the user asks for, with no extra text.',
      },
      { role: 'user', content: 'Reply with MIDSCENE_CODELY_OK' },
    ],
    runtime,
    { stream: true, onChunk: (chunk) => chunks.push(chunk) },
  );
  assert.equal(text.content.trim(), 'MIDSCENE_CODELY_OK');
  assert.equal(chunks.at(-1)?.isComplete, true);
  result.checks.push({
    name: 'text-stream',
    passed: true,
    elapsedMs: Date.now() - started,
    content: text.content,
  });
  const image = await readFile(values.image);
  assert(
    image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'Expected PNG',
  );
  const size = {
    width: image.readUInt32BE(16),
    height: image.readUInt32BE(20),
  };
  const locateStarted = Date.now();
  const location = await AiLocateElement({
    context: {
      screenshot: ScreenshotItem.create(
        `data:image/png;base64,${image.toString('base64')}`,
        Date.now(),
      ),
      shotSize: size,
      shrunkShotToLogicalRatio: 1,
    },
    modelRuntime: runtime,
    targetElementDescription: values.target,
  });
  const element = location.parseResult.element;
  assert(element, JSON.stringify(location.parseResult.errors));
  const [x, y] = element.center;
  assert(
    Number.isFinite(x) &&
      Number.isFinite(y) &&
      x >= 0 &&
      x < size.width &&
      y >= 0 &&
      y < size.height,
  );
  result.checks.push({
    name: 'AiLocateElement',
    passed: true,
    elapsedMs: Date.now() - locateStarted,
    size,
    rawResponse: location.rawResponse,
    element,
  });
  result.passed = true;
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  await writeFile(
    path.join(output, 'summary.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  console.log(`Evidence: ${output}`);
}
