import { useEffect, useRef, useState } from 'react'
import { statusLabel } from './admin-helpers.js'

export function FailureNotice({ failure, onRetry }) {
  if (!failure) return null
  return (
    <div className="admin-notice admin-notice-error" role="alert">
      <p>{failure.message}</p>
      {onRetry ? (
        <button type="button" className="admin-button" onClick={onRetry}>
          Thử lại
        </button>
      ) : null}
    </div>
  )
}

export function EmptyState({ title = 'Không có bản ghi phù hợp.', description = 'Bộ lọc hiện tại chưa trả về dữ liệu.' }) {
  return (
    <div className="admin-empty">
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  )
}

export function LoadingState({ label = 'Đang tải dữ liệu…' }) {
  return (
    <div className="admin-empty" aria-busy="true">
      <p>{label}</p>
    </div>
  )
}

export function RecordTable({ rows, columns, label }) {
  if (!rows.length) return <EmptyState />
  return (
    <div className="admin-records" role="region" aria-label={label}>
      {rows.map((row, index) => (
        <article className="admin-record" key={row.id ?? index}>
          {columns.map(([key, heading, render]) => (
            <div className="admin-record-field" key={key} data-label={heading}>
              <span className="admin-record-label">{heading}</span>
              <span className="admin-record-value">{render ? render(row[key], row) : (row[key] ?? '—')}</span>
            </div>
          ))}
        </article>
      ))}
    </div>
  )
}

export function AdminListControls({ query, fields, onApply, data, loadingMore, onLoadMore }) {
  const [draft, setDraft] = useState(query ?? {})
  const [errors, setErrors] = useState({})
  const apply = (event) => {
    event.preventDefault()
    const nextErrors = Object.fromEntries(fields.flatMap(([key]) => (String(draft[key] ?? '').length > 128 ? [[key, 'Giá trị không được dài quá 128 ký tự.']] : [])))
    setErrors(nextErrors)
    const firstInvalid = fields.find(([key]) => nextErrors[key])?.[0]
    if (firstInvalid) {
      globalThis.document?.getElementById?.(`admin-filter-${firstInvalid}`)?.focus?.({ preventScroll: true })
      return
    }
    onApply(Object.fromEntries(Object.entries(draft).filter(([, value]) => value)))
  }
  return (
    <>
      <form className="admin-list-controls" onSubmit={apply}>
        {fields.map(([key, label, options]) => (
          <label key={key} htmlFor={`admin-filter-${key}`}>
            <span>{label}</span>
            {options ? (
              <select id={`admin-filter-${key}`} value={draft[key] ?? ''} aria-invalid={Boolean(errors[key])} aria-describedby={errors[key] ? `admin-filter-${key}-error` : undefined} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}>
                <option value="">Tất cả</option>
                {options.map((option) => (
                  <option key={option} value={option}>
                    {statusLabel(option)}
                  </option>
                ))}
              </select>
            ) : (
              <input id={`admin-filter-${key}`} value={draft[key] ?? ''} maxLength="128" aria-invalid={Boolean(errors[key])} aria-describedby={errors[key] ? `admin-filter-${key}-error` : undefined} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} />
            )}
            {errors[key] ? (
              <small id={`admin-filter-${key}-error`} className="admin-field-error" role="alert">
                {errors[key]}
              </small>
            ) : null}
          </label>
        ))}
        <button type="submit" className="admin-button">
          Áp dụng bộ lọc
        </button>
      </form>
      {data?.meta?.hasNext ? (
        <div className="admin-record-actions">
          <button type="button" className="admin-button" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Đang tải thêm…' : 'Tải thêm'}
          </button>
        </div>
      ) : null}
    </>
  )
}

export function AdminConfirmationDialog({ open = false, title, consequence, reasonCode, busy = false, retryAfter = 0, error = null, trigger = null, onCancel, onConfirm, children = null }) {
  const dialogRef = useRef(null)
  const cancelRef = useRef(null)
  const confirmRef = useRef(null)
  const wasOpen = useRef(false)
  const triggerRef = useRef(null)
  useEffect(() => {
    if (open && trigger) triggerRef.current = trigger
  }, [open, trigger])
  useEffect(() => {
    if (open) cancelRef.current?.focus()
  }, [open])
  useEffect(() => {
    if (!open && wasOpen.current && triggerRef.current?.isConnected) {
      triggerRef.current.focus({ preventScroll: true })
      triggerRef.current = null
    }
    wasOpen.current = open
  }, [open])
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        onCancel?.()
        return
      }
      if (event.key !== 'Tab') return
      const focusables = [...(dialogRef.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])]
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onCancel, open])
  if (!open) return null
  return (
    <div className="admin-dialog-scrim" role="presentation">
      <section className="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-confirm-title" aria-describedby="admin-confirm-copy" ref={dialogRef}>
        <div className="admin-dialog-body">
          <span className="admin-eyebrow">Xác nhận thao tác</span>
          <h2 id="admin-confirm-title">{title}</h2>
          <p id="admin-confirm-copy">{consequence}</p>
          <p className="admin-fixed-reason">
            <span>Lý do cố định</span>
            <code>{reasonCode}</code>
          </p>
          {children}
          {error ? (
            <p className="admin-field-error" role="alert">
              {error}
            </p>
          ) : null}
          <p className="admin-sr-only">Có thể nhấn Escape để đóng.</p>
        </div>
        <div className="admin-dialog-actions">
          <button type="button" className="admin-button" ref={cancelRef} onClick={onCancel} disabled={busy}>
            Quay lại
          </button>
          <button type="button" className="admin-button admin-button-primary" ref={confirmRef} onClick={onConfirm} disabled={busy || retryAfter > 0} aria-busy={busy || undefined}>
            {busy ? 'Đang xử lý…' : retryAfter > 0 ? `Thử lại sau ${retryAfter} giây` : 'Xác nhận'}
          </button>
        </div>
      </section>
    </div>
  )
}
