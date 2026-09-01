import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  daemonStdioLogPath,
  logsDirectory,
  resolveDaemonDirectory,
  resolveDaemonLocation,
  resolveVibestHome,
  vibestLogPath,
} from "../src/config/paths";

describe("resolveVibestHome", () => {
  it("prefers an explicit VIBEST_HOME over any default", () => {
    expect(resolveVibestHome({ VIBEST_HOME: "/tmp/custom", NODE_ENV: "development" })).toBe(
      "/tmp/custom",
    );
  });

  it("defaults to ~/.vibest outside development", () => {
    expect(resolveVibestHome({})).toBe(path.join(os.homedir(), ".vibest"));
    expect(resolveVibestHome({ NODE_ENV: "production" })).toBe(path.join(os.homedir(), ".vibest"));
  });

  it("defaults to ~/.vibest-dev under NODE_ENV=development", () => {
    expect(resolveVibestHome({ NODE_ENV: "development" })).toBe(
      path.join(os.homedir(), ".vibest-dev"),
    );
  });

  it("treats an empty VIBEST_HOME as unset", () => {
    expect(resolveVibestHome({ VIBEST_HOME: "" })).toBe(path.join(os.homedir(), ".vibest"));
    expect(resolveVibestHome({ VIBEST_HOME: "   " })).toBe(path.join(os.homedir(), ".vibest"));
  });
});

describe("logsDirectory", () => {
  it("is $VIBEST_HOME/logs, with the process log and daemon stdio named beside it", () => {
    const logsDir = logsDirectory("/tmp/data");
    expect(logsDir).toBe(path.join("/tmp/data", "logs"));
    expect(vibestLogPath(logsDir)).toBe(path.join("/tmp/data", "logs", "vibest.log"));
    expect(daemonStdioLogPath(logsDir)).toBe(path.join("/tmp/data", "logs", "daemon-stdio.log"));
  });
});

describe("resolveDaemonDirectory", () => {
  it("prefers an explicit VIBEST_DAEMON_DIR without legacy-root compatibility", () => {
    const env = {
      VIBEST_HOME: "/tmp/data",
      VIBEST_DAEMON_DIR: "/tmp/daemon-state",
    };
    expect(resolveDaemonDirectory(env)).toBe("/tmp/daemon-state");
    expect(resolveDaemonLocation(env)).toEqual({
      home: "/tmp/data",
      daemonDir: "/tmp/daemon-state",
    });
  });

  it("defaults under VIBEST_HOME and exposes the legacy root during migration", () => {
    const env = { VIBEST_HOME: "/tmp/data" };
    expect(resolveDaemonDirectory(env)).toBe(path.join("/tmp/data", "daemon"));
    expect(resolveDaemonLocation(env)).toEqual({
      home: "/tmp/data",
      daemonDir: path.join("/tmp/data", "daemon"),
      legacyDaemonDir: "/tmp/data",
    });
  });

  it("follows the development VIBEST_HOME default", () => {
    expect(resolveDaemonDirectory({ NODE_ENV: "development" })).toBe(
      path.join(os.homedir(), ".vibest-dev", "daemon"),
    );
  });

  it("treats an empty VIBEST_DAEMON_DIR as unset", () => {
    expect(resolveDaemonDirectory({ VIBEST_HOME: "/tmp/data", VIBEST_DAEMON_DIR: "" })).toBe(
      path.join("/tmp/data", "daemon"),
    );
    expect(resolveDaemonDirectory({ VIBEST_HOME: "/tmp/data", VIBEST_DAEMON_DIR: "  " })).toBe(
      path.join("/tmp/data", "daemon"),
    );
  });
});
