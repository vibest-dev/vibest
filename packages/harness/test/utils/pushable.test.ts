import { describe, expect, it } from "vitest";

import { Pushable } from "../../src/claude-code/utils/pushable";

describe("Pushable", () => {
  it("yields queued values immediately when available", async () => {
    const pushable = new Pushable<number>();

    pushable.push(1);
    pushable.push(2);

    await expect(pushable.next()).resolves.toEqual({ value: 1, done: false });
    await expect(pushable.next()).resolves.toEqual({ value: 2, done: false });
  });

  it("resolves pending next calls once values are pushed", async () => {
    const pushable = new Pushable<string>();

    const nextPromise = pushable.next();
    const stateBeforePush = await Promise.race([
      nextPromise.then(() => "resolved"),
      Promise.resolve("pending"),
    ]);

    expect(stateBeforePush).toBe("pending");

    pushable.push("hello");

    await expect(nextPromise).resolves.toEqual({ value: "hello", done: false });
  });

  it("delivers values to multiple pending next callers in order", async () => {
    const pushable = new Pushable<number>();

    const first = pushable.next();
    const second = pushable.next();

    pushable.push(5);
    pushable.push(10);

    await expect(first).resolves.toEqual({ value: 5, done: false });
    await expect(second).resolves.toEqual({ value: 10, done: false });
  });

  it("resolves pending and future next calls with done after end", async () => {
    const pushable = new Pushable<number>();

    const pending = pushable.next();
    pushable.end();

    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    await expect(pushable.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it("resolves all pending next calls when ended", async () => {
    const pushable = new Pushable<number>();

    const first = pushable.next();
    const second = pushable.next();

    pushable.end();

    await expect(first).resolves.toEqual({ value: undefined, done: true });
    await expect(second).resolves.toEqual({ value: undefined, done: true });
  });

  it("delivers queued values before reporting completion", async () => {
    const pushable = new Pushable<number>();

    pushable.push(7);
    pushable.push(8);
    pushable.end();

    await expect(pushable.next()).resolves.toEqual({ value: 7, done: false });
    await expect(pushable.next()).resolves.toEqual({ value: 8, done: false });
    await expect(pushable.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it("supports for-await-of consumption", async () => {
    const pushable = new Pushable<number>();
    const values: number[] = [];

    const consumer = (async () => {
      for await (const value of pushable) {
        values.push(value);
      }
    })();

    pushable.push(1);
    pushable.push(2);
    pushable.end();

    await consumer;

    expect(values).toEqual([1, 2]);
  });
});
