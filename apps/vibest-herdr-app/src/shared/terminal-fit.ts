export const BAR_HEIGHT = 32
export const FIXED_HEIGHT = BAR_HEIGHT + 8 * 2 + 2 + 40

export const rowHeight = (fontSize: number): number => Math.round(fontSize * 1.5)

export const barExtra = (viewportHeight: number, fontSize: number): number => {
  const row = rowHeight(fontSize)
  return (((Math.floor(viewportHeight) - FIXED_HEIGHT) % row) + row) % row
}
