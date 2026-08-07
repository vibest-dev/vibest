import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveTelemetryConfig } from "../../src/telemetry";

// `resolveTelemetryConfig` takes the environment as a parameter, so these need
// no `process.env` juggling.
const withEnv = (env: NodeJS.ProcessEnv) =>
  resolveTelemetryConfig({ VIBEST_HOME: "/tmp/h", ...env });

describe("resolveTelemetryConfig", () => {
  it("puts logs under $VIBEST_HOME", () => {
    expect(withEnv({}).logsDir).toBe(path.join("/tmp/h", "logs"));
  });

  it("inherits the dev/prod home split, so the two never share a log file", () => {
    const dev = resolveTelemetryConfig({ NODE_ENV: "development" }).logsDir;
    const prod = resolveTelemetryConfig({}).logsDir;
    expect(dev).not.toBe(prod);
    expect(dev).toContain(".vibest-dev");
  });

  it("defaults to Info, pretty console, 30 days", () => {
    const config = withEnv({});
    expect(config.minimumLogLevel).toBe("Info");
    expect(config.consoleFormat).toBe("pretty");
    expect(config.retentionDays).toBe(30);
  });

  it("reads the level and console format case-insensitively", () => {
    const config = withEnv({ VIBEST_LOG_LEVEL: "debug", VIBEST_LOG_CONSOLE: "QUIET" });
    expect(config.minimumLogLevel).toBe("Debug");
    expect(config.consoleFormat).toBe("quiet");
  });

  // A typo in an env var must not take the server down — logging is what would
  // have to report that failure.
  it("falls back to the default on an unrecognised value rather than failing", () => {
    const config = withEnv({ VIBEST_LOG_LEVEL: "loud", VIBEST_LOG_CONSOLE: "yaml" });
    expect(config.minimumLogLevel).toBe("Info");
    expect(config.consoleFormat).toBe("pretty");
  });

  it.each(["0", "-5", "many", ""])("rejects %o as a retention window", (raw) => {
    expect(withEnv({ VIBEST_LOG_RETENTION_DAYS: raw }).retentionDays).toBe(30);
  });

  it("accepts a positive retention window", () => {
    expect(withEnv({ VIBEST_LOG_RETENTION_DAYS: "7" }).retentionDays).toBe(7);
  });
});
