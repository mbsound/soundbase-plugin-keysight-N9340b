// winusb.dll and SetupAPI through koffi: the N9340B's USB port with no libusb.
//
// libusb cannot be used for this unit at all. Its configuration descriptor
// declares bConfigurationValue 0, and libusb skips any device whose current
// configuration is 0 ("current config: 0, ignoring it"). Windows' own stack
// does not care: with Microsoft's WinUSB driver bound, winusb.dll opens it,
// every control request answers and bulk transfers work (checked on an x64
// PC, 2026-10-31).
//
// Two halves:
//
//   listWinusbUnits()  SetupAPI only. Reads the registry-side view of the bus
//                      and never opens a device, so it is safe in the plugin
//                      process and never disturbs a unit an adapter holds
//                      (WinUSB allows one handle per device).
//   openWinusbDevice() The device itself. Calls block for up to their pipe
//                      timeout, so this runs in driver/winusb-worker.js, a
//                      child process the plugin can kill if a call wedges.
//
// Windows only. Importing this file elsewhere throws; callers catch that.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import koffi from 'koffi';

/** Keysight (formerly Agilent). Any product id: not only the N9340B's 0xFFEF. */
export const VENDOR_ID = 0x0957;

// --- types -------------------------------------------------------------------

const GUID = koffi.struct('GUID', {
  Data1: 'uint32_t',
  Data2: 'uint16_t',
  Data3: 'uint16_t',
  Data4: koffi.array('uint8_t', 8),
});
koffi.struct('SP_DEVINFO_DATA', {
  cbSize: 'uint32_t',
  ClassGuid: GUID,
  DevInst: 'uint32_t',
  Reserved: 'uintptr_t',
});
koffi.struct('SP_DEVICE_INTERFACE_DATA', {
  cbSize: 'uint32_t',
  InterfaceClassGuid: GUID,
  Flags: 'uint32_t',
  Reserved: 'uintptr_t',
});
koffi.pack('USB_INTERFACE_DESCRIPTOR', {
  bLength: 'uint8_t',
  bDescriptorType: 'uint8_t',
  bInterfaceNumber: 'uint8_t',
  bAlternateSetting: 'uint8_t',
  bNumEndpoints: 'uint8_t',
  bInterfaceClass: 'uint8_t',
  bInterfaceSubClass: 'uint8_t',
  bInterfaceProtocol: 'uint8_t',
  iInterface: 'uint8_t',
});
koffi.struct('WINUSB_PIPE_INFORMATION', {
  PipeType: 'int32_t',
  PipeId: 'uint8_t',
  MaximumPacketSize: 'uint16_t',
  Interval: 'uint8_t',
});
koffi.pack('WINUSB_SETUP_PACKET', {
  RequestType: 'uint8_t',
  Request: 'uint8_t',
  Value: 'uint16_t',
  Index: 'uint16_t',
  Length: 'uint16_t',
});

// --- functions ---------------------------------------------------------------

const setupapi = koffi.load('setupapi.dll');
const kernel32 = koffi.load('kernel32.dll');
const winusb = koffi.load('winusb.dll');

