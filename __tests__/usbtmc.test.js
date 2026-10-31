// The N9340B over USB, against the fake USBTMC backend in driver/fake-usbtmc.js.
//
// Two layers: the USBTMC client on its own (framing, multi-transfer replies,
// recovery after a timeout), then the adapter through the real shell over
// HTTP with a `usb:<serial>` device that has no host at all. Nothing here
// needs hardware or the `usb` package.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeUsbBackend } from '../driver/fake-usbtmc.js';
import { POINT_COUNT } from '../driver/n9340b.js';
import { UsbtmcClient, setUsbBackend } from '../driver/usbtmc.js';
import { PRODUCT, addressOf, discoverDevices } from '../adapter.js';

const SERIAL = 'CN03481015';
const fake = createFakeUsbBackend({ serial: SERIAL });
setUsbBackend(fake.backend);

const DEVICE_ID = `usb:${SERIAL}`;
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;
const START_HZ = 470_000_000;
const STOP_HZ = 616_000_000;

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

const waitFor = async (predicate, ms) => {
  const deadline = Date.now() + ms;
  let value;
  while (Date.now() < deadline) {
    value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return value;
};

test.after(async () => {
  await handle.close();
});

// -- the client ---------------------------------------------------------------

test('the client frames a query and reads the identity back', async () => {
  const client = new UsbtmcClient({ serial: SERIAL });
  await client.connect();
  try {
    await client.clear();
    assert.equal(
      await client.query('*IDN?'),
      `Keysight Technologies,N9340B,${SERIAL},A.02.07`
    );
    assert.deepEqual(fake.usb.protocolErrors, []);
  } finally {
    await client.close();
  }
});

test('a reply longer than one transfer is reassembled until EOM', async () => {
  // the fake's REAL trace is 1845 bytes (the real unit sends 1844 over USB);
  // ask for 100 at a time so it takes 19 transfers
  const client = new UsbtmcClient({ serial: SERIAL, readChunkBytes: 100 });
  await client.connect();
  try {
    await client.write(':TRAC:FORM REAL');
    const before = fake.usb.transfersIn;
    await client.write(':TRAC1:DATA?');
    const buf = await client.read();
    assert.equal(buf.length, POINT_COUNT * 4 + 1);
    assert.equal(fake.usb.transfersIn - before, Math.ceil(buf.length / 100));
    assert.deepEqual(fake.usb.protocolErrors, []);
  } finally {
    await client.close();
  }
});

test('a query that times out clears the link, so the next one is in step', async () => {
  const client = new UsbtmcClient({ serial: SERIAL, ioTimeoutMs: 300 });
  await client.connect();
  try {
    // an unknown query: the instrument never answers it
    await assert.rejects(client.query(':NOT:A:COMMAND?'), /did not answer in time/);
    assert.match(await client.query('*IDN?'), /N9340B/);
  } finally {
    await client.close();
  }
});

// -- the adapter --------------------------------------------------------------

test('a USB device id needs no host', () => {
  assert.deepEqual(addressOf({ id: DEVICE_ID }), { kind: 'usbtmc', serial: SERIAL });
  assert.deepEqual(addressOf({ id: DEVICE_ID, config: {} }), {
    kind: 'usbtmc',
    serial: SERIAL,
  });
  // LAN is unchanged
  assert.deepEqual(addressOf({ id: 'net:192.168.42.251' }), {
    kind: 'vxi11',
    host: '192.168.42.251',
    port: null,
  });
  assert.deepEqual(addressOf({ id: 'x', config: { host: '10.0.0.7', port: 1024 } }), {
    kind: 'vxi11',
    host: '10.0.0.7',
    port: 1024,
  });
});

test('discovery lists a USB unit by serial with no addresses configured', async () => {
  const devices = await discoverDevices({});
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, DEVICE_ID);
  assert.equal(devices[0].product, PRODUCT);
  assert.deepEqual(devices[0].transport, { kind: 'usbtmc', serial: SERIAL });
  assert.match(devices[0].name, /N9340B/);

  fake.unplug();
  try {
    assert.deepEqual(await discoverDevices({}), []);
  } finally {
    fake.plug();
  }
});

test('a USB device opens, configures and sweeps through the shell', async (t) => {
  const added = await request('POST', '/devices', {
    id: DEVICE_ID,
    product: PRODUCT,
    config: {},
  });
  assert.ok([200, 201].includes(added.status), JSON.stringify(added));

  const configured = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    rbwHz: 100_000,
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.equal(configured.body.pointCount, POINT_COUNT);
  assert.equal(configured.body.rbwHz, 100_000);
  assert.ok(configured.body.resolved.sweepTimeMs > 0);
  assert.equal(configured.body.controls.preamp, 'on');

  const device = await deviceRecord();
  assert.equal(device.status.status, 'ok');
  assert.equal(device.identity?.serial ?? SERIAL, SERIAL);
  assert.equal(fake.state.continuous, false);
  assert.equal(fake.state.format, 'REAL');

  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));
  const trace = await request('GET', `${DEVICE_PATH}/trace`);
  assert.equal(trace.status, 200, JSON.stringify(trace.body));
  assert.equal(trace.body.amplitudesDbm.length, POINT_COUNT);
  assert.equal(trace.body.startHz, configured.body.startHz);
  const middle = trace.body.amplitudesDbm[Math.floor(POINT_COUNT / 2)];
  assert.ok(middle > -50, `carrier read ${middle}`);
  assert.deepEqual(fake.usb.protocolErrors, []);
});

test('unplugging the cable fails the device, and it reopens once plugged back', async (t) => {
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));
  await request('GET', `${DEVICE_PATH}/trace`);

  fake.unplug();
  const failed = await waitFor(async () => {
    const d = await deviceRecord();
    return d.status.status === 'failed' && d;
  }, 5_000);
  assert.ok(failed, 'device went failed');
  assert.match(failed.status.message ?? '', /USB|connection|unplugged/i);

  fake.plug();
  const reopened = await request('POST', `${DEVICE_PATH}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
  });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal((await deviceRecord()).status.status, 'ok');
});

test('closing a USB device hands the front panel back and releases the interface', async () => {
  assert.equal(fake.state.continuous, false);
  const removed = await request('DELETE', DEVICE_PATH);
  assert.ok([200, 204].includes(removed.status), JSON.stringify(removed));
  await waitFor(() => fake.state.continuous && fake.usb.openPipes.size === 0, 2_000);
  assert.equal(fake.state.continuous, true);
  assert.equal(fake.usb.openPipes.size, 0);
});
