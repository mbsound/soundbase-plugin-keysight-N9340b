// One N9340B on USB, in its own process: through winusb.dll when WinUSB is
// bound to it, or through VISA when Keysight's driver is.
//
// Both libraries block until their timeout, and a sweep read waits as long as
// the sweep. If a call wedges (a cable pulled mid-transfer, a confused
// firmware), only this process is stuck: driver/usbtmc.js kills it and the
// plugin stays up. See docs/native-runtimes.md.
//
// JSON lines over stdio, one request at a time, answered in order.
//
// WinUSB, USBTMC framing done by the caller:
//   {"id":1,"op":"open","path":"\\\\?\\usb#vid_0957&pid_ffef#..."}
//   {"id":2,"op":"bulkOut","data":"<base64>","timeoutMs":5000}
//   {"id":3,"op":"bulkIn","length":65548,"timeoutMs":5000}        -> {"data":"<base64>"}
//   {"id":4,"op":"control","requestType":161,"request":5,"value":0,"index":0,"length":1,"timeoutMs":5000}
//   {"id":5,"op":"resetPipe","which":"out"}
//
// VISA, whole messages:
//   {"id":1,"op":"visaOpen","serial":"CN03481015"}                 -> {"resource":"USB0::..."}
//   {"id":2,"op":"visaWrite","data":"<base64>","timeoutMs":5000}
//   {"id":3,"op":"visaRead","maxBytes":4194304,"timeoutMs":5000}  -> {"data":"<base64>"}
//   {"id":4,"op":"visaClear","timeoutMs":5000}
//
// Either:
//   {"id":6,"op":"close"}
//   {"id":7,"op":"list"}     the SetupAPI view of every N9340B, with its driver
//
// Each answer is {"id":n,"ok":true,"result":...} or
// {"id":n,"ok":false,"code":"TIMEOUT|STALL|NO_DEVICE|IO","message":"..."}.
// stdin closing (the plugin went away) closes the device and exits.

import { createInterface } from 'node:readline';
import { listWinusbUnits, openWinusbDevice } from './winusb.js';

let device = null;

const fail = (message) => Object.assign(new Error(message), { code: 'IO' });

const ops = {
  list: () => listWinusbUnits(),

  open({ path }) {
    if (device) throw fail('already open');
    device = openWinusbDevice(path);
    return {
      interfaceNumber: device.interfaceNumber,
      interfaceClass: device.interfaceClass,
      pipes: device.pipes,
    };
  },
  bulkOut({ data, timeoutMs }) {
    return need('bulkOut').bulkOut(Buffer.from(data, 'base64'), timeoutMs);
  },
  bulkIn({ length, timeoutMs }) {
    return { data: need('bulkIn').bulkIn(length, timeoutMs).toString('base64') };
  },
  control({ requestType, request, value, index, length, timeoutMs }) {
    const buf = need('control').control({ requestType, request, value, index, length }, timeoutMs);
    return { data: buf.toString('base64') };
  },
  resetPipe({ which }) {
    need('resetPipe').resetPipe(which);
    return null;
  },

  async visaOpen({ serial }) {
    if (device) throw fail('already open');
    // loaded only here: a PC without VISA never touches it
    const { openVisaDevice } = await import('./visa.js');
    device = openVisaDevice(serial);
    return { resource: device.resource };
  },
  visaWrite({ data, timeoutMs }) {
    return need('write').write(Buffer.from(data, 'base64'), timeoutMs);
  },
  visaRead({ maxBytes, timeoutMs }) {
    return { data: need('read').read(maxBytes, timeoutMs).toString('base64') };
  },
  visaClear({ timeoutMs }) {
    need('clear').clear(timeoutMs);
    return null;
  },

  close() {
    device?.close();
    device = null;
    return null;
  },
};

/** The open device, if it is the kind that has this call. */
function need(method) {
  if (!device) throw fail('not open');
  if (typeof device[method] !== 'function') throw fail(`${method} is not available on this route`);
  return device;
}

const answer = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

// one at a time, in order; the calls themselves are synchronous
let queue = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    answer({ id: null, ok: false, code: 'IO', message: 'not JSON' });
    return;
  }
  queue = queue.then(async () => {
    const op = ops[request.op];
    try {
      if (!op) throw fail(`unknown op ${request.op}`);
      answer({ id: request.id, ok: true, result: (await op(request)) ?? null });
    } catch (err) {
      answer({ id: request.id, ok: false, code: err.code ?? 'IO', message: err.message });
    }
  });
});
lines.on('close', () => {
  queue.finally(() => {
    try {
      device?.close();
    } finally {
      process.exit(0);
    }
  });
});
