import fs from "node:fs"

import { assert, describe, it } from "@effect/vitest"
import { OPENAPI_JSON } from "@vibest/protocol/script/contract"
import { HttpApi, OpenApi } from "effect/http-api"

import { VibestApi } from "../src/api.ts"

const ENDPOINT_NAME = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/
const HTTP_STATUS = /^[1-5][0-9]{2}$/

describe("openapi patterns", () => {
  it("every endpoint uses a <group>.<action> identifier and /api/ route prefix", () => {
    const endpoints: Array<{ readonly group: string; readonly name: string; readonly path: string }> = []

    HttpApi.reflect(VibestApi, {
      onGroup: () => undefined,
      onEndpoint: ({ group, endpoint }) => {
        endpoints.push({ group: group.identifier, name: endpoint.identifier, path: endpoint.path })
      },
    })

    assert.isAbove(endpoints.length, 0)

    for (const endpoint of endpoints) {
      assert.match(endpoint.name, ENDPOINT_NAME, `endpoint ${endpoint.name} must match <group>.<action>`)
      assert.isTrue(
        endpoint.path.startsWith("/api/"),
        `endpoint ${endpoint.name} path ${endpoint.path} must start with /api/`,
      )
    }
  })

  it("every operation in OpenApi has explicit numeric HTTP status codes and matches openapi.json deterministically", () => {
    const generated = OpenApi.fromApi(VibestApi)
    const regenerated = OpenApi.fromApi(VibestApi)
    assert.deepStrictEqual(generated, regenerated)

    const committed = JSON.parse(fs.readFileSync(OPENAPI_JSON, "utf8")) as { readonly openapi: OpenApi.OpenAPISpec }
    assert.deepStrictEqual(generated, committed.openapi)

    const paths = Object.entries(generated.paths)
    assert.isAbove(paths.length, 0)

    for (const [route, item] of paths) {
      assert.isTrue(route.startsWith("/api/"), `route ${route} must start with /api/`)

      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        const operation = item[method]

        if (operation === undefined) continue
        assert.match(operation.operationId ?? "", ENDPOINT_NAME, `${method.toUpperCase()} ${route} operationId`)
        const statuses = Object.keys(operation.responses)
        assert.isAbove(statuses.length, 0, `${method.toUpperCase()} ${route} must declare responses`)

        for (const status of statuses) {
          assert.match(status, HTTP_STATUS, `${method.toUpperCase()} ${route} response status ${status}`)
        }
      }
    }
  })
})
