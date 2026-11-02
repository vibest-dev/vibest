# `until-file.py <file> <seconds> argv…`: run an interactive program (a harness's TUI) on a pseudo-terminal until <file>
# exists or <seconds> pass, then stop it. Exit 0 when the file appeared; otherwise 1, with the end of its screen output on stderr.
import os, pty, select, signal, sys, time

file, seconds, argv = sys.argv[1], float(sys.argv[2]), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)

screen = b""
deadline = time.time() + seconds
while time.time() < deadline and not os.path.exists(file):
    if select.select([fd], [], [], 0.5)[0]:
        try:
            screen = (screen + os.read(fd, 65536))[-4000:]
        except OSError:
            break
seen = os.path.exists(file)
# Let the turn's last hooks finish before the program goes.
time.sleep(2 if seen else 0)
# Closing the terminal first: an exiting child would otherwise wait for its unread output to drain.
# A TUI may take SIGTERM as a request to confirm; it gets 3 seconds, then SIGKILL.
os.close(fd)
os.kill(pid, signal.SIGTERM)
for _ in range(30):
    if os.waitpid(pid, os.WNOHANG)[0]:
        break
    time.sleep(0.1)
else:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
if not seen:
    sys.stderr.write(screen.decode(errors="replace"))
sys.exit(0 if seen else 1)
