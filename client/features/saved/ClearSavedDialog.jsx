import { useEffect, useRef } from 'react'
import { focusTrapTarget } from './dialog-focus.js'

export default function ClearSavedDialog({ open, busy, onCancel, onConfirm }) {
  const dialogRef = useRef(null)
  const confirmRef = useRef(null)
  useEffect(() => {
    if (open) confirmRef.current?.focus()
  }, [open])
  if (!open) return null
  function onKeyDown(event) {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault()
      onCancel?.()
      return
    }
    const focusables = [...(dialogRef.current?.querySelectorAll('button:not([disabled]), [href], input:not([disabled])') ?? [])]
    const target = focusTrapTarget({ key: event.key, shiftKey: event.shiftKey, activeElement: document.activeElement, focusables })
    if (target) {
      event.preventDefault()
      target.focus()
    }
  }
  return (
    <div className="content-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel?.() }}>
      <section className="content-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-saved-title" aria-describedby="clear-saved-copy" ref={dialogRef} onKeyDown={onKeyDown}>
        <div className="content-dialog-body">
          <div className="content-eyebrow">Thao tác không thể hoàn tác</div>
          <h2 id="clear-saved-title">Xóa tất cả bài đã lưu?</h2>
          <p id="clear-saved-copy">Danh sách đã lưu của tài khoản này sẽ được xóa. Bài nguồn không bị ảnh hưởng.</p>
        </div>
        <div className="content-dialog-actions">
          <button className="content-button" type="button" onClick={onCancel} disabled={busy}>Giữ lại</button>
          <button className="content-button content-button-danger" type="button" onClick={onConfirm} disabled={busy} aria-busy={busy || undefined} ref={confirmRef}>{busy ? 'Đang xóa…' : 'Xóa tất cả bài đã lưu'}</button>
        </div>
      </section>
    </div>
  )
}
