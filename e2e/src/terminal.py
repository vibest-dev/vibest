# Run argv on a pseudo-terminal and answer its questions: each time it prints a "[y/N]" or "[Y/n]" prompt, type the next line of
# stdin. Typing ahead does not work: a program that sets up the terminal may flush what was typed before it asked.
# Copies the output to stdout and exits with the child's status once the child exits.
import os, pty, re, select, sys

answers = sys.stdin.read().splitlines()
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

since = b""
status = None
while True:
    ready, _, _ = select.select([fd], [], [], 0.05)
    data = b""
    if ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            pass
    if data:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        since += data
        if answers and re.search(rb"\[(y/N|Y/n)\]:?\s*$", since):
            os.write(fd, (answers.pop(0) + "\n").encode())
            since = b""
        continue
    if status is None:
        done, raw = os.waitpid(pid, os.WNOHANG)
        if done:
            status = raw
    # Exited and nothing more to read (macOS reports a closed terminal as readable with no data).
    if status is not None:
        break
sys.exit(os.waitstatus_to_exitcode(status))
