import assert from "node:assert/strict";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import { makeJsonDocument } from "../src";
import { withTmp } from "./helpers";

const V1 = Schema.Struct({ count: Schema.Number });

it.effect("serializes concurrent updates so none are lost", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      const store = yield* makeJsonDocument({
        path: file,
        schema: V1,
        defaults: { count: 0 },
      });

      yield* Effect.all(
        Array.from({ length: 20 }, () => store.update((current) => ({ count: current.count + 1 }))),
        { concurrency: "unbounded" },
      );

      assert.deepEqual(yield* store.get, { count: 20 });
      const parsed: unknown = JSON.parse(yield* fs.readFileString(file));
      assert.deepEqual(parsed, { version: 1, data: { count: 20 } });
    }),
  ),
);
