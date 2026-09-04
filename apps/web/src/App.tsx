import { startTransition, useEffect, useState, type MouseEvent } from 'react'

import { HomePage } from './routes/HomePage'
import { IncidentsPage } from './routes/IncidentsPage'
import {
  getInitialStatusSnapshot,
  getStatusSnapshot,
  type SnapshotLoadState,
  type StatusSnapshot,
} from './lib/api'

type RoutePath = '/' | '/incidents'

export function resolveRoutePath(pathname: string): RoutePath {
  return pathname === '/incidents' ? '/incidents' : '/'
}

function readPathname(): RoutePath {
  return typeof window === 'undefined' ? '/' : resolveRoutePath(window.location.pathname)
}

export default function App() {
  const [pathname, setPathname] = useState<RoutePath>(readPathname)
  const [snapshot, setSnapshot] = useState<StatusSnapshot>(() => getInitialStatusSnapshot())
  const [snapshotLoadState, setSnapshotLoadState] = useState<SnapshotLoadState>('idle')
  const [clockNow, setClockNow] = useState(() => Date.now())
  const [retryToken, setRetryToken] = useState(0)

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
      }

      timerId = window.setTimeout(() => {
        timerId = undefined
        void updateSnapshot()
      }, delay)
    }

    const updateSnapshot = async () => {
      if (inFlight) {
        return
      }

      inFlight = true
      startTransition(() => {
        setSnapshotLoadState('loading')
      })

      let nextDelay = 30_000

      try {
        const nextSnapshot = await getStatusSnapshot()

        if (ignore) {
          return
        }

        startTransition(() => {
          setSnapshot(nextSnapshot)
          setSnapshotLoadState('ready')
        })
        retryDelay = 10_000
      } catch {
        if (ignore) {
          return
        }

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
        return
      }

      void updateSnapshot()
    }

    void updateSnapshot()
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
  }, [retryToken])

  useEffect(() => {
    const intervalId = window.setInterval(() => setClockNow(Date.now()), 30_000)

    return () => window.clearInterval(intervalId)
  }, [])

  const retrySnapshot = () => setRetryToken((value) => value + 1)

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

  return (
    <div className="app-shell">
      <div className="app-shell__glow app-shell__glow--left" />
      <div className="app-shell__glow app-shell__glow--right" />

      <header className="topbar">
        <a className="brand" href="/" onClick={navigate('/')}>
          <span className="brand__mark" aria-hidden="true" />
          <span>
            <strong>{snapshot.product.name}</strong>
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
        </nav>
      </header>

      <main
        aria-busy={snapshotLoadState === 'loading'}
        className="app-main"
        data-sync-state={snapshotLoadState}
      >
        {snapshotLoadState === 'error' ? (
          <p className="sync-notice" role="status">
            Live status data is unavailable. Retrying automatically.
          </p>
        ) : null}
        {pathname === '/incidents' ? (
          <IncidentsPage snapshot={snapshot} />
        ) : (
          <HomePage
            now={clockNow}
            onRetry={retrySnapshot}
            snapshot={snapshot}
            loadState={snapshotLoadState}
          />
        )}
      </main>
    </div>
  )
}
