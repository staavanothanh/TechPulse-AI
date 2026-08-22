# Admin dashboard benchmark

Use `scripts/benchmarks/admin-dashboard-benchmark.js` to measure authenticated, read-only admin dashboard reads.

The command does not load `.env` files. It requires explicit environment input from the runner. It does not print the target URL, credentials, cookies, request headers, response headers, or response bodies. It only sends one login request and `GET` requests after login. Do not enable mutation E2E flags for this benchmark.

## Local run

Start the local host and provide a dedicated active admin account through the shell or CI secret store. Do not put values in the command history.

```powershell
$env:ADMIN_BENCHMARK_ENABLED = 'true'
$env:ADMIN_BENCHMARK_TARGET = 'local'
$env:ADMIN_BENCHMARK_BASE_URL = 'http://localhost:3000'
$env:ADMIN_BENCHMARK_ORIGIN = 'http://localhost:3000'
$env:ADMIN_BENCHMARK_EMAIL = '<dedicated-admin-email>'
$env:ADMIN_BENCHMARK_PASSWORD = '<dedicated-admin-password>'
node scripts/benchmarks/admin-dashboard-benchmark.js
```

The target must be `http://localhost[:port]` for `local`. The command rejects embedded URL credentials and mismatched origins.

## Preview run

Use only an HTTPS Preview URL and a dedicated test admin. If deployment protection is enabled, pass only provider-issued protection headers through `ADMIN_BENCHMARK_PROTECTION_HEADERS_JSON`. The runner accepts `Authorization`, `X-Vercel-Protection-Bypass`, and `X-Vercel-Set-Bypass-Cookie`; it rejects Cookie, Origin, Host, and unrecognized headers.

```text
ADMIN_BENCHMARK_ENABLED=true
ADMIN_BENCHMARK_TARGET=preview
ADMIN_BENCHMARK_BASE_URL=https://preview.example.test
ADMIN_BENCHMARK_ORIGIN=https://preview.example.test
ADMIN_BENCHMARK_EMAIL=<dedicated-admin-email>
ADMIN_BENCHMARK_PASSWORD=<dedicated-admin-password>
ADMIN_BENCHMARK_PROTECTION_HEADERS_JSON=<provider-issued-json>
```

## Measurements

Each endpoint receives a cold probe and sequential warm requests. The report contains p50/p95, status counts, response byte totals, errors, and timeouts for these authenticated endpoints:

- Overview: `GET /api/v1/admin/overview`
- Jobs/Ingestion: `GET /api/v1/admin/ingestion-jobs` and `GET /api/v1/admin/sources`
- Jobs/Indexing: `GET /api/v1/admin/indexing-jobs`
- Articles: `GET /api/v1/admin/articles`
- Audit: `GET /api/v1/admin/audit-logs`

The waterfall represents the expected dashboard reads after user navigation: overview (1 request), Jobs/Ingestion (2 concurrent reads), Jobs/Indexing (1 read after tab switch), Articles (1 read), and Audit (1 read). It measures API behavior. It does not prove browser rendering.

`cold` sends `Cache-Control: no-cache` and `Connection: close`. It is a client-side cold probe. It cannot force or prove a Vercel/serverless cold start.

Tune bounds through `ADMIN_BENCHMARK_ITERATIONS` (1–1000), `ADMIN_BENCHMARK_COLD_ITERATIONS` (1–100), and `ADMIN_BENCHMARK_TIMEOUT_MS` (1–120000).

## Mongo explain diagnostics

Add `--with-mongo-explain` only where the runner already provides Mongo access through the normal indirection:

```text
MONGODB_URI_ENV=ADMIN_BENCHMARK_MONGO_URI
ADMIN_BENCHMARK_MONGO_URI=<runtime-read-uri>
MONGODB_DATABASE=<database-name>
```

The probe opens a Mongo client, runs only `find({}).sort(...).limit(21).explain('executionStats')` for articles, ingestion jobs, indexing jobs, sources, and audit logs, then closes the client. It reports stage names and aggregate execution statistics without URI, database name, query values, or document content. `COLLSCAN` or `SORT` marks a plan `requiresAttention`; it does not silently pass. If the runtime credential does not permit `explain`, the output is `unavailable` and the rest of the HTTP report remains valid.

## E2E regression gate

`test/e2e/admin-dashboard-regression.test.js` uses the existing authenticated local-host client and skips by default. It verifies the authenticated API sequence for admin overview/jobs/articles/audit and contract filters. It does not drive browser UI controls or prove UI polling behavior. Run it only against a prepared local target:

```text
ADMIN_E2E_ENABLED=true
ADMIN_E2E_RUNNER_ENFORCE=true
E2E_BASE_URL=http://localhost:3000
E2E_ORIGIN=http://localhost:3000
E2E_ADMIN_EMAIL=<dedicated-admin-email>
E2E_ADMIN_PASSWORD=<dedicated-admin-password>
npm test -- --run test/e2e/admin-dashboard-regression.test.js
```

The regression has no mutation steps. The active indexing screen has a separate adaptive poll policy. Browser-level validation of controls and polling needs an installed browser test runner and a prepared target.
