import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type DaemonRecord,
  readRecord,
  recordPath,
  removeRecord,
  writeRecord,
} from "../../src/daemon/record";

const record: DaemonRecord = {
  pid: 4321,
  address: "http://127.0.0.1:41234",
  token: "sekret",
  startedAt: 1_700_000_000_000,
};

describe("daemon record", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-daemon-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("round-trips through daemon.pid", () => {
    writeRecord(home, record);
    expect(readRecord(home)).toEqual(record);
  });

  it("writes daemon.pid at the expected path", () => {
    writeRecord(home, record);
    expect(recordPath(home)).toBe(path.join(home, "daemon.pid"));
  });

  // Windows does not honor unix perms; the token is only a secret on posix.
  it.skipIf(process.platform === "win32")("writes daemon.pid with 0600 perms", () => {
    writeRecord(home, record);
    expect(fs.statSync(recordPath(home)).mode & 0o777).toBe(0o600);
  });

  it("returns undefined when the record is missing", () => {
    expect(readRecord(home)).toBeUndefined();
  });

  it("returns undefined for a garbage or incomplete record", () => {
    fs.writeFileSync(recordPath(home), "not json");
    expect(readRecord(home)).toBeUndefined();

    fs.writeFileSync(recordPath(home), JSON.stringify({ pid: 1 }));
    expect(readRecord(home)).toBeUndefined();
  });

  it("removeRecord is a no-op when the file is already gone", () => {
    expect(() => removeRecord(home)).not.toThrow();
    writeRecord(home, record);
    removeRecord(home);
    expect(readRecord(home)).toBeUndefined();
  });
});