const SetupDiGetClassDevsW = setupapi.func(
  'void *SetupDiGetClassDevsW(const GUID *guid, const char16_t *enumerator, void *hwnd, uint32_t flags)'
);
const SetupDiEnumDeviceInterfaces = setupapi.func(
  'bool SetupDiEnumDeviceInterfaces(void *set, void *info, const GUID *guid, uint32_t index, _Inout_ SP_DEVICE_INTERFACE_DATA *data)'
);
const SetupDiGetDeviceInterfaceDetailW = setupapi.func(
  'bool SetupDiGetDeviceInterfaceDetailW(void *set, SP_DEVICE_INTERFACE_DATA *data, _Inout_ uint8_t *detail, uint32_t size, _Out_ uint32_t *required, _Inout_ SP_DEVINFO_DATA *info)'
);
const SetupDiGetDeviceInstanceIdW = setupapi.func(
  'bool SetupDiGetDeviceInstanceIdW(void *set, SP_DEVINFO_DATA *info, _Inout_ uint8_t *buffer, uint32_t chars, _Out_ uint32_t *required)'
);
const SetupDiGetDeviceRegistryPropertyW = setupapi.func(
  'bool SetupDiGetDeviceRegistryPropertyW(void *set, SP_DEVINFO_DATA *info, uint32_t property, _Out_ uint32_t *type, _Inout_ uint8_t *buffer, uint32_t size, _Out_ uint32_t *required)'
);
koffi.struct('DEVPROPKEY', { fmtid: GUID, pid: 'uint32_t' });
const SetupDiGetDevicePropertyW = setupapi.func(
  'bool SetupDiGetDevicePropertyW(void *set, SP_DEVINFO_DATA *info, const DEVPROPKEY *key, _Out_ uint32_t *type, _Inout_ uint8_t *buffer, uint32_t size, _Out_ uint32_t *required, uint32_t flags)'
);
const SetupDiDestroyDeviceInfoList = setupapi.func('bool SetupDiDestroyDeviceInfoList(void *set)');

const CreateFileW = kernel32.func(
  'void *CreateFileW(const char16_t *path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *template)'
);
const CloseHandle = kernel32.func('bool CloseHandle(void *handle)');
const GetLastError = kernel32.func('uint32_t GetLastError()');

const WinUsb_Initialize = winusb.func('bool WinUsb_Initialize(void *file, _Out_ void **handle)');
const WinUsb_Free = winusb.func('bool WinUsb_Free(void *handle)');
const WinUsb_QueryInterfaceSettings = winusb.func(
  'bool WinUsb_QueryInterfaceSettings(void *handle, uint8_t index, _Out_ USB_INTERFACE_DESCRIPTOR *descriptor)'
);
const WinUsb_QueryPipe = winusb.func(
  'bool WinUsb_QueryPipe(void *handle, uint8_t alt, uint8_t index, _Out_ WINUSB_PIPE_INFORMATION *pipe)'
);
const WinUsb_SetPipePolicy = winusb.func(
  'bool WinUsb_SetPipePolicy(void *handle, uint8_t pipe, uint32_t policy, uint32_t length, uint8_t *value)'
);
const WinUsb_WritePipe = winusb.func(
  'bool WinUsb_WritePipe(void *handle, uint8_t pipe, uint8_t *buffer, uint32_t length, _Out_ uint32_t *transferred, void *overlapped)'
);
const WinUsb_ReadPipe = winusb.func(
  'bool WinUsb_ReadPipe(void *handle, uint8_t pipe, _Inout_ uint8_t *buffer, uint32_t length, _Out_ uint32_t *transferred, void *overlapped)'
);
const WinUsb_ControlTransfer = winusb.func(
  'bool WinUsb_ControlTransfer(void *handle, WINUSB_SETUP_PACKET setup, _Inout_ uint8_t *buffer, uint32_t length, _Out_ uint32_t *transferred, void *overlapped)'
);
const WinUsb_ResetPipe = winusb.func('bool WinUsb_ResetPipe(void *handle, uint8_t pipe)');

