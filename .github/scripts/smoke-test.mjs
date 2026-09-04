import { pathToFileURL } from 'node:url'

const MAX_RESPONSE_BODY_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ATTEMPTS = 12
const DEFAULT_RETRY_DELAY_MS = 5_000

async function readResponseBody(response) {
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
  let body = ''

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        body += decoder.decode()
        return body
      }

      bytesRead += value.byteLength
      if (bytesRead > MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`Response body exceeded ${MAX_RESPONSE_BODY_BYTES} byte limit`)
      }

      body += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

function buildEndpointUrl(baseUrl, path) {
  let parsed

  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('PULSEFLARE_HEALTHCHECK_URL must be a valid HTTPS URL')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('PULSEFLARE_HEALTHCHECK_URL must be a valid HTTPS URL')
  }

  return new URL(path, parsed.origin).toString()
}

async function fetchJson(url, fetcher) {
  const response = await fetcher(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const body = await readResponseBody(response)

  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`)
  }

  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`${url} returned invalid JSON`)
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertSnapshotPayload(payload) {
  if (
    !isRecord(payload) ||
    !isRecord(payload.product) ||
    typeof payload.product.name !== 'string' ||
    !isRecord(payload.summary) ||
    typeof payload.summary.status !== 'string' ||
    !Array.isArray(payload.services) ||
    !Array.isArray(payload.incidents) ||
    !Array.isArray(payload.maintenance)
  ) {
    throw new Error('Public snapshot returned an invalid payload')
  }
}

export async function runSmokeChecks({
  baseUrl,
  fetcher = globalThis.fetch,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer')
  }

  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error('retryDelayMs must be a non-negative integer')
  }

  const healthUrl = buildEndpointUrl(baseUrl, '/api/health')
  const snapshotUrl = buildEndpointUrl(baseUrl, '/api/public/snapshot')
  let lastError

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const health = await fetchJson(healthUrl, fetcher)

      if (isRecord(health) && health.status === 'ok') {
        lastError = undefined
        break
      }

      lastError = new Error('Health endpoint reported a non-ready status')
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Health request failed')
    }

    if (attempt < maxAttempts) {
      await sleep(retryDelayMs)
    }
  }

  if (lastError) {
    throw new Error(`Health check did not become ready after ${maxAttempts} attempts: ${lastError.message}`)
  }

  const snapshot = await fetchJson(snapshotUrl, fetcher)
  assertSnapshotPayload(snapshot)

  return { healthUrl, snapshotUrl }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.PULSEFLARE_HEALTHCHECK_URL) {
    throw new Error('Missing required environment variable: PULSEFLARE_HEALTHCHECK_URL')
  }

  await runSmokeChecks({ baseUrl: process.env.PULSEFLARE_HEALTHCHECK_URL })
  console.log('Live deployment smoke checks passed')
}
