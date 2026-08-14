import { useState } from 'react'
import JobsPanel from '../jobs/JobsPanel.jsx'
import IndexingJobsPanel from '../jobs/indexing/IndexingJobsPanel.jsx'

export default function AdminJobsWorkspace({ api, csrfToken, onSessionExpired, initialView = 'ingestion' }) {
  const [view, setView] = useState(initialView)
  const panelId = `admin-jobs-panel-${view}`
  return <section className="admin-jobs-workspace" aria-labelledby="admin-jobs-workspace-title">
    <div className="admin-jobs-tabs" role="tablist" aria-label="Jobs workspace">
      <button id="admin-jobs-tab-ingestion" type="button" role="tab" aria-selected={view === 'ingestion'} aria-controls="admin-jobs-panel-ingestion" tabIndex={view === 'ingestion' ? 0 : -1} onClick={() => setView('ingestion')}>Ingestion jobs</button>
      <button id="admin-jobs-tab-indexing" type="button" role="tab" aria-selected={view === 'indexing'} aria-controls="admin-jobs-panel-indexing" tabIndex={view === 'indexing' ? 0 : -1} onClick={() => setView('indexing')}>Indexing jobs</button>
    </div>
    <h1 id="admin-jobs-workspace-title" className="admin-sr-only">Jobs</h1>
    <div id={panelId} role="tabpanel" aria-labelledby={`admin-jobs-tab-${view}`} tabIndex="0">
      {view === 'ingestion' ? <JobsPanel api={api} csrfToken={csrfToken} onSessionExpired={onSessionExpired} /> : <IndexingJobsPanel api={api} csrfToken={csrfToken} onSessionExpired={onSessionExpired} />}
    </div>
  </section>
}