// GUID_DEVINTERFACE_USB_DEVICE: every USB device has one, whatever driver it has
const GUID_DEVINTERFACE_USB_DEVICE = {
  Data1: 0xa5dcbf10,
  Data2: 0x6530,
  Data3: 0x11d2,
  Data4: [0x90, 0x1f, 0x00, 0xc0, 0x4f, 0xb9, 0x51, 0xed],
};
const DIGCF_PRESENT = 0x02;
const DIGCF_DEVICEINTERFACE = 0x10;
const SPDRP_COMPATIBLEIDS = 0x02;
const SPDRP_SERVICE = 0x04;
// the product string the device itself reports (iProduct), e.g. "N9340B";
// unlike the friendly name, a bound driver does not replace it
const DEVPKEY_Device_BusReportedDeviceDesc = {
  fmtid: {
    Data1: 0x540b947e,
    Data2: 0x8b40,
    Data3: 0x45bc,
    Data4: [0xa8, 0xa2, 0x6a, 0x0b, 0x89, 0x4c, 0xbd, 0xa2],
  },
  pid: 4,
};
// USB Test and Measurement Class (USBTMC): class FE, subclass 03
const USBTMC_COMPATIBLE_ID = /^USB\\Class_FE&SubClass_03/i;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const GENERIC_READ_WRITE = 0xc0000000;
const FILE_SHARE_READ_WRITE = 0x03;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const FILE_FLAG_OVERLAPPED = 0x40000000; // WinUSB requires it; calls below stay synchronous
const PIPE_TRANSFER_TIMEOUT = 0x03;
const PIPE_TYPE_BULK = 2;
const PIPE_TYPE_INTERRUPT = 3;
const INTERFACE_INDEX = 0;

const POINTER_BYTES = koffi.sizeof('void *');

const utf16 = (buf, chars = buf.length / 2) => {
  const s = buf.subarray(0, chars * 2).toString('utf16le');
  const nul = s.indexOf('\0');
  return nul === -1 ? s : s.slice(0, nul);
};

// --- errors ------------------------------------------------------------------

/** Win32 error codes as driver/usbtmc.js classifies transfer failures. */
export function classifyWin32(error) {
  switch (error) {
    case 121: // ERROR_SEM_TIMEOUT: the pipe timeout expired
      return 'TIMEOUT';
    case 31: // ERROR_GEN_FAILURE: the device answered STALL
      return 'STALL';
    case 2: // ERROR_FILE_NOT_FOUND
    case 3: // ERROR_PATH_NOT_FOUND
    case 6: // ERROR_INVALID_HANDLE
    case 22: // ERROR_BAD_COMMAND: the device went away under the handle
    case 433: // ERROR_NO_SUCH_DEVICE
    case 995: // ERROR_OPERATION_ABORTED
    case 1167: // ERROR_DEVICE_NOT_CONNECTED
      return 'NO_DEVICE';
    default:
      return 'IO';
  }
}

export class Win32Error extends Error {
  constructor(what, error = GetLastError()) {
    super(`${what} failed (Win32 error ${error})`);
    this.win32 = error;
    this.code = classifyWin32(error);
  }
}

// --- discovery ---------------------------------------------------------------

/**
 * Every Keysight (vendor 0x0957) USBTMC instrument on USB right now, as
 * [{ serial, model, productId, service, path }]. Not only the N9340B: other
 * Keysight handhelds are offered too and driven the same way. `model` is the
 * product string the device reports ("N9340B"), or null. `service` is the
 * bound driver's service name ('WinUSB' is driven directly; Keysight's IO
 * Libraries binds 'Usbtmc'; null means no driver). Never opens a device.
 */
