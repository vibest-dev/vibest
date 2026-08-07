import path from "node:path";

const FILE_PREFIX = "server-";
const FILE_SUFFIX = ".jsonl";

/** Matches a rolled log file and captures its day. */
export const LOG_FILE_PATTERN = /^server-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * `YYYY-MM-DD` in **local** time, not UTC. Retrospection is a human activity in
 * a human timezone — a UTC boundary would split "today" across two files for
 * most of the world.
 *
 * Lexicographic order on this format is chronological order, which is what
 * makes the retention sweep a string comparison.
 */
export const dayKey = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};

/** The file a line written at `date` belongs in. */
export const logFileFor = (directory: string, date: Date): string =>
  path.join(directory, `${FILE_PREFIX}${dayKey(date)}${FILE_SUFFIX}`);

/** `$VIBEST_HOME/logs` — the one place any vibest process writes a log. */
export const logsDirectory = (home: string): string => path.join(home, "logs");

/**
 * Owner-only, matching `daemon.pid` (which holds the auth token). Log lines
 * carry working directories, project and session ids, and whatever an agent
 * wrote to stderr; the default `0644`/`0755` would publish all of that to every
 * account on a shared machine.
 *
 * Here rather than beside either writer because there are two, in different
 * processes, and **whichever runs first decides**: the launcher opens
 * `daemon-stdio.log` before the daemon exists, so it — not the batched sink
 * inside the daemon — is what creates `logs/` on a fresh install. A mode set on
 * only one of them is a mode that does not hold.
 *
 * Both apply at creation only, so an install that predates this keeps whatever
 * it was made with.
 */
export const LOG_FILE_MODE = 0o600;
export const LOG_DIRECTORY_MODE = 0o700;

/**
 * Where a detached daemon's raw stdout/stderr lands.
 *
 * This is not application logging — that goes to `server-<date>.jsonl` in the
 * same directory, from the daemon and the foreground server alike. What is left
 * for this file is only what never passes through a logger: an OOM or segfault
 * message from the runtime, output from a library writing to fd 2 directly, and
 * anything printed before the telemetry context exists. In a healthy install it
 * holds nothing but the startup handshake.
 *
 * It lives beside the JSONL rather than in `$VIBEST_DAEMON_DIR` so that there is
 * a single place to look; the daemon directory keeps only lifecycle *state*
 * (`daemon.pid`, `.lock`, `.stopped`).
 */
export const stdioLogFile = (logsDir: string): string => path.join(logsDir, "daemon-stdio.log");
