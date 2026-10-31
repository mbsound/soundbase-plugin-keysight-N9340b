// The Keysight (Agilent) N9340B handheld spectrum analyzer.
//
// This file knows the instrument's SCPI dialect and its quirks; it knows
// nothing about SoundBase, and nothing about the wire either: it is handed a
// transport (Vxi11Client for LAN, UsbtmcClient for USB) with connect, write,
// read, query, clear, close and onFatal. adapter.js translates between this
// and SoundBase.
//
// Everything here was checked against a real N9340B (firmware A.02.07), not
// just the programmer's guide. Where the two disagree, the instrument won:
//
//   - The LAN port offers VXI-11 only. There is no raw SCPI socket on 5025.
//   - The USB port is USBTMC/USB488, but its configuration descriptor says
//     bConfigurationValue 0 and it rejects SET_CONFIGURATION(1): usable from
//     Windows (WinUSB), never from macOS. See usbtmc.js.
//   - A sweep always has 461 points. There is no :SWEep:POINts command.
//   - RBW is a 1-3-10 ladder from 300 Hz to 1 MHz; values in between snap.
//   - The attenuator takes 0-51 dB in 1 dB steps and clamps beyond that.
//   - The [:SENSe]:DETector commands in the guide are rejected (-171).
//   - *OPC? only means anything right after :INITiate:IMMediate, so a sweep
//     is `:INIT:IMM;*OPC?` as one message.
//   - The instrument is single-threaded: while it sweeps it answers nothing,
//     and device_clear does not abort the sweep. A 128 s sweep (full span at
//     10 kHz RBW) is 128 s of silence. Know the sweep time before you start.
//   - :TRACe:FORMat REAL returns 461 little-endian IEEE-754 floats, no block
//     header, then a newline over LAN. Over USB there is no newline: exactly
//     1844 bytes (seen through both Keysight VISA and raw WinUSB).
//
// Other Keysight analyzers (N9342C and the rest of the handheld family, or
// anything else that answers *IDN? as Keysight or Agilent) are driven with
// the same commands, untested. Rather than assume the N9340B's 461 points and
// 3 GHz, prepare() learns each unit's point count from a trace and, for any
// model but the N9340B, asks for its frequency limits; see learnLimits().

/** The N9340B's point count, and what a unit is assumed to have until a trace says otherwise. */
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

/**
 * Round-trip overhead on top of the instrument's own sweep time, unless the
 * transport asks for more (USB does: `sweepOverheadMs`).
 */
const SWEEP_OVERHEAD_MS = 1_500;
const SETTLE_TIMEOUT_MS = 8_000;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Keysight, or Agilent before the 2014 split: the makers this driver will talk to. */
export const isKeysight = (identity) => /keysight|agilent/i.test(identity?.manufacturer ?? '');

