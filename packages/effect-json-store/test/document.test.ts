import assert from "node:assert/strict";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import { makeJsonDocument } from "../src";
import { withTmp } from "./helpers";

const schema = Schema.Struct({ theme: Schema.String, count: Schema.Number });
const defaults = { theme: "light", count: 0 };

it.effect("seeds a missing file with defaults immediately, creating parent directories", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "nested", "config.json");
      const store = yield* makeJsonDocument({ path: file, schema, defaults });
      assert.deepEqual(yield* store.get, defaults);
      const parsed: unknown = JSON.parse(yield* fs.readFileString(file));
      assert.deepEqual(parsed, { version: 1, data: defaults });
    }),
  ),
);

it.effect("set persists atomically and a reopened store reads the value back", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      const store = yield* makeJsonDocument({ path: file, schema, defaults });
      yield* store.set({ theme: "dark", count: 2 });
      assert.deepEqual(yield* store.get, { theme: "dark", count: 2 });

      const reopened = yield* makeJsonDocument({ path: file, schema, defaults });
      assert.deepEqual(yield* reopened.get, { theme: "dark", count: 2 });

      const leftovers = (yield* fs.readDirectory(dir)).filter((name) => name.endsWith(".tmp"));
      assert.deepEqual(leftovers, []);
    }),
  ),
);

it.effect("update applies the function and returns the new value", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const file = path.join(dir, "config.json");
      const store = yield* makeJsonDocument({ path: file, schema, defaults });
      const next = yield* store.update((current) => ({ ...current, count: current.count + 1 }));
      assert.equal(next.count, 1);
      assert.deepEqual(yield* store.get, next);
    }),
  ),
);

it.effect("load re-reads the file after an external change", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      const store = yield* makeJsonDocument({ path: file, schema, defaults });
      yield* fs.writeFileString(
        file,
        JSON.stringify({ version: 1, data: { theme: "external", count: 9 } }),
      );
      assert.deepEqual(yield* store.load, { theme: "external", count: 9 });
      assert.deepEqual(yield* store.get, { theme: "external", count: 9 });
    }),
  ),
);
