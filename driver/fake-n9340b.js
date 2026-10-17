// A fake N9340B: a VXI-11 core-channel server speaking the SCPI subset the
// driver uses, so the tests run with nothing on the bench.
//
// It mimics the real unit's habits where they matter to the adapter: 461
// points, RBW snapping to the 1-3-10 ladder, an attenuator that clamps at
// 51 dB, a sweep time coupled to span and RBW, an instrument that answers
// nothing while it sweeps, a reply that never comes for a command it does not
// know, and an error queue. It also implements the RPC side of VXI-11, which
// means the driver's XDR encoding is exercised end to end.
//
// There is no port mapper here (binding port 111 needs root), so tests hand
// the core port straight to the driver.

import net from 'node:net';
import { POINT_COUNT, RBW_HZ, snapToLadder } from './n9340b.js';

const DEVICE_CORE_PROG = 395183;
const CREATE_LINK = 10;
const DEVICE_WRITE = 11;
const DEVICE_READ = 12;
const DEVICE_CLEAR = 15;
const DESTROY_LINK = 23;
const REASON_END = 4;
const ERR_IO_TIMEOUT = 15;

const VBW_HZ = [...RBW_HZ, 3_000_000];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export async function startFakeN9340B({
  port = 0,
  sweepDelayMs = 20,
  identity = 'Keysight Technologies,N9340B,CN00000001,A.02.07',
} = {}) {
  const state = {
    identity,
    mode: 'SA',
    measurement: 'OFF',
    continuous: true,
    startHz: 0,
    stopHz: 3_000_000_000,
    rbwHz: 1_000_000,
    rbwAuto: true,
    vbwHz: 3_000_000,
    vbwAuto: true,
    refLevelDbm: -20,
    attenDb: 20,
    attenAuto: true,
    preamp: false,
    sweepMode: 'NORM',
    sweepTimeAuto: true,
    format: 'ASC',
    traceMode: 'WRIT',
    sweepDelayMs,
    sweepCount: 0,
    busyUntil: 0,
    errors: [],
    /** the instrument's one input/output queue, shared by every link */
    io: { input: '', output: [] },
    /** amplitudes for the next trace; replace to shape the spectrum */
    trace: (i) =>
      -100 + Math.sin(i / 7) * 2 + (i === Math.floor(POINT_COUNT / 2) ? 60 : 0),
    commandLog: [],
  };

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const session = state.io;
    let buffered = Buffer.alloc(0);
    let fragments = [];
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < 4) return;
        const header = buffered.readUInt32BE(0);
        const length = header & 0x7fffffff;
        if (buffered.length < 4 + length) return;
        fragments.push(buffered.subarray(4, 4 + length));
        buffered = buffered.subarray(4 + length);
        if (header & 0x80000000) {
          const message = Buffer.concat(fragments);
          fragments = [];
          handleCall(message, session, state, socket).catch(() => {});
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    state,
    /** kill every connection without closing the listener: the cable came out */
    dropConnections() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// --- RPC plumbing -----------------------------------------------------------

function readCall(message) {
  let o = 0;
  const u32 = () => {
    const v = message.readUInt32BE(o);
    o += 4;
    return v;
  };
  const opaque = () => {
    const len = u32();
    const v = message.subarray(o, o + len);
    o += len + ((4 - (len % 4)) % 4);
    return v;
  };
  const xid = u32();
  const msgType = u32();
  const rpcVersion = u32();
  const program = u32();
  const version = u32();
  const procedure = u32();
  u32();
  opaque(); // cred
  u32();
  opaque(); // verf
  return {
    xid,
    msgType,
    rpcVersion,
    program,
    version,
    procedure,
    args: message.subarray(o),
    u32,
    opaque,
    i32: () => {
      const v = message.readInt32BE(o);
      o += 4;
      return v;
    },
  };
}

function reply(socket, xid, acceptStat, results = Buffer.alloc(0)) {
  const head = Buffer.alloc(24);
  head.writeUInt32BE(xid, 0);
  head.writeUInt32BE(1, 4); // REPLY
  head.writeUInt32BE(0, 8); // MSG_ACCEPTED
  head.writeUInt32BE(0, 12); // verf flavor
  head.writeUInt32BE(0, 16); // verf length
  head.writeUInt32BE(acceptStat, 20);
  const body = Buffer.concat([head, results]);
  const marker = Buffer.alloc(4);
  marker.writeUInt32BE((0x80000000 | body.length) >>> 0, 0);
  if (!socket.destroyed) socket.write(Buffer.concat([marker, body]));
}

const ints = (...values) => {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeInt32BE(v | 0, i * 4));
  return b;
};

