// Contract tests for the N9340B adapter, driven through the real shell over
// real HTTP, against the fake instrument in driver/fake-n9340b.js.
//
// Nothing here needs hardware. The fake speaks VXI-11, so the whole stack is
// exercised: shell -> adapter -> driver -> XDR -> TCP -> fake -> SCPI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HANDSHAKE_PREFIX } from '@soundbase/plugin-contract';
import { startFakeN9340B } from '../driver/fake-n9340b.js';
import { POINT_COUNT, RBW_HZ, parseTrace, snapToLadder } from '../driver/n9340b.js';
import { PRODUCT, discoverDevices } from '../adapter.js';

const manifest = JSON.parse(
  readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8')
);

const instrument = await startFakeN9340B();
const HOST = '127.0.0.1';
const DEVICE_ID = `net:${HOST}:${instrument.port}`;
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;
const START_HZ = 470_000_000;
const STOP_HZ = 616_000_000;

// boots under the real shell, exactly as the host spawns it
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

const deviceRecord = async () => {
  const { body } = await request('GET', '/devices');
  return body.devices.find((d) => d.id === DEVICE_ID);
};

test.after(async () => {
  await handle.close();
  await instrument.close();
});

test('the manifest is valid and the handshake reports a real port', () => {
  assert.equal(handle.manifest.id, manifest.id);
  assert.ok(handle.port > 0);
  assert.equal(HANDSHAKE_PREFIX, 'SB_PLUGIN_READY ');
});

test('the product the adapter announces is declared in the manifest', () => {
  const declared = manifest.products.map((p) => p.deviceTypeId);
  assert.ok(declared.includes(PRODUCT), `${PRODUCT} not in ${declared}`);
  assert.ok(PRODUCT.startsWith(`plugin:${manifest.id}/`));
});

test('the driver snaps RBW to the 1-3-10 ladder on a log scale', () => {
  assert.equal(snapToLadder(12_345), 10_000);
  assert.equal(snapToLadder(50_000), 30_000);
  assert.equal(snapToLadder(60_000), 100_000);
  assert.equal(snapToLadder(1), RBW_HZ[0]);
  assert.equal(snapToLadder(1e9), RBW_HZ[RBW_HZ.length - 1]);
});

test('the driver reads both trace formats the instrument can send', () => {
  const values = Array.from({ length: POINT_COUNT }, (_, i) => -100 + i / 10);
  const real = Buffer.alloc(POINT_COUNT * 4 + 1);
  values.forEach((v, i) => real.writeFloatLE(v, i * 4));
  real[POINT_COUNT * 4] = 0x0a;
  const fromReal = parseTrace(real);
  assert.equal(fromReal.length, POINT_COUNT);
  assert.ok(Math.abs(fromReal[7] - values[7]) < 1e-4);

  const ascii = Buffer.from(values.map((v) => v.toExponential(9)).join(',') + '\n');
  assert.deepEqual(parseTrace(ascii).slice(0, 3), values.slice(0, 3));

  assert.throws(() => parseTrace(Buffer.from('1,2,3\n')), /expected 461 points/);
});

test('discovery probes the configured addresses and names a stable device', async () => {
  const devices = await discoverDevices({ addresses: `${HOST}:${instrument.port}` });
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, DEVICE_ID);
  assert.equal(devices[0].product, PRODUCT);
  assert.match(devices[0].name, /N9340B/);
});

test('an address with nothing on it is an empty result, not an error', async () => {
  assert.deepEqual(await discoverDevices({ addresses: '127.0.0.1:1' }), []);
  assert.deepEqual(await discoverDevices({}), []);
});

test('a unit that is not an N9340B is not offered', async () => {
  const other = await startFakeN9340B({ identity: 'Acme,SA-3000,1,1.0' });
  try {
    assert.deepEqual(
      await discoverDevices({ addresses: `${HOST}:${other.port}` }),
      []
    );
  } finally {
    await other.close();
  }
});

