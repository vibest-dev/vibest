import { describe, expect, it } from "vitest";

import {
  type BackendStatus,
  type ServerProcess,
  type SpawnServer,
  createSupervisor,
} from "./supervisor";

type FakeProc = ServerProcess & {
  port: number;
  becomeReady: (boundPort?: number) => void;
  failToStart: (error?: Error) => void;
  exit: () => void;
  killed: boolean;
};

/** A controllable spawn: each call records the requested port and returns a proc you drive by hand. */
function makeHarness() {
  const procs: FakeProc[] = [];
  const delays: number[] = [];
  let clock = 0;

  const spawn: SpawnServer = (port) => {
    let resolveReady!: (p: number) => void;
    let rejectReady!: (e: Error) => void;
    const ready = new Promise<number>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    // Swallow the default rejection so an unobserved failToStart doesn't warn.
    ready.catch(() => {});

    const exitListeners: Array<() => void> = [];
    const proc: FakeProc = {
      port,
      killed: false,
      ready,
      onExit: (listener) => exitListeners.push(listener),
      kill: () => {
        proc.killed = true;
      },
      becomeReady: (boundPort = port || 4000) => resolveReady(boundPort),
      failToStart: (error = new Error("exited before ready")) => {
        rejectReady(error);
        for (const l of exitListeners.splice(0)) l();
      },
      exit: () => {
        for (const l of exitListeners.splice(0)) l();
      },
    };
    procs.push(proc);
    return proc;
  };

  return {
    spawn,
    procs,
    delays,
    // delay() resolves immediately but records the requested duration.
    delay: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** Let queued microtasks (ready.then chains, delay.then restarts) run. */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function options(h: ReturnType<typeof makeHarness>, statuses: BackendStatus[]) {
  return {
    spawn: h.spawn,
    delay: h.delay,
    now: h.now,
    onStatus: (s: BackendStatus) => statuses.push(s),
    initialRestartDelayMs: 500,
    maxRestartDelayMs: 10_000,
    maxFastFailures: 5,
    stableAfterMs: 10_000,
  };
}

describe("createSupervisor", () => {
  it("starts on port 0 and resolves with the bound port", async () => {
    const h = makeHarness();
    const statuses: BackendStatus[] = [];
    const sup = createSupervisor(options(h, statuses));

    const startP = sup.start();
    await flush();
    expect(h.procs[0]?.port).toBe(0); // first start lets the OS pick
    h.procs[0]!.becomeReady(56789);

    await expect(startP).resolves.toBe(56789);
    expect(sup.status()).toBe("ready");
    // "starting" is the initial state, so only the transition to ready is emitted.
    expect(statuses).toEqual(["ready"]);
  });

  it("propagates a first-start failure and never enters the restart loop", async () => {
    const h = makeHarness();
    const statuses: BackendStatus[] = [];
    const sup = createSupervisor(options(h, statuses));

    const startP = sup.start();
    await flush();
    h.procs[0]!.failToStart();

    await expect(startP).rejects.toThrow("exited before ready");
    await flush();
    expect(h.procs).toHaveLength(1); // no restart spawned
    expect(statuses).not.toContain("reconnecting");
  });

  it("restarts a crashed server on the SAME pinned port", async () => {
    const h = makeHarness();
    const statuses: BackendStatus[] = [];
    const sup = createSupervisor(options(h, statuses));

    const startP = sup.start();
    await flush();
    h.procs[0]!.becomeReady(50000);
    await startP;

    h.advance(20_000); // ran healthily for a while
    h.procs[0]!.exit(); // crash
    await flush();

    expect(sup.status()).toBe("reconnecting");
    expect(h.procs[1]?.port).toBe(50000); // pinned, not 0
    h.procs[1]!.becomeReady();
    await flush();
    expect(sup.status()).toBe("ready");
  });

  it("backs off exponentially, capped, across consecutive fast failures", async () => {
    const h = makeHarness();
    const statuses: BackendStatus[] = [];
    const sup = createSupervisor(options(h, statuses));

    const startP = sup.start();
    await flush();
    h.procs[0]!.becomeReady(50000);
    await startP;

    // Each restart fails immediately (no uptime), so the failure count climbs.
    for (let i = 1; i <= 5; i += 1) {
      const proc = h.procs[h.procs.length - 1]!;
      proc.exit();
      await flush();
    }

    // 5 backoff waits, doubling from 500 and capped at 10_000.
    expect(h.delays).toEqual([500, 1000, 2000, 4000, 8000]);
  });

  it("gives up in a terminal failed state after too many fast failures", async () => {
    const h = makeHarness();
    const statuses: BackendStatus[] = [];
    const sup = createSupervisor(options(h, statuses));

    const startP = sup.start();
    await flush();
    h.procs[0]!.becomeReady(50000);
    await startP;

    // 6 consecutive fast failures: the 6th exceeds maxFastFailures = 5.
    for (let i = 0; i < 6; i += 1) {
      h.procs[h.procs.length - 1]!.exit();
      await flush();
    }

    expect(sup.status()).toBe("failed");
    const spawnCountAtFailure = h.procs.length;

    // No further restarts once failed.
    await flush();
    expect(h.procs).toHaveLength(spawnCountAtFailure);
    expect(statuses.at(-1)).toBe("failed");
  });

  it("resets the failure count after a run that stays up long enough", async () => {
    const h = makeHarness();
    const statuses: BackendStatus[] = [];
    const sup = createSupervisor(options(h, statuses));

    const startP = sup.start();
    await flush();
    h.procs[0]!.becomeReady(50000);
    await startP;

    // Two fast failures → backoff 500, 1000.
    h.procs[0]!.exit();
    await flush();
    h.procs[1]!.becomeReady();
    await flush();
    h.procs[1]!.exit();
    await flush();

    // The next server runs healthily past the stable threshold, then dies.
    h.procs[2]!.becomeReady();
    await flush();
    h.advance(15_000);
    h.procs[2]!.exit();
    await flush();

    // Backoff restarted at 500 because the healthy run reset the count.
    expect(h.delays).toEqual([500, 1000, 500]);
  });

  it("retry() clears a failed state and starts again", async () => {
    const h = makeHarness();
    const statuses: BackendStatus[] = [];
    const sup = createSupervisor(options(h, statuses));

    const startP = sup.start();
    await flush();
    h.procs[0]!.becomeReady(50000);
    await startP;

    for (let i = 0; i < 6; i += 1) {
      h.procs[h.procs.length - 1]!.exit();
      await flush();
    }
    expect(sup.status()).toBe("failed");

    sup.retry();
    await flush();
    expect(sup.status()).toBe("reconnecting");
    const retried = h.procs.at(-1)!;
    expect(retried.port).toBe(50000);
    retried.becomeReady();
    await flush();
    expect(sup.status()).toBe("ready");
  });

  it("stop() kills the current server and suppresses restarts", async () => {
    const h = makeHarness();
    const statuses: BackendStatus[] = [];
    const sup = createSupervisor(options(h, statuses));

    const startP = sup.start();
    await flush();
    h.procs[0]!.becomeReady(50000);
    await startP;

    sup.stop();
    expect(h.procs[0]!.killed).toBe(true);

    h.procs[0]!.exit(); // a late exit after stop must not restart
    await flush();
    expect(h.procs).toHaveLength(1);
    expect(sup.status()).not.toBe("reconnecting");
  });
});