const opaque = (buf) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  const pad = Buffer.alloc((4 - (buf.length % 4)) % 4);
  return Buffer.concat([len, buf, pad]);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handleCall(message, session, state, socket) {
  const call = readCall(message);
  if (call.msgType !== 0 || call.program !== DEVICE_CORE_PROG) {
    reply(socket, call.xid, 1); // PROG_UNAVAIL
    return;
  }
  switch (call.procedure) {
    case CREATE_LINK: {
      // error, lid, abortPort, maxRecvSize
      reply(socket, call.xid, 0, ints(0, 1, 0, 4096));
      return;
    }
    case DEVICE_WRITE: {
      call.i32(); // lid
      const ioTimeout = call.u32();
      call.u32(); // lock timeout
      call.u32(); // flags
      const data = call.opaque();
      await waitUntilIdle(state, ioTimeout);
      session.input += data.toString('latin1');
      let index;
      while ((index = session.input.indexOf('\n')) >= 0) {
        const line = session.input.slice(0, index);
        session.input = session.input.slice(index + 1);
        const replies = [];
        for (const command of line.split(';')) {
          const out = execute(command.trim(), state);
          if (out !== undefined) replies.push(out);
        }
        if (replies.length) session.output.push(`${replies.join(';')}\n`);
      }
      reply(socket, call.xid, 0, ints(0, data.length));
      return;
    }
    case DEVICE_READ: {
      call.i32(); // lid
      const requestSize = call.u32();
      const ioTimeout = call.u32();
      const deadline = Date.now() + ioTimeout;
      // a sweep in progress: the real unit says nothing until it is done, and
      // if that is longer than the caller's I/O timeout the read simply fails
      const idle = await waitUntilIdle(state, ioTimeout);
      while (idle && !session.output.length && Date.now() < deadline) {
        // a link whose socket died must not take the next link's reply
        if (socket.destroyed) return;
        await sleep(5);
      }
      if (socket.destroyed) return;
      if (!idle || !session.output.length) {
        state.errors.push('-420,"[R]Query UNTERMINATED"');
        reply(socket, call.xid, 0, ints(ERR_IO_TIMEOUT, 0, 0));
        return;
      }
      const pending = Buffer.from(session.output[0], 'latin1');
      const chunk = pending.subarray(0, requestSize);
      if (chunk.length === pending.length) session.output.shift();
      else session.output[0] = pending.subarray(chunk.length).toString('latin1');
      const reason = chunk.length === pending.length ? REASON_END : 0;
      reply(
        socket,
        call.xid,
        0,
        Buffer.concat([ints(0, reason), opaque(chunk)])
      );
      return;
    }
    case DEVICE_CLEAR: {
      session.input = '';
      session.output = [];
      reply(socket, call.xid, 0, ints(0));
      return;
    }
    case DESTROY_LINK: {
      reply(socket, call.xid, 0, ints(0));
      return;
    }
    default:
      reply(socket, call.xid, 3); // PROC_UNAVAIL
  }
}

/** The real unit answers nothing at all while it sweeps. True once idle. */
async function waitUntilIdle(state, ioTimeout) {
  const remaining = state.busyUntil - Date.now();
  if (remaining <= 0) return true;
  await sleep(Math.min(remaining, ioTimeout));
  return state.busyUntil <= Date.now();
}

// --- SCPI -------------------------------------------------------------------

function sweepTimeSeconds(state) {
  const span = Math.max(1, state.stopHz - state.startHz);
  const normal = clamp((span / state.rbwHz) * 0.0004, 0.03, 4000);
  return state.sweepMode === 'FAST' ? normal / 15 : normal;
}

function sci(n) {
  return n.toExponential(9).replace(/e([+-])(\d)$/, 'E$10$2').replace('e', 'E');
}

