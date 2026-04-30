import type { StatusCheck } from '@pulseflare/schema'

export type CheckRunResult = {
  status: 'up' | 'down'
  reason: string
  latencyMs?: number
}

type Fetcher = typeof fetch
type TcpConnector = (address: { hostname: string; port: number }) => {
  opened: Promise<unknown>
  close(): Promise<void>
}

function formatExpectedStatuses(statuses: number[]): string {
  return statuses.join(', ')
}

function parseTcpTarget(target: string): { hostname: string; port: number } {
  let parsed: URL

  try {
    parsed = new URL(`tcp://${target}`)
  } catch {
    throw new Error(`Invalid TCP target: ${target}`)
  }

  if (!parsed.hostname || !parsed.port) {
    throw new Error(`TCP target must include host and port: ${target}`)
  }

  return {
    hostname: parsed.hostname,
    port: Number(parsed.port),
  }
}

async function runTcpCheck(
  target: string,
  timeoutMs: number | undefined,
  tcpConnect: TcpConnector
): Promise<CheckRunResult> {
  const address = parseTcpTarget(target)
  const startedAt = Date.now()
  const socket = tcpConnect(address)

  try {
    const opened = socket.opened
    const openedInfo = await (typeof timeoutMs === 'number'
      ? Promise.race([
          opened,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`TCP connect timed out after ${timeoutMs} ms`)), timeoutMs)
          ),
        ])
      : opened)

    await socket.close()

    return {
      status: 'up',
      reason: `TCP ${target} connected`,
      latencyMs: Date.now() - startedAt,
    }
  } catch (error) {
    await socket.close().catch(() => undefined)

    return {
      status: 'down',
      reason: error instanceof Error ? error.message : `TCP connection failed for ${target}`,
    }
  }
}

async function getDefaultTcpConnector(): Promise<TcpConnector> {
  const runtime = await import('cloudflare:sockets')
  return runtime.connect
}

export async function runConfiguredCheck(
  check: StatusCheck,
  fetcher: Fetcher = globalThis.fetch,
  tcpConnect?: TcpConnector
): Promise<CheckRunResult> {
  if (check.type === 'tcp') {
    return runTcpCheck(check.target, check.timeoutMs, tcpConnect ?? (await getDefaultTcpConnector()))
  }

  const method = check.method ?? 'GET'
  const startedAt = Date.now()

  try {
    const response = await fetcher(check.url, {
      method,
      headers: check.headers,
      body: check.body,
      signal: typeof check.timeoutMs === 'number' ? AbortSignal.timeout(check.timeoutMs) : undefined,
    })
    const latencyMs = Date.now() - startedAt
    const bodyText = await response.text()

    if (check.expect?.status && !check.expect.status.includes(response.status)) {
      return {
        status: 'down',
        reason: `Expected HTTP status ${formatExpectedStatuses(check.expect.status)} but received ${response.status}`,
        latencyMs,
      }
    }

    if (!check.expect?.status && (response.status < 200 || response.status >= 300)) {
      return {
        status: 'down',
        reason: `Expected a 2xx HTTP status but received ${response.status}`,
        latencyMs,
      }
    }

    for (const expectedText of check.expect?.bodyIncludes ?? []) {
      if (!bodyText.includes(expectedText)) {
        return {
          status: 'down',
          reason: `Expected response body to include "${expectedText}"`,
          latencyMs,
        }
      }
    }

    for (const excludedText of check.expect?.bodyExcludes ?? []) {
      if (bodyText.includes(excludedText)) {
        return {
          status: 'down',
          reason: `Expected response body to exclude "${excludedText}"`,
          latencyMs,
        }
      }
    }

    return {
      status: 'up',
      reason: `${method} ${check.url} -> ${response.status}`,
      latencyMs,
    }
  } catch (error) {
    return {
      status: 'down',
      reason: error instanceof Error ? error.message : `Request failed for ${check.url}`,
    }
  }
}
