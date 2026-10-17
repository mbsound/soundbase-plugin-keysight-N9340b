// SoundBase adapter for the Keysight N9340B handheld spectrum analyzer.
//
// This file knows the SoundBase contract: what open() must report, how
// applyConfig() echoes, what a trace looks like. driver/n9340b.js knows the
// instrument. Nothing here touches the wire directly.
//
// The N9340B's LAN interface speaks VXI-11, so a unit is addressed by its IP
// address alone (the port comes from the instrument's RPC port mapper). Users
// either list addresses in the plugin settings, so discovery finds the units
// that answer, or add a unit by address from the device picker.

import {
  N9340B,
  probe,
  POINT_COUNT,
  MIN_FREQUENCY_HZ,
  MAX_FREQUENCY_HZ,
  RBW_HZ,
  MIN_REF_LEVEL_DBM,
  MAX_REF_LEVEL_DBM,
  MAX_ATTENUATION_DB,
  SWEEP_MODES,
} from './driver/n9340b.js';

export const PRODUCT = 'plugin:keysight-n9340b/n9340b';

/** Models that share the N9340B's SCPI dialect closely enough to drive. */
const MODEL_PATTERN = /^N93\d\d[A-Z]?$/i;

/** Above this, a live view is not live; tell the user why. */
const SLOW_SWEEP_WARNING_MS = 10_000;

/** What the plugin adds on top of the instrument's own sweep time estimate. */
const SWEEP_OVERHEAD_MS = 400;

const ATTENUATION_CHOICES = [
  { id: 'auto', label: 'Auto (coupled to ref level)' },
  ...[0, 5, 10, 15, 20, 25, 30, 40, 50].map((db) => ({
    id: String(db),
    label: `${db} dB`,
  })),
];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Units reachable right now, from the addresses the user listed in the plugin
 * settings. Called once a second while SoundBase enumerates and never
 * otherwise. An address with nothing on it is a normal empty result.
 */
export async function discoverDevices(pluginConfig = {}) {
  const addresses = parseAddresses(pluginConfig.addresses);
  const found = await Promise.all(
    addresses.map(async ({ host, port }) => {
      const identity = await probe({ host, port });
      if (!identity || !MODEL_PATTERN.test(identity.model)) return null;
      return {
        id: deviceId(host, port),
        name: `${identity.model} ${identity.serial ?? ''} (${host})`.replace(
          '  ',
          ' '
        ),
        product: PRODUCT,
        transport: { kind: 'vxi11', host, ...(port ? { port } : {}) },
      };
    })
  );
  return found.filter(Boolean);
}

export function createSpectrumAnalyzerAdapter(device, pluginConfig) {
  return new N9340BAdapter(device, pluginConfig);
}

class N9340BAdapter {
  constructor(device) {
    const { host, port } = addressOf(device);
    this.host = host;
    this.port = port;
    this.instrument = null;
    this.hasPreamp = false;
    this.preampOn = null; // what we last set; null until the first apply
    this.effective = null;
    this.sweepTimeMs = 0;
    this.sweeping = false;
    this.lock = Promise.resolve();
    /** assigned by the shell */
    this.onFatal = null;
    this.onWarnings = null;
  }

