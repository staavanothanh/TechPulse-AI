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
    expect((html.match(/<button/g) ?? [])).toHaveLength(8)
    expect(html).toContain('>Tài khoản<')
    expect(html).toContain('>Source Registry<')
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

  it('exposes Source Registry as a current, keyboard-reachable destination', () => {
    const onNavigate = vi.fn()
    const navigation = AdminNavigation({ route: 'sources', onNavigate })
    const buttons = React.Children.toArray(navigation.props.children).filter((child) => child.type === 'button')
    const source = buttons.find((button) => button.props.children === 'Source Registry')

    expect(source.props['aria-current']).toBe('page')
    expect(source.props.type).toBe('button')
    source.props.onClick()

    expect(onNavigate).toHaveBeenCalledWith('sources')
  })

  it('keeps Source Registry and account controls available from every mobile admin workspace', () => {
    const onNavigate = vi.fn()
    for (const route of ['overview', 'jobs', 'sources']) {
      const navigation = AdminMobileAccountNavigation({ route, onNavigate })
      const buttons = React.Children.toArray(navigation.props.children)
      const sourceButton = buttons.find((button) => button.props.children === 'Source Registry')
      const accountButton = buttons.find((button) => ['Tài khoản', 'Quay lại admin'].includes(button.props.children))

      expect(navigation.props['aria-label']).toBe('Điều hướng quản trị mobile')
      expect(sourceButton.props.type).toBe('button')
      expect(accountButton.props.type).toBe('button')
      sourceButton.props.onClick()
      accountButton.props.onClick()
    }

    expect(onNavigate).toHaveBeenCalledTimes(6)
    expect(onNavigate.mock.calls.filter(([route]) => route === 'sources')).toHaveLength(3)
    expect(onNavigate).toHaveBeenLastCalledWith('account')

    const accountNavigation = AdminMobileAccountNavigation({ route: 'account', onNavigate })
    const accountButtons = React.Children.toArray(accountNavigation.props.children)
    const escapeButton = accountButtons.find((button) => button.props.children === 'Quay lại admin')
    expect(escapeButton.props.children).toBe('Quay lại admin')
    expect(escapeButton.props['aria-current']).toBeUndefined()
    escapeButton.props.onClick()
    expect(onNavigate).toHaveBeenLastCalledWith('overview')
  })
})
