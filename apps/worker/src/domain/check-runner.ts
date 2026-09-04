import type { StatusCheck } from '@pulseflare/schema'

export type CheckRunResult = {
  status: 'up' | 'down'
  reason: string
  latencyMs?: number
  locationLabel?: string
}

type Fetcher = typeof fetch
type TcpConnector = (address: { hostname: string; port: number }) => {
  opened: Promise<unknown>
  close(): Promise<void>
}

const MAX_RESPONSE_BODY_BYTES = 64 * 1024
const DEFAULT_REMOTE_PROBE_TIMEOUT_MS = 15_000
const MAX_REMOTE_LATENCY_MS = 10 * 60_000

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

function isSecureRemoteProbeUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function getProbeLocationLabel(check: StatusCheck): string | undefined {
  if (check.probe?.kind === 'proxy') {
    return 'proxy'
  }

  if (check.probe?.kind !== 'region') {
    return undefined
  }

  const target = (check.probe.target ?? 'unknown').trim().replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 64)
  return `region:${target || 'unknown'}`
}

function withLocationLabel(result: CheckRunResult, locationLabel: string | undefined): CheckRunResult {
  return locationLabel ? { ...result, locationLabel } : result
}

function parseRemoteProbePayload(body: string): CheckRunResult | null {
  let value: unknown

  try {
    value = JSON.parse(body)
  } catch {
    return null
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const payload = value as Record<string, unknown>
  if (
    (payload.status !== 'up' && payload.status !== 'down') ||
    typeof payload.reason !== 'string' ||
    payload.reason.trim().length === 0
  ) {
    return null
  }

  if (
    payload.latencyMs !== undefined &&
    (typeof payload.latencyMs !== 'number' ||
      !Number.isFinite(payload.latencyMs) ||
      !Number.isInteger(payload.latencyMs) ||
      payload.latencyMs < 0 ||
      payload.latencyMs > MAX_REMOTE_LATENCY_MS)
  ) {
    return null
  }

  return {
    status: payload.status,
    reason: payload.reason,
    ...(payload.latencyMs === undefined ? {} : { latencyMs: payload.latencyMs }),
  }
}

async function runRemoteProbe(
  check: StatusCheck,
  endpoint: string,
  fetcher: Fetcher,
  authorizationToken?: string
): Promise<CheckRunResult> {
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }

    if (authorizationToken) {
      headers.authorization = `Bearer ${authorizationToken}`
    }

    const response = await fetcher(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        check,
        probe: check.probe,
      }),
      signal: AbortSignal.timeout(check.timeoutMs ?? DEFAULT_REMOTE_PROBE_TIMEOUT_MS),
    })

    if (!response.ok) {
      return {
        status: 'down',
        reason: `Remote probe request failed with ${response.status}`,
      }
    }

    const payload = parseRemoteProbePayload(await readResponseBody(response))
    if (!payload) {
      return {
        status: 'down',
        reason: 'Remote probe returned an invalid status payload',
      }
    }

    return payload
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
  remoteProbeUrl?: string,
  remoteProbeToken?: string
): Promise<CheckRunResult> {
  const locationLabel = getProbeLocationLabel(check)

  if (check.probe?.kind === 'proxy') {
    if (!check.probe.target || !isRemoteProbeUrl(check.probe.target)) {
      return withLocationLabel(
        {
          status: 'down',
          reason: 'Proxy probe target must be a valid HTTP(S) URL',
        },
        locationLabel
      )
    }

    return withLocationLabel(await runRemoteProbe(check, check.probe.target, fetcher), locationLabel)
  }

  if (check.probe?.kind === 'region') {
    if (!remoteProbeUrl) {
      return withLocationLabel(
        {
          status: 'down',
          reason: `No shared remote probe endpoint configured for region probe ${check.probe.target ?? 'unknown'}`,
        },
        locationLabel
      )
    }

    if (!isSecureRemoteProbeUrl(remoteProbeUrl)) {
      return withLocationLabel(
        {
          status: 'down',
          reason: 'Shared remote probe endpoint must use HTTPS',
        },
        locationLabel
      )
    }

    if (!remoteProbeToken) {
      return withLocationLabel(
        {
          status: 'down',
          reason: `No shared remote probe token configured for region probe ${check.probe.target ?? 'unknown'}`,
        },
        locationLabel
      )
    }

    return withLocationLabel(await runRemoteProbe(check, remoteProbeUrl, fetcher, remoteProbeToken), locationLabel)
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
