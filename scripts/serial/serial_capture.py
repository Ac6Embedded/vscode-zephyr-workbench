#!/usr/bin/env python3
# Serial port helper for the agent tools of Zephyr Workbench (the MCP `hardware`
# tool). The extension host runs it with the Python of the Zephyr virtual
# environment, whose requirements include pyserial, and talks to it over pipes:
#
#   --list
#       Print the serial ports as one JSON array on stdout. No port is opened.
#   --port P --baud B --duration S [--dtr]
#       Capture P, with DTR and RTS kept low unless --dtr raises DTR once the
#       port is open: the device's bytes go to stdout unchanged, status events go
#       to stderr as one JSON object per line ({"event": "opened"|"disconnected"|
#       "reopened"|"error"|"closed", ...}), and commands arrive on stdin as one
#       JSON object per line ({"id": 1, "send": "text", "line_ending": "crlf"}).
#
# stdin reaching its end means stop, so the helper never outlives the extension
# host that started it. It also stops after S seconds and on SIGTERM, and always
# closes the port on the way out.

import argparse
import errno
import json
import os
import queue
import signal
import sys
import threading
import time

# How often a port that went away is tried again, in seconds.
REOPEN_INTERVAL_S = 0.5
# How long one read waits for data, which bounds how late a command or a stop
# request is noticed.
READ_TIMEOUT_S = 0.05
LINE_ENDINGS = {"crlf": b"\r\n", "lf": b"\n", "cr": b"\r", "none": b""}


def emit(event, **fields):
    """One status event on stderr, never mixed with the device's own output."""
    record = {"event": event}
    record.update(fields)
    try:
        sys.stderr.write(json.dumps(record) + "\n")
        sys.stderr.flush()
    except (OSError, ValueError):
        # The host is gone; the main loop notices on its next write.
        pass


try:
    import serial
    from serial.tools import list_ports
except ImportError as import_error:
    emit("error", code="pyserial_missing", message=str(import_error))
    sys.exit(3)

if not hasattr(serial, "Serial"):
    # Another package named "serial" shadows pyserial.
    emit("error", code="pyserial_missing", message="the installed 'serial' module is not pyserial")
    sys.exit(3)

# What opening a port can raise. On POSIX, pyserial's open() calls termios
# functions it does not wrap, whose error is neither an OSError nor a
# SerialException: a device dropping in the middle of the open raises it.
try:
    import termios
    OPEN_ERRORS = (serial.SerialException, OSError, ValueError, termios.error)
except ImportError:
    OPEN_ERRORS = (serial.SerialException, OSError, ValueError)


def list_ports_json():
    ports = []
    for info in list_ports.comports():
        ports.append({
            "port": info.device,
            "description": info.description,
            "hwid": info.hwid,
            "vid": info.vid,
            "pid": info.pid,
            "serial_number": info.serial_number,
            "manufacturer": info.manufacturer,
            "product": info.product,
            "location": info.location,
            "interface": info.interface,
        })
    sys.stdout.write(json.dumps(ports) + "\n")
    sys.stdout.flush()
    return 0


def classify(error):
    """Why a port did not open: busy, not_found, permission or open_failed."""
    code = getattr(error, "errno", None)
    if code is None and error.args and isinstance(error.args[0], int):
        # termios.error carries its errno as its first argument.
        code = error.args[0]
    text = str(error)
    if isinstance(error, FileNotFoundError) or code == errno.ENOENT \
            or "No such file" in text or "FileNotFoundError" in text or "cannot find the file" in text:
        return "not_found"
    if os.name == "nt":
        # Windows opens a COM port for one program at a time and refuses the
        # next one with "Access is denied".
        if isinstance(error, PermissionError) or "Access is denied" in text or "PermissionError" in text:
            return "busy"
        return "open_failed"
    if code in (errno.EBUSY, errno.EAGAIN) or "Resource busy" in text or "exclusively lock" in text:
        return "busy"
    # On Linux and macOS, EACCES means the account may not open the device
    # (on Linux, usually not in the dialout group), not that it is in use.
    if code == errno.EACCES or isinstance(error, PermissionError) or "Permission denied" in text:
        return "permission"
    return "open_failed"


def open_port(port, baud, dtr=False):
    ser = serial.Serial()
    ser.port = port
    ser.baudrate = baud
    ser.timeout = READ_TIMEOUT_S
    ser.write_timeout = 2
    # Set before open, so pyserial applies them as the port opens: boards
    # whose reset or boot pin is wired to DTR or RTS (ESP32, Arduino-style)
    # are not reset by the capture. Some operating systems still pulse DTR
    # while the port opens.
    ser.dtr = False
    ser.rts = False
    if os.name == "posix":
        # Another program asking for the port exclusively is refused while
        # this capture holds it, instead of splitting the output with it.
        ser.exclusive = True
        # Linux and macOS raise DTR and RTS as the port opens, and pyserial
        # then lowers DTR before RTS. RTS high with DTR low is exactly the
        # reset step of an ESP32 auto-program circuit (EN low). With dsrdtr
        # set, pyserial's open() leaves DTR alone and lowers RTS first; DTR is
        # set right after. On POSIX pyserial uses dsrdtr for nothing else.
        ser.dsrdtr = True
    ser.open()
    if os.name == "posix" or dtr:
        # The board's own USB console (Zephyr's USB stack) waits for DTR
        # before it prints, and has no reset circuit on it.
        try:
            ser.dtr = bool(dtr)
        except (OSError, serial.SerialException) as error:
            # A device without modem lines (a pseudo-terminal) refuses it, as
            # pyserial's own open() allows.
            if getattr(error, "errno", None) not in (errno.EINVAL, errno.ENOTTY):
                raise
    return ser


