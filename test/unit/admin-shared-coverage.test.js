import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  ADMIN_DIALOG_FOCUSABLE_SELECTOR,
  AdminButton,
  AdminConfirmDialog,
  ArticlePreviewDialog,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  PageHeader,
  Panel,
  ResourceFrame,
  StatusBadge,
  Table,
  adminDialogFocusAction,
  collectAdminDialogFocusables,
  resolveDialogReturnTarget,
} from '../../client/features/admin/ui/AdminShared.jsx'

function el(type, props, ...children) {
  return React.createElement(type, props, ...children)
}

function render(element) {
  return renderToStaticMarkup(element)
}

describe('AdminShared render states', () => {
  it('renders every icon fallback and button/header/panel variant', () => {
    const names = [
      'activity',
      'archive',
      'arrow',
      'book',
      'check',
      'globe',
      'jobs',
      'articles',
      'audit',
      'grid',
      'lock',
      'moon',
      'pause',
      'play',
      'refresh',
      'shield',
      'sun',
      'user',
      'account',
      'x',
      'unknown',
    ]
    for (const name of names) expect(render(el(Icon, { name, size: 16 }))).toContain('<svg')
    expect(
      render(
        el(
          AdminButton,
          { variant: 'primary', size: 'small', icon: 'check', disabled: true },
          'Run',
        ),
      ),
    ).toContain('admin-btn-small')
    expect(render(el(AdminButton, null, 'Plain'))).not.toContain('admin-icon')
    expect(
      render(
        el(PageHeader, {
          eyebrow: 'Eyebrow',
          title: 'Title',
          description: 'Description',
          action: el('span', null, 'Action'),
        }),
      ),
    ).toContain('admin-page-actions')
    expect(render(el(PageHeader, { eyebrow: 'Eyebrow', title: 'Title' }))).not.toContain(
      'admin-page-description',
    )
    expect(
      render(
        el(Panel, { title: 'Panel', hint: 'Hint', className: 'custom' }, el('p', null, 'Body')),
      ),
    ).toContain('custom')
    expect(render(el(Panel, null, el('p', null, 'Body')))).toContain('Body')
  })

  it('renders loading, error, empty, status and table data states', () => {
    expect(render(el(LoadingState, { label: 'Loading now' }))).toContain('Loading now')
    expect(render(el(ErrorState, { message: 'Failed', onRetry: vi.fn() }))).toContain('Thử lại')
    expect(render(el(ErrorState, { message: 'Failed' }))).not.toContain('Thử lại')
    expect(render(el(EmptyState))).toContain('Chưa có bản ghi phù hợp')
    expect(render(el(StatusBadge, { value: 'failed' }))).toContain('Lỗi')
    expect(render(el(StatusBadge, { value: 'unknown', label: 'Custom' }))).toContain('Custom')

    const columns = [
      { key: 'id', label: 'ID' },
      { key: 'name', label: 'Name', render: (value) => el('strong', null, value) },
    ]
    expect(
      render(el(Table, { label: 'Rows', columns, rows: [], emptyTitle: 'No rows' })),
    ).toContain('No rows')
    expect(
      render(
        el(Table, {
          label: 'Rows',
          columns,
          rows: [{ id: 'row-1', name: 'Name' }, { name: null }],
          emptyTitle: 'No rows',
        }),
      ),
    ).toContain('row-1')
    expect(
      render(
        el(Table, { label: 'Rows', columns, rows: [{ id: 'row-1', name: 'Name' }] }, (row) =>
          el('button', { type: 'button' }, row.id),
        ),
      ),
    ).toContain('admin-table-actions')
  })

  it('renders ResourceFrame loading, error, pagination and normal states', () => {
    expect(
      render(
        el(
          ResourceFrame,
          { resource: { state: 'loading' }, loadingLabel: 'Loading resources' },
          el('p', null, 'Hidden'),
        ),
      ),
    ).toContain('Loading resources')
    expect(
      render(
        el(
          ResourceFrame,
          {
            resource: {
              state: 'loading',
              data: { meta: { hasNext: false } },
              loadMore: vi.fn(),
              loadingMore: false,
            },
            loadingLabel: 'Refreshing resources',
          },
          el('p', null, 'Existing rows remain mounted'),
        ),
      ),
    ).toContain('Existing rows remain mounted')
    expect(
      render(
        el(
          ResourceFrame,
          {
            resource: { state: 'error', error: 'Failed', reload: vi.fn() },
            loadingLabel: 'Loading',
          },
          el('p', null, 'Hidden'),
        ),
      ),
    ).toContain('Failed')
    expect(
      render(
        el(
          ResourceFrame,
          {
            resource: {
              state: 'ready',
              data: { meta: { hasNext: true, nextCursor: 'cursor' } },
              loadMore: vi.fn(),
              loadingMore: false,
            },
          },
          el('p', null, 'Ready'),
        ),
      ),
    ).toContain('Tải thêm')
    expect(
      render(
        el(
          ResourceFrame,
          {
            resource: {
              state: 'ready',
              data: { meta: { hasNext: true, nextCursor: 'cursor' } },
              loadMore: vi.fn(),
              loadingMore: true,
            },
          },
          el('p', null, 'Ready'),
        ),
      ),
    ).toContain('Đang tải thêm')
    expect(
      render(
        el(
          ResourceFrame,
          { resource: { state: 'ready', data: { meta: { hasNext: false } } } },
          el('p', null, 'Ready'),
        ),
      ),
    ).not.toContain('Tải thêm')
  })

  it('renders confirmation dialog closed, open and busy variants', () => {
    const props = {
      title: 'Confirm',
      consequence: 'Consequence',
      reasonCode: 'reason',
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }
    expect(render(el(AdminConfirmDialog, props))).toBe('')
    expect(render(el(AdminConfirmDialog, { ...props, open: true }))).toContain('Xác nhận')
    expect(render(el(AdminConfirmDialog, { ...props, open: true, busy: true }))).toContain(
      'Đang xử lý',
    )
  })
  it('covers all enabled dialog controls, gated Escape, and dynamic return targets', () => {
    const link = { focus: vi.fn(), disabled: false, getAttribute: () => null }
    const button = { focus: vi.fn(), disabled: false, getAttribute: () => null }
    const input = { focus: vi.fn(), disabled: false, getAttribute: () => null }
    const textarea = { focus: vi.fn(), disabled: false, getAttribute: () => null }
    const select = { focus: vi.fn(), disabled: false, getAttribute: () => null }
    const custom = { focus: vi.fn(), disabled: false, getAttribute: () => '0' }
    const disabled = { focus: vi.fn(), disabled: true, getAttribute: () => null }
    const untabbable = { focus: vi.fn(), disabled: false, getAttribute: () => '-1' }
    const dialog = {
      querySelectorAll: vi.fn(() => [
        link,
        button,
        input,
        textarea,
        select,
        custom,
        disabled,
        untabbable,
      ]),
    }

    const focusables = collectAdminDialogFocusables(dialog)

    expect(dialog.querySelectorAll).toHaveBeenCalledWith(ADMIN_DIALOG_FOCUSABLE_SELECTOR)
    expect(focusables).toEqual([link, button, input, textarea, select, custom])
    expect(adminDialogFocusAction({ key: 'Tab', activeElement: custom, focusables })).toEqual({
      type: 'focus',
      target: link,
    })
    expect(
      adminDialogFocusAction({ key: 'Tab', shiftKey: true, activeElement: link, focusables }),
    ).toEqual({ type: 'focus', target: custom })
    expect(adminDialogFocusAction({ key: 'Tab', activeElement: input, focusables })).toBeNull()
    expect(adminDialogFocusAction({ key: 'Escape', escapeAllowed: true })).toEqual({
      type: 'close',
    })
    expect(adminDialogFocusAction({ key: 'Escape', escapeAllowed: false })).toBeNull()
    const dialogFallback = { focus: vi.fn() }
    expect(
      adminDialogFocusAction({ key: 'Tab', focusables: [], fallbackTarget: dialogFallback }),
    ).toEqual({ type: 'focus', target: dialogFallback })

    const jobsTrigger = { focus: vi.fn(), isConnected: true }
    const sourceRegistryTrigger = { focus: vi.fn(), isConnected: true }
    expect(resolveDialogReturnTarget({ activeElement: jobsTrigger })).toBe(jobsTrigger)
    expect(resolveDialogReturnTarget({ explicitTarget: jobsTrigger })).toBe(jobsTrigger)
    expect(resolveDialogReturnTarget({ activeElement: sourceRegistryTrigger })).toBe(
      sourceRegistryTrigger,
    )
    expect(resolveDialogReturnTarget({ explicitTarget: sourceRegistryTrigger })).toBe(
      sourceRegistryTrigger,
    )
    const detachedTrigger = { focus: vi.fn(), isConnected: false }
    expect(
      resolveDialogReturnTarget({ activeElement: jobsTrigger, explicitTarget: detachedTrigger }),
    ).toBe(jobsTrigger)
    for (const trigger of [jobsTrigger, sourceRegistryTrigger]) {
      resolveDialogReturnTarget({ explicitTarget: trigger })?.focus({ preventScroll: true })
      expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true })
    }
  })

  it('keeps both admin dialogs SSR-safe and keyboard-fallback focusable', () => {
    expect(() =>
      render(
        el(AdminConfirmDialog, {
          open: true,
          title: 'Confirm',
          consequence: 'Consequence',
          reasonCode: 'reason',
          onCancel: vi.fn(),
          onConfirm: vi.fn(),
        }),
      ),
    ).not.toThrow()
    const preview = render(
      el(ArticlePreviewDialog, { open: true, articleId: 'article-1', api: {} }),
    )
    expect(preview).toContain('role="dialog"')
    expect(preview).toContain('tabindex="-1"')
  })
 })
