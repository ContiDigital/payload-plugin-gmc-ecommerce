const PREFIX = '[GMC]'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogMethod = (...args: any[]) => void

type PayloadLogger = {
  debug: LogMethod
  error: LogMethod
  info: LogMethod
  warn: LogMethod
}

export type PluginLogger = {
  debug: (message: string, meta?: Record<string, unknown>) => void
  error: (message: string, meta?: Record<string, unknown>) => void
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
}

const noop = (): void => {
  // intentional no-op
}

export const createPluginLogger = (
  payloadLogger?: null | PayloadLogger,
  context?: Record<string, unknown>,
): PluginLogger => {
  if (!payloadLogger) {
    return { debug: noop, error: noop, info: noop, warn: noop }
  }

  const wrap = (method: LogMethod) => {
    return (message: string, meta?: Record<string, unknown>): void => {
      const merged = context || meta
        ? { ...context, ...meta }
        : undefined

      if (merged) {
        method(merged, `${PREFIX} ${message}`)
      } else {
        method(`${PREFIX} ${message}`)
      }
    }
  }

  return {
    debug: wrap(payloadLogger.debug.bind(payloadLogger)),
    error: wrap(payloadLogger.error.bind(payloadLogger)),
    info: wrap(payloadLogger.info.bind(payloadLogger)),
    warn: wrap(payloadLogger.warn.bind(payloadLogger)),
  }
}
