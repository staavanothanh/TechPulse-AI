import { useCallback, useMemo, useState } from 'react'
import ArticleDetailScreen from '../article-detail/ArticleDetailScreen.jsx'
import SavedScreen from '../saved/SavedScreen.jsx'
import SearchScreen from '../search/SearchScreen.jsx'
import { createContentApi } from './content-api.js'
import FeedScreen from './FeedScreen.jsx'
import GroundedQaScreen from '../qa/GroundedQaScreen.jsx'
import './content.css'

const SAFE_ROUTES = new Set(['feed', 'search', 'saved', 'qa', 'account'])

export default function ContentWorkspace({ generatedApi, csrfToken, route = 'feed', onRouteChange, onSessionExpired, accountPanel }) {
  const api = useMemo(() => createContentApi(generatedApi), [generatedApi])
  const [articleId, setArticleId] = useState(null)
  const [savedOverrides, setSavedOverrides] = useState({})
  const [liveStatus, setLiveStatus] = useState('')
  const current = route === 'article' ? 'article' : SAFE_ROUTES.has(route) ? route : 'feed'

  const select = useCallback((nextRoute) => {
    if (!SAFE_ROUTES.has(nextRoute)) return
    onRouteChange?.(nextRoute)
  }, [onRouteChange])

  const openArticle = useCallback((nextArticleId) => {
    setArticleId(nextArticleId)
    onRouteChange?.('article')
  }, [onRouteChange])

  const expire = useCallback((safeRoute) => {
    const nextRoute = SAFE_ROUTES.has(safeRoute) ? safeRoute : current === 'article' ? 'feed' : current
    onRouteChange?.(nextRoute)
    onSessionExpired?.('Phiên đã hết hạn. Đăng nhập lại để tiếp tục.')
  }, [current, onRouteChange, onSessionExpired])

  const onSavedChange = useCallback((id, saved) => {
    setSavedOverrides((currentOverrides) => ({ ...currentOverrides, [id]: saved }))
  }, [])

  const shared = {
    api,
    csrfToken,
    savedOverrides,
    onSavedChange,
    onOpenArticle: openArticle,
    onSessionExpired: expire,
    announce: setLiveStatus,
  }

  return (
    <section className="content-product-shell" aria-label="TechPulse reader workspace">
      <div className="content-main" id="content-workspace" tabIndex="-1">
        {current === 'feed' ? <FeedScreen {...shared} onOpenSearch={() => select('search')} /> : null}
        {current === 'search' ? <SearchScreen {...shared} /> : null}
        {current === 'saved' ? <SavedScreen {...shared} onOpenFeed={() => select('feed')} /> : null}
        {current === 'qa' ? <GroundedQaScreen generatedApi={generatedApi} csrfToken={csrfToken} announce={setLiveStatus} onSessionExpired={() => expire('qa')} /> : null}
        {current === 'account' ? accountPanel : null}
        {current === 'article' && articleId ? <ArticleDetailScreen {...shared} articleId={articleId} onBack={() => select('feed')} /> : null}
        {current === 'article' && !articleId ? <section className="content-state"><h1>Chưa chọn bài viết</h1><button className="content-button" type="button" onClick={() => select('feed')}>Quay lại Feed</button></section> : null}
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{liveStatus}</p>
    </section>
  )
}