export function listWinusbUnits() {
  const set = SetupDiGetClassDevsW(
    GUID_DEVINTERFACE_USB_DEVICE,
    null,
    null,
    DIGCF_PRESENT | DIGCF_DEVICEINTERFACE
  );
  if (koffi.address(set) === INVALID_HANDLE_VALUE) throw new Win32Error('SetupDiGetClassDevs');
  const units = [];
  try {
    for (let index = 0; ; index++) {
      const iface = { cbSize: koffi.sizeof('SP_DEVICE_INTERFACE_DATA') };
      if (!SetupDiEnumDeviceInterfaces(set, null, GUID_DEVINTERFACE_USB_DEVICE, index, iface)) {
        break; // ERROR_NO_MORE_ITEMS
      }
      const info = { cbSize: koffi.sizeof('SP_DEVINFO_DATA') };
      const required = [0];
      SetupDiGetDeviceInterfaceDetailW(set, iface, null, 0, required, null);
      if (!required[0]) continue;
      const detail = Buffer.alloc(required[0]);
      // cbSize of SP_DEVICE_INTERFACE_DETAIL_DATA_W: the DWORD plus one WCHAR, aligned
      detail.writeUInt32LE(POINTER_BYTES === 8 ? 8 : 6, 0);
      if (!SetupDiGetDeviceInterfaceDetailW(set, iface, detail, detail.length, required, info)) {
        continue;
      }
      const path = utf16(detail.subarray(4));
      const ids = /vid_0957&pid_([0-9a-f]{4})(&mi_)?/i.exec(path);
      // a Keysight device, and the whole device rather than one function of
      // a composite one (those have no serial-based instance id of their own)
      if (!ids || ids[2]) continue;
      const type = [0];
      const text = (property) => {
        const buf = Buffer.alloc(1024);
        return SetupDiGetDeviceRegistryPropertyW(set, info, property, type, buf, buf.length, required)
          ? buf.subarray(0, required[0])
          : null;
      };

      // a test-and-measurement instrument: Keysight also makes USB devices
      // that are not (GPIB adapters, dongles), and those are not offered
      const compatible = text(SPDRP_COMPATIBLEIDS)?.toString('utf16le').split('\0') ?? [];
      if (!compatible.some((id) => USBTMC_COMPATIBLE_ID.test(id))) continue;

      // the instance id keeps the serial's case; the interface path lower-cases it
      const idBuf = Buffer.alloc(512);
      if (!SetupDiGetDeviceInstanceIdW(set, info, idBuf, idBuf.length / 2, required)) continue;
      const instanceId = utf16(idBuf);
      const serial = instanceId.split('\\').pop();
      // no iSerialNumber: Windows makes up a port-based id like 5&2c1a3f&0&3
      if (!serial || serial.includes('&')) continue;

      const svc = text(SPDRP_SERVICE);
      const service = svc ? utf16(svc) || null : null;

      const descBuf = Buffer.alloc(512);
      const model = SetupDiGetDevicePropertyW(
        set,
        info,
        DEVPKEY_Device_BusReportedDeviceDesc,
        type,
        descBuf,
        descBuf.length,
        required,
        0
      )
        ? utf16(descBuf).trim() || null
        : null;

      units.push({ serial, model, productId: parseInt(ids[1], 16), service, path });
    }
  } finally {
    SetupDiDestroyDeviceInfoList(set);
  }
  return units;
}

export const isWinusb = (service) => /^winusb$/i.test(service ?? '');

/** Keysight IO Libraries' USBTMC driver (service Usbtmc), reached through VISA. */
export const isVendorUsbtmc = (service) => /usbtmc/i.test(service ?? '');

/**
 * Is a VISA library installed? A file check, so the plugin process never
 * loads VISA itself; driver/visa.js does that, in the worker.
 */
export function visaInstalled() {
  const dll = POINTER_BYTES === 8 ? 'visa64.dll' : 'visa32.dll';
  return existsSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', dll));
}

// --- the device --------------------------------------------------------------

/**
 * Open one unit through WinUSB. Blocking: for driver/winusb-worker.js only.
 * Returns { interfaceNumber, pipes, bulkOut, bulkIn, control, resetPipe, close }.
 */
