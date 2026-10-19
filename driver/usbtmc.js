// A minimal USBTMC (USB488) client for the N9340B's USB port, through libusb.
//
// The same surface as Vxi11Client — connect, write, read, query, clear,
// close, onFatal — so driver/n9340b.js runs over either without knowing which.
//
// Windows only, with the WinUSB driver bound to the analyzer (Zadig does it).
// The N9340B's configuration descriptor declares bConfigurationValue 0 and the
// unit rejects SET_CONFIGURATION(1), so macOS never creates an interface for
// it and nothing can open it there. Firmware A.02.07 is the last release.
//
// USBTMC in one paragraph: every bulk transfer starts with a 12-byte header
// (MsgID, bTag, ~bTag, transfer size LE, attributes). A command is one
// DEV_DEP_MSG_OUT (MsgID 1) with the EOM bit set. A reply is asked for with
// REQUEST_DEV_DEP_MSG_IN (MsgID 2) on bulk OUT and arrives as a
// DEV_DEP_MSG_IN on bulk IN; repeat until a header carries EOM. Payloads are
// padded to a multiple of 4. INITIATE_CLEAR (class request 5) is the device
// clear. Like the LAN side, the instrument answers nothing while it sweeps.

export const VENDOR_ID = 0x0957;
export const PRODUCT_ID = 0xffef;

/** Where the libusb backend is tried at all. Elsewhere USB reports no units. */
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
/** Asked for per REQUEST_DEV_DEP_MSG_IN; a REAL trace is 1845 bytes. */
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
// touches:
//
//   bulkOut(buffer, timeoutMs)                       -> Promise<void>
//   bulkIn(length, timeoutMs)                        -> Promise<Buffer>
//   classRequestIn(bRequest, wValue, length, timeoutMs) -> Promise<Buffer>
//   clearHalt('out' | 'in')                          -> Promise<void>
//   close()                                          -> Promise<void>
//   onDetach                                         set by the client
//
// Tests swap in driver/fake-usbtmc.js with setUsbBackend(); production gets
// libusb.

let backend;

/** Replace the backend (tests). Returns the previous one; null disables USB. */
export function setUsbBackend(next) {
  const previous = backend;
  backend = next;
  return previous;
}

