import assert from "node:assert/strict";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expectTypeOf } from "vitest";

import { makeJsonDocument } from "../src";
import { withTmp } from "./helpers";

const Appearance = Schema.Struct({ theme: Schema.String, fontSize: Schema.Number });
const Settings = Schema.Struct({ appearance: Appearance, tags: Schema.Array(Schema.String) });
const defaults = {
  appearance: { theme: "light", fontSize: 14 },
  tags: [] as ReadonlyArray<string>,
};

it.effect("getKey and setKey navigate typed dot-notation paths", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const file = path.join(dir, "config.json");
      const store = yield* makeJsonDocument({ path: file, schema: Settings, defaults });

      const fontSize = yield* store.getKey("appearance.fontSize");
      expectTypeOf(fontSize).toEqualTypeOf<number>();
      assert.equal(fontSize, 14);

      yield* store.setKey("appearance.theme", "dark");
      assert.deepEqual(yield* store.get, {
        appearance: { theme: "dark", fontSize: 14 },
        tags: [],
      });

      // Arrays are leaves: replaced as a whole at their own key.
      yield* store.setKey("tags", ["a", "b"]);
      assert.deepEqual(yield* store.getKey("tags"), ["a", "b"]);

      // setKey persists — a reopened store sees the change.
      const reopened = yield* makeJsonDocument({ path: file, schema: Settings, defaults });
      assert.equal(yield* reopened.getKey("appearance.theme"), "dark");

      // @ts-expect-error unknown paths are rejected at compile time
      yield* store.getKey("appearance.nope").pipe(Effect.ignore);
      // @ts-expect-error the value type must match the path's leaf type
      yield* store.setKey("appearance.fontSize", "big").pipe(Effect.ignore);
    }),
  ),
);
