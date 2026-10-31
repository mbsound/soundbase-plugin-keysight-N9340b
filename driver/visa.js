// The system VISA library through koffi, for an N9340B on Keysight's driver.
//
// Keysight IO Libraries Suite binds its own USBTMC driver (service Usbtmc) to
// the analyzer. That driver has no public interface of its own; VISA is the
// way in, and it is always installed alongside it. Through VISA the unit
// answers *IDN? and returns a full REAL trace (checked on an x64 PC with
// IO Libraries 21.4, 2026-10-31), so a user who has IO Libraries needs no
// driver change at all.
//
// The resource is found by serial with viFindRsrc, not assumed to be USB0.
// Calls block for up to the session timeout, so this runs in
// driver/usb-worker.js, never in the plugin process.
//
// Windows only. Importing this file where visa64.dll is missing throws;
// callers catch that.

import koffi from 'koffi';

const visa = koffi.load(koffi.sizeof('void *') === 8 ? 'visa64.dll' : 'visa32.dll');

const viOpenDefaultRM = visa.func('int32_t viOpenDefaultRM(_Out_ uint32_t *rm)');
const viFindRsrc = visa.func(
  'int32_t viFindRsrc(uint32_t rm, const char *expr, _Out_ uint32_t *list, _Out_ uint32_t *count, _Inout_ uint8_t *desc)'
);
const viOpen = visa.func(
  'int32_t viOpen(uint32_t rm, const char *resource, uint32_t mode, uint32_t timeout, _Out_ uint32_t *vi)'
);
const viSetAttribute = visa.func('int32_t viSetAttribute(uint32_t vi, uint32_t attribute, uintptr_t value)');
const viWrite = visa.func(
  'int32_t viWrite(uint32_t vi, uint8_t *buffer, uint32_t count, _Out_ uint32_t *written)'
);
const viRead = visa.func(
  'int32_t viRead(uint32_t vi, _Inout_ uint8_t *buffer, uint32_t count, _Out_ uint32_t *read)'
);
const viClear = visa.func('int32_t viClear(uint32_t vi)');
const viClose = visa.func('int32_t viClose(uint32_t object)');
const viStatusDesc = visa.func(
  'int32_t viStatusDesc(uint32_t object, int32_t status, _Inout_ uint8_t *desc)'
);

const VI_ATTR_TMO_VALUE = 0x3fff001a;
const VI_ATTR_TERMCHAR_EN = 0x3fff0038;
const VI_SUCCESS_MAX_CNT = 0x3fff0006; // the buffer filled before END
// VISA lets any number of sessions talk to one instrument at once, and
// interleaved USBTMC exchanges leave Keysight's driver answering every read
// with VI_ERROR_IO until the analyzer is re-plugged. IO Libraries' own
// discovery services open new instruments by themselves, so hold the
// instrument exclusively for as long as the plugin has it open.
const VI_EXCLUSIVE_LOCK = 1;
const VI_ERROR_RSRC_LOCKED = 0xbfff000f;

/** VISA status codes as driver/usbtmc.js classifies failures. */
export function classifyVisa(status) {
  switch (status >>> 0) {
    case 0xbfff0015: // VI_ERROR_TMO
      return 'TIMEOUT';
    case 0xbfff00a6: // VI_ERROR_CONN_LOST
    case 0xbfff0011: // VI_ERROR_RSRC_NFOUND
    case 0xbfff000e: // VI_ERROR_INV_OBJECT
      return 'NO_DEVICE';
    default:
      return 'IO';
  }
}

export class VisaError extends Error {
  constructor(what, status, session = 0) {
    const desc = Buffer.alloc(256);
    viStatusDesc(session, status, desc);
    const text = desc.toString('latin1', 0, Math.max(0, desc.indexOf(0)));
    super(`${what}: ${text || `VISA status 0x${(status >>> 0).toString(16)}`}`);
    this.status = status;
    this.code = classifyVisa(status);
  }
}

const check = (what, status, session) => {
  if (status < 0) throw new VisaError(what, status, session);
  return status;
};

/**
 * Open the N9340B with this serial through VISA. Blocking: for the worker only.
 * Returns { resource, write, read, clear, close }.
 */
export function openVisaDevice(serial) {
  const rmOut = [0];
  check('viOpenDefaultRM', viOpenDefaultRM(rmOut));
  const rm = rmOut[0];
  let vi = 0;
  try {
    const list = [0];
    const count = [0];
    const desc = Buffer.alloc(256);
    const found = viFindRsrc(rm, `USB?*::0x0957::0xFFEF::${serial}::?*INSTR`, list, count, desc);
    if (found < 0) {
      throw Object.assign(new VisaError(`no VISA resource for the N9340B ${serial}`, found, rm), {
        code: 'NO_DEVICE',
      });
    }
    viClose(list[0]);
    const resource = desc.toString('latin1', 0, desc.indexOf(0));

    const viOut = [0];
    const opened = viOpen(rm, resource, VI_EXCLUSIVE_LOCK, 0, viOut);
    if (opened >>> 0 === VI_ERROR_RSRC_LOCKED) {
      throw Object.assign(new Error('another program has the analyzer open over USB'), {
        code: 'IO',
      });
    }
    check(`viOpen ${resource}`, opened, rm);
    vi = viOut[0];
    // binary traces: a 0x0a inside the floats must not end a read
    check('viSetAttribute', viSetAttribute(vi, VI_ATTR_TERMCHAR_EN, 0), vi);

    let timeout = -1;
    const setTimeout = (ms) => {
      const value = Math.max(1, Math.round(ms));
      if (value === timeout) return;
      check('viSetAttribute', viSetAttribute(vi, VI_ATTR_TMO_VALUE, value), vi);
      timeout = value;
    };

    let closed = false;
    return {
      resource,

      write(buffer, timeoutMs) {
        setTimeout(timeoutMs);
        const written = [0];
        check('viWrite', viWrite(vi, buffer, buffer.length, written), vi);
        return written[0];
      },

      /** One whole message: reads until END (EOM), at most maxBytes. */
      read(maxBytes, timeoutMs) {
        setTimeout(timeoutMs);
        const parts = [];
        let total = 0;
        for (;;) {
          const want = Math.min(64 * 1024, maxBytes - total);
          const buf = Buffer.alloc(want);
          const got = [0];
          const status = check('viRead', viRead(vi, buf, want, got), vi);
          parts.push(buf.subarray(0, got[0]));
          total += got[0];
          if (status !== VI_SUCCESS_MAX_CNT || total >= maxBytes) break;
        }
        return Buffer.concat(parts);
      },

      /** Device clear (USBTMC INITIATE_CLEAR underneath). */
      clear(timeoutMs) {
        setTimeout(timeoutMs);
        check('viClear', viClear(vi), vi);
      },

      close() {
        if (closed) return;
        closed = true;
        viClose(vi);
        viClose(rm);
      },
    };
  } catch (err) {
    if (vi) viClose(vi);
    viClose(rm);
    throw err;
  }
}
