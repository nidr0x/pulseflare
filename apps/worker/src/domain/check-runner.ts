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

type FetchResultShape = {
  status?: unknown
  reason?: unknown
  latencyMs?: unknown
}

const MAX_RESPONSE_BODY_BYTES = 64 * 1024

function formatExpectedStatuses(statuses: number[]): string {
  return statuses.join(', ')
}

async function readResponseBody(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'))

  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BODY_BYTES) {
    throw new Error(`Response body exceeded ${MAX_RESPONSE_BODY_BYTES} byte limit`)
  }

  if (!response.body) {
    return ''
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let bodyText = ''

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        bodyText += decoder.decode()
        return bodyText
      }

      bytesRead += value.byteLength

      if (bytesRead > MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`Response body exceeded ${MAX_RESPONSE_BODY_BYTES} byte limit`)
      }

      bodyText += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
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

function isRemoteProbeUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

async function runRemoteProbe(
  check: StatusCheck,
  endpoint: string,
  fetcher: Fetcher
): Promise<CheckRunResult> {
  try {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        check,
        probe: check.probe,
      }),
    })

    if (!response.ok) {
      return {
        status: 'down',
        reason: `Remote probe request failed with ${response.status}`,
      }
    }

    const payload = (await response.json()) as FetchResultShape
    if (payload.status !== 'up' && payload.status !== 'down') {
      return {
        status: 'down',
        reason: 'Remote probe returned an invalid status payload',
      }
    }

    return {
      status: payload.status,
      reason: typeof payload.reason === 'string' ? payload.reason : 'Remote probe completed',
      latencyMs: typeof payload.latencyMs === 'number' ? payload.latencyMs : undefined,
    }
  } catch (error) {
    return {
      status: 'down',
      reason: error instanceof Error ? error.message : `Remote probe failed for ${endpoint}`,
    }
  }
}

export async function runConfiguredCheck(
  check: StatusCheck,
  fetcher: Fetcher = globalThis.fetch,
  tcpConnect?: TcpConnector,
  remoteProbeUrl?: string
): Promise<CheckRunResult> {
  if (check.probe?.kind === 'proxy') {
    if (!check.probe.target || !isRemoteProbeUrl(check.probe.target)) {
      return {
        status: 'down',
        reason: 'Proxy probe target must be a valid HTTP(S) URL',
      }
    }

    return runRemoteProbe(check, check.probe.target, fetcher)
  }

  if (check.probe?.kind === 'region') {
    if (!remoteProbeUrl) {
      return {
        status: 'down',
        reason: `No shared remote probe endpoint configured for region probe ${check.probe.target ?? 'unknown'}`,
      }
    }

    return runRemoteProbe(check, remoteProbeUrl, fetcher)
  }

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

    const bodyExpectations = [
      ...(check.expect?.bodyIncludes ?? []),
      ...(check.expect?.bodyExcludes ?? []),
    ]
    const bodyText = bodyExpectations.length > 0 ? await readResponseBody(response) : ''

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
