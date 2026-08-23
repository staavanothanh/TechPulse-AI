# HTTP benchmark utility

Use `scripts/benchmarks/http-benchmark.js` to measure API latency and response size.

The command does not load `.env` files. It does not read `process.env`. It does not print the target URL, request headers, response headers, or response bodies. The report contains only endpoint paths, aggregate timings, status counts, byte counts, timeout counts, and error counts.

## Local run

Start the local server, then run the default health benchmark:

```powershell
npm run dev
node scripts/benchmarks/http-benchmark.js
```

Run the planned public endpoints with 30 warm and concurrency samples:

```powershell
node scripts/benchmarks/http-benchmark.js `
  --endpoint /api/v1/health `
  --endpoint "/api/v1/articles?limit=20" `
  --endpoint "/api/v1/search-results?q=AI&mode=text" `
  --iterations 30 `
  --concurrency 4
```

## Preview or remote run

The command requires an explicit `--url` for a non-local target. Do not place credentials in the URL. Use a public or otherwise unauthenticated endpoint for this utility.

```powershell
node scripts/benchmarks/http-benchmark.js `
  --url https://preview.example.test `
  --endpoint /api/v1/health `
  --iterations 30 `
  --concurrency 4
```

The utility sends `GET` requests only. It does not perform login, mutate data, or attach cookies and authorization headers.

## Measurement modes

`--mode all` runs three measurements for each endpoint:

- `cold`: sequential probes. Each probe sends `cache-control: no-cache` and `Connection: close`. The client cannot force a Vercel or serverless cold start. Treat this result as a cold-start probe, not proof of a new instance.
- `warm`: sequential requests on the same process.
- `concurrency`: requests with a bounded worker count from `--concurrency`.

Use `--cold-iterations` and `--cold-gap-ms` to repeat or space cold probes. Use `--mode warm` or `--mode concurrency` to run only one measurement.

Each summary reports `p50Ms`, `p95Ms`, `p99Ms`, `statusCounts`, `bytes`, `timeouts`, `errors`, and `responseTooLarge`. The command prints JSON to standard output. It never prints response content.

## Safety limits

The CLI and the imported `runBenchmark()` API enforce the same bounds: at most 20 endpoints, 1,000 warm/concurrency requests per endpoint, 100 cold probes per endpoint, 100 workers, a 120-second request timeout, and a 5-minute cold gap. Response accounting stops at 8 MiB and cancels a readable stream when that limit is exceeded. Query values and secret-like, opaque path segments are redacted in the report; do not place credentials in request paths or queries.

## Release schema attestation

Vercel runtime bootstrap does not inspect MongoDB collection validators or indexes. The release gate must run the complete metadata verification for each runtime scope and issue a signed attestation:

```text
npm run db:verify -- auth-core --issue-runtime-attestation
npm run db:verify -- sources --issue-runtime-attestation
npm run db:verify -- durable-jobs --issue-runtime-attestation
npm run db:verify -- articles --issue-runtime-attestation
npm run db:verify -- indexing-jobs --issue-runtime-attestation
npm run db:verify -- provider-routing-v2 --issue-runtime-attestation
npm run db:verify -- chat-sessions --issue-runtime-attestation
npm run db:verify -- governance --issue-runtime-attestation
```

Generate an Ed25519 key pair outside the repository and store it in the deployment secret manager. The release verifier receives the base64 PKCS8 private key through `SCHEMA_ATTESTATION_PRIVATE_KEY_ENV`. It also receives the immutable deployment SHA through `SCHEMA_ATTESTATION_COMMIT`. The Vercel runtime receives only the matching base64 SPKI public key in `SCHEMA_ATTESTATION_PUBLIC_KEY`; `VERCEL_GIT_COMMIT_SHA` supplies the runtime deployment SHA.

Each successful command returns `runtimeSchemaAttestation` with a signed `payload` and `signature`. Add each envelope under its payload scope in `RUNTIME_SCHEMA_ATTESTATIONS_JSON`. The payload binds the verified generation to the deployment SHA, MongoDB database, and a SHA-256 hash of the MongoDB host authority. Do not reuse it for another commit, Atlas cluster, or database. Do not put the private key, database URI, credentials, HMAC keys, or provider keys in `RUNTIME_SCHEMA_ATTESTATIONS_JSON` or the runtime environment. A missing, mismatched, or invalid signature prevents its runtime capability from starting.

### Pre-push automation

The repository contains a tracked `.githooks/pre-push` hook. Enable it once after cloning:

```text
npm run setup:hooks
```

The hook reads the final branch SHA from Git's pre-push input, runs the eight verification scopes in sequence, builds one attestation registry, and updates `RUNTIME_SCHEMA_ATTESTATIONS_JSON` in the linked Vercel project before Git continues the push. `main` targets Vercel `production`; every other branch targets `preview`. A tag-only push or branch deletion is skipped. Multiple branch updates in one push are rejected so one Vercel target cannot receive an ambiguous attestation.

Keep the gate disabled until the local or CI release environment has a Vercel API token and linked project configuration. To enable it, set `PREPUSH_ATTESTATION_ENABLED=true` and `PREPUSH_VERCEL_UPDATE=true`; configure `PREPUSH_VERCEL_API_TOKEN_ENV`, and either `PREPUSH_VERCEL_PROJECT_ID`/`PREPUSH_VERCEL_TEAM_ID` or a local `.vercel/project.json`. The token and `SCHEMA_ATTESTATION_PRIVATE_KEY` stay outside Git and outside the Vercel runtime. The hook never prints verifier output, URI, token, key or attestation payload contents.

The hook updates the environment variable before the Git push. Vercel environment changes apply to a new deployment, so the subsequent Git deployment must use the same final SHA. If the Vercel API update fails, the hook exits non-zero and blocks the push.

### Local attestation refresh

When a local checkout has moved to a new commit, refresh the local release
attestation before starting `npm run dev`:

```text
npm run attestation:local
```

The command reads the current `HEAD`, runs the same eight verification scopes,
and updates only `SCHEMA_ATTESTATION_COMMIT` and
`RUNTIME_SCHEMA_ATTESTATIONS_JSON` in `.env` after every scope succeeds. It
does not call Vercel and does not print the URI, credentials, key material, or
attestation registry. Restart the local server after the update so its
environment is reloaded.
