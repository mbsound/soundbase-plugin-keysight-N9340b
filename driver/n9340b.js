// The Keysight (Agilent) N9340B handheld spectrum analyzer, over VXI-11.
//
// This file knows the instrument's SCPI dialect and its quirks; it knows
// nothing about SoundBase. adapter.js translates between the two.
//
// Everything here was checked against a real N9340B (firmware A.02.07), not
// just the programmer's guide. Where the two disagree, the instrument won:
//
//   - The LAN port offers VXI-11 only. There is no raw SCPI socket on 5025.
//   - A sweep always has 461 points. There is no :SWEep:POINts command.
//   - RBW is a 1-3-10 ladder from 300 Hz to 1 MHz; values in between snap.
//   - The attenuator takes 0-51 dB in 1 dB steps and clamps beyond that.
//   - The [:SENSe]:DETector commands in the guide are rejected (-171).
//   - *OPC? only means anything right after :INITiate:IMMediate, so a sweep
//     is `:INIT:IMM;*OPC?` as one message.
//   - The instrument is single-threaded: while it sweeps it answers nothing,
//     and device_clear does not abort the sweep. A 128 s sweep (full span at
//     10 kHz RBW) is 128 s of silence. Know the sweep time before you start.
//   - :TRACe:FORMat REAL returns 461 little-endian IEEE-754 floats and a
//     newline, no block header.

import { Vxi11Client } from './vxi11.js';

export const POINT_COUNT = 461;
export const MIN_FREQUENCY_HZ = 100_000;
export const MAX_FREQUENCY_HZ = 3_000_000_000;
export const MIN_SPAN_HZ = 1_000;
export const RBW_HZ = [300, 1_000, 3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000];
export const MIN_REF_LEVEL_DBM = -120;
export const MAX_REF_LEVEL_DBM = 30;
export const MIN_ATTENUATION_DB = 0;
export const MAX_ATTENUATION_DB = 51;
export const SWEEP_MODES = ['normal', 'fast'];

/** Round-trip overhead on top of the instrument's own sweep time. */
const SWEEP_OVERHEAD_MS = 1_500;
const SETTLE_TIMEOUT_MS = 8_000;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Nearest value in a 1-3-10 ladder, compared on a log scale. */
export function snapToLadder(hz, ladder = RBW_HZ) {
  const target = Math.log10(clamp(hz, ladder[0], ladder[ladder.length - 1]));
  return ladder.reduce((best, candidate) =>
    Math.abs(Math.log10(candidate) - target) <
    Math.abs(Math.log10(best) - target)
      ? candidate
      : best
  );
}

export class N9340B {
  #vxi = null;

  constructor({ host, port = null, connectTimeoutMs, ioTimeoutMs } = {}) {
    this.host = host;
    this.port = port;
    this.connectTimeoutMs = connectTimeoutMs ?? 3_000;
    this.ioTimeoutMs = ioTimeoutMs ?? 5_000;
    this.identity = null;
    /** set by the owner; called when the transport dies unprompted */
    this.onFatal = null;
  }

  get connected() {
    return !!this.#vxi?.connected;
  }

  // -- connection ------------------------------------------------------------

  async connect() {
    const vxi = new Vxi11Client({
      host: this.host,
      port: this.port,
      connectTimeoutMs: this.connectTimeoutMs,
      ioTimeoutMs: this.ioTimeoutMs,
    });
    vxi.onFatal = (err) => this.onFatal?.(err);
    await vxi.connect();
    this.#vxi = vxi;
    try {
      // flush whatever a previous, interrupted session left in the output
      // queue, then prove the link is in sync by reading the identity
      await vxi.clear();
      this.identity = await this.#identify();
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  async #identify() {
    const reply = await this.#query('*IDN?', SETTLE_TIMEOUT_MS);
    const [manufacturer, model, serial, firmware] = reply
      .split(',')
      .map((s) => s.trim());
    if (!model) {
      throw new Error(
        `${this.host} answered *IDN? with "${reply}", which is not an instrument identity`
      );
    }
    return { manufacturer, model, serial, firmware };
  }

  /** Destroy the link. Never throws. */
  async close() {
    const vxi = this.#vxi;
    this.#vxi = null;
    if (vxi) await vxi.close();
  }

  // -- primitives ------------------------------------------------------------

  #require() {
    if (!this.#vxi?.connected) {
      throw new Error(`no connection to the N9340B at ${this.host}`);
    }
    return this.#vxi;
  }

