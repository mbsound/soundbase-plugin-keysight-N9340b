// A minimal USBTMC (USB488) client for the N9340B's USB port. Whichever
// driver Windows has bound to the unit decides the route: winusb.dll directly
// (driver/winusb.js), or the system VISA library for Keysight's own driver
// (driver/visa.js). Either way the calls run in a worker process
// (driver/usb-worker.js).
//
// The same surface as Vxi11Client — connect, write, read, query, clear,
// close, onFatal — so driver/n9340b.js runs over either without knowing which.
//
// Windows only, with the WinUSB driver bound to the analyzer. The N9340B's
// configuration descriptor declares bConfigurationValue 0 and the unit
// rejects SET_CONFIGURATION(1), so macOS never creates an interface for it
// and nothing can open it there; libusb skips it on every OS for the same
// reason. Windows' own USB stack does not mind. Firmware A.02.07 is the last
// release.
//
// USBTMC in one paragraph: every bulk transfer starts with a 12-byte header
// (MsgID, bTag, ~bTag, transfer size LE, attributes). A command is one
// DEV_DEP_MSG_OUT (MsgID 1) with the EOM bit set. A reply is asked for with
// REQUEST_DEV_DEP_MSG_IN (MsgID 2) on bulk OUT and arrives as a
// DEV_DEP_MSG_IN on bulk IN; repeat until a header carries EOM. Payloads are
// padded to a multiple of 4. INITIATE_CLEAR (class request 5) is the device
// clear. Like the LAN side, the instrument answers nothing while it sweeps.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const VENDOR_ID = 0x0957;
// any product id: every Keysight USBTMC instrument is offered, not only the N9340B

/** Where the WinUSB backend is tried at all. Elsewhere USB reports no units. */
export const USB_PLATFORMS = ['win32'];

export const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
export const DEFAULT_IO_TIMEOUT_MS = 5_000;

const DEV_DEP_MSG_OUT = 1;
const REQUEST_DEV_DEP_MSG_IN = 2;
const INITIATE_CLEAR = 5;
const CHECK_CLEAR_STATUS = 6;
const STATUS_SUCCESS = 0x01;
const STATUS_PENDING = 0x02;
const HEADER_BYTES = 12;
/** Asked for per REQUEST_DEV_DEP_MSG_IN; a REAL trace over USB is 1844 bytes. */
const DEFAULT_READ_CHUNK_BYTES = 64 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pad4 = (n) => (4 - (n % 4)) % 4;

/** A transfer failure, classified so the client can tell a stall from a dead cable. */
export class UsbError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'TIMEOUT' | 'NO_DEVICE' | 'STALL' | 'IO'
  }
}

// --- backends ----------------------------------------------------------------
//
// A backend finds units and opens a pipe to one. The pipe is all the client
// touches, and comes in two kinds.
//
// A USBTMC pipe (WinUSB, and the fake): the client does the framing.
//
//   bulkOut(buffer, timeoutMs)                       -> Promise<void>
//   bulkIn(length, timeoutMs)                        -> Promise<Buffer>
//   classRequestIn(bRequest, wValue, length, timeoutMs) -> Promise<Buffer>
//   clearHalt('out' | 'in')                          -> Promise<void>
//
// A message pipe (VISA, which frames USBTMC itself): `messages: true`, and
//
//   writeMessage(buffer, timeoutMs)                  -> Promise<void>
//   readMessage(maxBytes, timeoutMs)                 -> Promise<Buffer>, one whole message
//   clear(timeoutMs)                                 -> Promise<void>
//
// Both have close() -> Promise<void>, and onDetach, set by the client.
//
// Tests swap in driver/fake-usbtmc.js with setUsbBackend(); production gets
// createUsbBackend(), which picks a route per unit from the driver bound to it.

let backend;

/** Replace the backend (tests). Returns the previous one; null disables USB. */
export function setUsbBackend(next) {
  const previous = backend;
  backend = next;
  return previous;
}

async function getBackend() {
  if (backend === undefined) backend = await loadUsbBackend();
  return backend;
}

/** USB units present right now, as [{ serial }]. Never throws. */
export async function listUsbInstruments() {
  try {
    const b = await getBackend();
    return b ? await b.list() : [];
  } catch {
    return [];
  }
}

async function loadUsbBackend() {
  if (!USB_PLATFORMS.includes(process.platform)) return null;
  let mod;
  try {
    mod = await import('./winusb.js');
  } catch {
    // koffi missing or unloadable on this machine: USB is simply unavailable
    return null;
  }
  return createUsbBackend({ listUnits: mod.listWinusbUnits, visaInstalled: mod.visaInstalled });
}

