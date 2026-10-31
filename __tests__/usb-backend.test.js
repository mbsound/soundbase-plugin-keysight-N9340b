// The USB backend's routing and process handling, against
// driver/fake-usb-worker.js: a real child process speaking the worker's JSON
// lines, with the fake N9340B behind it. What runs for real is everything
// between UsbtmcClient and the native libraries — which route a unit gets
// from its driver, the worker link, the watchdog, detach — on both routes.
// winusb.dll and visa64.dll themselves are exercised only on a Windows PC
// with a unit attached.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POINT_COUNT } from '../driver/n9340b.js';
import { UsbtmcClient, createUsbBackend, routeFor, setUsbBackend } from '../driver/usbtmc.js';

const SERIAL = 'CN03481015';
const FAKE_WORKER = fileURLToPath(new URL('../driver/fake-usb-worker.js', import.meta.url));
const PATH = '\\\\?\\usb#vid_0957&pid_ffef#cn03481015#{guid}';

// the driver each route is reached through, as SetupAPI reports it
const SERVICES = { winusb: 'WINUSB', visa: 'Usbtmc' };

function backendWith({ service = 'WINUSB', units, env = {}, visa = true, ...options } = {}) {
  const workers = [];
  const backend = createUsbBackend({
    listUnits: units ?? (() => [{ serial: SERIAL, service, path: PATH }]),
    visaInstalled: () => visa,
    spawnWorker: () => {
      const child = spawn(process.execPath, [FAKE_WORKER], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env, FAKE_USB_SERIAL: SERIAL, ...env },
      });
      workers.push(child);
      return child;
    },
    presencePollMs: 100,
    ...options,
  });
  return { backend, workers };
}

const exited = (child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', resolve));

async function connected(backend, options) {
  setUsbBackend(backend);
  const client = new UsbtmcClient({ serial: SERIAL, ...options });
  await client.connect();
  return client;
}

// -- routing ------------------------------------------------------------------

test('a unit is routed by the driver bound to it', () => {
  const withVisa = { visaInstalled: () => true };
  const noVisa = { visaInstalled: () => false };
  assert.equal(routeFor('WINUSB', noVisa).route, 'winusb');
  assert.equal(routeFor('WinUSB', noVisa).route, 'winusb');
  assert.equal(routeFor('Usbtmc', withVisa).route, 'visa');
  assert.equal(routeFor('Usbtmc', noVisa).route, null);
  assert.match(routeFor('Usbtmc', noVisa).reason, /no VISA library/);
  assert.equal(routeFor(null, withVisa).route, null);
  assert.match(routeFor(null, withVisa).reason, /no driver/);
  assert.match(routeFor('usbccgp', withVisa).reason, /usbccgp driver/);
});

test('discovery lists every unit it has a route to, and only those', async () => {
  const units = () => [
    { serial: 'CN00000001', model: 'N9340B', service: 'WINUSB', path: 'a' },
    // another Keysight model: offered the same way, named by its product string
    { serial: 'CN00000002', model: 'N9342C', service: 'Usbtmc', path: 'b' },
    { serial: 'CN00000003', model: 'N9340B', service: null, path: 'c' },
  ];
  assert.deepEqual(await backendWith({ units }).backend.list(), [
    { serial: 'CN00000001', model: 'N9340B' },
    { serial: 'CN00000002', model: 'N9342C' },
  ]);
  // without VISA, a unit on Keysight's driver is out of reach
  assert.deepEqual(await backendWith({ units, visa: false }).backend.list(), [
    { serial: 'CN00000001', model: 'N9340B' },
  ]);
});

test('a unit with no route says why and what to do, and starts no worker', async () => {
  const { backend, workers } = backendWith({ service: null });
  await assert.rejects(backend.open(SERIAL), /no driver\. Bind WinUSB to it, or install Keysight IO Libraries/);
  assert.equal(workers.length, 0);
});

// -- both routes --------------------------------------------------------------

for (const [route, service] of Object.entries(SERVICES)) {
  test(`${route}: the client queries and reads a whole trace through the worker`, async () => {
    const { backend, workers } = backendWith({ service });
    const client = await connected(backend, { readChunkBytes: 100 });
    try {
      await client.clear();
      assert.equal(await client.query('*IDN?'), `Keysight Technologies,N9340B,${SERIAL},A.02.07`);
      await client.write(':TRAC:FORM REAL');
      await client.write(':TRAC1:DATA?');
      const buf = await client.read();
      // the fake ends the trace with a newline; the real unit sends exactly 1844 over USB
      assert.ok([POINT_COUNT * 4, POINT_COUNT * 4 + 1].includes(buf.length), `${buf.length} bytes`);
    } finally {
      await client.close();
    }
    await exited(workers[0]);
    assert.equal(workers[0].exitCode, 0, 'the worker exits by itself on close');
  });

  test(`${route}: a query that times out clears the link, so the next one is in step`, async () => {
    const { backend } = backendWith({ service });
    const client = await connected(backend, { ioTimeoutMs: 300 });
    try {
      await assert.rejects(client.query(':NOT:A:COMMAND?'), /did not answer in time/);
      assert.match(await client.query('*IDN?'), /N9340B/);
    } finally {
      await client.close();
    }
  });

  test(`${route}: a worker call that never returns is killed, and the link reports fatal`, async () => {
    const read = route === 'visa' ? 'visaRead' : 'bulkIn';
    const { backend, workers } = backendWith({ service, env: { FAKE_USB_WEDGE: read }, graceMs: 200 });
    const client = await connected(backend, { ioTimeoutMs: 300 });
    const fatal = new Promise((resolve) => (client.onFatal = resolve));
    await assert.rejects(client.query('*IDN?'), /stopped responding/);
    assert.match((await fatal).message, /stopped responding/);
    await exited(workers[0]);
    assert.equal(client.connected, false);
  });

  test(`${route}: a worker that dies mid-call fails the call and the link`, async () => {
    const read = route === 'visa' ? 'visaRead' : 'bulkIn';
    const { backend } = backendWith({ service, env: { FAKE_USB_CRASH: read } });
    const client = await connected(backend);
    const fatal = new Promise((resolve) => (client.onFatal = resolve));
    await assert.rejects(client.query('*IDN?'), /worker stopped/);
    assert.match((await fatal).message, /worker stopped/);
  });

  test(`${route}: a cable pulled while idle is noticed without any transfer`, async () => {
    let present = true;
    const { backend, workers } = backendWith({
      units: () => (present ? [{ serial: SERIAL, service, path: PATH }] : []),
    });
    const client = await connected(backend);
    const fatal = new Promise((resolve) => (client.onFatal = resolve));
    present = false;
    assert.match((await fatal).message, /unplugged/);
    await exited(workers[0]);
    assert.equal(client.connected, false);
  });
}
