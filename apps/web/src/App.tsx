import { startTransition, useEffect, useRef, useState, type MouseEvent } from 'react'

import { HomePage } from './routes/HomePage'
import { IncidentsPage } from './routes/IncidentsPage'
import {
  EMPTY_INCIDENT_PAGE_DATA,
  EMPTY_STATUS_SNAPSHOT,
  getIncidentPageData,
  getStatusSnapshot,
  type IncidentPageData,
  type SnapshotLoadState,
  type StatusProduct,
  type StatusSnapshot,
} from './lib/api'

type RoutePath = '/' | '/incidents'

export function resolveRoutePath(pathname: string): RoutePath {
  return pathname === '/incidents' ? '/incidents' : '/'
}

function readPathname(): RoutePath {
  return typeof window === 'undefined' ? '/' : resolveRoutePath(window.location.pathname)
}

function isSafeNavigationHref(href: string): boolean {
  const normalized = href.trim()
  if (normalized.startsWith('//') || normalized.startsWith('\\\\')) return false

  try {
    const parsed = new URL(normalized)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return !/^[a-z][a-z\d+.-]*:/i.test(normalized)
  }
}

function isSafeAssetHref(href: string): boolean {
  return isSafeNavigationHref(href)
}

function updateDocumentMetadata(product: StatusProduct, pathname: RoutePath): void {
  const pageLabel = pathname === '/incidents' ? 'Incidents' : 'Status'
  document.title = `${pageLabel} · ${product.name}`

  let description = document.querySelector<HTMLMetaElement>('meta[name="description"]')
  if (!description) {
    description = document.createElement('meta')
    description.name = 'description'
    document.head.append(description)
  }
  description.content = product.description

  let iconLink = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
  if (!iconLink) {
    iconLink = document.createElement('link')
    iconLink.rel = 'icon'
    document.head.append(iconLink)
  }
  iconLink.href = product.icon && isSafeAssetHref(product.icon) ? product.icon : '/brand/icon.svg'
}

export default function App() {
  const [pathname, setPathname] = useState<RoutePath>(readPathname)
  const [snapshot, setSnapshot] = useState<StatusSnapshot>(() => EMPTY_STATUS_SNAPSHOT)
  const [incidentPageData, setIncidentPageData] = useState<IncidentPageData>(() => EMPTY_INCIDENT_PAGE_DATA)
  const [snapshotLoadState, setSnapshotLoadState] = useState<SnapshotLoadState>('idle')
  const [retryToken, setRetryToken] = useState(0)
  const mainRef = useRef<HTMLElement>(null)
  const previousPathname = useRef(pathname)
  const product = pathname === '/incidents' ? incidentPageData.product : snapshot.product

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    let ignore = false

    const handleNavigation = () => {
      startTransition(() => {
        setPathname(readPathname())
      })
    }

    let timerId: number | undefined
    let inFlight = false
    let retryDelay = 10_000

    const scheduleUpdate = (delay: number) => {
      if (timerId !== undefined) {
        window.clearTimeout(timerId)
        timerId = undefined
      }

      if (document.visibilityState !== 'visible') {
        return
      }

      timerId = window.setTimeout(() => {
        timerId = undefined
        void updatePageData()
      }, delay)
    }

    const updatePageData = async () => {
      if (inFlight) {
        return
      }

      inFlight = true
      startTransition(() => {
        setSnapshotLoadState('loading')
      })

      let nextDelay = 60_000

      try {
        if (pathname === '/incidents') {
          const nextData = await getIncidentPageData()
          if (ignore) return
          startTransition(() => {
            setIncidentPageData(nextData)
            setSnapshotLoadState('ready')
          })
        } else {
          const nextSnapshot = await getStatusSnapshot()
          if (ignore) return
          startTransition(() => {
            setSnapshot(nextSnapshot)
            setSnapshotLoadState('ready')
          })
        }
        retryDelay = 10_000
      } catch {
        if (ignore) return
        startTransition(() => {
          setSnapshotLoadState('error')
        })
        nextDelay = retryDelay
        retryDelay = Math.min(retryDelay * 2, 60_000)
      } finally {
        inFlight = false

        if (!ignore) {
          scheduleUpdate(nextDelay)
        }
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        if (timerId !== undefined) {
          window.clearTimeout(timerId)
          timerId = undefined
        }
        return
      }

      void updatePageData()
    }

    if (document.visibilityState === 'visible') {
      void updatePageData()
    }
    window.addEventListener('popstate', handleNavigation)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      ignore = true
      if (timerId !== undefined) {
        window.clearTimeout(timerId)
      }
      window.removeEventListener('popstate', handleNavigation)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [pathname, retryToken])

  useEffect(() => {
    updateDocumentMetadata(product, pathname)

    if (previousPathname.current !== pathname) {
      window.scrollTo(0, 0)
      mainRef.current?.focus({ preventScroll: true })
      previousPathname.current = pathname
    }
  }, [pathname, product])

  const retryPageData = () => setRetryToken((value) => value + 1)

  const navigate = (nextPath: RoutePath) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()

    if (typeof window === 'undefined' || window.location.pathname === nextPath) {
      return
    }

    window.history.pushState({}, '', nextPath)
    startTransition(() => {
      setPathname(nextPath)
    })
  }

  const logo = product.logo && isSafeAssetHref(product.logo) ? product.logo : undefined
  const configuredLinks = (product.navigation ?? []).filter((item) => isSafeNavigationHref(item.href))

  return (
    <div className="app-shell">
      <div className="app-shell__glow app-shell__glow--left" />
      <div className="app-shell__glow app-shell__glow--right" />

      <header className="topbar">
        <a className="brand" href="/" onClick={navigate('/')}>
          {logo ? <img className="brand__logo" src={logo} alt="" /> : <span className="brand__mark" aria-hidden="true" />}
          <span>
            <strong>{product.name}</strong>
            <small>Service status</small>
          </span>
        </a>

        <nav className="topbar__nav" aria-label="Primary">
          <a
            aria-current={pathname === '/' ? 'page' : undefined}
            className={pathname === '/' ? 'nav-link nav-link--active' : 'nav-link'}
            href="/"
            onClick={navigate('/')}
          >
            Status
          </a>
          <a
            aria-current={pathname === '/incidents' ? 'page' : undefined}
            className={pathname === '/incidents' ? 'nav-link nav-link--active' : 'nav-link'}
            href="/incidents"
            onClick={navigate('/incidents')}
          >
            Incidents
          </a>
          {configuredLinks.map((item) => (
            <a className="nav-link" href={item.href} key={`${item.label}-${item.href}`}>
              {item.label}
            </a>
          ))}
        </nav>
      </header>

      <main
        aria-busy={snapshotLoadState === 'loading'}
        className="app-main"
        data-sync-state={snapshotLoadState}
        id="main-content"
        ref={mainRef}
        tabIndex={-1}
      >
        {snapshotLoadState === 'error' && pathname === '/' ? (
          <p className="sync-notice" role="status">
            Live status data is unavailable. Retrying automatically.
          </p>
        ) : null}
        {pathname === '/incidents' ? (
          <IncidentsPage data={incidentPageData} loadState={snapshotLoadState} onRetry={retryPageData} />
        ) : (
          <HomePage
            onRetry={retryPageData}
            snapshot={snapshot}
            loadState={snapshotLoadState}
          />
        )}
      </main>
    </div>
  )
}