def close_quietly(ser):
    if ser is None:
        return
    try:
        ser.close()
    except Exception:  # noqa: BLE001 - closing a vanished device may fail in any way
        pass


def send(ser, command):
    """Write one command's text. Raises SerialException when the device went away."""
    ident = command.get("id")
    text = command.get("send")
    line_ending = command.get("line_ending", "crlf")
    ending = LINE_ENDINGS.get(line_ending) if isinstance(line_ending, str) else None
    if not isinstance(text, str) or ending is None:
        emit("send_failed", id=ident, message="malformed command")
        return
    try:
        data = text.encode("utf-8") + ending
    except UnicodeError:
        # Half of a UTF-16 surrogate pair has no UTF-8 form. One bad command
        # must never end the capture.
        emit("send_failed", id=ident, message="the text is not valid Unicode")
        return
    try:
        # No flush(): it waits until the device has taken every byte, which a
        # halted board never does, and the capture would stop reading meanwhile.
        # write() returns once the bytes are with the driver, bounded by
        # write_timeout.
        ser.write(data)
    except serial.SerialTimeoutException as error:
        emit("send_failed", id=ident, message=str(error) or "write timeout")
        return
    except (serial.SerialException, OSError) as error:
        emit("send_failed", id=ident, message=str(error) or "the device is disconnected")
        raise
    emit("sent", id=ident, bytes=len(data))


def capture(port, baud, duration, dtr=False):
    commands = queue.Queue()
    stop = threading.Event()
    stop_reason = []

    def request_stop(why):
        if not stop_reason:
            stop_reason.append(why)
        stop.set()

    def take(raw):
        line = raw.strip()
        if not line:
            return
        try:
            commands.put(json.loads(line.decode("utf-8")))
        except (ValueError, UnicodeDecodeError):
            emit("send_failed", id=None, message="command is not JSON")

    def read_stdin():
        # Raw reads of the descriptor, never sys.stdin: this thread is still
        # blocked reading when the capture ends by itself (its duration, an
        # open error) while the host holds stdin open, and a thread blocked in
        # the buffered reader holds its lock, which makes the interpreter abort
        # at exit ("Fatal Python error: _enter_buffered_busy").
        pending = b""
        try:
            fd = sys.stdin.fileno()
            while True:
                chunk = os.read(fd, 4096)
                if not chunk:
                    break
                lines = (pending + chunk).split(b"\n")
                pending = lines.pop()
                for raw in lines:
                    take(raw)
            take(pending)
        except (OSError, ValueError, AttributeError):
            pass
        request_stop("stdin")

    threading.Thread(target=read_stdin, daemon=True).start()
    for name in ("SIGTERM", "SIGINT", "SIGBREAK"):
        if hasattr(signal, name):
            try:
                signal.signal(getattr(signal, name), lambda *_: request_stop("signal"))
            except (OSError, ValueError):
                pass

    deadline = time.monotonic() + duration
    emit("ready")
    try:
        ser = open_port(port, baud, dtr)
    except OPEN_ERRORS as error:
        emit("error", code=classify(error), message=str(error), port=port)
        return 2
    emit("opened", port=port, baud=baud)

    out = sys.stdout.buffer
    next_attempt = 0.0
    while not stop.is_set():
        now = time.monotonic()
        if now >= deadline:
            request_stop("duration")
            break
        if ser is None:
            # Commands cannot reach a device that is not there.
            while not commands.empty():
                command = commands.get_nowait()
                emit("send_failed", id=command.get("id") if isinstance(command, dict) else None,
                     message="the device is disconnected")
            if now >= next_attempt:
                try:
                    ser = open_port(port, baud, dtr)
                    emit("reopened", port=port)
                    continue
                except OPEN_ERRORS:
                    next_attempt = now + REOPEN_INTERVAL_S
            stop.wait(READ_TIMEOUT_S)
            continue
        try:
            while not commands.empty():
                command = commands.get_nowait()
                if isinstance(command, dict):
                    send(ser, command)
            data = ser.read(max(1, ser.in_waiting))
        except (serial.SerialException, OSError) as error:
            # A USB device re-enumerating after a flash, or a board whose
            # console is its own USB port, comes back under the same name.
            close_quietly(ser)
            ser = None
            emit("disconnected", message=str(error))
            next_attempt = time.monotonic() + REOPEN_INTERVAL_S
            continue
        if data:
            try:
                out.write(data)
                out.flush()
            except (OSError, ValueError):
                request_stop("host_gone")
                break

    close_quietly(ser)
    emit("closed", reason=stop_reason[0] if stop_reason else "stopped")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Serial port helper for Zephyr Workbench agents.")
    parser.add_argument("--list", action="store_true", help="print the serial ports as JSON and exit")
    parser.add_argument("--port", help="the port to capture, as --list prints it")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--duration", type=float, default=600.0, help="seconds before the capture stops by itself")
    parser.add_argument("--dtr", action="store_true", help="raise DTR once the port is open (a board's own USB console)")
    args = parser.parse_args()
    if args.list:
        return list_ports_json()
    if not args.port:
        parser.error("--port is required without --list")
    return capture(args.port, args.baud, args.duration, args.dtr)


if __name__ == "__main__":
    sys.exit(main())
