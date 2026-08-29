# Architectural Blueprint: Iterative Due-Work & Cron Drain Orchestration

## 1. Executive Summary & Problem Diagnosis

### The Failure Mode
Under the daily Vercel Cron invocation (`GET /api/internal/cron/due-work`), the materialization step generates daily ingestion jobs for all active sources (`arXiv`, `The Verge`, `Hacker News`).
However, `createCoordinatorRunner` in `server/bootstrap/jobs.js` hardcodes `budgetMs: 8000` (8 seconds) and `maxJobs: 3`. When the first connector (`arXiv`) takes ~34.5s to fetch and validate 30 papers over the network:
1. `due-work-coordinator.js` awaits the arXiv execution to completion.
2. Upon settling, `now() - startedAt = 34.5s > 8s (workDeadline)`, so `canStart()` returns `false`.
3. The coordinator terminates immediately, leaving the remaining ingestion jobs (`The Verge`, `Hacker News`) unprocessed in `status: 'queued'`.
4. The linear pipeline moves to `cronIndexingDrainRunner`, which drains only indexing tasks for 240s, without any loop-back mechanism to process remaining ingestion jobs.
5. Because Vercel Cron triggers only once per day, uncompleted ingestion jobs and their downstream indexing tasks stay stranded in `status: 'queued'` indefinitely until manual operator intervention.

---

## 2. Target Architecture: Global Execution Window & Iterative Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          GLOBAL EXECUTION WINDOW                            │
│  - Vercel Function: maxDuration = 300s (300,000ms)                          │
│  - Global Safety Deadline = startTime + 285,000ms (15s an toàn trước Vercel)│
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│            MÔ HÌNH VÒNG LẶP ĐAN XEN (ITERATIVE MULTI-TURN PIPELINE)         │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Phase A: Materialize Daily Ingestion (Tạo jobs cho các nguồn active)     │
│ 2. Phase B: Initial Recovery + First Fair Turn (Cào lượt 1)                 │
│ 3. Phase C: Iterative Weighted Rounds (Lặp khi còn deadline & còn jobs):    │
│    ├── Lượt Ingestion tiếp theo (Cào nguồn tiếp: The Verge, Hacker News...) │
│    └── Lượt Bounded Indexing Wave (Chạy song song Summary + Embedding)      │
│ 4. Phase D: Final Indexing Drain (Vét sạch toàn bộ backlog vector/summary)  │
│ 5. Phase E: Serialize Response & Return 202 Accepted                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Invariants
1. **Single Wall-Clock Global Deadline**: A single request-global deadline (`startedAt + 285,000ms`) is established at request entry and propagated to materialization, coordinator turns, and indexing task drains. All individual task budgets are clamped to this global deadline.
2. **Fair Turn per Due Source**: Every due source receives at most one fair ingestion turn while start-guard allows (`canStart()`). Independent source leases are claimed without cross-source blocking.
3. **Indexing Uses Remaining Budget**: Downstream indexing (summary & embedding) runs concurrently up to task concurrency limits using only the remaining profile time window.
4. **Finite Backlog & nextAvailableAt Reporting**: If the global deadline is reached before all work is exhausted, the HTTP response cleanly reports the completed progress and accurate `nextAvailableAt` timestamp without failing the invocation.
5. **Separation of Execution Runners**: `coordinatorRunner` retains its 8-second / 3-job / 3-recovery baseline for fast service auto-kicks (create/retry), while `adminDueWorkRunner` and `dueWorkRunner` use dedicated profiled runners (`ADMIN_DUE_WORK_PROFILE` and `CRON_DUE_WORK_PROFILE`).
6. **Lease Isolation & Poisoning Prevention**: Ingestion queue adapter catches 409 lease claim conflicts, immediately releases the acquired source lease, and defers only the failing candidate rather than poisoning the entire queue.
7. **Zero OpenAPI Contract Breakage**: All HTTP responses maintain strict compliance with the existing `DueWorkRun` OpenAPI schema.
---

## 3. Implementation Plan & Kanban Work Items

| Card ID | Title | Owner | Target Files | Merge Gate |
| :--- | :--- | :--- | :--- | :--- |
| **CARD-010** | Safe 409 Lease Release & Candidate Deferral | Database/Backend | `server/jobs/ingestion-queue.js`<br>`test/unit/jobs/ingestion-queue.test.js` | Unit tests verify lease release on 409 and candidate-local deferral. |
| **CARD-011** | Profiled Due-Work Coordinator with Iterative Weighted Rounds | Core Backend | `server/jobs/due-work-coordinator.js`<br>`test/unit/jobs/coordinator.test.js` | Unit tests verify multi-turn execution and global deadline clamping. |
| **CARD-012** | Integrated Cron Due-Work Runner Pipeline | Core Backend | `server/bootstrap/jobs.js`<br>`test/unit/jobs/worker-scheduling.test.js` | Unit tests verify complete cron flow and multi-source ingestion. |
| **CARD-013** | End-to-End Cron & Queue Verification | Lead QA / Arch | `test/unit/jobs/**/*`<br>`test/vercel/deployment-config.test.js` | 100% test pass rate across all job suites, clean Vite build, zero regressions. |
