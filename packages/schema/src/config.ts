export type StatusProbeKind = 'local' | 'region' | 'proxy'

export type StatusProbe = {
  kind: StatusProbeKind
  target?: string
}

export type StatusHttpExpect = {
  status?: number[]
  bodyIncludes?: string[]
  bodyExcludes?: string[]
}

export type StatusHttpCheck = {
  type: 'http'
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  expect?: StatusHttpExpect
  probe?: StatusProbe
}

export type StatusTcpCheck = {
  type: 'tcp'
  target: string
  timeoutMs?: number
  probe?: StatusProbe
}

export type StatusCheck = StatusHttpCheck | StatusTcpCheck

export type StatusSiteBrand = {
  logo?: string
  icon?: string
}

export type StatusSiteNavigationItem = {
  label: string
  href: string
}

export type StatusSite = {
  name: string
  description?: string
  url?: string
  brand?: StatusSiteBrand
  navigation?: StatusSiteNavigationItem[]
}

export type StatusService = {
  id: string
  name: string
  group?: string
  failureThreshold?: number
  recoveryThreshold?: number
  checks: StatusCheck[]
}

export type StatusNotificationProvider = {
  id: string
  type: 'webhook'
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH'
  headers?: Record<string, string>
  secretName?: string
  secretHeader?: string
  secretPrefix?: string
  bodyTemplate?: Record<string, unknown>
}

export type StatusNotifications = {
  gracePeriodMinutes?: number
  providers: StatusNotificationProvider[]
}

export type StatusMaintenance = {
  id: string
  title: string
  body: string
  start: string
  end?: string
  services?: string[]
}

export type StatusConfig = {
  site: StatusSite
  services: StatusService[]
  notifications: StatusNotifications
  maintenances: StatusMaintenance[]
  staleAfterMinutes?: number
  retentionDays?: number
}

