import { useState } from 'react'
import { safeHttpsUrl } from './safe-url.js'

function OwnedFallback() {
  return (
    <div className="content-media-fallback" role="img" aria-label="Minh họa dự phòng của TechPulse">
      <span aria-hidden="true">TP</span>
      <p>TechPulse · tín hiệu đã kiểm chứng</p>
    </div>
  )
}

export default function LeadMediaView({ media }) {
  const [failed, setFailed] = useState(false)
  if (!media || failed) return <OwnedFallback />
  const sourcePageUrl = safeHttpsUrl(media.sourcePageUrl)
  if (media.type === 'image' && media.displayMode === 'remote-preview') {
    const url = safeHttpsUrl(media.url)
    if (!url || !sourcePageUrl || !media.attribution) return <OwnedFallback />
    return (
      <figure className="content-media">
        <img src={url} alt={media.altText || ''} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
        <figcaption>{media.attribution}</figcaption>
      </figure>
    )
  }
  if (media.type === 'video' && media.displayMode === 'link-only' && sourcePageUrl) {
    return (
      <aside className="content-video" aria-label="Video tại nguồn">
        <div className="content-video-mark" aria-hidden="true">VIDEO</div>
        <p>AI chưa phân tích video này</p>
        <a href={sourcePageUrl} target="_blank" rel="noopener noreferrer external">Mở video tại nguồn</a>
        <small>{media.attribution}</small>
      </aside>
    )
  }
  return <OwnedFallback />
}
