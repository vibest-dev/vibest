export interface Pull {
  readonly token: number
  readonly closed: boolean
  readonly running: boolean
  readonly again: boolean
}

export const idlePull = (): Pull => ({ token: 0, closed: false, running: false, again: false })

export const requestPull = (pull: Pull): Pull => {
  if (pull.closed) return pull
  if (pull.running) return { ...pull, again: true }
  return { token: pull.token + 1, closed: false, running: true, again: false }
}

export const completePull = (pull: Pull, token: number): { readonly pull: Pull; readonly apply: boolean } => {
  if (pull.closed || token !== pull.token) return { pull, apply: false }
  if (pull.again) return { apply: false, pull: { token: pull.token + 1, closed: false, running: true, again: false } }
  return { apply: true, pull: { ...pull, running: false } }
}

export const closePull = (pull: Pull): Pull => ({
  token: pull.token + 1,
  closed: true,
  running: false,
  again: false,
})
