import assert from "node:assert/strict";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import { makeJsonDocument } from "../src";
import { withTmp } from "./helpers";

const V1 = Schema.Struct({ theme: Schema.String });
const V2 = Schema.Struct({ theme: Schema.String, fontSize: Schema.Number });
const V3 = Schema.Struct({ appearance: V2 });

const defaults = { appearance: { theme: "light", fontSize: 14 } };

const makeV3Store = (file: string) =>
  makeJsonDocument({
    path: file,
    schema: V3,
    migrations: [
      { schema: V1, migrate: (v1) => ({ ...v1, fontSize: 14 }) },
      { schema: V2, migrate: (v2) => ({ appearance: v2 }) },
    ],
    defaults,
  });

it.effect("migrates a v2 file one step to v3 and writes the new version back", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      yield* fs.writeFileString(
        file,
        JSON.stringify({ version: 2, data: { theme: "dark", fontSize: 16 } }),
      );
      const store = yield* makeV3Store(file);
      assert.deepEqual(yield* store.get, { appearance: { theme: "dark", fontSize: 16 } });

      const parsed: unknown = JSON.parse(yield* fs.readFileString(file));
      assert.deepEqual(parsed, {
        version: 3,
        data: { appearance: { theme: "dark", fontSize: 16 } },
      });
    }),
  ),
);

it.effect("migrates a v1 file through every intermediate version in order", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      yield* fs.writeFileString(file, JSON.stringify({ version: 1, data: { theme: "dark" } }));
      const store = yield* makeV3Store(file);
      // v1→v2 injects fontSize 14, v2→v3 nests under appearance — order is observable.
      assert.deepEqual(yield* store.get, { appearance: { theme: "dark", fontSize: 14 } });

      const parsed: unknown = JSON.parse(yield* fs.readFileString(file));
      assert.deepEqual(parsed, {
        version: 3,
        data: { appearance: { theme: "dark", fontSize: 14 } },
      });
    }),
  ),
);

it.effect("does not rewrite a file that is already at the latest version", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      // Compact formatting: any write-back would pretty-print and change the bytes.
      const original = JSON.stringify({
        version: 3,
        data: { appearance: { theme: "dark", fontSize: 16 } },
      });
      yield* fs.writeFileString(file, original);
      yield* makeV3Store(file);
      assert.equal(yield* fs.readFileString(file), original);
    }),
  ),
);

it.effect("fails with JsonStoreDecodeError when the data does not match its declared version", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      yield* fs.writeFileString(
        file,
        JSON.stringify({ version: 2, data: { theme: "dark" } }), // fontSize missing for v2
      );
      const error = yield* Effect.flip(makeV3Store(file));
      assert.equal(error._tag, "JsonStoreDecodeError");
      assert.equal(error._tag === "JsonStoreDecodeError" && error.version, 2);
    }),
  ),
);

it.effect("fails with JsonStoreMigrationError when a migrate() step throws", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      const original = JSON.stringify({ version: 1, data: { theme: "dark" } });
      yield* fs.writeFileString(file, original);
      const error = yield* Effect.flip(
        makeJsonDocument({
          path: file,
          schema: V2,
          migrations: [
            {
              schema: V1,
              migrate: () => {
                throw new Error("boom");
              },
            },
          ],
          defaults: { theme: "x", fontSize: 1 },
        }),
      );
      assert.equal(error._tag, "JsonStoreMigrationError");
      // The old file must survive a failed migration untouched.
      assert.equal(yield* fs.readFileString(file), original);
    }),
  ),
);

it.effect("fails with JsonStoreMigrationError when a migrate() output fails the next schema", () =>
  withTmp((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(dir, "config.json");
      const original = JSON.stringify({ version: 1, data: { theme: "dark" } });
      yield* fs.writeFileString(file, original);
      const error = yield* Effect.flip(
        makeJsonDocument({
          path: file,
          schema: V2,
          // fontSize missing: output is invalid under V2
          migrations: [{ schema: V1, migrate: (v1) => ({ theme: v1.theme }) }],
          defaults: { theme: "x", fontSize: 1 },
        }),
      );
      assert.equal(error._tag, "JsonStoreMigrationError");
      assert.equal(error._tag === "JsonStoreMigrationError" && error.fromVersion, 1);
      assert.equal(error._tag === "JsonStoreMigrationError" && error.toVersion, 2);
      assert.equal(yield* fs.readFileString(file), original);
    }),
  ),
);