export function openWinusbDevice(path) {
  const file = CreateFileW(
    path,
    GENERIC_READ_WRITE,
    FILE_SHARE_READ_WRITE,
    null,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED,
    null
  );
  if (koffi.address(file) === INVALID_HANDLE_VALUE) {
    const error = GetLastError();
    const err = new Win32Error('CreateFile', error);
    // ERROR_ACCESS_DENIED: another program (or another adapter) holds it
    if (error === 5) err.message = 'the analyzer is open in another program';
    throw err;
  }
  const out = [null];
  if (!WinUsb_Initialize(file, out)) {
    const err = new Win32Error('WinUsb_Initialize');
    CloseHandle(file);
    throw err;
  }
  const handle = out[0];

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    WinUsb_Free(handle);
    CloseHandle(file);
  };

  try {
    const descriptor = {};
    if (!WinUsb_QueryInterfaceSettings(handle, INTERFACE_INDEX, descriptor)) {
      throw new Win32Error('WinUsb_QueryInterfaceSettings');
    }
    const pipes = [];
    for (let i = 0; i < descriptor.bNumEndpoints; i++) {
      const pipe = {};
      if (WinUsb_QueryPipe(handle, INTERFACE_INDEX, i, pipe)) {
        // wMaxPacketSize is reported for information only: the N9340B
        // claims 16384 on its bulk endpoints, impossible at full speed
        pipes.push({
          type: pipe.PipeType,
          id: pipe.PipeId,
          maxPacket: pipe.MaximumPacketSize,
        });
      }
    }
    const bulkOutId = pipes.find((p) => p.type === PIPE_TYPE_BULK && !(p.id & 0x80))?.id;
    const bulkInId = pipes.find((p) => p.type === PIPE_TYPE_BULK && p.id & 0x80)?.id;
    if (bulkOutId === undefined || bulkInId === undefined) {
      throw Object.assign(new Error('the USBTMC interface has no bulk endpoints'), { code: 'IO' });
    }

    // pipe timeouts are a per-pipe policy; set one only when it changes
    const timeouts = new Map();
    const setTimeout = (pipeId, ms) => {
      const value = Math.max(1, Math.round(ms));
      if (timeouts.get(pipeId) === value) return;
      const buf = Buffer.alloc(4);
      buf.writeUInt32LE(value, 0);
      if (!WinUsb_SetPipePolicy(handle, pipeId, PIPE_TRANSFER_TIMEOUT, 4, buf)) {
        throw new Win32Error('WinUsb_SetPipePolicy');
      }
      timeouts.set(pipeId, value);
    };

    return {
      interfaceNumber: descriptor.bInterfaceNumber,
      interfaceClass: [
        descriptor.bInterfaceClass,
        descriptor.bInterfaceSubClass,
        descriptor.bInterfaceProtocol,
      ],
      pipes,
      hasInterrupt: pipes.some((p) => p.type === PIPE_TYPE_INTERRUPT),

      bulkOut(buffer, timeoutMs) {
        setTimeout(bulkOutId, timeoutMs);
        const sent = [0];
        if (!WinUsb_WritePipe(handle, bulkOutId, buffer, buffer.length, sent, null)) {
          throw new Win32Error('WinUsb_WritePipe');
        }
        return sent[0];
      },

      bulkIn(length, timeoutMs) {
        setTimeout(bulkInId, timeoutMs);
        const buf = Buffer.alloc(length);
        const got = [0];
        if (!WinUsb_ReadPipe(handle, bulkInId, buf, length, got, null)) {
          throw new Win32Error('WinUsb_ReadPipe');
        }
        return buf.subarray(0, got[0]);
      },

      control({ requestType, request, value, index, length }, timeoutMs) {
        setTimeout(0, timeoutMs);
        const buf = Buffer.alloc(Math.max(length, 1));
        const got = [0];
        const setup = {
          RequestType: requestType,
          Request: request,
          Value: value,
          Index: index,
          Length: length,
        };
        if (!WinUsb_ControlTransfer(handle, setup, buf, length, got, null)) {
          throw new Win32Error('WinUsb_ControlTransfer');
        }
        return buf.subarray(0, got[0]);
      },

      /** CLEAR_FEATURE(ENDPOINT_HALT) and a data-toggle reset. */
      resetPipe(which) {
        const id = which === 'in' ? bulkInId : bulkOutId;
        if (!WinUsb_ResetPipe(handle, id)) throw new Win32Error('WinUsb_ResetPipe');
      },

      close,
    };
  } catch (err) {
    close();
    throw err;
  }
}
