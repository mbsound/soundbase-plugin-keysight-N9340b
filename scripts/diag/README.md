# USB diagnostics (work in progress, not part of the plugin)

Bench scripts from bringing up USB on the N9340B. Not shipped (pack-release
excludes `scripts/`), not run by CI. Delete once the USB transport is settled.

- `winusb_probe.py` - with the analyzer bound to Microsoft's "WinUsb Device"
  driver, open it through `winusb.dll` directly (no libusb) and send `*IDN?`
  over USBTMC. `py -3 -I winusb_probe.py`
- `winusb_ctrl.py` - same device, EP0 only: GET_CONFIGURATION, GET_STATUS and
  the USBTMC/USB488 class requests. Needs `winusb_probe.py` beside it.
- `compare-usb-lan.mjs` - one unit, same settings, five sweeps over USB then
  five over LAN through the plugin's own driver, and a comparison.
  `node compare-usb-lan.mjs <repo> <serial> <host>`

What they showed in a Parallels ARM64 Windows 11 VM on Apple silicon
(2026-10-19): WinUSB binds and the device starts, but libusb ignores it
("current config: 0"), GET_CONFIGURATION returns 0, GET_STATUS and every class
request stall, and bulk OUT times out. Not yet known whether a native x64 PC
behaves differently.
