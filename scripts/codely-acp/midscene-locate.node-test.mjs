import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMidsceneLocate } from './midscene-locate.mjs';

const locate = await buildMidsceneLocate('TapTap 应用图标');
const size = { width: 1200, height: 2670 };

test('uses Midscene source parser and normalized-to-pixel codec', () => {
  assert.deepEqual(
    locate.parseResponse('```json\n{"bbox":[300,500,400,600]}\n```', size)
      .center,
    [420, 1469],
  );
  assert.deepEqual(
    locate.parseResponse('{"bbox":[0,0,1000,1000]}', size).center,
    [600, 1335],
  );
  assert.equal(locate.userPrompt, 'Find: TapTap 应用图标');
  assert.ok(
    locate.sources.every((source) => /^[a-f0-9]{64}$/.test(source.sha256)),
  );
});

test('rejects absent, malformed, reversed, and out-of-range responses before any action', () => {
  for (const response of [
    '{"bbox":[]}',
    '{"bbox":[300,500,400,600],"error":"uncertain"}',
    '{"bbox":[null,500,400,600]}',
    '{"bbox":["300",500,400,600]}',
    '{"bbox":[0,0,1200,2670]}',
    '{"bbox":[400,600,300,500]}',
    '{"bbox":[300,500,400]}',
    'not JSON',
  ])
    assert.throws(() => locate.parseResponse(response, size));
});
