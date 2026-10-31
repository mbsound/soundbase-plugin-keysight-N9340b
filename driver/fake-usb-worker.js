// A stand-in for driver/usb-worker.js: the same JSON lines over stdio, in a
// real child process, with the fake N9340B where winusb.dll and VISA would be.
// It lets the USB backend's process handling — both routes, the framing, the
// watchdog, a worker that dies — run on any OS with no hardware.
//
//   FAKE_USB_SERIAL   the unit's serial (default CN00000001)
//   FAKE_USB_WEDGE    an op name that never answers, as a stuck driver call
//   FAKE_USB_CRASH    an op name that kills the process instead of answering

import { createInterface } from 'node:readline';
import { clearIo, receive, waitUntilIdle } from './fake-n9340b.js';
import { createFakeUsbBackend } from './fake-usbtmc.js';
import { UsbError } from './usbtmc.js';

const serial = process.env.FAKE_USB_SERIAL ?? 'CN00000001';
const wedge = process.env.FAKE_USB_WEDGE;
const crash = process.env.FAKE_USB_CRASH;
const fake = createFakeUsbBackend({ serial });
const state = fake.state;
let pipe = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bytes = (data) => Buffer.from(data, 'base64');

const ops = {
  // WinUSB: raw USBTMC transfers against the strict fake
  async open() {
    pipe = await fake.backend.open(serial);
    return { interfaceNumber: 0, interfaceClass: [0xfe, 3, 1], pipes: [] };
  },
  async bulkOut({ data, timeoutMs }) {
    await pipe.bulkOut(bytes(data), timeoutMs);
    return null;
  },
  async bulkIn({ length, timeoutMs }) {
    return { data: (await pipe.bulkIn(length, timeoutMs)).toString('base64') };
  },
  async control({ request, value, length, timeoutMs }) {
    return { data: (await pipe.classRequestIn(request, value, length, timeoutMs)).toString('base64') };
  },
  async resetPipe({ which }) {
    await pipe.clearHalt(which);
    return null;
  },

  // VISA: whole messages, as viWrite and viRead deliver them
  async visaOpen() {
    return { resource: `USB0::0x0957::0xFFEF::${serial}::0::INSTR` };
  },
  async visaWrite({ data, timeoutMs }) {
    if (!(await waitUntilIdle(state, timeoutMs))) throw new UsbError('TIMEOUT', 'VI_ERROR_TMO');
    receive(state, bytes(data).toString('latin1'));
    return null;
  },
  async visaRead({ maxBytes, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    const idle = await waitUntilIdle(state, timeoutMs);
    while (idle && !state.io.output.length && Date.now() < deadline) await sleep(5);
    if (!idle || !state.io.output.length) throw new UsbError('TIMEOUT', 'VI_ERROR_TMO');
    const message = Buffer.from(state.io.output.shift(), 'latin1');
    return { data: message.subarray(0, maxBytes).toString('base64') };
  },
  async visaClear() {
    clearIo(state);
    return null;
  },

  async close() {
    await pipe?.close();
    pipe = null;
    return null;
  },
};

// one at a time, in order, as the real worker's blocking calls are
let queue = Promise.resolve();
const answer = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin })
  .on('line', (line) => {
    const request = JSON.parse(line);
    queue = queue.then(async () => {
      if (request.op === crash) process.exit(3);
      if (request.op === wedge) return new Promise(() => {});
      try {
        answer({ id: request.id, ok: true, result: await ops[request.op](request) });
      } catch (err) {
        answer({ id: request.id, ok: false, code: err.code ?? 'IO', message: err.message });
      }
    });
  })
  .on('close', () => process.exit(0));