  async #write(command) {
    await this.#require().write(command);
  }

  async #query(command, timeoutMs = this.ioTimeoutMs) {
    return this.#require().query(command, { timeoutMs });
  }

  async #queryNumber(command) {
    const reply = await this.#query(command);
    const value = Number(reply);
    if (!Number.isFinite(value)) {
      throw new Error(`${command} answered "${reply}", not a number`);
    }
    return value;
  }

  async #queryBool(command) {
    const reply = await this.#query(command);
    return reply === '1' || reply.toUpperCase() === 'ON';
  }

  /**
   * Drain the error queue. Returns [{ code, message }], oldest first. Errors
   * here are the instrument's opinion of the last few commands, so call it
   * right after a batch of settings.
   */
  async errors() {
    const out = [];
    for (let i = 0; i < 20; i++) {
      const reply = await this.#query(':SYST:ERR?');
      const match = /^\s*([+-]?\d+)\s*,\s*"?(.*?)"?\s*$/.exec(reply);
      const code = match ? Number(match[1]) : NaN;
      if (!match || code === 0) break;
      out.push({ code, message: match[2] });
    }
    return out;
  }

  // -- instrument state ------------------------------------------------------

  /**
   * Put the instrument into the state the sweep loop relies on. Idempotent,
   * and deliberately narrow: it changes what it needs for remote sweeping and
   * leaves the user's frequency, amplitude and bandwidth settings alone until
   * applyConfig asks for them.
   */
  async prepare() {
    const mode = await this.#query(':INST:SEL?');
    if (mode.toUpperCase() !== 'SA') {
      await this.#write(':INST:SEL SA');
      // a mode change takes the instrument a moment; wait for it to answer
      await this.#query('*IDN?', SETTLE_TIMEOUT_MS);
    }
    const measurement = await this.#query(':INST:MEAS?').catch(() => 'OFF');
    if (measurement.toUpperCase() !== 'OFF') {
      await this.#write(':INST:MEAS OFF');
    }
    await this.#write(':INIT:CONT 0');
    await this.#write(':TRAC:FORM REAL');
    await this.#write(':UNIT:POW DBM');
    await this.#write(':DISP:WIND:TRAC:Y:SPAC LOG');
    await this.#write(':TRAC1:MODE WRIT');
    await this.#write(':SENS:AVER:TRAC1 OFF');
    // sweep time must couple to span and RBW, or narrow RBWs read "Meas Uncal"
    await this.#write(':SENS:SWE:TIME:AUTO 1');
    await this.#write('*CLS');
  }

  /** Hand the front panel back: continuous sweep, as a user expects to find it. */
  async restoreContinuous() {
    await this.#write(':INIT:CONT 1');
  }

  async getFrequencyRange() {
    return {
      startHz: await this.#queryNumber(':SENS:FREQ:STAR?'),
      stopHz: await this.#queryNumber(':SENS:FREQ:STOP?'),
    };
  }

  /** Set start/stop and return what the instrument settled on. */
  async setFrequencyRange(startHz, stopHz) {
    let start = clamp(Math.round(startHz), MIN_FREQUENCY_HZ, MAX_FREQUENCY_HZ);
    let stop = clamp(Math.round(stopHz), MIN_FREQUENCY_HZ, MAX_FREQUENCY_HZ);
    if (stop - start < MIN_SPAN_HZ) {
      stop = Math.min(MAX_FREQUENCY_HZ, start + MIN_SPAN_HZ);
      start = stop - MIN_SPAN_HZ;
    }
    // stop first when moving up, start first when moving down, so the two
    // never cross while the instrument applies them one at a time
    if (stop > (await this.#queryNumber(':SENS:FREQ:STOP?'))) {
      await this.#write(`:SENS:FREQ:STOP ${stop}`);
      await this.#write(`:SENS:FREQ:STAR ${start}`);
    } else {
      await this.#write(`:SENS:FREQ:STAR ${start}`);
      await this.#write(`:SENS:FREQ:STOP ${stop}`);
    }
    return {
      startHz: await this.#queryNumber(':SENS:FREQ:STAR?'),
      stopHz: await this.#queryNumber(':SENS:FREQ:STOP?'),
    };
  }

  /** `null` couples RBW to span. Returns { rbwHz, auto }. */
  async setRbw(hz) {
    if (hz === null || hz === undefined) {
      await this.#write(':SENS:BAND:RES:AUTO 1');
    } else {
      await this.#write(':SENS:BAND:RES:AUTO 0');
      await this.#write(`:SENS:BAND:RES ${snapToLadder(hz, RBW_HZ)}`);
    }
    return {
      rbwHz: await this.#queryNumber(':SENS:BAND:RES?'),
      auto: await this.#queryBool(':SENS:BAND:RES:AUTO?'),
    };
  }

  /** `null` couples VBW to RBW. Returns { vbwHz, auto }. */
  async setVbw(hz) {
    if (hz === null || hz === undefined) {
      await this.#write(':SENS:BAND:VID:AUTO 1');
    } else {
      await this.#write(':SENS:BAND:VID:AUTO 0');
      await this.#write(`:SENS:BAND:VID ${Math.round(hz)}`);
    }
    return {
      vbwHz: await this.#queryNumber(':SENS:BAND:VID?'),
      auto: await this.#queryBool(':SENS:BAND:VID:AUTO?'),
    };
  }

  async setRefLevel(dbm) {
    const value = clamp(Number(dbm), MIN_REF_LEVEL_DBM, MAX_REF_LEVEL_DBM);
    await this.#write(`:DISP:WIND:TRAC:Y:RLEV ${value.toFixed(2)}`);
    return this.#queryNumber(':DISP:WIND:TRAC:Y:RLEV?');
  }

  async getRefLevel() {
    return this.#queryNumber(':DISP:WIND:TRAC:Y:RLEV?');
  }

  /** `'auto'` couples attenuation to the reference level. Returns { db, auto }. */
  async setAttenuation(value) {
    if (value === 'auto' || value === null || value === undefined) {
      await this.#write(':SENS:POW:ATT:AUTO 1');
    } else {
      const db = clamp(
        Math.round(Number(value)),
        MIN_ATTENUATION_DB,
        MAX_ATTENUATION_DB
      );
      await this.#write(':SENS:POW:ATT:AUTO 0');
      await this.#write(`:SENS:POW:ATT ${db}`);
    }
    return this.getAttenuation();
  }

  async getAttenuation() {
    return {
      db: await this.#queryNumber(':SENS:POW:ATT?'),
      auto: await this.#queryBool(':SENS:POW:ATT:AUTO?'),
    };
  }

  /**
   * The preamplifier is option PA3; on a unit without it the query is an
   * error. Returns true/false, or null when the unit has no preamp.
   */
  async getPreamp() {
    try {
      const on = await this.#queryBool(':SENS:POW:GAIN?');
      const errors = await this.errors();
      if (errors.some((e) => e.code < 0)) return null;
      return on;
    } catch {
      return null;
    }
  }

  async setPreamp(on) {
    await this.#write(`:SENS:POW:GAIN ${on ? 1 : 0}`);
    return this.#queryBool(':SENS:POW:GAIN?');
  }

  /** 'normal' | 'fast' — how the auto sweep time couples. */
  async setSweepMode(mode) {
    const want = mode === 'fast' ? 'FAST' : 'NORM';
    await this.#write(`:SENS:SWE:TIME:AUTO:MODE ${want}`);
    return this.getSweepMode();
  }

  async getSweepMode() {
    const reply = await this.#query(':SENS:SWE:TIME:AUTO:MODE?');
    return reply.toUpperCase().startsWith('FAST') ? 'fast' : 'normal';
  }

  /** The instrument's own estimate of one sweep, in milliseconds. */
  async getSweepTimeMs() {
    const seconds = await this.#queryNumber(':SENS:SWE:TIME?');
    return Math.max(1, Math.round(seconds * 1000));
  }

  // -- sweeping --------------------------------------------------------------

  /**
   * One complete single sweep: trigger, wait for completion, read trace 1.
   * `sweepTimeMs` sizes the wait; without it the default I/O timeout applies,
   * which is far too short for a slow sweep.
   */
  async sweep({ sweepTimeMs = 0 } = {}) {
    const timeoutMs = Math.max(
      this.ioTimeoutMs,
      Math.round(sweepTimeMs * 1.5) + SWEEP_OVERHEAD_MS
    );
    const done = await this.#query(':INIT:IMM;*OPC?', timeoutMs);
    if (done !== '1') {
      throw new Error(`the N9340B answered "${done}" instead of 1 to *OPC?`);
    }
    return this.readTrace();
  }

  /** Read trace 1 as 461 dBm values, whichever format the instrument is in. */
  async readTrace() {
    const vxi = this.#require();
    await vxi.write(':TRAC1:DATA?');
    const buf = await vxi.read({ timeoutMs: this.ioTimeoutMs });
    return parseTrace(buf);
  }
}