export function defineStatusConfig<const T extends StatusConfig>(config: T): T {
  return config
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid ${label}`)
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}`)
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${label}`)
  }
}

function assertHttpUrl(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label)

  if (!/^https?:\/\/[^\s]+$/i.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  assertRecord(value, label)
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }

  for (const [index, item] of value.entries()) {
    assertNonEmptyString(item, `${label} ${index}`)
  }
}

function assertNumberArray(value: unknown, label: string): asserts value is number[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }

  for (const [index, item] of value.entries()) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0) {
      throw new Error(`Invalid ${label} ${index}`)
    }
  }
}

function assertStringRecord(value: unknown, label: string): asserts value is Record<string, string> {
  assertRecord(value, label)

  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new Error(`Invalid ${label} ${key}`)
    }
  }
}

function assertStatusProbe(value: unknown, label: string): asserts value is StatusProbe {
  assertRecord(value, label)

  if (value.kind !== 'local' && value.kind !== 'region' && value.kind !== 'proxy') {
    throw new Error(`Invalid ${label} kind`)
  }

  if (value.target !== undefined) {
    assertNonEmptyString(value.target, `${label} target`)
  }
}

function assertStatusCheck(value: unknown, serviceId: string, index: number): asserts value is StatusCheck {
  assertRecord(value, `service ${serviceId} check ${index}`)

  if (value.probe !== undefined) {
    assertStatusProbe(value.probe, `service ${serviceId} check ${index} probe`)
  }

  if (value.timeoutMs !== undefined) {
    if (typeof value.timeoutMs !== 'number' || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 0) {
      throw new Error(`Invalid service ${serviceId} check ${index} timeoutMs`)
    }
  }

  if (value.type === 'http') {
    assertNonEmptyString(value.url, `service ${serviceId} check ${index} url`)

    if (value.method !== undefined) {
      assertNonEmptyString(value.method, `service ${serviceId} check ${index} method`)
    }

    if (value.body !== undefined) {
      if (typeof value.body !== 'string') {
        throw new Error(`Invalid service ${serviceId} check ${index} body`)
      }
    }

    if (value.headers !== undefined) {
      assertStringRecord(value.headers, `service ${serviceId} check ${index} headers`)
    }

    if (value.expect !== undefined) {
      assertRecord(value.expect, `service ${serviceId} check ${index} expect`)

      if (value.expect.status !== undefined) {
        assertNumberArray(value.expect.status, `service ${serviceId} check ${index} expect status`)
      }

      if (value.expect.bodyIncludes !== undefined) {
        assertStringArray(value.expect.bodyIncludes, `service ${serviceId} check ${index} expect bodyIncludes`)
      }

      if (value.expect.bodyExcludes !== undefined) {
        assertStringArray(value.expect.bodyExcludes, `service ${serviceId} check ${index} expect bodyExcludes`)
      }
    }

    return
  }

  if (value.type === 'tcp') {
    assertNonEmptyString(value.target, `service ${serviceId} check ${index} target`)
    return
  }

  throw new Error(`Invalid service ${serviceId} check ${index} type`)
}

function assertStatusNavigation(value: unknown, index: number): asserts value is StatusSiteNavigationItem {
  assertRecord(value, `site navigation ${index}`)
  assertNonEmptyString(value.label, `site navigation ${index} label`)
  assertNonEmptyString(value.href, `site navigation ${index} href`)
}

function assertStatusProvider(value: unknown, index: number): asserts value is StatusNotificationProvider {
  assertRecord(value, `notification provider ${index}`)
  assertNonEmptyString(value.id, `notification provider ${index} id`)
  assertHttpUrl(value.url, `notification provider ${index} url`)

  if (value.type !== 'webhook') {
    throw new Error(`Invalid notification provider ${index} type`)
  }

  if (value.method !== undefined) {
    if (value.method !== 'GET' && value.method !== 'POST' && value.method !== 'PUT' && value.method !== 'PATCH') {
      throw new Error(`Invalid notification provider ${index} method`)
    }
  }

  if (value.headers !== undefined) {
    assertStringRecord(value.headers, `notification provider ${index} headers`)
  }

  if (value.secretName !== undefined) {
    assertNonEmptyString(value.secretName, `notification provider ${index} secretName`)
  }

  if (value.secretHeader !== undefined) {
    assertNonEmptyString(value.secretHeader, `notification provider ${index} secretHeader`)
  }

  if (value.secretPrefix !== undefined && typeof value.secretPrefix !== 'string') {
    throw new Error(`Invalid notification provider ${index} secretPrefix`)
  }

  if (value.bodyTemplate !== undefined) {
    assertPlainObject(value.bodyTemplate, `notification provider ${index} bodyTemplate`)
  }
}

function assertStatusMaintenance(value: unknown, index: number, serviceIds: Set<string>): asserts value is StatusMaintenance {
  assertRecord(value, `maintenance ${index}`)
  assertNonEmptyString(value.id, `maintenance ${index} id`)
  assertNonEmptyString(value.title, `maintenance ${index} title`)
  assertNonEmptyString(value.body, `maintenance ${index} body`)
  assertNonEmptyString(value.start, `maintenance ${index} start`)

  if (value.end !== undefined) {
    assertNonEmptyString(value.end, `maintenance ${index} end`)
  }

  const services = value.services
  if (services !== undefined) {
    if (!Array.isArray(services)) {
      throw new Error(`Invalid maintenance ${index} services`)
    }

    for (const [serviceIndex, serviceId] of services.entries()) {
      assertNonEmptyString(serviceId, `maintenance ${index} service ${serviceIndex}`)

      if (!serviceIds.has(serviceId)) {
        throw new Error(`Invalid maintenance ${index} service reference: ${serviceId}`)
      }
    }
  }
}

export function parseStatusConfig(config: unknown): StatusConfig {
  assertRecord(config, 'config')
  const site = config.site
  assertRecord(site, 'site')
  assertNonEmptyString(site.name, 'site name')

  if (site.description !== undefined) {
    assertNonEmptyString(site.description, 'site description')
  }

  if (site.url !== undefined) {
    assertNonEmptyString(site.url, 'site url')
  }

  const brand = site.brand
  if (brand !== undefined) {
    assertRecord(brand, 'site brand')

    if (brand.logo !== undefined) {
      assertNonEmptyString(brand.logo, 'site brand logo')
    }

    if (brand.icon !== undefined) {
      assertNonEmptyString(brand.icon, 'site brand icon')
    }
  }

  if (site.navigation !== undefined) {
    if (!Array.isArray(site.navigation)) {
      throw new Error('Invalid site navigation')
    }

    site.navigation.forEach((navigationItem, index) => {
      assertStatusNavigation(navigationItem, index)
    })
  }

  const services = config.services
  if (!Array.isArray(services)) {
    throw new Error('Invalid services')
  }

  const serviceIds = new Set<string>()

  for (const [index, service] of services.entries()) {
    assertRecord(service, `service ${index}`)
    assertNonEmptyString(service.id, `service ${index} id`)
    assertNonEmptyString(service.name, `service ${index} name`)

    if (serviceIds.has(service.id)) {
      throw new Error(`Duplicate service id: ${service.id}`)
    }

    serviceIds.add(service.id)

    if (service.group !== undefined) {
      assertNonEmptyString(service.group, `service ${service.id} group`)
    }

    if (service.failureThreshold !== undefined) {
      assertPositiveInteger(service.failureThreshold, `service ${service.id} failure threshold`)
    }

    if (service.recoveryThreshold !== undefined) {
      assertPositiveInteger(service.recoveryThreshold, `service ${service.id} recovery threshold`)
    }

    if (!Array.isArray(service.checks) || service.checks.length === 0) {
      throw new Error(`Invalid service ${service.id} checks`)
    }

    for (const [checkIndex, check] of service.checks.entries()) {
      assertStatusCheck(check, service.id, checkIndex)
    }
  }

  const notifications = config.notifications as {
    gracePeriodMinutes?: unknown
    providers?: unknown
  }
  if (!notifications || typeof notifications !== 'object' || Array.isArray(notifications)) {
    throw new Error('Invalid notifications')
  }

  const gracePeriodMinutes = notifications.gracePeriodMinutes
  if (gracePeriodMinutes !== undefined) {
    assertNonNegativeInteger(gracePeriodMinutes, 'notifications grace period')
  }

  if (!Array.isArray(notifications.providers)) {
    throw new Error('Invalid notification providers')
  }

  for (const [index, provider] of notifications.providers.entries()) {
    assertStatusProvider(provider, index)
  }

  const maintenances = config.maintenances
  if (!Array.isArray(maintenances)) {
    throw new Error('Invalid maintenances')
  }

  const knownServiceIds = serviceIds

  for (const [index, maintenance] of maintenances.entries()) {
    assertStatusMaintenance(maintenance, index, knownServiceIds)
  }

  if (config.staleAfterMinutes !== undefined) {
    assertPositiveInteger(config.staleAfterMinutes, 'stale after minutes')
  }

  if (config.retentionDays !== undefined) {
    assertPositiveInteger(config.retentionDays, 'retention days')
  }

  return config as StatusConfig
}
