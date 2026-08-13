export default function AnswerScopeControls({ value = {}, onChange, onFieldChange, error = '', errors = {}, idPrefix = 'qa' }) {
  const scope = { topics: [], ...value }
  const update = (key, next) => { onFieldChange?.(key); onChange?.({ ...scope, [key]: next }) }
  const field = (name) => errors[name] || (name === 'scope' ? error : '')
  const props = (name) => ({
    'aria-invalid': Boolean(field(name)),
    'aria-describedby': field(name) ? `${idPrefix}-${name}-error` : undefined,
  })

  return (
    <fieldset className="qa-scope-form" id={`${idPrefix}-scope`} tabIndex="-1" aria-invalid={Boolean(field('scope'))} aria-describedby={field('scope') ? `${idPrefix}-scope-error` : undefined}>
      <legend>Phạm vi nguồn</legend>
      <label className="qa-control" htmlFor={`${idPrefix}-articleId`}>
        <span>Bài viết (tuỳ chọn)</span>
        <input className="qa-input" id={`${idPrefix}-articleId`} value={scope.articleId ?? ''} maxLength="128" onChange={(event) => update('articleId', event.target.value || undefined)} {...props('articleId')} placeholder="Mã bài viết" />
        {field('articleId') ? <span className="qa-error" id={`${idPrefix}-articleId-error`}>{field('articleId')}</span> : null}
      </label>
      <label className="qa-control" htmlFor={`${idPrefix}-topics`}>
        <span>Chủ đề, cách nhau bằng dấu phẩy</span>
        <input className="qa-input" id={`${idPrefix}-topics`} value={scope.topics.join(', ')} onChange={(event) => update('topics', event.target.value.split(',').map((topic) => topic.trim()).filter(Boolean))} {...props('topics')} placeholder="AI, chip, dữ liệu" />
        {field('topics') ? <span className="qa-error" id={`${idPrefix}-topics-error`}>{field('topics')}</span> : null}
      </label>
      <div className="qa-date-grid">
        <label className="qa-control" htmlFor={`${idPrefix}-publishedAfter`}>
          <span>Từ ngày</span>
          <input className="qa-input" id={`${idPrefix}-publishedAfter`} type="datetime-local" value={scope.publishedAfter ? scope.publishedAfter.slice(0, 16) : ''} onChange={(event) => update('publishedAfter', event.target.value ? new Date(event.target.value).toISOString() : undefined)} {...props('publishedAfter')} />
          {field('publishedAfter') ? <span className="qa-error" id={`${idPrefix}-publishedAfter-error`}>{field('publishedAfter')}</span> : null}
        </label>
        <label className="qa-control" htmlFor={`${idPrefix}-publishedBefore`}>
          <span>Đến ngày</span>
          <input className="qa-input" id={`${idPrefix}-publishedBefore`} type="datetime-local" value={scope.publishedBefore ? scope.publishedBefore.slice(0, 16) : ''} onChange={(event) => update('publishedBefore', event.target.value ? new Date(event.target.value).toISOString() : undefined)} {...props('publishedBefore')} />
          {field('publishedBefore') ? <span className="qa-error" id={`${idPrefix}-publishedBefore-error`}>{field('publishedBefore')}</span> : null}
        </label>
      </div>
      {field('scope') ? <p className="qa-error" id={`${idPrefix}-scope-error`} role="alert">{field('scope')}</p> : <p className="qa-hint">Chọn bài viết, chủ đề hoặc đủ hai mốc thời gian.</p>}
    </fieldset>
  )
}
