import { useState } from 'react'
import { validateQuestionScope } from './qa-validation.js'

export default function QuestionComposer({ scope, onSubmit, onInvalid, onFieldChange, busy = false, cooldown = 0, errors = {} }) {
  const [question, setQuestion] = useState('')
  const [error, setError] = useState('')
  function submit(event) {
    event.preventDefault()
    const result = validateQuestionScope(question, scope)
    if (!result.valid) {
      setError(result.firstInvalid === 'question' ? result.message : '')
      onInvalid?.(result)
      return
    }
    setError(''); onSubmit?.(question.trim())
  }
  const questionError = errors.question || error
  return <form className="qa-composer" id="qa-composer" onSubmit={submit} aria-busy={busy}><label className="qa-control" htmlFor="qa-question"><span>Câu hỏi tiếng Việt</span><textarea className="qa-input qa-question" id="qa-question" value={question} maxLength="1000" onChange={(event) => { setQuestion(event.target.value); setError(''); onFieldChange?.('question') }} aria-invalid={Boolean(questionError)} aria-describedby={questionError ? 'qa-question-error qa-question-hint' : 'qa-question-hint'} placeholder="Bạn muốn kiểm chứng điều gì?" /></label><div className="qa-composer-footer"><span className="qa-hint" id="qa-question-hint">{question.length} / 1.000 ký tự</span>{questionError ? <span className="qa-error" id="qa-question-error" role="alert">{questionError}</span> : null}<button className="qa-button qa-primary" type="submit" disabled={busy || cooldown > 0}>{busy ? 'Đang xử lý…' : cooldown > 0 ? `Thử lại sau ${cooldown} giây` : 'Gửi câu hỏi'}</button></div></form>
}
