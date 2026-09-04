import type { StatusConfig } from '@pulseflare/schema'

export type WorkerEnv = Partial<Env> & {
  [key: string]: unknown
  ASSETS?: {
    fetch(request: Request): Promise<Response>
  }
  PULSEFLARE_BOOTSTRAP_TOKEN?: string
  PULSEFLARE_REMOTE_PROBE_URL?: string
  PULSEFLARE_REMOTE_PROBE_TOKEN?: string
  STATUS_CONFIG?: StatusConfig
}

export function getWorkerConfig(env: unknown): StatusConfig | undefined {
  if (!env || typeof env !== 'object') {
    return undefined
  }

  const { STATUS_CONFIG } = env as WorkerEnv
  return STATUS_CONFIG
}

export function getWorkerDatabase(env: unknown): D1Database | undefined {
  if (!env || typeof env !== 'object') {
    return undefined
  }

  const { PULSEFLARE_D1 } = env as WorkerEnv
  return PULSEFLARE_D1
}

export function getBootstrapToken(env: unknown): string | undefined {
  if (!env || typeof env !== 'object') {
    return undefined
  }

  const { PULSEFLARE_BOOTSTRAP_TOKEN } = env as WorkerEnv
  return PULSEFLARE_BOOTSTRAP_TOKEN
}

export function getWorkerSecret(env: unknown, name: string): string | undefined {
  if (!env || typeof env !== 'object') {
    return undefined
  }

  const value = (env as WorkerEnv)[name]
  return typeof value === 'string' ? value : undefined
}

export function getWorkerAssets(env: unknown): WorkerEnv['ASSETS'] | undefined {
  if (!env || typeof env !== 'object') {
    return undefined
  }

  const { ASSETS } = env as WorkerEnv
  return ASSETS
}

export function getRemoteProbeUrl(env: unknown): string | undefined {
  if (!env || typeof env !== 'object') {
    return undefined
  }

  const { PULSEFLARE_REMOTE_PROBE_URL } = env as WorkerEnv
  return PULSEFLARE_REMOTE_PROBE_URL
}

export function getRemoteProbeToken(env: unknown): string | undefined {
  if (!env || typeof env !== 'object') {
    return undefined
  }

  const { PULSEFLARE_REMOTE_PROBE_TOKEN } = env as WorkerEnv
  return typeof PULSEFLARE_REMOTE_PROBE_TOKEN === 'string' && PULSEFLARE_REMOTE_PROBE_TOKEN.trim().length > 0
    ? PULSEFLARE_REMOTE_PROBE_TOKEN
    : undefined
}
