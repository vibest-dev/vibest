import { LayerNode } from "@vibest/core/effect/layer-node"
import { Identity } from "@vibest/core/identity"

import * as Http from "./http.ts"
import * as Server from "./server.ts"
import { services } from "./services.ts"

export const daemon = LayerNode.group([Identity.node, services, Server.node, Http.node])
