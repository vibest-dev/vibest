import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
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

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

describe("daemon record", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-daemon-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("round-trips through daemon.pid", async () => {
    await run(writeRecord(home, record));
    expect(await run(readRecord(home))).toEqual(record);
  });

  it("writes daemon.pid at the expected path", async () => {
    await run(writeRecord(home, record));
    expect(await run(recordPath(home))).toBe(path.join(home, "daemon.pid"));
  });

  // Windows does not honor unix perms; the token is only a secret on posix.
  it.skipIf(process.platform === "win32")("writes daemon.pid with 0600 perms", async () => {
    await run(writeRecord(home, record));
    expect(fs.statSync(path.join(home, "daemon.pid")).mode & 0o777).toBe(0o600);
  });

  it("returns undefined when the record is missing", async () => {
    expect(await run(readRecord(home))).toBeUndefined();
  });

  it("returns undefined for a garbage or incomplete record", async () => {
    const file = path.join(home, "daemon.pid");
    fs.writeFileSync(file, "not json");
    expect(await run(readRecord(home))).toBeUndefined();

    fs.writeFileSync(file, JSON.stringify({ pid: 1 }));
    expect(await run(readRecord(home))).toBeUndefined();
  });

  it("removeRecord is a no-op when the file is already gone", async () => {
    await expect(run(removeRecord(home))).resolves.toBeUndefined();
    await run(writeRecord(home, record));
    await run(removeRecord(home));
    expect(await run(readRecord(home))).toBeUndefined();
  });
});