  /** Run `fn` with exclusive use of the instrument. */
  exclusive(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  async open() {
    const instrument = new N9340B({ host: this.host, port: this.port });
    instrument.onFatal = (err) =>
      this.onFatal?.(
        new Error(
          `Lost the connection to the N9340B at ${this.host}: ${err?.message ?? 'connection closed'}`
        )
      );
    try {
      await instrument.connect();
    } catch (err) {
      throw new Error(
        `Could not reach an N9340B at ${this.host}: ${err.message}. ` +
          'Check the address, that the analyzer is on the same network, and that its LAN port is enabled.'
      );
    }
    const identity = instrument.identity;
    if (!MODEL_PATTERN.test(identity.model ?? '')) {
      await instrument.close();
      throw new Error(
        `${this.host} is a ${identity.manufacturer} ${identity.model}, not an N9340B-family analyzer.`
      );
    }
    this.instrument = instrument;

    await instrument.prepare();
    const preamp = await instrument.getPreamp();
    this.hasPreamp = preamp !== null;

    const controls = [
      {
        id: 'attenuation',
        type: 'dropdown',
        label: 'Input attenuation',
        default: 'auto',
        choices: ATTENUATION_CHOICES,
        help:
          'Auto couples the attenuator to the reference level. Raise it if strong nearby transmitters are compressing the front end.',
      },
      {
        id: 'sweepMode',
        type: 'dropdown',
        label: 'Sweep mode',
        default: 'normal',
        choices: [
          { id: 'normal', label: 'Normal' },
          { id: 'fast', label: 'Fast' },
        ],
        help:
          'Fast sweeps are roughly half the time of Normal at the same RBW, at a small cost in amplitude accuracy.',
      },
    ];
    if (this.hasPreamp) {
      controls.push({
        id: 'preamp',
        // A dropdown rather than a checkbox: a checkbox cannot tell "never
        // set" from "off", and the host renders one unchecked whatever the
        // plugin echoes. On by default: without the preamp this unit's floor
        // at 30 kHz RBW is about -80 dBm, which on SoundBase's plot looks
        // like a band full of signal.
        type: 'dropdown',
        label: 'Preamplifier',
        default: 'on',
        choices: [
          { id: 'on', label: 'On' },
          { id: 'off', label: 'Off' },
        ],
        help: 'Internal preamp (option PA3). Keep it on for coordination: off, the noise floor rises by 10 to 20 dB. Switch it off only next to strong transmitters that compress the front end.',
      });
    }

    return {
      capabilities: {
        minFrequencyHz: MIN_FREQUENCY_HZ,
        maxFrequencyHz: MAX_FREQUENCY_HZ,
        rbwHz: [...RBW_HZ],
        minRefLevelDbm: MIN_REF_LEVEL_DBM,
        maxRefLevelDbm: MAX_REF_LEVEL_DBM,
        // the N9340B always sweeps 461 points; there is no point-count command
        autoPointCount: true,
        controls,
      },
      identity: {
        manufacturer: identity.manufacturer,
        model: identity.model,
        firmware: identity.firmware,
        serial: identity.serial,
      },
    };
  }

  /**
   * Apply a configuration patch and echo what the instrument settled on.
   * Absent fields are unchanged; `controls` merges by id; clamping happens in
   * the driver and the readback is the truth.
   */
  applyConfig(cfg = {}) {
    return this.exclusive(() => this.#applyConfig(cfg));
  }

  async #applyConfig(cfg) {
    const instrument = this.#requireInstrument();
    const previous = this.effective ?? { controls: {} };
    const effective = {
      pointCount: POINT_COUNT,
      controls: { ...previous.controls },
      resolved: {},
    };

    // -- frequency range
    if (isNum(cfg.startHz) || isNum(cfg.stopHz) || !isNum(previous.startHz)) {
      const current =
        isNum(previous.startHz) && isNum(previous.stopHz)
          ? previous
          : await instrument.getFrequencyRange();
      const range = await instrument.setFrequencyRange(
        isNum(cfg.startHz) ? cfg.startHz : current.startHz,
        isNum(cfg.stopHz) ? cfg.stopHz : current.stopHz
      );
      effective.startHz = range.startHz;
      effective.stopHz = range.stopHz;
    } else {
      effective.startHz = previous.startHz;
      effective.stopHz = previous.stopHz;
    }

    // -- RBW. The shell hands us its whole desired configuration, not a
    // delta, so a missing rbwHz is "the analyzer's choice" (the host cleared
    // it or never set it), not "leave it alone". Auto is reported under
    // `resolved`; a manual value is echoed as the instrument snapped it.
    const rbw = await instrument.setRbw(isNum(cfg.rbwHz) ? cfg.rbwHz : null);
    if (rbw.auto) effective.resolved.rbwHz = rbw.rbwHz;
    else effective.rbwHz = rbw.rbwHz;

    // -- VBW: same shape, coupled to RBW unless asked otherwise
    const vbw = await instrument.setVbw(isNum(cfg.vbwHz) ? cfg.vbwHz : null);
    if (vbw.auto) effective.resolved.vbwHz = vbw.vbwHz;
    else effective.vbwHz = vbw.vbwHz;

    // -- reference level. The shell reports the requested value as the
    // effective one, so the instrument's readback (clamped to -120..+30 dBm,
    // snapped to its own step) goes under `resolved` where it is visible.
    const refLevel = isNum(cfg.refLevelDbm)
      ? await instrument.setRefLevel(cfg.refLevelDbm)
      : await instrument.getRefLevel();
    effective.refLevelDbm = refLevel;
    effective.resolved.refLevelDbm = refLevel;

    // -- controls
    const controls = cfg.controls ?? {};
    if (controls.attenuation !== undefined || previous.controls.attenuation === undefined) {
      const want = controls.attenuation ?? 'auto';
      const atten = await instrument.setAttenuation(
        want === 'auto' || want === null ? 'auto' : Number(want)
      );
      effective.controls.attenuation = atten.auto ? 'auto' : String(atten.db);
    }
    // auto attenuation follows the reference level, so read it back every time
    effective.resolved.attenuationDb = (await instrument.getAttenuation()).db;
    if (controls.sweepMode !== undefined || previous.controls.sweepMode === undefined) {
      const want = SWEEP_MODES.includes(controls.sweepMode)
        ? controls.sweepMode
        : 'normal';
      effective.controls.sweepMode = await instrument.setSweepMode(want);
    }
    if (this.hasPreamp) {
      // no explicit choice means on; 'off', false or 'false' mean off
      const want = controls.preamp;
      const on = !(want === 'off' || want === false || want === 'false');
      if (on !== this.preampOn) {
        this.preampOn = await instrument.setPreamp(on);
      }
      effective.controls.preamp = this.preampOn ? 'on' : 'off';
    }

    // -- what this costs per sweep, so the host's stall watchdog can wait
    this.sweepTimeMs = await instrument.getSweepTimeMs();
    effective.resolved.sweepTimeMs = this.sweepTimeMs + SWEEP_OVERHEAD_MS;

    this.#reportWarnings(await instrument.errors());
    this.effective = effective;
    // one line per applied configuration in the plugin log, so "the trace
    // looks wrong" can be answered from the log instead of a bench visit
    console.log(
      `[net:${this.host}] applied ${(effective.startHz / 1e6).toFixed(3)}-${(effective.stopHz / 1e6).toFixed(3)} MHz ` +
        `rbw=${effective.rbwHz ?? `auto(${effective.resolved.rbwHz})`} ` +
        `vbw=${effective.vbwHz ?? `auto(${effective.resolved.vbwHz})`} ` +
        `ref=${effective.refLevelDbm} dBm atten=${effective.controls.attenuation}(${effective.resolved.attenuationDb} dB) ` +
        `preamp=${effective.controls.preamp ?? 'n/a'} sweep=${effective.controls.sweepMode} ` +
        `sweepTime=${this.sweepTimeMs} ms`
    );
    return publicConfig(effective);
  }

  #reportWarnings(errors) {
    const warnings = [];
    if (this.sweepTimeMs > SLOW_SWEEP_WARNING_MS) {
      warnings.push({
        id: 'slow-sweep',
        severity: 'warning',
        message:
          `One sweep takes ${(this.sweepTimeMs / 1000).toFixed(0)} s at this span and RBW. ` +
          'Widen the RBW, narrow the span, or choose the Fast sweep mode for a live view.',
      });
    }
    if (errors.some((e) => e.code === 130)) {
      warnings.push({
        id: 'meas-uncal',
        severity: 'warning',
        message:
          'The analyzer reports "Meas Uncal": its sweep time is too short for this RBW, so amplitudes are not trustworthy.',
      });
    }
    for (const e of errors) {
      if (e.code < 0 && e.code !== -420 && e.code !== -410) {
        warnings.push({
          id: `scpi-${Math.abs(e.code)}`,
          severity: 'info',
          message: `The analyzer rejected a command: ${e.message} (${e.code}).`,
        });
      }
    }
    this.onWarnings?.(warnings);
  }

