import { settings } from "herdr"

const HERDR_DEFAULT = 14
const SMALL_RATIO = 11.5 / 13

export const fontSize = (): number => Number(settings().font_size ?? HERDR_DEFAULT)

export const TEXT = (): number => fontSize()

export const SMALL = (): number => Math.round(fontSize() * SMALL_RATIO * 2) / 2
