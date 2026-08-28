import { useEffect, useState } from 'react'
import { registerSourceDictionary } from './AdminShared.jsx'
import { ADMIN_NAVIGATION, readResponseData, statusTone } from './admin-data.js'
import {
  AdminAccountView,
  AdminArticlesView,
  AdminAuditView,
  AdminGovernanceView,
  AdminJobsView,
  AdminOverviewView,
  AdminSourcesView,
  AdminUsersView,
  Icon,
} from './AdminViews.jsx'
import './admin.css'

export { ADMIN_NAVIGATION }

const ROUTES = new Set(ADMIN_NAVIGATION.map((item) => item.id))
const NAV_ICON_BY_ROUTE = Object.freeze({
  overview: 'grid',
  jobs: 'jobs',
  articles: 'articles',
  governance: 'shield',
  sources: 'globe',
  users: 'user',
  audit: 'audit',
  account: 'account',
})

function BrandMark() {
  return (
    <span className="admin-brand-mark" aria-hidden="true">
      <svg viewBox="0 0 256 256" fill="currentColor">
        <path d="M128.005 191.173C128.448 156.208 156.93 128 192 128V64h-64c0 35.346-28.654 64-64 64v64h64ZM192 256H64C28.654 256 0 227.346 0 192V64h64V0h128c35.346 0 64 28.654 64 64v128h-64v64Z" />
      </svg>
    </span>
  )
}

function ThemeButton({ theme, onToggle }) {
  const dark = theme === 'dark'
  return (
    <button
      className="admin-theme-button"
      type="button"
      onClick={onToggle}
      aria-label="Chuyển chế độ sáng tối"
    >
      <Icon name={dark ? 'sun' : 'moon'} size={16} />
      <span>{dark ? 'Chế độ sáng' : 'Chế độ tối'}</span>
    </button>
  )
}

function Navigation({ route, onNavigate, overview }) {
  const counts = readResponseData(overview) ?? {}
  const sections = []
  for (const item of ADMIN_NAVIGATION) {
    if (!sections.includes(item.section)) sections.push(item.section)
  }
  return (
    <nav className="admin-navigation" aria-label="Điều hướng quản trị">
      {sections.map((section) => (
        <div className="admin-nav-group" key={section}>
          <p>{section}</p>
          {ADMIN_NAVIGATION.filter((item) => item.section === section).map((item) => {
            const current = item.id === route
            const badge = item.badge ? counts[item.badge] : null
            return (
              <button
                key={item.id}
                className={`admin-nav-item${current ? ' active' : ''}`}
                type="button"
                aria-current={current ? 'page' : undefined}
                onClick={() => onNavigate(item.id)}
              >
                <Icon name={NAV_ICON_BY_ROUTE[item.id]} size={17} />
                <span>{item.label}</span>
                {Number(badge) > 0 ? (
                  <b
                    className={`admin-nav-badge admin-nav-badge-${statusTone(item.id === 'governance' ? 'reviewing' : 'failed')}`}
                  >
                    {badge}
                  </b>
                ) : null}
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

function MobileNavigation({ route, onNavigate }) {
  return (
    <nav className="admin-mobile-navigation" aria-label="Điều hướng quản trị trên thiết bị di động">
      {ADMIN_NAVIGATION.map((item) => (
        <button
          key={item.id}
          className={item.id === route ? 'active' : ''}
          type="button"
          aria-current={item.id === route ? 'page' : undefined}
          onClick={() => onNavigate(item.id)}
        >
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  )
}

function renderView(route, props) {
  if (route === 'overview')
    return <AdminOverviewView {...props} initialData={props.initialData?.overview} />
  if (route === 'jobs') return <AdminJobsView {...props} initialData={props.initialData?.jobs} />
  if (route === 'articles')
    return <AdminArticlesView {...props} initialData={props.initialData?.articles} />
  if (route === 'governance' || route === 'deletions')
    return <AdminGovernanceView {...props} initialData={props.initialData?.governance} />
  if (route === 'sources')
    return <AdminSourcesView {...props} initialData={props.initialData?.sources} />
  if (route === 'users') return <AdminUsersView {...props} initialData={props.initialData?.users} />
  if (route === 'audit') return <AdminAuditView {...props} initialData={props.initialData?.audit} />
  if (route === 'account') return <AdminAccountView {...props} />
  return null
}

export default function AdminRedesign({
  api,
  session,
  route,
  initialData = {},
  onNavigate,
  onSessionExpired,
  onLogout,
  theme: suppliedTheme,
  onToggleTheme,
}) {
  const controlled = route !== undefined
  const [localRoute, setLocalRoute] = useState('overview')
  const [localTheme, setLocalTheme] = useState(suppliedTheme ?? 'light')
  const activeRoute = controlled ? (route === 'deletions' ? 'governance' : route) : localRoute
  const theme = suppliedTheme ?? localTheme
  const overview = initialData?.overview
  if (initialData?.sources) {
    const sources = initialData.sources?.sources || initialData.sources || []
    if (Array.isArray(sources)) registerSourceDictionary(sources)
  }
  useEffect(() => {
    if (!api?.listSources) return undefined
    let active = true
    void Promise.resolve(api.listSources({ credentials: 'same-origin' }))
      .then((res) => {
        if (!active) return
        const sources = res?.data?.sources || res?.data || []
        if (Array.isArray(sources)) registerSourceDictionary(sources)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [api])
  const viewProps = {
    api,
    session,
    initialData,
    onSessionExpired,
    onNavigate,
    cacheScope: session,
  }

  function navigate(nextRoute) {
    if (!ROUTES.has(nextRoute)) return
    if (!controlled) setLocalRoute(nextRoute)
    onNavigate?.(nextRoute)
  }

  function toggleTheme() {
    if (onToggleTheme) {
      onToggleTheme()
      return
    }
    setLocalTheme((value) => (value === 'dark' ? 'light' : 'dark'))
  }

  return (
    <section
      className={`redesign-admin${theme === 'dark' ? ' admin-theme-dark' : ''}`}
      data-admin-route={activeRoute}
    >
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <BrandMark />
          <span>TechPulse Admin</span>
        </div>
        <Navigation route={activeRoute} onNavigate={navigate} overview={overview} />
        <div className="admin-sidebar-footer">
          <ThemeButton theme={theme} onToggle={toggleTheme} />
        </div>
      </aside>
      <div className="admin-content">
        <MobileNavigation route={activeRoute} onNavigate={navigate} />
        <main className="admin-main" tabIndex="-1">
          {renderView(activeRoute, { ...viewProps, onLogout })}
        </main>
      </div>
    </section>
  )
}

export { BrandMark, ThemeButton, Navigation, MobileNavigation }
