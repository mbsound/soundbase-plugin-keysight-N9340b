# SoundBase plugin: Keysight N9340B

A [SoundBase](https://soundbase.app) plugin that turns a Keysight (Agilent)
N9340B handheld spectrum analyzer into a live-scan device over the network.
Its sweeps become the trace on the plot, and SoundBase coordinates against
them.

Developed and tested against an N9340B running firmware A.02.07 with the
preamp option (PA3), over its LAN port.

## How it talks to the analyzer

The N9340B's LAN interface does not offer a raw SCPI socket; it speaks
**VXI-11**, the RPC protocol VISA uses behind a `TCPIP0::<ip>::inst0::INSTR`
resource. `driver/vxi11.js` is a small VXI-11 client in plain Node: it asks
the analyzer's RPC port mapper (TCP 111) where the instrument channel is,
opens a link, and exchanges SCPI over it. No VISA, no Keysight IO Libraries,
no native code.

`driver/n9340b.js` is the instrument: the SCPI commands the unit actually
honours, what it clamps and snaps, how long a sweep takes, and how to read a
trace. `adapter.js` maps that onto the SoundBase contract.

## Using it

1. Put the analyzer on the show network and note its address
   (on the unit: **SYS > Setting > I/O Config > LAN**).
2. In SoundBase, either:
   - list the address under **Settings > Plugins > Keysight N9340B >
     Analyzer addresses**, and the unit appears in the live-scan device picker
     when it answers, or
   - pick **Keysight N9340B (LAN)** from the device picker's "add a device"
     option and type the address.
3. Press **Live**.

What SoundBase can set:

| Setting | What the plugin does |
|---|---|
| Start / stop frequency | 100 kHz to 3 GHz, minimum span 1 kHz; the analyzer's readback is what is reported |
| RBW | 300 Hz to 1 MHz in 1-3-10 steps; anything else snaps to the nearest step. Leave it on auto and the analyzer couples it to the span (reported under `resolved`) |
| Reference level | -120 to +30 dBm |
| Points | Always 461. The N9340B has no point-count command; the plugin declares `autoPointCount` so SoundBase hides the control |
| Input attenuation (control) | Auto (coupled to ref level) or 0 to 50 dB |
| Sweep mode (control) | Normal, or Fast, which roughly halves the sweep time at a small cost in amplitude accuracy |
| Preamplifier (control) | On or Off, only shown when the unit has option PA3. On by default: without it the noise floor rises by 10 to 20 dB |

### Sweep time matters

The analyzer is single-threaded: while it sweeps it answers nothing, and a
sweep cannot be aborted. The plugin reads the analyzer's own sweep-time
estimate after every configuration change, reports it to SoundBase as
`resolved.sweepTimeMs` so the stall watchdog waits, and sizes its own
timeouts from it. It also raises a warning when a sweep will take more than
10 s.

Measured on the test unit, trigger-to-trace per sweep:

| Span | RBW | Mode | Per sweep |
|---|---|---|---|
| 147 MHz (470 to 617 MHz) | 100 kHz | Normal | about 0.75 s |
| 147 MHz | 100 kHz | Fast | about 0.35 s |
| 3 GHz (full) | 1 MHz | Normal | about 1.1 s |
| 3 GHz | 10 kHz | Normal | about 128 s |

Narrow RBW across a wide span is where a "live" view stops being live.

### What the plugin changes on the analyzer

On open: spectrum-analyzer mode, measurements off, single-sweep mode, binary
trace format, dBm, log scale, trace 1 in clear-write, averaging off, and sweep
time coupled to span and RBW (so narrow RBWs do not read "Meas Uncal"). The
frequency, amplitude and bandwidth settings stay as they were until SoundBase
sets them. On close the analyzer is put back into continuous sweep so the
front panel behaves normally again.

## Development

```sh
npm install
npm run doctor      # is everything wired up?
npm test            # the contract, through the real shell, against a fake N9340B
npm run manifest    # validate soundbase-plugin.json against the schema
npm run smoke       # boot as a child process and handshake, exactly as the host does
```

`driver/fake-n9340b.js` is a fake N9340B: a VXI-11 server speaking the SCPI
subset the driver uses, with the real unit's quirks (461 points, RBW snapping,
an attenuator that clamps at 51 dB, silence during a sweep, an error queue).
The tests need no hardware.

To run against a real unit by hand:

```sh
npm start
# SB_PLUGIN_READY {"port":54321}
PORT=54321; DEV=net%3A192.168.42.251
curl -s -X POST localhost:$PORT/devices -H 'content-type: application/json' \
  -d '{"id":"net:192.168.42.251","product":"plugin:keysight-n9340b/n9340b","config":{"host":"192.168.42.251"}}'
curl -s -X POST localhost:$PORT/devices/$DEV/configuration -H 'content-type: application/json' \
  -d '{"startHz":470000000,"stopHz":617000000,"rbwHz":100000}'
curl -s -X POST localhost:$PORT/devices/$DEV/sweep/start
curl -s localhost:$PORT/devices/$DEV/trace
```

To see it inside SoundBase Desktop, start the app with `SB_PLUGIN_DIRS`
pointing at the folder that *contains* this one:

```sh
SB_PLUGIN_DIRS="/path/to/parent-folder" open -a "SoundBase Desktop"
```

[docs/running-in-soundbase.md](docs/running-in-soundbase.md) covers the plugin
manager, the device picker and the logs; the rest of `docs/` is the SoundBase
plugin guide this plugin was built from.

## Things found on the bench, not in the programmer's guide

- The guide documents `[:SENSe]:DETector`; firmware A.02.07 rejects it with
  `-171 Invalid expression`, so there is no detector control.
- `*OPC?` is only meaningful immediately after `:INITiate:IMMediate`, so a
  sweep is the single message `:INIT:IMM;*OPC?`.
- `:TRACe:FORMat REAL` returns 461 little-endian IEEE-754 floats and a
  newline with no block header. It reads in 9 ms where ASCII takes 97 ms.
- `device_clear` does not abort a sweep in progress.
- Stop frequency accepts up to 3.05 GHz; start accepts down to -80 MHz. The
  plugin clamps to the specified 100 kHz to 3 GHz.

## Status

Tested on macOS (Apple silicon), so `platforms` lists only `darwin-arm64`.
The code has nothing platform-specific in it; add `darwin-x64` and
`win32-x64` once it has been run there. The N9342C/N9343C/N9344C handhelds
share the dialect and are accepted by the model check, but have not been
tried.

## Licence

MIT for this plugin's code. The SoundBase Plugin SDK it builds on is BUSL-1.1
with an Additional Use Grant for SoundBase plugins; see LICENSE.