const WORKER_PATH = fileURLToPath(new URL('./usb-worker.js', import.meta.url));

/**
 * Which way to reach a unit, from the driver Windows has bound to it:
 * 'winusb' (winusb.dll directly), 'visa' (Keysight's driver, through the
 * system VISA library), or null with the reason it cannot be used.
 */
export function routeFor(service, { visaInstalled = () => false } = {}) {
  if (/^winusb$/i.test(service ?? '')) return { route: 'winusb' };
  if (/usbtmc/i.test(service ?? '')) {
    return visaInstalled()
      ? { route: 'visa' }
      : { route: null, reason: `it is on the ${service} driver but no VISA library is installed` };
  }
  return {
    route: null,
    reason: service ? `it is on the ${service} driver` : 'it has no driver',
  };
}

/**
 * The real thing. Every device call runs in a worker process
 * (driver/usb-worker.js) that is killed if it stops answering.
 *
 *   listUnits()       -> [{ serial, service, path }], SetupAPI only (driver/winusb.js)
 *   visaInstalled()   -> whether units on Keysight's driver can be reached
 *   spawnWorker()     -> a child process speaking the worker's JSON lines (tests swap it)
 *   graceMs           how long past a call's own timeout before the worker counts as wedged
 *   presencePollMs    how often an open unit is looked for, to notice a cable pulled while idle
 */