  /**
   * Sweep until told to stop. Each iteration is one single sweep on the
   * instrument: trigger, wait for *OPC?, read 461 points. A loop, not a timer,
   * because a sweep can take anything from 50 ms to minutes.
   */
  async startSweep(onTrace) {
    if (this.sweeping) return;
    this.sweeping = true;
    (async () => {
      while (this.sweeping) {
        try {
          const amplitudes = await this.exclusive(() => {
            if (!this.sweeping) return null;
            return this.#requireInstrument().sweep({
              sweepTimeMs: this.sweepTimeMs,
            });
          });
          if (this.sweeping && amplitudes) onTrace(amplitudes);
        } catch (err) {
          if (!this.sweeping) return;
          this.sweeping = false;
          this.onFatal?.(
            new Error(
              `The N9340B at ${this.host} stopped answering during a sweep: ${err.message}`
            )
          );
          return;
        }
      }
    })();
  }

  async stopSweep() {
    this.sweeping = false;
  }

  /** Release the instrument: continuous sweep back on, link destroyed. */
  async close() {
    this.sweeping = false;
    this.preampOn = null;
    const instrument = this.instrument;
    this.instrument = null;
    if (!instrument) return;
    await this.exclusive(async () => {
      if (instrument.connected) {
        await instrument.restoreContinuous().catch(() => {});
      }
      await instrument.close();
    });
  }

  #requireInstrument() {
    if (!this.instrument) {
      throw new Error(`the N9340B at ${this.host} is not open`);
    }
    return this.instrument;
  }
}

/** A copy the shell can keep without sharing our bookkeeping objects. */
function publicConfig(effective) {
  return {
    ...effective,
    controls: { ...effective.controls },
    resolved: { ...effective.resolved },
  };
}

/** "192.168.42.251, 10.0.0.7:1024" -> [{ host, port }] (port null = ask the port mapper) */
function parseAddresses(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^(.+?)(?::(\d+))?$/.exec(entry);
      return { host: match[1], port: match[2] ? Number(match[2]) : null };
    });
}

function deviceId(host, port) {
  return port ? `net:${host}:${port}` : `net:${host}`;
}

/**
 * Where this device lives. `device.config` carries the manifest's
 * deviceConfigFields; the id fallback covers a unit discovery found itself.
 */
function addressOf(device) {
  const config = device?.config ?? {};
  if (typeof config.host === 'string' && config.host.trim()) {
    const port = Number(config.port);
    return {
      host: config.host.trim(),
      port: Number.isInteger(port) && port > 0 ? port : null,
    };
  }
  const match = /^net:(.+?)(?::(\d+))?$/.exec(device?.id ?? '');
  if (match) return { host: match[1], port: match[2] ? Number(match[2]) : null };
  throw new Error(
    `device ${device?.id} has no address: set "IP address" in its configuration`
  );
}