test('a host-added device opens and reports capabilities from the hardware', async () => {
  const added = await request('POST', '/devices', {
    id: DEVICE_ID,
    product: PRODUCT,
    config: { host: HOST, port: instrument.port },
  });
  assert.ok([200, 201].includes(added.status), JSON.stringify(added));

  const configured = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: 1001,
    rbwHz: 100_000,
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  const device = await deviceRecord();
  assert.equal(device.status.status, 'ok');
  const caps = device.capabilities;
  assert.equal(caps.autoPointCount, true);
  assert.deepEqual(caps.rbwHz, RBW_HZ);
  assert.equal(caps.minRefLevelDbm, -120);
  assert.equal(caps.maxRefLevelDbm, 30);
  assert.deepEqual(
    caps.controls.map((c) => c.id),
    ['attenuation', 'sweepMode', 'preamp']
  );
  // the instrument was put into single-sweep mode and binary traces
  assert.equal(instrument.state.continuous, false);
  assert.equal(instrument.state.format, 'REAL');
});

test('the echo reports 461 points whatever was asked, and the real sweep time', async () => {
  const { body } = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: 1001,
    rbwHz: 100_000,
  });
  assert.equal(body.startHz, START_HZ);
  assert.equal(body.stopHz, STOP_HZ);
  assert.equal(body.pointCount, POINT_COUNT);
  assert.equal(body.rbwHz, 100_000);
  assert.equal(typeof body.resolved.sweepTimeMs, 'number');
  assert.ok(body.resolved.sweepTimeMs > 0);
  // VBW was left coupled, so it is reported as resolved rather than set
  assert.equal(body.vbwHz, undefined);
  assert.equal(typeof body.resolved.vbwHz, 'number');
  // the reference level was never requested, so the instrument's own value
  // shows up as resolved rather than as a setting
  assert.equal(body.refLevelDbm, undefined);
  assert.equal(typeof body.resolved.refLevelDbm, 'number');
});

test('out-of-range configuration is clamped, not rejected', async () => {
  const { status, body } = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: 0,
    stopHz: 9_000_000_000,
    rbwHz: 12_345,
    refLevelDbm: 99,
  });
  assert.equal(status, 200);
  assert.equal(body.startHz, 100_000);
  assert.equal(body.stopHz, 3_000_000_000);
  assert.equal(body.rbwHz, 10_000);
  assert.equal(body.resolved.refLevelDbm, 30);
});

test('omitting RBW means auto, reported under resolved', async () => {
  const { body } = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    rbwHz: null,
  });
  assert.equal(body.rbwHz, undefined);
  assert.ok(RBW_HZ.includes(body.resolved.rbwHz));
  assert.equal(instrument.state.rbwAuto, true);
});

test('controls are merged by id and echoed as the instrument settled on them', async () => {
  const first = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { sweepMode: 'fast' },
  });
  assert.equal(first.body.controls.sweepMode, 'fast');
  assert.equal(first.body.controls.attenuation, 'auto');

  const second = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { attenuation: '20', preamp: 'off' },
  });
  assert.equal(second.body.controls.attenuation, '20');
  assert.equal(second.body.controls.preamp, 'off');
  assert.equal(second.body.controls.sweepMode, 'fast', 'untouched control survived');
  assert.equal(instrument.state.attenDb, 20);
  assert.equal(instrument.state.attenAuto, false);
  assert.equal(instrument.state.preamp, false);

  const third = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { attenuation: 'auto', sweepMode: 'normal' },
  });
  assert.equal(third.body.controls.attenuation, 'auto');
  assert.equal(instrument.state.attenAuto, true);
  assert.equal(third.body.controls.sweepMode, 'normal');
  assert.equal(third.body.controls.preamp, 'off', 'untouched control survived');

  // clearing the choice (the host sends no value) means on, the default
  const fourth = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { preamp: null },
  });
  assert.equal(fourth.body.controls.preamp, 'on');
  assert.equal(instrument.state.preamp, true);
});

test('a freshly opened unit with its preamp off gets it switched on by default', async () => {
  // a unit left on the bench with the preamp off: remove the device so the
  // next operation opens a fresh adapter, as a reload in SoundBase does
  await request('DELETE', DEVICE_PATH);
  instrument.state.preamp = false;
  const added = await request('POST', '/devices', {
    id: DEVICE_ID,
    product: PRODUCT,
    config: { host: HOST, port: instrument.port },
  });
  assert.ok([200, 201].includes(added.status), JSON.stringify(added));
  const { body } = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
  });
  assert.equal(body.controls.preamp, 'on');
  assert.equal(instrument.state.preamp, true);
});

