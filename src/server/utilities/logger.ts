const PREFIX = '[GMC]'

type LogMethod = (
  messageOrMeta: Record<string, unknown> | string,
  message?: string,
  ...args: unknown[]
) => void

type PayloadLogger = {
  debug?: LogMethod
  error?: LogMethod
  info?: LogMethod
  warn?: LogMethod
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

  const bindOrNoop = (method: LogMethod | undefined): LogMethod => {
    return method ? method.bind(payloadLogger) : noop
  }

  return {
    debug: wrap(bindOrNoop(payloadLogger.debug)),
    error: wrap(bindOrNoop(payloadLogger.error)),
    info: wrap(bindOrNoop(payloadLogger.info)),
    warn: wrap(bindOrNoop(payloadLogger.warn)),
  }
}
