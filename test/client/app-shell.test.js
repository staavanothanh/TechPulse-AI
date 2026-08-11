import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AdminNavigation } from '../../client/App.jsx'

describe('admin shell navigation', () => {
  it('renders one current admin destination without blueprint-step copy', () => {
    const html = renderToStaticMarkup(React.createElement(AdminNavigation, {
      route: 'indexing',
      onNavigate: vi.fn(),
    }))
    expect(html).toContain('aria-current="page"')
    expect((html.match(/aria-current="page"/g) ?? [])).toHaveLength(1)
    expect(html).toContain('aria-label="Điều hướng quản trị"')
    expect(html).toContain('<button')
    expect(html).toContain('Indexing jobs')
    expect(html).not.toContain('Step 04')
    expect(html).not.toContain('Source policy, durable jobs')
  })

  it('uses local button selection without adding a route', () => {
    const onNavigate = vi.fn()
    const navigation = AdminNavigation({ route: 'sources', onNavigate })
    const buttons = React.Children.toArray(navigation.props.children).filter((child) => child.type === 'button')
    const indexing = buttons.find((button) => button.props.children === 'Indexing jobs')

    indexing.props.onClick()

    expect(onNavigate).toHaveBeenCalledWith('indexing')
  })
})