async function getBackend() {
  if (backend === undefined) backend = await loadLibusbBackend();
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

async function loadLibusbBackend() {
  if (!USB_PLATFORMS.includes(process.platform)) return null;
  let mod;
  try {
    mod = await import('usb');
  } catch {
    // optional dependency: missing on a machine it could not install on
    return null;
  }
  const usb = mod.usb ?? mod.default?.usb;
  return usb ? createLibusbBackend(usb) : null;
}

/** The real thing: node-usb 2.x (libusb, WinUSB underneath on Windows). */
export function createLibusbBackend(usb) {
  // reading the serial number means opening the device, which WinUSB only
  // lets one handle do; remember each one so discovery never reopens a unit
  // an adapter is holding
  const serials = new Map();
  const keyOf = (d) =>
    `${d.busNumber}:${(d.portNumbers ?? []).join('.')}:${d.deviceAddress}`;
  const candidates = () =>
    usb
      .getDeviceList()
      .filter(
        (d) =>
          d.deviceDescriptor.idVendor === VENDOR_ID &&
          d.deviceDescriptor.idProduct === PRODUCT_ID
      );

  const call = (fn) =>
    new Promise((resolve, reject) =>
      fn((err, value) => (err ? reject(classify(usb, err)) : resolve(value)))
    );

  async function serialOf(device) {
    const key = keyOf(device);
    if (serials.has(key)) return serials.get(key);
    const index = device.deviceDescriptor.iSerialNumber;
    if (!index) return null;
    device.open(false);
    try {
      const serial = await call((cb) => device.getStringDescriptor(index, cb));
      serials.set(key, serial);
      return serial;
    } finally {
      try {
        device.close();
      } catch {}
    }
  }

  return {
    async list() {
      const out = [];
      for (const device of candidates()) {
        try {
          const serial = await serialOf(device);
          if (serial) out.push({ serial });
        } catch {
          // no driver bound, or held by another program: not usable here
        }
      }
      // forget units that are gone, so a re-plug reads its serial afresh
      const present = new Set(candidates().map(keyOf));
      for (const key of serials.keys()) if (!present.has(key)) serials.delete(key);
      return out;
    },

    async open(serial) {
      let device = null;
      for (const d of candidates()) {
        if ((await serialOf(d).catch(() => null)) === serial) {
          device = d;
          break;
        }
      }
      if (!device) {
        throw new UsbError('NO_DEVICE', `no N9340B with serial ${serial} on USB`);
      }
      device.open();
      let iface;
      try {
        iface =
          device.interfaces?.find(
            (i) =>
              i.descriptor.bInterfaceClass === 0xfe &&
              i.descriptor.bInterfaceSubClass === 3
          ) ?? device.interface(0);
        iface.claim();
      } catch (err) {
        try {
          device.close();
        } catch {}
        throw classify(usb, err);
      }
      const bulk = (direction) =>
        iface.endpoints.find(
          (e) => e.direction === direction && e.transferType === usb.LIBUSB_TRANSFER_TYPE_BULK
        );
      const epOut = bulk('out');
      const epIn = bulk('in');
      if (!epOut || !epIn) {
        throw new UsbError('IO', 'the USBTMC interface has no bulk endpoints');
      }

      const pipe = {
        onDetach: null,
        bulkOut(buffer, timeoutMs) {
          epOut.timeout = timeoutMs;
          return call((cb) => epOut.transfer(buffer, cb)).then(() => {}, fail);
        },
        bulkIn(length, timeoutMs) {
          epIn.timeout = timeoutMs;
          return call((cb) => epIn.transfer(length, cb)).catch(fail);
        },
        classRequestIn(bRequest, wValue, length, timeoutMs) {
          device.timeout = timeoutMs;
          // class request, recipient interface, device-to-host
          return call((cb) =>
            device.controlTransfer(0xa1, bRequest, wValue, iface.interfaceNumber, length, cb)
          ).catch(fail);
        },
        clearHalt(which) {
          const ep = which === 'in' ? epIn : epOut;
          return call((cb) => ep.clearHalt(cb)).catch(fail);
        },
        async close() {
          usb.removeListener?.('detach', onDetach);
          await call((cb) => iface.release(true, cb)).catch(() => {});
          try {
            device.close();
          } catch {}
        },
      };
      // a cable pulled mid-transfer reports as NO_DEVICE on the next call;
      // the detach event covers a cable pulled while idle
      function fail(err) {
        if (err.code === 'NO_DEVICE') pipe.onDetach?.(err);
        throw err;
      }
      function onDetach(d) {
        if (d === device) {
          pipe.onDetach?.(new UsbError('NO_DEVICE', 'the USB cable was unplugged'));
        }
      }
      usb.on?.('detach', onDetach);
      return pipe;
    },
  };
}

/** node-usb errors carry libusb codes; transfers and control calls use different ones. */
function classify(usb, err) {
  if (err instanceof UsbError) return err;
  const n = err?.errno;
  const is = (...names) => names.some((name) => usb[name] !== undefined && usb[name] === n);
  let code = 'IO';
  if (is('LIBUSB_TRANSFER_TIMED_OUT', 'LIBUSB_ERROR_TIMEOUT')) code = 'TIMEOUT';
  else if (is('LIBUSB_TRANSFER_NO_DEVICE', 'LIBUSB_ERROR_NO_DEVICE')) code = 'NO_DEVICE';
  else if (is('LIBUSB_TRANSFER_STALL', 'LIBUSB_ERROR_PIPE')) code = 'STALL';
  return new UsbError(code, err?.message ?? String(err));
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
        `USB is not available on ${process.platform}-${process.arch}; connect the N9340B over LAN`
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
    if (!this.#pipe) throw new Error(`no USB link to the N9340B ${this.serial}`);
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
          err.code === 'TIMEOUT' ? 'the N9340B did not answer in time over USB' : err.message
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
