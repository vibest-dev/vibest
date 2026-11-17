import type { Method } from "./generated/params.js"
import type { HerdrResponse, ResultOf } from "./herdr.js"

export const resultOf = <M extends Method>(response: HerdrResponse) => response.result as ResultOf<M>
