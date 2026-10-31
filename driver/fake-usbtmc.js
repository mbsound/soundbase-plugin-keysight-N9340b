// A fake N9340B on USB: a USBTMC backend for driver/usbtmc.js, in memory.
//
// It is the device side of the protocol, strict where the real unit is:
// headers are checked (bTag, ~bTag, MsgID), payloads must be padded to 4,
// a reply needs a REQUEST_DEV_DEP_MSG_IN first and goes out in pieces no
// bigger than that request asked for, and nothing moves while a sweep is in
// progress. Behind the interface is the same instrument as the VXI-11 fake
// (fake-n9340b.js), so both transports are tested against one SCPI engine.
//
//   const usb = createFakeUsbBackend();
//   setUsbBackend(usb.backend);
//   usb.state       // the instrument, as with startFakeN9340B()
//   usb.unplug()    // the cable came out
//   usb.plug()      // and went back in

import { createInstrumentState, receive, clearIo, waitUntilIdle } from './fake-n9340b.js';
import { UsbError } from './usbtmc.js';

const HEADER_BYTES = 12;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createFakeUsbBackend({
  serial = 'CN00000001',
  attached = true,
  ...instrument
} = {}) {
  const state = createInstrumentState({
    identity: `Keysight Technologies,N9340B,${serial},A.02.07`,
    ...instrument,
  });
  const usb = {
    attached,
    openPipes: new Set(),
    /** the framing errors a real unit would have rejected; tests assert it stays empty */
    protocolErrors: [],
    /** the outstanding REQUEST_DEV_DEP_MSG_IN, as { tag, max }, or null */
    request: null,
    transfersIn: 0,
  };

  const backend = {
    async list() {
      // the model is the product string the device reports over USB
      return usb.attached ? [{ serial, model: state.identity.split(',')[1] ?? null }] : [];
    },
    async open(want) {
      if (!usb.attached || want !== serial) {
        throw new UsbError('NO_DEVICE', `no N9340B with serial ${want} on USB`);
      }
      if (usb.openPipes.size) {
        // WinUSB: one handle per device
        throw new UsbError('IO', 'the device is already open');
      }
      const pipe = createPipe(state, usb);
      usb.openPipes.add(pipe);
      return pipe;
    },
  };

  return {
    backend,
    state,
    usb,
    unplug() {
      usb.attached = false;
      for (const pipe of usb.openPipes) {
        pipe.dead = true;
        pipe.onDetach?.(new UsbError('NO_DEVICE', 'the USB cable was unplugged'));
      }
      usb.openPipes.clear();
    },
    plug() {
      usb.attached = true;
    },
  };
}

function createPipe(state, usb) {
  const alive = () => {
    if (pipe.dead) throw new UsbError('NO_DEVICE', 'the device is gone');
  };
  const protocol = (message) => {
    usb.protocolErrors.push(message);
    throw new UsbError('STALL', message);
  };

  const pipe = {
    dead: false,
    onDetach: null,

    async bulkOut(buffer, timeoutMs) {
      alive();
      // a sweeping unit NAKs bulk OUT until it is done
      if (!(await waitUntilIdle(state, timeoutMs))) {
        throw new UsbError('TIMEOUT', 'bulk OUT timed out');
      }
      alive();
      if (buffer.length < HEADER_BYTES) protocol(`short bulk OUT (${buffer.length} bytes)`);
      if (buffer.length % 4) protocol(`bulk OUT of ${buffer.length} bytes is not padded to 4`);
      const [msgId, tag, inverse] = buffer;
      if (tag === 0 || inverse !== (~tag & 0xff)) protocol(`bad bTag ${tag}/${inverse}`);
      const size = buffer.readUInt32LE(4);
      if (msgId === 1) {
        if (size > buffer.length - HEADER_BYTES) protocol(`message claims ${size} bytes`);
        if (!(buffer[8] & 0x01)) protocol('a command without EOM');
        receive(state, buffer.subarray(HEADER_BYTES, HEADER_BYTES + size).toString('latin1'));
      } else if (msgId === 2) {
        if (size === 0) protocol('REQUEST_DEV_DEP_MSG_IN for 0 bytes');
        usb.request = { tag, max: size };
      } else {
        protocol(`unknown MsgID ${msgId}`);
      }
    },

    async bulkIn(length, timeoutMs) {
      alive();
      const deadline = Date.now() + timeoutMs;
      const idle = await waitUntilIdle(state, timeoutMs);
      while (idle && !state.io.output.length && Date.now() < deadline) {
        await sleep(5);
        alive();
      }
      alive();
      if (!idle || !state.io.output.length || !usb.request) {
        if (!usb.request) usb.protocolErrors.push('bulk IN with no request outstanding');
        state.errors.push('-420,"[R]Query UNTERMINATED"');
        throw new UsbError('TIMEOUT', 'bulk IN timed out');
      }
      const { tag, max } = usb.request;
      usb.request = null;
      const pending = Buffer.from(state.io.output[0], 'latin1');
      const chunk = pending.subarray(0, Math.min(max, length - HEADER_BYTES));
      const end = chunk.length === pending.length;
      if (end) state.io.output.shift();
      else state.io.output[0] = pending.subarray(chunk.length).toString('latin1');
      const header = Buffer.alloc(HEADER_BYTES);
      header[0] = 2;
      header[1] = tag;
      header[2] = ~tag & 0xff;
      header.writeUInt32LE(chunk.length, 4);
      header[8] = end ? 0x01 : 0x00;
      usb.transfersIn += 1;
      return Buffer.concat([header, chunk, Buffer.alloc((4 - (chunk.length % 4)) % 4)]);
    },

    async classRequestIn(bRequest, wValue, length) {
      alive();
      if (bRequest === 5) {
        // INITIATE_CLEAR: does not abort a sweep, as on the real unit
        clearIo(state);
        usb.request = null;
        return Buffer.from([0x01]).subarray(0, length);
      }
      if (bRequest === 6) return Buffer.from([0x01, 0x00]).subarray(0, length);
      protocol(`unexpected class request ${bRequest}`);
    },

    async clearHalt() {
      alive();
    },

    async close() {
      pipe.dead = true;
      usb.openPipes.delete(pipe);
    },
  };
  return pipe;
}
