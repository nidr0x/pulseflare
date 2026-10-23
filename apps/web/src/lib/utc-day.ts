export function scheduleUtcDayChange(onDayChange: (day: string) => void): () => void {
  let timeout: ReturnType<typeof setTimeout>
  let cancelled = false

  const schedule = () => {
    const now = new Date()
    const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    timeout = setTimeout(() => {
      if (cancelled) return
      onDayChange(new Date().toISOString().slice(0, 10))
      schedule()
    }, nextMidnight - now.getTime())
  }

  schedule()
  return () => {
    cancelled = true
    clearTimeout(timeout)
  }
}
