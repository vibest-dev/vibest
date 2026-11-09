import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"

import { Secrets } from "./keychain.ts"

const files = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const processes = Layer.mergeAll(NodeChildProcessSpawner.layer, FetchHttpClient.layer).pipe(Layer.provideMerge(files))

export const platform = Secrets.layer.pipe(Layer.provideMerge(processes))
