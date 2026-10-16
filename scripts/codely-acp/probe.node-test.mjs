import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { AcpClient } from './client.mjs';
import { createFixturePng, parseLocateResponse } from './fixture.mjs';

const fakeServer = `
const readline = require('node:readline');
const mode = process.argv[1];
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let promptId;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (mode === 'timeout') return;
  if (mode === 'exit') return process.exit(7);
  if (mode === 'bad-json') return process.stdout.write('not json\\n');
  if (m.method === 'initialize') {
    if (mode === 'missing-result') return send({id:m.id});
    if (mode === 'rpc-error') return send({id:m.id,error:{code:-32000,message:'secret'}});
    return send({id:m.id,result:{protocolVersion:1}});
  }
  if (m.method === 'session/prompt') {
    promptId = m.id;
    if (mode === 'permission') return send({id:999,method:'session/request_permission',params:{}});
    if (mode === 'tool') return send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'tool_call'}}});
    send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'{"found":false}'}}}});
    return send({id:m.id,result:{stopReason:'end_turn'}});
  }
  if (m.id === 999) send({id:promptId,result:m.result});
});
`;

function fake(t, mode, onEvent = () => {}) {
  const client = new AcpClient(process.execPath, ['-e', fakeServer, mode], {
    cwd: tmpdir(),
    env: process.env,
    onEvent,
  });
  t.after(() => client.close());
  return client;
}

test('correlates replies and receives text before prompt completion', async (t) => {
  const events = [];
  const client = fake(t, 'normal', (event) => events.push(event));
  assert.equal(
    (await client.request('initialize', {}, 2000)).protocolVersion,
    1,
  );
  assert.deepEqual(await client.request('session/prompt', {}, 2000), {
    stopReason: 'end_turn',
  });
  assert.equal(events.find((event) => event.text)?.text, '{"found":false}');
});

test('denies server permission requests without granting tools', async (t) => {
  const client = fake(t, 'permission');
  assert.deepEqual(await client.request('session/prompt', {}, 2000), {
    outcome: { outcome: 'cancelled' },
  });
});

test('fails direct-vision validation when a tool is used', async (t) => {
  const client = fake(t, 'tool');
  await assert.rejects(
    client.request('session/prompt', {}, 2000),
    /Unexpected tool call/,
  );
});

test('times out a pending request and releases its bookkeeping', async (t) => {
  const client = fake(t, 'timeout');
  await assert.rejects(client.request('initialize', {}, 60), /timed out/);
  assert.equal(client.pending.size, 0);
});

for (const [mode, pattern] of [
  ['missing-result', /no result/],
  ['rpc-error', /code=-32000/],
  ['exit', /code=7/],
  ['bad-json', /JSON|Unexpected token/],
]) {
  test(`rejects ${mode} responses`, async (t) => {
    const client = fake(t, mode);
    await assert.rejects(client.request('initialize', {}, 2000), pattern);
  });
}

test('handles missing CLI executables and closes without hanging', async () => {
  const client = new AcpClient('/nonexistent-midscene-codely-probe', [], {
    cwd: tmpdir(),
    env: process.env,
  });
  const errorEvent = once(client.child, 'error');
  const request = assert.rejects(
    client.request('initialize', {}, 2000),
    /ENOENT|EPIPE/,
  );
  await errorEvent;
  await request;
  await client.close();
});

test('accepts correct visual evidence and rejects hallucinations or coordinate drift', () => {
  const present = {
    found: true,
    coordinateSystem: 'pixels',
    bbox: [500, 360, 700, 480],
    center: [600, 420],
  };
  assert.deepEqual(parseLocateResponse(JSON.stringify(present), true), present);
  const absent = {
    found: false,
    coordinateSystem: 'pixels',
    bbox: null,
    center: null,
  };
  assert.deepEqual(parseLocateResponse(JSON.stringify(absent), false), absent);
  for (const invalid of [
    { ...present, center: [750, 420] },
    { ...present, center: [600, null] },
    { ...present, bbox: [625, 600, 875, 800], center: [750, 700] },
    { ...present, bbox: [500, 360, 800, 480] },
    { ...present, found: false },
    { ...present, coordinateSystem: 'normalized-1000' },
  ])
    assert.throws(() => parseLocateResponse(JSON.stringify(invalid), true));
  assert.throws(() => parseLocateResponse(JSON.stringify(present), false));
  assert.throws(() =>
    parseLocateResponse(JSON.stringify({ ...absent, bbox: [] }), false),
  );
  assert.throws(() => parseLocateResponse('```json\n{}\n```', true));
  const image = createFixturePng();
  assert.equal(image.readUInt32BE(16), 800);
  assert.equal(image.readUInt32BE(20), 600);
});
