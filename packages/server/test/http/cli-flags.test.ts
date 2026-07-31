import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Option } from "effect";
import { CliError, Command } from "effect/unstable/cli";

import { serveFlags } from "../../src/http/serve";

type ServeInput = {
  readonly port: Option.Option<number>;
  readonly corsOrigin: ReadonlyArray<string>;
};

/**
 * Compatibility smoke test for `effect/unstable/cli` (issue #161): the CLI
 * builds `vibest serve` from these exact flags, and the unstable module can
 * change parsing behaviour across Effect beta bumps without a compile error.
 */
layer(NodeServices.layer)("serveFlags parsing via effect/unstable/cli", (it) => {
  const parse = (argv: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const seen: ServeInput[] = [];
      const command = Command.make("serve", serveFlags, (input) =>
        Effect.sync(() => {
          seen.push(input);
        }),
      );
      yield* Command.runWith(command, { version: "0.0.0" })(argv);
      const input = seen[0];
      assert.ok(input !== undefined, "the command handler never ran");
      return input;
    });

  it.effect("parses --port and repeated --cors-origin", () =>
    Effect.gen(function* () {
      const input = yield* parse([
        "--port",
        "4123",
        "--cors-origin",
        "https://a.test",
        "--cors-origin",
        "https://b.test",
      ]);
      assert.deepEqual(input.port, Option.some(4123));
      assert.deepEqual(input.corsOrigin, ["https://a.test", "https://b.test"]);
    }),
  );

  it.effect("yields none / empty when no flags are given", () =>
    Effect.gen(function* () {
      const input = yield* parse([]);
      assert.deepEqual(input.port, Option.none());
      assert.deepEqual(input.corsOrigin, []);
    }),
  );

  it.effect("fails with a CliError when --port is not an integer", () =>
    Effect.gen(function* () {
      const command = Command.make("serve", serveFlags, () => Effect.void);
      const error = yield* Command.runWith(command, { version: "0.0.0" })([
        "--port",
        "not-a-port",
      ]).pipe(Effect.flip);
      assert.ok(CliError.isCliError(error));
    }),
  );
});
