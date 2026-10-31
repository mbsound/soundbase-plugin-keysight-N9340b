// Keysight analyzers other than the N9340B, through the real shell.
//
// The plugin is built and checked on the N9340B but does not refuse other
// Keysight models: it drives them with the same commands, learns their point
// count and frequency limits from the unit, and says the model is untested.
// The fake here plays a different model with its own point count and range;
// what a real N9342C actually reports has not been checked.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeN9340B } from '../driver/fake-n9340b.js';
import { parseTrace } from '../driver/n9340b.js';
import { setUsbBackend } from '../driver/usbtmc.js';
import { PRODUCT, discoverDevices, pointsFor } from '../adapter.js';

setUsbBackend(null);

const POINTS = 401;
const MAX_HZ = 7e9;
const other = await startFakeN9340B({
  identity: 'Keysight Technologies,N9342C,MY00000042,A.01.00',
  pointCount: POINTS,
  minHz: 100e3,
  maxHz: MAX_HZ,
});
const stranger = await startFakeN9340B({ identity: 'Rohde&Schwarz,FSH8,123456,1.0' });

const HOST = '127.0.0.1';
const DEVICE_ID = `net:${HOST}:${other.port}`;
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;

const handle = await (await import('../main.js')).default;

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const deviceRecord = async (id = DEVICE_ID) => {
  const { body } = await request('GET', '/devices');
  return body.devices.find((d) => d.id === id);
};

test.after(async () => {
  await handle.close();
  await other.close();
  await stranger.close();
});

test('a trace of any length is read when no length is expected', () => {
  const real = Buffer.alloc(POINTS * 4);
  for (let i = 0; i < POINTS; i++) real.writeFloatLE(-90 + i / 100, i * 4);
  assert.equal(parseTrace(real, null).length, POINTS);
  // but once a unit's count is known, a short read is still an error
  assert.throws(() => parseTrace(real.subarray(0, 400), POINTS), /expected 401 points/);
});

test('discovery offers any Keysight analyzer, and only Keysight', async () => {
  const devices = await discoverDevices({
    addresses: `${HOST}:${other.port}, ${HOST}:${stranger.port}`,
  });
  assert.equal(devices.length, 1, JSON.stringify(devices));
  assert.equal(devices[0].id, DEVICE_ID);
  assert.match(devices[0].name, /^N9342C MY00000042/);
});

test('another model opens with its own limits, and says it is untested', async () => {
  const added = await request('POST', '/devices', {
    id: DEVICE_ID,
    product: PRODUCT,
    config: { host: HOST, port: other.port },
  });
  assert.ok([200, 201].includes(added.status), JSON.stringify(added));
  const configured = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 4e9,
    stopHz: 6e9,
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  // above the N9340B's 3 GHz: the range came from the unit, not the N9340B
  assert.equal(configured.body.startHz, 4e9);
  assert.equal(configured.body.stopHz, 6e9);
  assert.equal(configured.body.pointCount, POINTS);

  const device = await deviceRecord();
  assert.equal(device.status.status, 'ok');
  assert.equal(device.capabilities.maxFrequencyHz, MAX_HZ);
  const resolution = device.capabilities.controls.find((c) => c.id === 'resolution');
  assert.match(resolution.choices[0].label, /401 points/);
  const warnings = device.status.warnings ?? [];
  assert.ok(
    warnings.some((w) => w.id === 'untested-model' && /N9342C/.test(w.message)),
    JSON.stringify(warnings)
  );
});

test('another model sweeps traces of its own length, and stitches them', async (t) => {
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));
  const trace = await request('GET', `${DEVICE_PATH}/trace`);
  assert.equal(trace.status, 200, JSON.stringify(trace.body));
  assert.equal(trace.body.amplitudesDbm.length, POINTS);
  await request('POST', `${DEVICE_PATH}/sweep/stop`);

  const sliced = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 4e9,
    stopHz: 6e9,
    controls: { resolution: '2' },
  });
  assert.equal(sliced.body.pointCount, pointsFor(2, POINTS));
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  const joined = await request('GET', `${DEVICE_PATH}/trace`);
  assert.equal(joined.body.amplitudesDbm.length, pointsFor(2, POINTS));
});

test('an analyzer from another maker is refused with its name', async () => {
  const id = `net:${HOST}:${stranger.port}`;
  await request('POST', '/devices', {
    id,
    product: PRODUCT,
    config: { host: HOST, port: stranger.port },
  });
  const tried = await request('POST', `/devices/${encodeURIComponent(id)}/configuration`, {
    startHz: 470e6,
    stopHz: 616e6,
  });
  assert.notEqual(tried.status, 200);
  const device = await deviceRecord(id);
  assert.match(device.status.message ?? '', /Rohde&Schwarz FSH8, not a Keysight analyzer/);
});
