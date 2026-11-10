import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import { Layer } from "effect"

const files = Layer.merge(NodeFileSystem.layer, NodePath.layer)

export const platform = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(files))