/** The model every limit and quirk in this file was checked on. */
export const isN9340B = (identity) => /^N9340B?$/i.test(identity?.model ?? '');

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
  #transport;
  #link = null;

  /** `transport`: a not-yet-connected Vxi11Client or UsbtmcClient. */
  constructor({ transport }) {
    this.#transport = transport;
    /** for messages: the host, or "USB <serial>" */
    this.where = transport.label ?? transport.host;
    this.ioTimeoutMs = transport.ioTimeoutMs ?? 5_000;
    this.sweepOverheadMs = transport.sweepOverheadMs ?? SWEEP_OVERHEAD_MS;
    this.identity = null;
    /** what this unit accepts; the N9340B's until prepare() learns otherwise */
    this.pointCount = POINT_COUNT;
    this.minFrequencyHz = MIN_FREQUENCY_HZ;
    this.maxFrequencyHz = MAX_FREQUENCY_HZ;
    /** set by the owner; called when the transport dies unprompted */
    this.onFatal = null;
  }

  get connected() {
    return !!this.#link?.connected;
  }

  // -- connection ------------------------------------------------------------

  async connect() {
    const link = this.#transport;
    link.onFatal = (err) => this.onFatal?.(err);
    await link.connect();
    this.#link = link;
    try {
      // flush whatever a previous, interrupted session left in the output
      // queue, then prove the link is in sync by reading the identity
      await link.clear();
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
        `${this.where} answered *IDN? with "${reply}", which is not an instrument identity`
      );
    }
    return { manufacturer, model, serial, firmware };
  }

  /** Destroy the link. Never throws. */
  async close() {
    const link = this.#link;
    this.#link = null;
    if (link) await link.close();
  }

  // -- primitives ------------------------------------------------------------

  #require() {
    if (!this.#link?.connected) {
      throw new Error(`no connection to the analyzer at ${this.where}`);
    }
    return this.#link;
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
    await this.learnLimits();
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
  /**
   * What this unit accepts, as far as it says. The point count is read from
   * the trace it already holds (no sweep), so a model with a different
   * count is simply believed. The N9340B keeps the frequency limits checked
   * on it; any other model is asked for its own (SCPI MIN/MAX), keeping the
   * N9340B's where it does not answer. Anything this sends that a unit
   * rejects lands in its error queue, which prepare() clears straight after.
   */
  async learnLimits() {
    try {
      const trace = await this.readTrace({ expectedPoints: null });
      if (trace.length >= 2) this.pointCount = trace.length;
    } catch {
      // keep the default; the first sweep will say if it is wrong
    }
    if (isN9340B(this.identity)) return;
    const asked = async (command) => {
      try {
        return await this.#queryNumber(command);
      } catch {
        return null;
      }
    };
    const max = await asked(':SENS:FREQ:STOP? MAX');
    const min = await asked(':SENS:FREQ:STAR? MIN');
    if (max !== null && max > MIN_SPAN_HZ) this.maxFrequencyHz = max;
    if (min !== null && min >= 0 && min < this.maxFrequencyHz) this.minFrequencyHz = min;
  }

  async setFrequencyRange(startHz, stopHz) {
    const lo = this.minFrequencyHz;
    const hi = this.maxFrequencyHz;
    let start = clamp(Math.round(startHz), lo, hi);
    let stop = clamp(Math.round(stopHz), lo, hi);
    if (stop - start < MIN_SPAN_HZ) {
      stop = Math.min(hi, start + MIN_SPAN_HZ);
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
      Math.round(sweepTimeMs * 1.5) + this.sweepOverheadMs
    );
    // Trigger, then wait out the sweep with nothing in flight on the link,
    // and only then read the "1". Blocking in a read for the whole sweep
    // means a plugin killed mid-sweep (SoundBase quitting kills the whole
    // process tree on Windows) aborts a USB transfer half-way, and through
    // Keysight's driver that leaves every later read failing with
    // VI_ERROR_IO until the analyzer is re-plugged. *OPC? still has to
    // travel with :INIT:IMM; on its own it does not wait for the sweep.
    const link = this.#require();
    await link.write(':INIT:IMM;*OPC?');
    if (sweepTimeMs > 0) await new Promise((resolve) => setTimeout(resolve, sweepTimeMs));
    const done = (await link.read({ timeoutMs })).toString('latin1').trim();
    if (done !== '1') {
      throw new Error(`the N9340B answered "${done}" instead of 1 to *OPC?`);
    }
    return this.readTrace();
  }

  /** Read trace 1 as 461 dBm values, whichever format the instrument is in. */
  /** The current trace in dBm; as many points as the unit was found to have, unless told otherwise. */
  async readTrace({ expectedPoints = this.pointCount } = {}) {
    const link = this.#require();
    await link.write(':TRAC1:DATA?');
    const buf = await link.read({ timeoutMs: this.ioTimeoutMs });
    return parseTrace(buf, expectedPoints);
  }
}

/**
 * A trace in either format. REAL is little-endian float32s (461 on the
 * N9340B), with a newline after them over LAN and none over USB; ASCii is
 * comma-separated `-9.528974152E+01` values. `expectedPoints` rejects a
 * trace of any other length, which is how a truncated read shows itself;
 * null accepts whatever the unit sent.
 */
export function parseTrace(buf, expectedPoints = POINT_COUNT) {
  const text = buf.toString('latin1').trim();
  let values;
  if (text.includes(',') && /^[-+\d.eE,\s]+$/.test(text)) {
    values = text.split(',').map(Number);
  } else {
    const body = buf.length % 4 === 1 && buf[buf.length - 1] === 0x0a ? buf.subarray(0, -1) : buf;
    if (body.length % 4 === 0 && body.length >= 8) {
      values = Array.from({ length: body.length / 4 }, (_, i) => body.readFloatLE(i * 4));
    }
  }
  const count = values?.length ?? 0;
  if (!values || values.some((v) => !Number.isFinite(v)) || (expectedPoints && count !== expectedPoints)) {
    throw new Error(
      `trace data was ${buf.length} bytes / ${count} values` +
        (expectedPoints ? `, expected ${expectedPoints} points` : ', not a trace')
    );
  }
  return values;
}

/**
 * Is there a Keysight analyzer on the other end of this transport? For
 * discovery: quick, quiet, never throws. Returns the identity or null.
 */
export async function probe(transport) {
  const instrument = new N9340B({ transport });
  try {
    await instrument.connect();
    return instrument.identity;
  } catch {
    return null;
  } finally {
    await instrument.close();
  }
}