export function createUsbBackend({
  listUnits,
  visaInstalled = () => false,
  spawnWorker = () =>
    spawn(process.execPath, [WORKER_PATH], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    }),
  graceMs = 3_000,
  presencePollMs = 1_000,
}) {
  const units = async () => listUnits();
  const route = (unit) => routeFor(unit.service, { visaInstalled });

  return {
    async list() {
      return (await units()).filter((u) => route(u).route).map(({ serial, model }) => ({ serial, model: model ?? null }));
    },

    async open(serial, { timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
      const unit = (await units()).find((u) => u.serial === serial);
      if (!unit) throw new UsbError('NO_DEVICE', `no Keysight instrument with serial ${serial} on USB`);
      const { route: way, reason } = route(unit);
      if (!way) {
        throw new UsbError(
          'IO',
          `the analyzer ${serial} cannot be used over USB: ${reason}. ` +
            'Bind WinUSB to it, or install Keysight IO Libraries Suite (see the README)'
        );
      }

      const worker = createWorkerLink(spawnWorker(), graceMs);
      let info;
      try {
        info =
          way === 'visa'
            ? await worker.call('visaOpen', { serial }, timeoutMs)
            : await worker.call('open', { path: unit.path }, timeoutMs);
      } catch (err) {
        worker.kill();
        throw err;
      }

      let closed = false;
      const call = (op, args, ms) => worker.call(op, { ...args, timeoutMs: ms }, ms).catch(fail);
      const bytes = (r) => Buffer.from(r.data, 'base64');

      const pipe =
        way === 'visa'
          ? {
              messages: true,
              route: 'visa',
              resource: info.resource,
              writeMessage: (buffer, ms) =>
                call('visaWrite', { data: buffer.toString('base64') }, ms).then(() => {}),
              readMessage: (maxBytes, ms) => call('visaRead', { maxBytes }, ms).then(bytes),
              clear: (ms) => call('visaClear', {}, ms).then(() => {}),
            }
          : {
              route: 'winusb',
              bulkOut: (buffer, ms) =>
                call('bulkOut', { data: buffer.toString('base64') }, ms).then(() => {}),
              bulkIn: (length, ms) => call('bulkIn', { length }, ms).then(bytes),
              // class request, recipient interface, device-to-host
              classRequestIn: (bRequest, wValue, length, ms) =>
                call(
                  'control',
                  {
                    requestType: 0xa1,
                    request: bRequest,
                    value: wValue,
                    index: info.interfaceNumber,
                    length,
                  },
                  ms
                ).then(bytes),
              clearHalt: (which) =>
                call('resetPipe', { which }, DEFAULT_IO_TIMEOUT_MS).then(() => {}),
            };
      pipe.onDetach = null;
      pipe.close = async () => {
        if (closed) return;
        closed = true;
        clearInterval(poll);
        await worker.call('close', {}, 1_000).catch(() => {});
        worker.end();
      };

      const detach = (err) => {
        if (closed) return;
        closed = true;
        clearInterval(poll);
        worker.kill();
        pipe.onDetach?.(err);
      };
      // a wedged or dead worker, or a cable pulled mid-transfer, is the end
      // of this link; the client reports it and the device reopens later
      function fail(err) {
        if (err.code === 'NO_DEVICE') detach(err);
        throw err;
      }
      worker.onExit = () => detach(new UsbError('NO_DEVICE', 'the USB worker stopped'));
      // a cable pulled while idle shows up as the unit leaving the bus
      const poll = setInterval(async () => {
        try {
          if (!(await units()).some((u) => u.serial === serial)) {
            detach(new UsbError('NO_DEVICE', 'the USB cable was unplugged'));
          }
        } catch {}
      }, presencePollMs);
      poll.unref?.();
      return pipe;
    },
  };
}

/** Request/answer over a worker's stdio, with a watchdog per call. */
function createWorkerLink(child, graceMs) {
  let nextId = 0;
  let dead = false;
  const pending = new Map();
  const link = { onExit: null };

  const failAll = (err) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    pending.clear();
  };

  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new UsbError(message.code ?? 'IO', message.message ?? 'USB worker error'));
  });
  child.on('exit', () => {
    const wasDead = dead;
    dead = true;
    failAll(new UsbError('NO_DEVICE', 'the USB worker stopped'));
    if (!wasDead) link.onExit?.();
  });
  child.on('error', (err) => {
    dead = true;
    failAll(new UsbError('IO', `could not start the USB worker: ${err.message}`));
  });
  child.stdin.on('error', () => {});

  link.call = (op, args, timeoutMs) =>
    new Promise((resolve, reject) => {
      if (dead) {
        reject(new UsbError('NO_DEVICE', 'the USB worker stopped'));
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        // the call's own pipe timeout has long passed: the worker is stuck
        pending.delete(id);
        reject(new UsbError('NO_DEVICE', 'the USB link stopped responding'));
        link.kill();
      }, timeoutMs + graceMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  link.kill = () => {
    if (dead) return;
    dead = true;
    failAll(new UsbError('NO_DEVICE', 'the USB worker stopped'));
    child.kill();
  };
  /** A close we asked for: let the worker exit on its own, kill it if it lingers. */
  link.end = () => {
    if (dead) return;
    dead = true;
    child.stdin.end();
    setTimeout(() => child.kill(), 2_000).unref?.();
  };
  return link;
}

// --- the client --------------------------------------------------------------

export class UsbtmcClient {
  #pipe = null;
  #tag = 0;
  #queue = Promise.resolve();

  constructor({
    serial,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    ioTimeoutMs = DEFAULT_IO_TIMEOUT_MS,
    readChunkBytes = DEFAULT_READ_CHUNK_BYTES,
  }) {
    this.serial = serial;
    this.connectTimeoutMs = connectTimeoutMs;
    this.ioTimeoutMs = ioTimeoutMs;
    this.readChunkBytes = readChunkBytes;
    /** how the instrument names this link in messages */
    this.label = `USB ${serial}`;
    /** on top of 1.5x the sweep time, before a sweep read gives up */
    this.sweepOverheadMs = 2_500;
    /** set by the owner; called when the transport dies unprompted */
    this.onFatal = null;
  }

  get connected() {
    return this.#pipe !== null;
  }

  async connect() {
    const b = await getBackend();
    if (!b) {
      throw new Error(
        `USB is not available on ${process.platform}-${process.arch}; connect the analyzer over LAN`
      );
    }
    const pipe = await b.open(this.serial, { timeoutMs: this.connectTimeoutMs });
    pipe.onDetach = (err) => {
      if (this.#pipe !== pipe) return;
      this.#pipe = null;
      this.onFatal?.(err);
    };
    this.#pipe = pipe;
  }

  #serial(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  #requirePipe() {
    if (!this.#pipe) throw new Error(`no USB link to the analyzer ${this.serial}`);
    return this.#pipe;
  }

  #nextTag() {
    this.#tag = (this.#tag % 255) + 1;
    return this.#tag;
  }

  #header(msgId, tag, size, attributes) {
    const h = Buffer.alloc(HEADER_BYTES);
    h[0] = msgId;
    h[1] = tag;
    h[2] = ~tag & 0xff;
    h.writeUInt32LE(size, 4);
    h[8] = attributes;
    return h;
  }

  /** Write one complete message (a newline is appended if missing). */
  write(text) {
    return this.#serial(() => this.#write(text));
  }

  async #write(text) {
    const pipe = this.#requirePipe();
    const data = Buffer.from(text.endsWith('\n') ? text : `${text}\n`, 'latin1');
    if (pipe.messages) {
      await this.#io(() => pipe.writeMessage(data, this.ioTimeoutMs));
      return;
    }
    const header = this.#header(DEV_DEP_MSG_OUT, this.#nextTag(), data.length, 0x01);
    await this.#io(() =>
      pipe.bulkOut(
        Buffer.concat([header, data, Buffer.alloc(pad4(data.length))]),
        this.ioTimeoutMs
      )
    );
  }

  /** Read one complete response (until a header carries EOM). */
  read({ maxBytes = 4 * 1024 * 1024, timeoutMs = this.ioTimeoutMs } = {}) {
    return this.#serial(() => this.#read({ maxBytes, timeoutMs }));
  }

  async #read({ maxBytes, timeoutMs }) {
    const pipe = this.#requirePipe();
    // as below, the wait for a sweep is this read's timeout
    if (pipe.messages) return this.#io(() => pipe.readMessage(maxBytes, timeoutMs));
    const parts = [];
    let total = 0;
    for (;;) {
      const want = Math.min(maxBytes - total, this.readChunkBytes);
      const tag = this.#nextTag();
      await this.#io(() =>
        pipe.bulkOut(this.#header(REQUEST_DEV_DEP_MSG_IN, tag, want, 0), this.ioTimeoutMs)
      );
      // the whole wait for a sweep happens here: the instrument holds the
      // reply until the sweep is done, so this timeout is the sweep timeout
      const b = await this.#io(() =>
        pipe.bulkIn(HEADER_BYTES + want + pad4(want), timeoutMs)
      );
      if (b.length < HEADER_BYTES || b[0] !== REQUEST_DEV_DEP_MSG_IN || b[1] !== tag || b[2] !== (~tag & 0xff)) {
        await this.#recover();
        throw new Error(
          `bad USBTMC reply header (${b.length} bytes, MsgID ${b[0]}, bTag ${b[1]} for ${tag})`
        );
      }
      const size = b.readUInt32LE(4);
      if (size > b.length - HEADER_BYTES) {
        await this.#recover();
        throw new Error(`USBTMC reply claims ${size} bytes but carries ${b.length - HEADER_BYTES}`);
      }
      parts.push(Buffer.from(b.subarray(HEADER_BYTES, HEADER_BYTES + size)));
      total += size;
      if (b[8] & 0x01) break;
      if (total >= maxBytes) break;
      if (size === 0) throw new Error('USBTMC reply was empty and not the end of the message');
    }
    return Buffer.concat(parts);
  }

  /**
   * A transfer that timed out leaves the instrument holding half a message
   * or an unanswered request. Clear it, so the next query is not answered
   * with this one's reply, then report the timeout.
   */
  async #io(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err?.code === 'TIMEOUT' || err?.code === 'STALL') {
        await this.#recover();
        throw new Error(
          err.code === 'TIMEOUT' ? 'the analyzer did not answer in time over USB' : err.message
        );
      }
      throw err;
    }
  }

  async #recover() {
    await this.#clear().catch(() => {});
  }

  /** Write a query and read its complete reply as a trimmed string. */
  query(text, options) {
    return this.#serial(async () => {
      await this.#write(text);
      const buf = await this.#read({
        maxBytes: options?.maxBytes ?? 4 * 1024 * 1024,
        timeoutMs: options?.timeoutMs ?? this.ioTimeoutMs,
      });
      return buf.toString('latin1').trim();
    });
  }

  /** INITIATE_CLEAR: flush the instrument's I/O buffers. */
  clear() {
    return this.#serial(() => this.#clear());
  }

  async #clear() {
    const pipe = this.#requirePipe();
    if (pipe.messages) {
      await pipe.clear(this.ioTimeoutMs);
      return;
    }
    const status = await pipe.classRequestIn(INITIATE_CLEAR, 0, 1, this.ioTimeoutMs);
    if (status[0] !== STATUS_SUCCESS) {
      throw new Error(`INITIATE_CLEAR answered status 0x${status[0].toString(16)}`);
    }
    const deadline = Date.now() + this.ioTimeoutMs;
    for (;;) {
      const check = await pipe.classRequestIn(CHECK_CLEAR_STATUS, 0, 2, this.ioTimeoutMs);
      if (check[0] !== STATUS_PENDING) break;
      if (Date.now() > deadline) throw new Error('device clear did not complete');
      // bmClear bit 0: the device wants its bulk IN FIFO read out
      if (check[1] & 0x01) await pipe.bulkIn(512, 100).catch(() => {});
      await sleep(20);
    }
    // the spec ends a clear with CLEAR_FEATURE(ENDPOINT_HALT) on bulk OUT
    await pipe.clearHalt('out');
  }

  /** Release the interface and close the device. Never throws. */
  async close() {
    const pipe = this.#pipe;
    this.onFatal = null; // a close we asked for is not a fatal error
    this.#pipe = null;
    if (pipe) await pipe.close().catch(() => {});
  }
}
