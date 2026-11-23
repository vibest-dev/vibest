import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
import tty

capture, *command = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.execvp(command[0], command)

def stop(_signal, _frame):
    raise SystemExit(0)

def resize(_signal=None, _frame=None):
    fcntl.ioctl(master, termios.TIOCSWINSZ, fcntl.ioctl(0, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0)))

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGHUP, stop)
signal.signal(signal.SIGWINCH, resize)
original = termios.tcgetattr(0)
tty.setraw(0)
resize()
try:
    with open(capture + ".raw", "wb") as raw, open(capture + ".jsonl", "w") as log:
        while True:
            readable, _, _ = select.select([master, 0], [], [])
            for source in readable:
                try:
                    data = os.read(source, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        raise SystemExit(0)
                    raise
                if not data:
                    raise SystemExit(0)
                log.write(json.dumps({"at": time.time(), "direction": "output" if source == master else "input", "data": data.decode("utf-8", "replace")}) + "\n")
                log.flush()
                if source == master:
                    raw.write(data)
                    raw.flush()
                elif os.environ.get("VIBEST_STATUS_NO_QUERY") == "1":
                    data = re.sub(rb"\x1b\]7501;\?[^\x07\x1b]*(?:\x07|\x1b\\)", b"", data)
                os.write(1 if source == master else master, data)
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, original)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    os.close(master)
    os.waitpid(pid, 0)