/**
 * A trace in either format. REAL is 461 little-endian float32 followed by a
 * newline; ASCii is comma-separated `-9.528974152E+01` values.
 */
export function parseTrace(buf) {
  const binaryLength = POINT_COUNT * 4;
  if (buf.length === binaryLength || buf.length === binaryLength + 1) {
    const out = new Array(POINT_COUNT);
    for (let i = 0; i < POINT_COUNT; i++) out[i] = buf.readFloatLE(i * 4);
    return out;
  }
  const text = buf.toString('latin1').trim();
  const values = text.split(',').map(Number);
  if (values.length !== POINT_COUNT || values.some((v) => !Number.isFinite(v))) {
    throw new Error(
      `trace data was ${buf.length} bytes / ${values.length} values, expected ${POINT_COUNT} points`
    );
  }
  return values;
}

/**
 * Is there an N9340B at this address? For discovery: quick, quiet, never
 * throws. Returns the identity or null.
 */
export async function probe({ host, port = null, timeoutMs = 2_000 }) {
  const instrument = new N9340B({
    host,
    port,
    connectTimeoutMs: timeoutMs,
    ioTimeoutMs: timeoutMs,
  });
  try {
    await instrument.connect();
    return instrument.identity;
  } catch {
    return null;
  } finally {
    await instrument.close();
  }
}
