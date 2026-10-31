# Throwaway proof: USBTMC *IDN? to the N9340B through winusb.dll directly (no libusb).
import ctypes, struct, sys
from ctypes import wintypes as W

setupapi = ctypes.WinDLL('setupapi', use_last_error=True)
kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
winusb = ctypes.WinDLL('winusb', use_last_error=True)

class GUID(ctypes.Structure):
    _fields_ = [('a', W.DWORD), ('b', W.WORD), ('c', W.WORD), ('d', ctypes.c_ubyte * 8)]
GUID_USB_DEVICE = GUID(0xA5DCBF10, 0x6530, 0x11D2, (ctypes.c_ubyte * 8)(0x90, 0x1F, 0x00, 0xC0, 0x4F, 0xB9, 0x51, 0xED))

class SP_DEVICE_INTERFACE_DATA(ctypes.Structure):
    _fields_ = [('cbSize', W.DWORD), ('guid', GUID), ('flags', W.DWORD), ('reserved', ctypes.c_void_p)]

setupapi.SetupDiGetClassDevsW.restype = ctypes.c_void_p
setupapi.SetupDiGetClassDevsW.argtypes = [ctypes.POINTER(GUID), W.LPCWSTR, W.HWND, W.DWORD]
setupapi.SetupDiEnumDeviceInterfaces.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(GUID), W.DWORD, ctypes.POINTER(SP_DEVICE_INTERFACE_DATA)]
setupapi.SetupDiGetDeviceInterfaceDetailW.argtypes = [ctypes.c_void_p, ctypes.POINTER(SP_DEVICE_INTERFACE_DATA), ctypes.c_void_p, W.DWORD, ctypes.POINTER(W.DWORD), ctypes.c_void_p]
kernel32.CreateFileW.restype = W.HANDLE
kernel32.CreateFileW.argtypes = [W.LPCWSTR, W.DWORD, W.DWORD, ctypes.c_void_p, W.DWORD, W.DWORD, W.HANDLE]
winusb.WinUsb_Initialize.argtypes = [W.HANDLE, ctypes.POINTER(ctypes.c_void_p)]
winusb.WinUsb_WritePipe.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_void_p, W.ULONG, ctypes.POINTER(W.ULONG), ctypes.c_void_p]
winusb.WinUsb_ReadPipe.argtypes = winusb.WinUsb_WritePipe.argtypes
winusb.WinUsb_SetPipePolicy.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, W.ULONG, W.ULONG, ctypes.c_void_p]
winusb.WinUsb_QueryInterfaceSettings.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_void_p]
winusb.WinUsb_QueryPipe.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_ubyte, ctypes.c_void_p]

DIGCF_PRESENT, DIGCF_DEVICEINTERFACE = 0x2, 0x10
info = setupapi.SetupDiGetClassDevsW(ctypes.byref(GUID_USB_DEVICE), None, None, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE)
path = None
i = 0
while True:
    d = SP_DEVICE_INTERFACE_DATA(); d.cbSize = ctypes.sizeof(d)
    if not setupapi.SetupDiEnumDeviceInterfaces(info, None, ctypes.byref(GUID_USB_DEVICE), i, ctypes.byref(d)):
        break
    i += 1
    need = W.DWORD()
    setupapi.SetupDiGetDeviceInterfaceDetailW(info, ctypes.byref(d), None, 0, ctypes.byref(need), None)
    buf = ctypes.create_string_buffer(need.value)
    struct.pack_into('I', buf, 0, 8)  # cbSize of SP_DEVICE_INTERFACE_DETAIL_DATA_W on 64-bit
    if setupapi.SetupDiGetDeviceInterfaceDetailW(info, ctypes.byref(d), buf, need, None, None):
        p = ctypes.wstring_at(ctypes.addressof(buf) + 4)
        if 'vid_0957&pid_ffef' in p.lower():
            path = p
print('path', path)
if not path:
    sys.exit(1)

h = kernel32.CreateFileW(path, 0xC0000000, 3, None, 3, 0x40000080, None)  # RW, share RW, OPEN_EXISTING, OVERLAPPED|NORMAL
print('CreateFile', h, ctypes.get_last_error())
wu = ctypes.c_void_p()
ok = winusb.WinUsb_Initialize(h, ctypes.byref(wu))
print('WinUsb_Initialize', ok, ctypes.get_last_error())
if not ok:
    sys.exit(1)
ifd = ctypes.create_string_buffer(9)
print('QueryInterfaceSettings', winusb.WinUsb_QueryInterfaceSettings(wu, 0, ifd), list(ifd.raw))
for k in range(ifd.raw[4]):
    pi = ctypes.create_string_buffer(12)
    winusb.WinUsb_QueryPipe(wu, 0, k, pi)
    ptype, pid, mps = struct.unpack_from('<iBH', pi.raw)
    print(f'  pipe {k}: type {ptype} id 0x{pid:02x} maxPacket {mps}')

PIPE_TRANSFER_TIMEOUT = 0x03
t = W.ULONG(3000)
for ep in (0x02, 0x81):
    winusb.WinUsb_SetPipePolicy(wu, ep, PIPE_TRANSFER_TIMEOUT, 4, ctypes.byref(t))

tag = 0
def nxt():
    global tag; tag = tag % 255 + 1; return tag
def out(b):
    n = W.ULONG()
    ok = winusb.WinUsb_WritePipe(wu, 0x02, b, len(b), ctypes.byref(n), None)
    if not ok: raise OSError(ctypes.get_last_error(), 'WritePipe')
def write(text):
    data = text.encode('latin1') + b'\n'
    t = nxt()
    hdr = struct.pack('<BBBxIBxxx', 1, t, ~t & 0xff, len(data), 1)
    out(hdr + data + b'\0' * ((4 - len(data) % 4) % 4))
def read(maxb=65536):
    parts = []
    while True:
        t = nxt()
        out(struct.pack('<BBBxIBxxx', 2, t, ~t & 0xff, maxb, 0))
        buf = ctypes.create_string_buffer(12 + maxb)
        n = W.ULONG()
        if not winusb.WinUsb_ReadPipe(wu, 0x81, buf, len(buf), ctypes.byref(n), None):
            raise OSError(ctypes.get_last_error(), 'ReadPipe')
        b = buf.raw[:n.value]
        assert b[0] == 2 and b[1] == t and b[2] == (~t & 0xff), ('bad header', b[:12])
        size = struct.unpack_from('<I', b, 4)[0]
        parts.append(b[12:12 + size])
        if b[8] & 1:
            return b''.join(parts)

write('*IDN?')
print('IDN', read().decode('latin1').strip())
write(':SENS:SWE:TIME?')
print('sweep time', read().decode('latin1').strip())
winusb.WinUsb_Free(wu)
kernel32.CloseHandle(h)