test('a partial request leaves the frequency range and RBW alone', async () => {
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    rbwHz: 30_000,
  });
  const again = await request('POST', `${DEVICE_PATH}/configuration`, {
    controls: { sweepMode: 'normal' },
  });
  assert.equal(again.body.startHz, applied.body.startHz);
  assert.equal(again.body.stopHz, applied.body.stopHz);
  assert.equal(again.body.rbwHz, 30_000);
  const shown = await request('GET', `${DEVICE_PATH}/configuration`);
  assert.equal(shown.body.rbwHz, 30_000);
  assert.equal(shown.body.pointCount, POINT_COUNT);
});

test('sweeping produces traces whose geometry matches the effective config', async (t) => {
  const applied = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    rbwHz: 100_000,
  });
  const sweepsBefore = instrument.state.sweepCount;
  const started = await request('POST', `${DEVICE_PATH}/sweep/start`);
  assert.equal(started.status, 200);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));

  const trace = await request('GET', `${DEVICE_PATH}/trace`);
  assert.equal(trace.status, 200, JSON.stringify(trace.body));
  assert.equal(trace.body.pointCount, POINT_COUNT);
  assert.equal(trace.body.amplitudesDbm.length, POINT_COUNT);
  assert.equal(trace.body.startHz, applied.body.startHz);
  assert.equal(trace.body.stopHz, applied.body.stopHz);
  assert.equal(trace.body.unit, 'dBm');
  assert.ok(instrument.state.sweepCount > sweepsBefore, 'a single sweep was triggered');

  // the fake puts a carrier in the middle bin and a floor near -100 dBm
  const amps = trace.body.amplitudesDbm;
  const middle = amps[Math.floor(POINT_COUNT / 2)];
  assert.ok(middle > -50, `carrier read ${middle}`);
  assert.ok(amps[10] < -90 && amps[10] > -110, `floor read ${amps[10]}`);

  const next = await request('GET', `${DEVICE_PATH}/trace`);
  assert.ok(next.body.sweepId > trace.body.sweepId, 'successive polls see successive sweeps');
});

test('a sweep that outlasts its expected time is reported, not hung', async (t) => {
  // the fake's sweep time estimate ignores sweepDelayMs, so this is a sweep
  // the instrument said would be quick and is not: the adapter's timeout
  // (1.5x the estimate plus overhead) fires and the device goes failed
  instrument.state.sweepDelayMs = 7_000;
  t.after(() => {
    instrument.state.sweepDelayMs = 20;
  });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));

  const deadline = Date.now() + 12_000;
  let device;
  while (Date.now() < deadline) {
    device = await deviceRecord();
    if (device.status.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(device.status.status, 'failed', JSON.stringify(device.status));
  assert.match(device.status.message ?? '', /sweep/i);
});

test('a dead transport fails the device and the next operation reopens it', async (t) => {
  // the fake is idle again; the first operation after a failure reopens
  const reopened = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    rbwHz: 100_000,
  });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal((await deviceRecord()).status.status, 'ok');

  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));
  await request('GET', `${DEVICE_PATH}/trace`);

  instrument.dropConnections();

  const deadline = Date.now() + 5_000;
  let device;
  while (Date.now() < deadline) {
    device = await deviceRecord();
    if (device.status.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(device.status.status, 'failed', JSON.stringify(device.status));
  assert.match(device.status.message ?? '', /connection/i);
});

test('closing hands the front panel back in continuous sweep', async () => {
  const again = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(instrument.state.continuous, false);
  const removed = await request('DELETE', DEVICE_PATH);
  assert.ok([200, 204].includes(removed.status), JSON.stringify(removed));
  // close() is asynchronous relative to the DELETE; give it a moment
  const deadline = Date.now() + 2_000;
  while (!instrument.state.continuous && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(instrument.state.continuous, true);
});
