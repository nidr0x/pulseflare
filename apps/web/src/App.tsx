import { startTransition, useEffect, useState, type MouseEvent } from 'react'

import { HomePage } from './routes/HomePage'
import { IncidentsPage } from './routes/IncidentsPage'
import { getInitialStatusSnapshot, getStatusSnapshot, type StatusSnapshot } from './lib/api'

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
  const [snapshotLoadState, setSnapshotLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')

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

    const updateSnapshot = async () => {
      startTransition(() => {
        setSnapshotLoadState('loading')
      })

      try {
        const nextSnapshot = await getStatusSnapshot()

        if (ignore) {
          return
        }

        startTransition(() => {
          setSnapshot(nextSnapshot)
          setSnapshotLoadState('ready')
        })
      } catch {
        if (ignore) {
          return
        }

        startTransition(() => {
          setSnapshotLoadState('error')
        })
      }
    }

    updateSnapshot()
    window.addEventListener('popstate', handleNavigation)

    return () => {
      ignore = true
      window.removeEventListener('popstate', handleNavigation)
    }
  }, [])

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
        {pathname === '/incidents' ? <IncidentsPage snapshot={snapshot} /> : <HomePage snapshot={snapshot} />}
      </main>
    </div>
  )
}
