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
