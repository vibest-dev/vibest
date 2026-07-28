import { Effect, FileSystem, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import { type JsonDocument, type JsonStoreLoadError, makeJsonDocument } from "../src";

const V1 = Schema.Struct({ theme: Schema.String });
const V2 = Schema.Struct({ theme: Schema.String, fontSize: Schema.Number });

describe("makeJsonDocument typing", () => {
  it("infers each migrate input from its sibling schema and the store value from `schema`", () => {
    // Constructing the effect is pure — nothing touches the filesystem here.
    const effect = makeJsonDocument({
      path: "/tmp/probe.json",
      schema: V2,
      migrations: [
        {
          schema: V1,
          migrate: (v1) => {
            expectTypeOf(v1.theme).toEqualTypeOf<string>();
            return { ...v1, fontSize: 14 };
          },
        },
      ],
      defaults: { theme: "light", fontSize: 14 },
    });

    const valueCheck: Effect.Effect<
      JsonDocument<{ readonly theme: string; readonly fontSize: number }>,
      JsonStoreLoadError,
      FileSystem.FileSystem
    > = effect;
    expect(valueCheck).toBe(effect);
  });

  it("accepts a store without migrations", () => {
    const effect = makeJsonDocument({
      path: "/tmp/probe.json",
      schema: V1,
      defaults: { theme: "light" },
    });
    const valueCheck: Effect.Effect<
      JsonDocument<{ readonly theme: string }>,
      JsonStoreLoadError,
      FileSystem.FileSystem
    > = effect;
    expect(valueCheck).toBe(effect);
  });
});
