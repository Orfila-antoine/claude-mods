export type Next<M, R> = (msg?: M) => Promise<R>
export type Step<M, R, C> = (msg: M, next: Next<M, R>, ctx: C) => Promise<R | void> | R | void
export type Entry<M, R, C> = { mod: string; name: string; step: Step<M, R, C>; ctx: C }
export type Fault = { mod: string; name: string; error: unknown }

export async function run<M, R, C>(
  entries: readonly Entry<M, R, C>[],
  msg: M,
  terminal: (msg: M) => Promise<R>,
  onFault: (fault: Fault) => void,
): Promise<R> {
  const go = async (index: number, current: M): Promise<R> => {
    const entry = entries[index]
    if (!entry) return terminal(current)
    let downstream: Promise<R> | undefined
    let downstreamError: { error: unknown } | undefined
    const next: Next<M, R> = (passed = current) => {
      downstream ??= go(index + 1, passed).catch(error => {
        downstreamError = { error }
        throw error
      })
      return downstream
    }
    try {
      const answered = await entry.step(current, next, entry.ctx)
      if (answered !== undefined) return answered
      return downstream ?? next()
    } catch (error) {
      if (downstreamError && downstreamError.error === error) throw error
      onFault({ mod: entry.mod, name: entry.name, error })
      return downstream ?? go(index + 1, current)
    }
  }
  return go(0, msg)
}
