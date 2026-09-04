export type ObservabilityLogger = Pick<Console, 'info' | 'warn' | 'error'>
export type ObservabilityLevel = keyof ObservabilityLogger

const MAX_ERROR_LENGTH = 500

export function getObservabilityError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error'
  return message.replaceAll(/\s+/g, ' ').slice(0, MAX_ERROR_LENGTH)
}

export function emitObservabilityEvent(
  level: ObservabilityLevel,
  event: string,
  fields: Record<string, unknown> = {},
  logger: ObservabilityLogger = console,
  timestamp = new Date().toISOString()
): void {
  logger[level](
    JSON.stringify({
      timestamp,
      component: 'pulseflare-worker',
      event,
      ...fields,
    })
  )
}
