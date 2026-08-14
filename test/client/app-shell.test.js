import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AdminNavigation } from '../../client/App.jsx'

describe('admin shell navigation', () => {
  it('renders one current admin destination without blueprint-step copy', () => {
    const html = renderToStaticMarkup(React.createElement(AdminNavigation, {
      route: 'jobs',
      onNavigate: vi.fn(),
    }))
    expect(html).toContain('aria-current="page"')
    expect((html.match(/aria-current="page"/g) ?? [])).toHaveLength(1)
    expect(html).toContain('aria-label="Điều hướng quản trị"')
    expect(html).toContain('<button')
    expect(html).toContain('>Jobs<')
    expect((html.match(/<button/g) ?? [])).toHaveLength(6)
    expect(html).not.toContain('Source Registry')
    expect(html).not.toContain('Step 04')
    expect(html).not.toContain('Source policy, durable jobs')
  })

  it('does not expose an unknown destination', () => {
    const html = renderToStaticMarkup(React.createElement(AdminNavigation, {
      route: 'removed',
      onNavigate: vi.fn(),
    }))
    expect(html).not.toContain('aria-current="page"')
  })

  it('uses local button selection without adding a route', () => {
    const onNavigate = vi.fn()
    const navigation = AdminNavigation({ route: 'jobs', onNavigate })
    const buttons = React.Children.toArray(navigation.props.children).filter((child) => child.type === 'button')
    const jobs = buttons.find((button) => button.props.children === 'Jobs')

    jobs.props.onClick()

    expect(onNavigate).toHaveBeenCalledWith('jobs')
  })
})