function number(arg) {
  const m = /^\s*([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*([a-zA-Z]*)\s*$/.exec(arg ?? '');
  if (!m) return NaN;
  const scale = { HZ: 1, KHZ: 1e3, MHZ: 1e6, GHZ: 1e9, DBM: 1, DB: 1, S: 1, MS: 1e-3 }[
    m[2].toUpperCase()
  ];
  return Number(m[1]) * (scale ?? 1);
}

const onOff = (arg) => /^(1|ON)$/i.test((arg ?? '').trim());

/** Run one command; return the reply string for a query, undefined otherwise. */
function execute(raw, state) {
  if (!raw) return undefined;
  state.commandLog.push(raw);
  const space = raw.search(/\s/);
  const head = (space < 0 ? raw : raw.slice(0, space)).toUpperCase().replace(/^:/, '');
  const arg = space < 0 ? '' : raw.slice(space + 1).trim();
  const isQuery = head.endsWith('?');
  const key = isQuery ? head.slice(0, -1) : head;

  switch (key) {
    case '*IDN':
      return state.identity;
    case '*CLS':
      state.errors = [];
      return undefined;
    case '*OPC':
      return isQuery ? '1' : undefined;
    case 'SYST:ERR':
      return state.errors.shift() ?? '+0,"No error"';
    case 'INST:SEL':
      if (isQuery) return state.mode;
      state.mode = arg.toUpperCase();
      return undefined;
    case 'INST:MEAS':
      if (isQuery) return state.measurement;
      state.measurement = arg.toUpperCase();
      return undefined;
    case 'INIT:CONT':
      if (isQuery) return state.continuous ? '1' : '0';
      state.continuous = onOff(arg);
      return undefined;
    case 'INIT:IMM':
      state.sweepCount += 1;
      state.busyUntil = Date.now() + state.sweepDelayMs;
      return undefined;
    case 'SENS:FREQ:STAR':
      if (isQuery) return sci(state.startHz);
      state.startHz = clamp(number(arg), -80e6, 3.08e9);
      if (state.stopHz - state.startHz < 1000) state.stopHz = state.startHz + 1000;
      return undefined;
    case 'SENS:FREQ:STOP':
      if (isQuery) return sci(state.stopHz);
      state.stopHz = clamp(number(arg), -80e6, 3.05e9);
      if (state.stopHz - state.startHz < 1000) state.stopHz = state.startHz + 1000;
      return undefined;
    case 'SENS:BAND:RES':
      if (isQuery) return sci(state.rbwHz);
      {
        const want = number(arg);
        if (want < RBW_HZ[0] || want > RBW_HZ[RBW_HZ.length - 1]) {
          state.errors.push('-222,"[R]Data out of range"');
        } else {
          state.rbwHz = snapToLadder(want, RBW_HZ);
          state.rbwAuto = false;
        }
      }
      return undefined;
    case 'SENS:BAND:RES:AUTO':
      if (isQuery) return state.rbwAuto ? '1' : '0';
      state.rbwAuto = onOff(arg);
      if (state.rbwAuto) state.rbwHz = snapToLadder((state.stopHz - state.startHz) / 150, RBW_HZ);
      return undefined;
    case 'SENS:BAND:VID':
      if (isQuery) return sci(state.vbwHz);
      state.vbwHz = snapToLadder(number(arg), VBW_HZ);
      state.vbwAuto = false;
      return undefined;
    case 'SENS:BAND:VID:AUTO':
      if (isQuery) return state.vbwAuto ? '1' : '0';
      state.vbwAuto = onOff(arg);
      if (state.vbwAuto) state.vbwHz = Math.min(3_000_000, state.rbwHz * 3);
      return undefined;
    case 'DISP:WIND:TRAC:Y:RLEV':
      if (isQuery) return sci(state.refLevelDbm);
      state.refLevelDbm = clamp(Math.round(number(arg)), -120, 30);
      return undefined;
    case 'DISP:WIND:TRAC:Y:SPAC':
    case 'UNIT:POW':
    case 'TRAC1:MODE':
    case 'SENS:AVER:TRAC1':
    case 'SENS:SWE:TIME:AUTO':
      return isQuery ? '1' : undefined;
    case 'SENS:POW:ATT':
      if (isQuery) return String(state.attenDb);
      {
        const want = Math.round(number(arg));
        if (want < 0 || want > 51) state.errors.push('-222,"[R]Data out of range"');
        state.attenDb = clamp(want, 0, 51);
        state.attenAuto = false;
      }
      return undefined;
    case 'SENS:POW:ATT:AUTO':
      if (isQuery) return state.attenAuto ? '1' : '0';
      state.attenAuto = onOff(arg);
      if (state.attenAuto) state.attenDb = 10;
      return undefined;
    case 'SENS:POW:GAIN':
      if (isQuery) return state.preamp ? '1' : '0';
      state.preamp = onOff(arg);
      return undefined;
    case 'SENS:SWE:TIME:AUTO:MODE':
      if (isQuery) return state.sweepMode;
      state.sweepMode = arg.toUpperCase().startsWith('FAST') ? 'FAST' : 'NORM';
      return undefined;
    case 'SENS:SWE:TIME':
      if (isQuery) return sci(sweepTimeSeconds(state));
      return undefined;
    case 'TRAC:FORM':
      if (isQuery) return state.format;
      state.format = arg.toUpperCase().startsWith('REAL') ? 'REAL' : 'ASC';
      return undefined;
    case 'TRAC1:DATA':
    case 'TRAC1': {
      if (!isQuery) return undefined;
      const values = Array.from({ length: POINT_COUNT }, (_, i) => state.trace(i));
      if (state.format === 'REAL') {
        const buf = Buffer.alloc(POINT_COUNT * 4);
        values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
        return buf.toString('latin1');
      }
      return values.map(sci).join(',');
    }
    default:
      // the real unit: an unknown header is an error and a query gets no reply
      state.errors.push(`-113,"[R]Undefined header;${raw}"`);
      return undefined;
  }
}
