import { Identity } from "@vibest/core/identity"
import { LayerNode } from "@vibest/util/layer-node"

import * as Server from "./server.ts"
import { services } from "./services.ts"
import * as Ui from "./ui.ts"

export const daemon = LayerNode.group([Identity.node, services, Server.node, Ui.node])
