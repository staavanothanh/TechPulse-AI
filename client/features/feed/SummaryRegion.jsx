const BASIS_LABELS = Object.freeze({
  metadata: 'Cơ sở: metadata nguồn',
  excerpt: 'Cơ sở: metadata + trích đoạn',
  'fulltext-temporary': 'Cơ sở: nội dung xử lý tạm thời',
})

function summaryBasisLabel(value) {
  return BASIS_LABELS[value] ?? 'Cơ sở: thông tin nguồn đã được phép'
}

function summaryCopy(status) {
  if (status === 'pending') return 'Tóm tắt đang chờ xử lý. Bài nguồn vẫn có thể được kiểm chứng.'
  if (status === 'processing') return 'Tóm tắt đang được xử lý. Bạn có thể mở nguồn gốc ngay.'
  return 'Tóm tắt chưa khả dụng. Bài nguồn vẫn có thể được kiểm chứng.'
}

export default function SummaryRegion({ article, detail = false }) {
  const status = ['pending', 'processing', 'ready', 'failed'].includes(article?.summaryStatus) ? article.summaryStatus : 'failed'
  const ready = status === 'ready' && typeof article?.summaryVi === 'string' && article.summaryVi.length > 0 && typeof article?.summaryBasis === 'string' && article.summaryBasis.length > 0
  const title = detail ? 'Tóm tắt tiếng Việt · AI' : 'AI tổng hợp'

  if (ready) {
    return (
      <section className="content-summary content-summary-ready" aria-label="Tóm tắt AI">
        <div className="content-summary-label"><span>{title}</span><span className="content-summary-basis">{summaryBasisLabel(article.summaryBasis)}</span></div>
        <p>{article.summaryVi}</p>
        {detail && article.aiDisclosure ? <small className="content-summary-disclosure">{article.aiDisclosure}</small> : null}
      </section>
    )
  }

  return (
    <section className={`content-summary content-summary-quiet content-summary-${status}`} aria-label="Trạng thái tóm tắt AI" aria-busy={status === 'processing' || undefined}>
      <div className="content-summary-label"><span>{title}</span><span className="content-summary-status">{status === 'processing' ? 'Đang xử lý' : status === 'pending' ? 'Đang chờ' : 'Chưa khả dụng'}</span></div>
      <p>{summaryCopy(status)}</p>
    </section>
  )
}
