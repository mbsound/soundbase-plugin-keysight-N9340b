# Throwaway: control transfers on EP0 (USBTMC class requests + standard GET_CONFIGURATION) via winusb.dll.
import ctypes, struct, sys
from ctypes import wintypes as W
exec(open(__file__.replace('winusb_ctrl.py', 'winusb_probe.py')).read().split("PIPE_TRANSFER_TIMEOUT = 0x03")[0])

class SETUP(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('bmRequestType', ctypes.c_ubyte), ('bRequest', ctypes.c_ubyte), ('wValue', W.USHORT), ('wIndex', W.USHORT), ('wLength', W.USHORT)]
winusb.WinUsb_ControlTransfer.argtypes = [ctypes.c_void_p, SETUP, ctypes.c_void_p, W.ULONG, ctypes.POINTER(W.ULONG), ctypes.c_void_p]
winusb.WinUsb_GetCurrentAlternateSetting.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ubyte)]
t = W.ULONG(3000)
winusb.WinUsb_SetPipePolicy(wu, 0x00, 0x03, 4, ctypes.byref(t))

def ctrl(name, rt, req, val, idx, length):
    buf = ctypes.create_string_buffer(max(length, 1)); n = W.ULONG()
    ok = winusb.WinUsb_ControlTransfer(wu, SETUP(rt, req, val, idx, length), buf, length, ctypes.byref(n), None)
    err = ctypes.get_last_error()
    print(f'{name:28s} ok={ok} err={0 if ok else err} data={buf.raw[:n.value].hex(" ") if ok else ""}')

ctrl('GET_CONFIGURATION', 0x80, 8, 0, 0, 1)
ctrl('GET_STATUS(device)', 0x80, 0, 0, 0, 2)
ctrl('GET_STATUS(ep 0x02)', 0x82, 0, 0, 0x02, 2)
ctrl('GET_STATUS(ep 0x81)', 0x82, 0, 0, 0x81, 2)
ctrl('USBTMC GET_CAPABILITIES', 0xA1, 7, 0, 0, 0x18)
ctrl('USBTMC INITIATE_CLEAR', 0xA1, 5, 0, 0, 1)
ctrl('USBTMC CHECK_CLEAR_STATUS', 0xA1, 6, 0, 0, 2)
ctrl('USB488 READ_STATUS_BYTE', 0xA1, 128, 2, 0, 3)
winusb.WinUsb_Free(wu); kernel32.CloseHandle(h)
