import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AdminMobileAccountNavigation, AdminNavigation } from '../../client/App.jsx'

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
    expect((html.match(/<button/g) ?? [])).toHaveLength(7)
    expect(html).toContain('>Tài khoản<')
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

  it('exposes the account destination as a current, keyboard-reachable button', () => {
    const onNavigate = vi.fn()
    const navigation = AdminNavigation({ route: 'account', onNavigate })
    const buttons = React.Children.toArray(navigation.props.children).filter((child) => child.type === 'button')
    const account = buttons.find((button) => button.props.children === 'Tài khoản')

    expect(account.props['aria-current']).toBe('page')
    expect(account.props.type).toBe('button')
    account.props.onClick()

    expect(onNavigate).toHaveBeenCalledWith('account')
  })

  it('keeps the account control available from every mobile admin workspace', () => {
    const onNavigate = vi.fn()
    for (const route of ['overview', 'jobs', 'sources']) {
      const navigation = AdminMobileAccountNavigation({ route, onNavigate })
      const button = navigation.props.children

      expect(navigation.props['aria-label']).toBe('Điều hướng quản trị mobile')
      expect(button.props.type).toBe('button')
      expect(button.props['aria-current']).toBeUndefined()
      button.props.onClick()
    }

    expect(onNavigate).toHaveBeenCalledTimes(3)
    expect(onNavigate).toHaveBeenLastCalledWith('account')

    const accountNavigation = AdminMobileAccountNavigation({ route: 'account', onNavigate })
    const escapeButton = accountNavigation.props.children
    expect(escapeButton.props.children).toBe('Quay lại admin')
    expect(escapeButton.props['aria-current']).toBeUndefined()
    escapeButton.props.onClick()
    expect(onNavigate).toHaveBeenLastCalledWith('overview')
  })
})
