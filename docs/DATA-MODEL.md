# TechPulse AI — MongoDB Data Model

> Trạng thái: Plan-of-Record persistence contract; ADR-0013/0014 amendment trước Step 12
> Phiên bản: 1.8
> Cập nhật: 15/08/2026
> Architecture: [TECHNICAL-DESIGN.md](./TECHNICAL-DESIGN.md)  
> Product contract: [PRD.md](./PRD.md)

## 1. Nguyên tắc

- MongoDB Atlas là system of record duy nhất cho mọi state bền vững. `techpulse_app` giữ runtime application state; `techpulse_governance` giữ signed suppression/checkpoint/retention-manifest state. File dump/sidecar ngoài Atlas chỉ là encrypted backup copy hậu MVP, không là live authority và không thuộc MVP serving gate.
- ID đi qua API luôn là opaque string; client không suy luận ObjectId.
- Date lưu theo UTC BSON Date và serialize ISO 8601.
- Mọi document có `createdAt`, `updatedAt` khi có mutation.
- Raw HTML/full text, provider key, session token rõ và password rõ không có field lưu trữ.
- MongoDB chỉ lưu media metadata/remote URL; không lưu binary, base64, GridFS hoặc bản cache ảnh/video nguồn.
- Article giữ rights snapshot để audit, nhưng quyền hiện tại ở `sources` vẫn được kiểm tra khi hiển thị/gọi provider.
- Schema validator của MongoDB và validation ở application boundary cùng enforce enum/required field quan trọng.
- Soft delete/hide dùng cho vận hành; hard delete chỉ theo takedown/privacy flow.

Các block `type ...` dưới đây là ký pháp tài liệu trung lập để mô tả shape, không phải TypeScript implementation. Code MVP dùng JavaScript/JSX; schema được enforce bằng MongoDB validator, runtime validation và test.

## 2. Collection overview

| Collection | Vai trò | Owner |
|---|---|---|
| `users` | Account, role, topic preferences, lifecycle | Auth/account module |
| `sessions` | Server-side session và CSRF state | Auth module |
| `rateLimitBuckets` | Subject-classified rate-limit/quota counters có TTL | HTTP/AI operations |
| `answerAttempts` | PII-safe Q&A idempotency/quota/provider attempt receipt | Q&A module |
| `providerAdmissionStates` | Per-admission-domain concurrency/budget + per-route circuit state | AI provider router |
| `providerFailureDomainStates` | Shared provider transport/control-plane circuit state | AI provider router |
| `sources` | Connector config, publisher/rights policy, health | Source Registry |
| `articles` | Normalized metadata, summary, vector, provenance | Content module |
| `savedArticles` | Quan hệ user–article | User library module |
| `ingestionJobs` | Durable connector run/checkpoint/counters | Job module |
| `ingestionScheduleProgress` | Cursor server-owned cho bounded daily ingestion materialization | Job module |
| `indexingJobs` | Summary/embedding/re-index work | Job/AI module |
| `jobLeases` | Persistent fencing high-water + active distributed ownership | Job module |
| `chatSessions` | Question/answer/citation history tối thiểu | Q&A module |
| `takedownRequests` | Quy trình gỡ source/article do publisher/rights request | Governance module |
| `accountDeletionRequests` | Durable automatic user-data cleanup | Account/governance module |
| `adminAuditLogs` | Append-only safe mutation/workflow evidence | Audit module |
| `hmacKeyLifecycleSnapshots` | Append-only quota-HMAC version history và retirement evidence | Auth/security bootstrap |
| `runtimeCapabilityProbes` | Ephemeral cross-database transaction/role capability evidence | Deployment verifier |

Các collection trên thuộc `techpulse_app`. Logical database `techpulse_governance` có `governanceSuppressions`, `governanceCheckpoints`, `auditRetentionManifests` và một mirrored `runtimeCapabilityProbes`. Hai database phải ở cùng Atlas deployment; business collections phải được tạo/index trước traffic để terminal transaction có thể ghi cross-database bằng cùng Mongo client/session. Probe collections không chứa business data hoặc PII và là deployment/Step-12 verification gate, không phải current startup-readiness collection.

Các field/collection provider-routing mới trong ADR-0013 (`embeddingArtifactCompatibilityId`, `providerId`, `providerFailureDomainStates`) là target schema v1.8 chưa có trong current migration/runtime. Step 9 owner phải thêm migration/readiness/repository evidence trước Step 12; không đọc phần này như mô tả schema đang deploy.

## 3. Shared conventions

### 3.1. Audit metadata

```text
type AuditMeta = {
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  updatedBy?: string;
};
```

### 3.2. Error snapshot

```text
type SafeError = {
  code: string;
  message: string;
  retryable: boolean;
  occurredAt: Date;
  upstreamStatus?: number;
};
```

`message` đã redact; không lưu body nguồn/provider, secret hoặc stack trace.

### 3.3. Policy enums

```text
type OperationalStatus = "draft" | "testing" | "active" | "paused" | "archived";
type LicenseStatus = "permitted" | "metadata-only" | "review-needed" | "blocked";
type LlmInputScope = "metadata" | "excerpt" | "fulltext-temporary" | "none";
type AuthorityTier = "primary" | "editorial" | "community-signal";
type ImageDisplayMode = "none" | "remote-preview";
type VideoDisplayMode = "none" | "link-only";
type AdminReasonCode = canonical enum from `contracts/openapi.json#/components/schemas/AdminReasonCode`;
type AuditReasonCode = canonical enum from `contracts/openapi.json#/components/schemas/AuditReasonCode`;
```

Persistence validator dùng cùng allowlist với OpenAPI và domain còn giới hạn code theo action. Không duy trì enum thứ hai có thể drift trong prose/data migration.

## 4. `users`

```text
type UserDocument = {
  _id: ObjectId;
  emailNormalized?: string;
  emailDisplay?: string;
  passwordHash?: string;
  role?: "user" | "admin";
  status: "active" | "suspended" | "deletion-pending" | "deleted";
  topicPreferences?: string[];
  suspendedAt?: Date;
  suspensionReason?: string;
  deletionRequestedAt?: Date;
  deletionRequestId?: ObjectId;
  deletedAt?: Date;
  sessionVersion: number;
  createdAt: Date;
  updatedAt: Date;
};
```

Rules:

- Public registration hard-code `role=user`; request schema không có `role`.
- `sessionVersion` tăng khi suspend, password/security change hoặc revoke-all.
- Deleted account chỉ giữ closed tombstone allowlist: `_id`, `status=deleted`, `deletionRequestedAt`, `deletionRequestId`, `deletedAt`, `sessionVersion`, `createdAt`, `updatedAt`. Không giữ `role`, email/password, preferences, `suspendedAt`, `suspensionReason` hoặc field profile/moderation khác.
- Mongo validator dùng conditional schema: `status=deleted` reject mọi field ngoài allowlist; status khác yêu cầu `role` và `topicPreferences`. Admin serializer trả `email=null`, `role=null` cho deleted user.

Indexes:

```text
unique partial { emailNormalized: 1 } where emailNormalized exists
{ status: 1, createdAt: -1 }
```

## 5. `sessions`

```text
type SessionDocument = {
  _id: ObjectId;
  tokenHash: string;
  userId: ObjectId;
  userSessionVersion: number;
  csrfSecretHash: string;
  status: "active" | "revoked";
  absoluteExpiresAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  createdIpHmac?: string;
  ipHmacKeyVersion?: number;
  userAgentSummary?: string;
  createdAt: Date;
  revokedAt?: Date;
};
```

`csrfSecretHash` chỉ lưu hash của token CSRF gắn ổn định với opaque session. Browser nhận token qua response auth hoặc `/me` và chỉ giữ nó trong memory; `/me` đồng thời ở tab khác không thay thế hash/token đang hợp lệ.

Indexes:

```text
unique { tokenHash: 1 }
{ userId: 1, status: 1 }
TTL { expiresAt: 1 } expireAfterSeconds: 0
```

Cookie token chỉ xuất hiện một lần ở response; database chỉ giữ hash.

Rules:

- Session active có idle window 24 giờ và absolute lifetime 7 ngày; `expiresAt` là thời điểm sớm hơn giữa idle renewal và `absoluteExpiresAt`.
- Revoke thông thường đặt `status=revoked`, `revokedAt` và rút `expiresAt` xuống tối đa 24 giờ sau revoke để TTL cleanup; request path vẫn kiểm tra status/expiry ngay lập tức.
- Account deletion không dùng TTL làm bằng chứng: sau revoke/session-version bump, worker trực tiếp xóa mọi session theo `userId` và xác minh zero match trước khi set `sessionsDeleted=true`.

## 6. `rateLimitBuckets`

```text
type RateLimitBucketDocument = {
  _id: ObjectId;
  scope: "login" | "register" | "answer-minute" | "answer-daily" | "admin-trigger" | "source-test";
  subjectType: "user" | "ip" | "admin" | "source";
  keyHash: string;
  keyVersion: number;
  keyFingerprint: string;
  windowStart: Date;
  count: number;
  limit: number;
  expiresAt: Date;
  updatedAt: Date;
};
```

Indexes:

```text
unique { scope: 1, subjectType: 1, keyHash: 1, windowStart: 1 }
{ keyVersion: 1 } // startup continuity scan
TTL { expiresAt: 1 } expireAfterSeconds: 0
```

Rules:

- Increment/check dùng atomic upsert; không dùng counter trong process memory.
- `subjectType` là source of truth cho ownership: `login|register→ip`, `answer-minute|answer-daily→user`, `admin-trigger→admin`, `source-test→source`. Validator/key-derivation helper từ chối scope/subject pair khác mapping này.
- MVP fixed bounds: login tối đa 10 attempt/15 phút/IP; register tối đa 5 attempt/60 phút/IP. Check + increment atomically trước password hashing, user insert hoặc session creation; registration bị reject không tạo user/session.
- `keyHash` luôn là keyed HMAC + `keyVersion` của subject opaque: canonical IP cho `ip`, opaque `userId` cho user quota, opaque admin ID cho admin và opaque source ID cho source. `keyFingerprint` là SHA-256 fingerprint của key material tương ứng, dùng để phát hiện đổi secret khi vẫn giữ nguyên version; không dùng raw email hoặc plain hash.
- `Retry-After` tính từ window hiện tại, không từ thời điểm TTL document thực sự bị cleanup.
- Daily AI quota dùng cùng collection với window dài hơn; provider call chỉ chạy sau khi reserve quota thành công.
- TTL chỉ cleanup; correctness dựa vào `windowStart`/`expiresAt` trong query.
- Account deletion chỉ xóa/verify `subjectType=user` cho hai scope answer; shared `subjectType=ip` anti-abuse bucket không thuộc user data và không bị broad-delete.
- HMAC keyring env gồm exactly một `current` version và tối đa hai `retiring` versions; secret chỉ đến từ environment. Env không giữ lifecycle history. New write dùng current version; read/quota/deletion derive candidate hash cho mọi non-retired version và transactionally migrate/consolidate về current, nên rotation không reset quota và deletion zero-verify được old+current bucket.
- `hmacKeyLifecycleSnapshots` là append-only full inventory có `inventoryId=quota-hmac`, monotonic `revision`, `previousSnapshotHash`, `snapshotHash`, `currentVersion`, sorted `versions[]` và `recordedAt`. Version entry giữ `version`, `state=current|retiring|retired`, one-way `keyFingerprint`, `firstObservedAt`; retiring/retired giữ immutable `successorVersion` + Mongo-recorded `successorActivatedAt`; retired thêm `retiredAt` và exact-zero evidence cho `rateLimitBuckets`, `sessions`, `adminAuditLogs`. Không lưu secret/key material hoặc raw subject.
- Mỗi snapshot mới phải giữ mọi version cũ và chỉ cho transition `current→retiring→retired`; missing revision/hash, removed version, reactivated retired version, current rollback, changed fingerprint/successor đều fail closed. Từng predecessor retire độc lập, kể cả predecessor khác còn retiring: successor phải được durable inventory quan sát ít nhất 30 ngày và transaction phải đếm zero dependent exact-version record trước khi append retirement snapshot.
- Runtime role chỉ `find/insert` lifecycle snapshots; `update/delete` bị deny và probe riêng. Startup verify validator/index/hash-chain, reconcile config với latest durable snapshot trước traffic, rồi vẫn fail nếu document dùng unknown/retired key version hoặc fingerprint không khớp.

## 7. `sources`

```text
type SourceDocument = {
  _id: ObjectId;
  name: string;
  sourceKey: string;
  publisherName: string;
  rightsHolderNote?: string;
  domain: string;
  connectorType: "rss" | "arxiv" | "hacker-news";
  accessMethod: "rss" | "atom" | "api";
  authorityTier: AuthorityTier;
  connectorConfig: {
    feedUrl?: string;
    arxivQuery?: string;
    hackerNewsStream?: "topstories" | "newstories" | "beststories";
    batchSize: number;
  };
  operationalStatus: OperationalStatus;
  licenseStatus: LicenseStatus;
  llmInputScope: LlmInputScope;
  storageScope: {
    metadata: boolean;
    excerpt: boolean;
    summary: boolean;
    embedding: boolean;
  };
  mediaPolicy: {
    imageMode: ImageDisplayMode;
    videoMode: VideoDisplayMode;
    allowedHosts: string[];
    attributionRequired: boolean;
    evidenceNote?: string;
  };
  attributionRequired: boolean;
  attributionText?: string;
  termsUrl?: string;
  licenseUrl?: string;
  evidenceNote?: string;
  reviewedAt?: Date;
  reviewedBy?: ObjectId;
  policyVersion: number;
  reconciliation: {
    status: "idle" | "pending" | "processing" | "completed" | "failed";
    requiredPolicyVersion: number;
    completedPolicyVersion?: number;
    requestedAt?: Date;
    cursorArticleId?: ObjectId;
    error?: SafeError;
  };
  technicalCheck: {
    status: "not-run" | "passed" | "failed";
    checkedAt?: Date;
    contentType?: string;
    resolvedHost?: string;
    sampleCount?: number;
    error?: SafeError;
  };
  health: {
    lastIngestSucceededAt?: Date;
    lastIngestFailedAt?: Date;
    consecutiveFailures: number;
    lastError?: SafeError;
  };
  createdAt: Date;
  updatedAt: Date;
};
```

Rules:

- `active` yêu cầu technical check passed và license `permitted|metadata-only`.
- Không tìm thấy bằng chứng rõ thì review kết thúc ở `metadata-only`.
- `sourceKey` là stable logical key, ví dụ `rss:publisher-feed-slug`, `arxiv:cs-ai`, `hn:topstories`.
- Credential không nằm trong `connectorConfig`; chỉ lưu tên server-side config nếu thật sự cần.
- Policy/connector change quan trọng tăng `policyVersion` và tạo reconciliation/index work.
- `mediaPolicy` độc lập với `llmInputScope`/`storageScope`; nguồn mới mặc định `imageMode=none`, `videoMode=none`, `allowedHosts=[]`.
- `allowedHosts` chỉ chứa canonical lowercase public DNS hostname chính xác đã review; IDN được lưu dạng A-label. Wildcard, IP literal, localhost/single-label host, URL/credential và hostname resolve tới private/special-use address bị từ chối.
- Mongo validator và domain validator cùng enforce Source Policy compatibility matrix trong PRD; `licenseStatus`, `llmInputScope` và `storageScope` không được validate độc lập.
- `blocked` yêu cầu `llmInputScope=none`, mọi storage flag false và media mode none. `metadata-only` yêu cầu metadata true, excerpt false và input chỉ `none|metadata`.
- `reviewedAt`/`reviewedBy` chỉ do server ghi. Re-review atomically pause source, đặt `review-needed`, tăng policyVersion và đặt `reconciliation.status=pending`/`requiredPolicyVersion` trong cùng source document.
- Step 3 sở hữu durable reconciliation marker; Step 9 materialize marker thành bounded `visibility-reconcile` jobs. Mọi claim/cursor/error/retry/completion phải CAS đồng thời exact `sources.policyVersion`, `reconciliation.requiredPolicyVersion`, expected status và expected cursor; CAS miss không được mutate marker mới. `completed` chỉ hợp lệ khi `completedPolicyVersion == requiredPolicyVersion`, error rỗng và đã quét hết article của source ở đúng version.
- Fan-out identity là deterministic tuple `sourceId:articleId:task:requiredPolicyVersion`; worker version N không được ghi `processing`, cursor, error hoặc `completed` lên marker N+1.
- Connector discriminant phải khớp config/access/authority; HN luôn `community-signal`, arXiv luôn `api` + `primary`.
- `health` được expose cho admin ở dạng redact; `rightsHolderNote` chỉ là persistence evidence nội bộ và không thuộc HTTP DTO trong MVP.

Indexes:

```text
unique { sourceKey: 1 }
{ connectorType: 1, operationalStatus: 1 }
{ licenseStatus: 1, reviewedAt: 1 }
{ "reconciliation.status": 1, "reconciliation.requiredPolicyVersion": 1 }
{ "health.lastIngestSucceededAt": 1 }
```

## 8. `articles`

```text
type ActiveArticleDocument = {
  _id: ObjectId;
  sourceId: ObjectId;
  connectorType: "rss" | "arxiv" | "hacker-news";
  externalId?: string;
  sourceType: string;
  authorityTier: AuthorityTier;
  status: "processing" | "review-needed" | "published" | "hidden";

  titleOriginal: string;
  titleVi?: string;
  originalUrl: string;
  canonicalUrl: string;
  canonicalUrlHash: string;
  author?: string;
  publishedAt: Date;
  retrievedAt: Date;
  sourceLanguage: string;
  topics: string[];
  excerptOriginal?: string;
  searchTextNormalized: string;

  leadMedia?: {
    type: "image" | "video";
    displayMode: "remote-preview" | "link-only";
    url: string;
    sourcePageUrl: string;
    altText?: string;
    credit?: string;
    attribution: string;
    mediaEvidenceStatus: "not-analyzed";
    sourcePolicyVersion: number;
  };
  leadMediaStatus: "none" | "available" | "hidden";
  leadMediaHiddenReason?: string;

  summaryVi?: string;
  summaryStatus: "pending" | "processing" | "ready" | "failed" | "removed";
  summaryParagraphsVi?: string[];
  summaryDetailStatus: "pending" | "processing" | "ready" | "failed" | "removed";
  summaryBasis?: "metadata" | "excerpt" | "fulltext-temporary" | "official-payload";
  summaryModel?: string;
  summaryInputHash?: string;
  summarySourcePolicyVersion?: number;
  summaryGeneratedAt?: Date;
  summaryError?: SafeError;

  contentScope: "metadata" | "excerpt" | "fulltext-temporary";
  rightsSnapshot: {
    sourcePolicyVersion: number;
    licenseStatus: LicenseStatus;
    llmInputScope: LlmInputScope;
    capturedAt: Date;
  };

  embeddingStatus: "pending" | "processing" | "ready" | "failed" | "removed";
  embedding?: number[];
  embeddingModel?: string;
  embeddingDimensions?: number;
  embeddingArtifactCompatibilityId?: string;
  embeddingInputHash?: string;
  embeddingVersion?: number;
  embeddingSourcePolicyVersion?: number;
  embeddedAt?: Date;
  embeddingError?: SafeError;

  provenance: Array<{
    sourceId: ObjectId;
    originalUrl: string;
    externalId?: string;
    observedAt: Date;
  }>;
  duplicateOfId?: ObjectId;
  dedupeKey: string;
  hiddenReason?: string;
  removedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

type RemovedArticleTombstoneDocument = {
  _id: ObjectId;
  sourceId: ObjectId;
  connectorType: "rss" | "arxiv" | "hacker-news";
  externalId?: string;
  externalIdVersion?: string;
  canonicalUrlHash: string;
  status: "removed";
  evidenceEligible: false;
  removalPolicyVersion: number;
  removedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type ArticleDocument = ActiveArticleDocument | RemovedArticleTombstoneDocument;
```

Rules:

- Không có field `rawHtml`, `body`, `fullText`, `translatedFullText`, media binary/base64 hoặc GridFS reference.
- `published` yêu cầu provenance tối thiểu, source policy snapshot và metadata hợp lệ.
- `summaryStatus=ready` yêu cầu summary, basis, model, hash và timestamp; `summaryDetailStatus=ready` đồng thời yêu cầu short summary ready và 2–5 paragraph detail, tổng tối đa 6000 ký tự.
- `summaryDetailStatus` khác `ready` bắt buộc `summaryParagraphsVi=null`; summary detail cũ được backfill về trạng thái pending/processing/failed/removed mà không tự tạo nội dung giả.
- `summaryStatus=ready` còn yêu cầu `summarySourcePolicyVersion` khớp policy đã kiểm tra tại commit.
- `embeddingStatus=ready` yêu cầu vector length khớp dimensions, đủ model/version/hash/`embeddingArtifactCompatibilityId` và có `embeddingSourcePolicyVersion` hợp lệ. Runtime chỉ so cosine giữa document có cùng compatibility identity.
- Khi merge duplicate, canonical document giữ union provenance; document phụ trỏ `duplicateOfId` và không published.
- User query phải kết hợp status article với current source policy, không chỉ dựa vào snapshot.
- `leadMedia` chỉ giữ remote metadata. Ảnh yêu cầu `displayMode=remote-preview`; video yêu cầu `displayMode=link-only`; URL HTTPS và host phải còn nằm trong current source policy.
- `leadMedia.attribution` luôn là sanitized canonical display value: media credit → source `attributionText` → source name. UI không tự suy luận từ nullable `credit`.
- `leadMediaStatus=available` yêu cầu có `leadMedia`; `hidden` giữ metadata phục vụ audit/khôi phục nhưng user serializer phải trả `leadMedia=null`; `none` nghĩa connector không có candidate hợp lệ.
- `sourcePageUrl` là trang nguồn để user kiểm chứng; `mediaEvidenceStatus=not-analyzed` ngăn summary/Q&A dùng media như evidence.
- Policy thay đổi hoặc takedown có thể unset `leadMedia` mà không cần ẩn toàn article.
- `summaryStatus=removed` bắt buộc unset `summaryVi`, `summaryParagraphsVi`, basis/model/hash/generatedAt/error và đặt `summaryDetailStatus=removed`; `embeddingStatus=removed` bắt buộc unset vector/model/dimensions/compatibility ID/hash/version/embeddedAt/error.
- Public serializer chỉ trả summary khi status `ready`; `removed` không phải public artifact status ngay cả khi article document chưa cleanup xong.
- Takedown scope `metadata` thay toàn bộ active article bằng closed `RemovedArticleTombstoneDocument`. Tombstone giữ opaque external identity và `canonicalUrlHash` để chống re-ingest/resurrection, kể cả RSS item không có `guid`; không giữ title, URL thô, author, provenance, excerpt/search, topics, media, summary, embedding hoặc rights snapshot.

Indexes:

```text
unique partial { sourceId: 1, externalId: 1 } where externalId exists
{ canonicalUrlHash: 1 }
{ dedupeKey: 1 }
{ status: 1, publishedAt: -1, _id: -1 }
{ status: 1, topics: 1, publishedAt: -1 }
{ status: 1, sourceId: 1, publishedAt: -1 }
{ embeddingStatus: 1, embeddingArtifactCompatibilityId: 1, embeddingVersion: 1 }
text {
  titleOriginal: "text",
  titleVi: "text",
  summaryVi: "text",
  topics: "text",
  searchTextNormalized: "text"
} default_language: "none"
```

## 9. `savedArticles`

```text
type SavedArticleDocument = {
  _id: ObjectId;
  userId: ObjectId;
  articleId: ObjectId;
  createdAt: Date;
};
```

Indexes:

```text
unique { userId: 1, articleId: 1 }
{ userId: 1, createdAt: -1, _id: -1 }
{ articleId: 1, userId: 1 }
```

Save dùng upsert; unsave là idempotent delete. Khi article không còn visible, saved list không trả content nhưng có thể cho biết item unavailable hoặc cleanup theo policy.

## 10. `ingestionJobs`

```text
type IngestionJobDocument = {
  _id: ObjectId;
  idempotencyKey: string;
  actorScope: string;
  requestHash: string;
  sourceId: ObjectId;
  connectorType: "rss" | "arxiv" | "hacker-news";
  expectedSourcePolicyVersion: number;
  trigger: "cron" | "admin" | "retry";
  requestedBy?: ObjectId;
  parentJobId?: ObjectId;
  status: "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
  attempt: number;
  priority: number;
  availableAt: Date;
  agingEligibleAt: Date;
  idempotencyExpiresAt: Date;
  leaseGeneration: number;
  batchSize: number;
  checkpoint?: {
    cursor?: string;
    lastExternalId?: string;
    processedCount: number;
  };
  counters: {
    fetched: number;
    created: number;
    updated: number;
    duplicate: number;
    skipped: number;
    failed: number;
  };
  cancellationRequestedAt?: Date;
  error?: SafeError;
  createdAt: Date;
  startedAt?: Date;
  heartbeatAt?: Date;
  finishedAt?: Date;
  purgeAfter?: Date;
  updatedAt: Date;
};
```

Indexes:

```text
unique { actorScope: 1, idempotencyKey: 1 }
{ sourceId: 1, createdAt: -1 }
{ status: 1, priority: -1, availableAt: 1, createdAt: 1, _id: 1 }
{ status: 1, agingEligibleAt: 1, availableAt: 1, createdAt: 1, _id: 1 }
partial { purgeAfter: 1, _id: 1 } where purgeAfter exists
```

`expectedSourcePolicyVersion` được capture trước external fetch; `policyVersion` đại diện cả rights policy và connector configuration ảnh hưởng ingestion, nên mọi thay đổi đó phải increment version. Final article/checkpoint transaction conditionally touch exact source `_id`, version, `operationalStatus=active`, eligible license và connector discriminant cùng lease fence; CAS miss discard candidate, không tăng counter/advance checkpoint và chỉ ghi safe `policy_version_mismatch` ở workflow hợp lệ.

Retry tạo job mới với idempotency key/attempt mới và `parentJobId`; không mutate failed history thành queued. Automatic crash recovery derive deterministic identity `system-recovery:<parentJobId>:<nextAttempt>` nên transaction/retry lặp chỉ tạo một child job. Create/retry admin resolve exact existing actor/key hoặc parent/attempt trước khi reserve admission; transaction duy nhất reserve đúng một quota slot, insert job và append audit. Reuse cùng actor/key nhưng `requestHash` khác là conflict, không trả generic duplicate.

Queue selector chạy aged lane trước: due document có `agingEligibleAt<=now` sort `agingEligibleAt → availableAt → createdAt → _id`; nếu không có thì normal lane sort `priority desc → availableAt → createdAt → _id`. `agingEligibleAt` server derive đúng `createdAt+30 phút`, immutable qua defer/retry của cùng job; caller không set. Job không được purge trước `idempotencyExpiresAt=createdAt+14 ngày`, nên `purgeAfter=max(terminal retention, idempotencyExpiresAt)`.

### 10.1. `ingestionScheduleProgress`

```text
type IngestionScheduleProgressDocument = {
  _id: ObjectId;
  period: "YYYY-MM-DD";
  cursorSourceId?: ObjectId;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};
```

`unique { period: 1 }`. Chỉ cron materializer sở hữu collection này. Mỗi trang materialize nhiều nhất 100 source eligible có `_id > cursorSourceId`, rồi transactionally CAS cursor/`completedAt`; production cron consume liên tiếp các trang trong một invocation với page cap/deadline bounded, và invocation sau tiếp tục từ durable cursor nếu còn `hasMore`. Replay hoặc concurrent invocation không quay lại các source đã commit. Period mới có record mới, không carry cursor giữa các ngày. Admin manual create/retry không đọc hoặc ghi collection này.

## 11. `indexingJobs`

```text
type IndexingJobDocument = {
  _id: ObjectId;
  idempotencyKey: string;
  actorScope: string;
  requestHash: string;
  articleId: ObjectId;
  sourceId: ObjectId;
  expectedSourcePolicyVersion: number;
  task: "summary" | "embedding" | "visibility-reconcile";
  trigger: "ingestion" | "admin" | "policy-change" | "model-change" | "retry";
  requestedBy?: ObjectId;
  parentJobId?: ObjectId;
  status: "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
  attempt: number;
  priority: number;
  availableAt: Date;
  agingEligibleAt: Date;
  idempotencyExpiresAt: Date;
  leaseGeneration: number;
  cancellationRequestedAt?: Date;
  targetEmbeddingVersion?: number;
  inputHash?: string;
  error?: SafeError;
  createdAt: Date;
  startedAt?: Date;
  heartbeatAt?: Date;
  finishedAt?: Date;
  purgeAfter?: Date;
  updatedAt: Date;
};
```

Indexes:

```text
unique { actorScope: 1, idempotencyKey: 1 }
unique partial { parentJobId: 1, attempt: 1 } where parentJobId exists
{ articleId: 1, createdAt: -1 }
{ sourceId: 1, status: 1, availableAt: 1 }
{ status: 1, priority: -1, availableAt: 1, createdAt: 1, _id: 1 }
{ status: 1, agingEligibleAt: 1, availableAt: 1, createdAt: 1, _id: 1 }
{ status: 1, availableAt: 1, createdAt: 1, _id: 1 } named indexing_next_available
articles: { sourceId: 1, _id: 1 } named articles_source_reconciliation
partial { purgeAfter: 1, _id: 1 } where purgeAfter exists
```

Một indexing job chỉ sở hữu một task. Summary thành công và embedding thất bại là hai job có state độc lập; retry không phải suy luận partial state bên trong một task array. Worker capture `expectedSourcePolicyVersion` khi tạo job và phải đối chiếu current source policy ngay tại commit; mismatch kết thúc job bằng safe `policy_version_mismatch`, discard output và để reconciliation/current policy quyết định work thay thế.

Indexing dùng cùng two-lane selector/14-day idempotency window như ingestion; mọi query plan phải dùng index trên, không `COLLSCAN` hoặc blocking sort.

## 12. `jobLeases`

```text
type JobLeaseDocument = {
  _id: ObjectId;
  key: string;
  generationHighWater: number;
  activeOwner?: {
    ownerTokenHash: string;
    jobId: ObjectId;
    leaseGeneration: number;
    acquiredAt: Date;
    heartbeatAt: Date;
    expiresAt: Date;
  };
  lastFenceValidatedAt?: Date;
  lastReleasedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};
```

Indexes:

```text
unique { key: 1 }
{ "activeOwner.expiresAt": 1 }
```

Lease record không dùng TTL và không bị xóa khi release. Bounded recovery phải clear expired ownership trước; acquire chỉ match record không có `activeOwner`, atomically tăng `generationHighWater` rồi gán generation mới. Heartbeat yêu cầu owner token + generation khớp. Normal completion transactionally ghi terminal/partial job state và unset `activeOwner` bằng cùng exact fence; không clear owner trước job transition.

`key` chỉ được server derive theo canonical table; caller không truyền raw key:

| Resource | Canonical key | Shared operations |
|---|---|---|
| Source ingestion | `ingestion:source:<sourceId>` | cron, admin trigger và retry cùng source |
| Article indexing | `indexing:article:<articleId>` | summary, embedding và visibility reconciliation cùng article |
| Source reconciliation | `reconciliation:source:<sourceId>` | marker claim/cursor/fan-out/retry cùng source |

ID suffix là lowercase opaque ID 1–128 ký tự chỉ gồm `[a-z0-9_-]`; cấm email, actor, invocation, random job ID và namespace ngoài table. Table-driven tests phải chứng minh cron/manual cùng source contend trên một key.

Mọi job transition, checkpoint, counter, article và artifact commit chạy trong transaction ngắn: conditionally touch lease record với exact owner token hash + generation + `expiresAt > authoritative database/server now`, sau đó mới ghi target document. Heartbeat cũng match exact owner/generation và unexpired lease; lease hết hạn không được heartbeat làm sống lại. Ingestion/indexing recovery match exact expired owner/generation, terminalize immutable parent, insert deterministic linked retry nếu eligible và clear owner. Account deletion là explicit exception: recovery exact-fence CAS requeue chính stable request, tăng attempt, giữ completion flags và không tạo parent/child. AI artifact commit còn match `sources.policyVersion == indexingJobs.expectedSourcePolicyVersion`; lease reacquire hoặc policy change gây conditional miss/write conflict và toàn transaction abort.

## 13. `chatSessions`

```text
type ChatSessionDocument = {
  _id: ObjectId;
  userId: ObjectId;
  title?: string;
  scope: {
    articleId?: ObjectId;
    topics?: string[];
    publishedAfter?: Date;
    publishedBefore?: Date;
  };
  messages: Array<
    | {
        id: string;
        role: "user";
        text: string;
        createdAt: Date;
      }
    | {
        id: string;
        role: "assistant";
        status: "answered";
        paragraphs: Array<{
          text: string;
          citationIds: string[];
        }>;
        citations: Array<
          | {
              id: string;
              status: "available";
              articleId: ObjectId;
              sourceId: ObjectId;
              originalUrl: string;
              titleOriginal: string;
              publishedAt: Date;
            }
          | {
              id: string;
              status: "unavailable";
              articleId?: ObjectId;
              sourceId?: ObjectId;
              unavailableReason: "takedown" | "source-policy" | "article-removed";
            }
        >;
        createdAt: Date;
      }
    | {
        id: string;
        role: "assistant";
        status: "refused";
        refusalReason: "insufficient-evidence" | "policy-blocked" | "sensitive-input" | "provider-unavailable";
        createdAt: Date;
      }
  >;
  messageCount: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};
```

Không lưu retrieved full text/evidence body. User chỉ truy cập/xóa session của mình. Admin không có endpoint đọc nội dung chat trong MVP.

Bounds bắt buộc:

- tối đa 30 messages/session; request tiếp theo tạo rollover session mới có cùng scope;
- user question tối đa 1.000 ký tự, assistant paragraph tối đa 2.000 ký tự;
- tối đa 12 paragraphs, 50 citations/answer và 10 citation IDs/paragraph;
- `messageCount` cập nhật atomically và không được vượt bound trước append;
- answered assistant bắt buộc paragraphs/citations và cấm refusal reason; refused assistant bắt buộc refusal reason và cấm factual text/paragraph/citation.
- privacy admission có thể append một assistant-only `sensitive-input` refusal. Offending user question không được persist vào chat, answer attempt, log hoặc provider request; `messageCount` chỉ tăng một.
- citation tới article bị takedown bị chuyển atomically sang union branch `unavailable`: branch này cấm `originalUrl`, `titleOriginal`, `publishedAt`; giữ opaque citation ID và lý do allowlisted. Answer text không được dùng lại trong retrieval.
- delayed Q&A capture `userId + expectedSessionVersion` trước provider call. Final chat/quota append transaction phải conditionally touch user `status=active` + exact session version và current visible article/takedown lifecycle; CAS miss discard provider result và không tạo lại user-owned data.
- `authorityTier=community-signal` không được đi vào Q&A evidence. Internal provider output phải trả exact evidence-block IDs cho từng paragraph; một support verifier trả `supported` mới được persist, còn `unsupported|uncertain` chuyển deterministic refusal trong MVP. Không lưu evidence body/block text trong chat.

Indexes:

```text
{ userId: 1, updatedAt: -1, _id: -1 }
{ "messages.citations.articleId": 1, _id: 1 }
{ "messages.citations.sourceId": 1, _id: 1 }
TTL { expiresAt: 1 } expireAfterSeconds: 0
```

### 13.1. `answerAttempts`

```text
type AnswerAttemptDocument = {
  _id: ObjectId;
  userId: ObjectId;
  sessionId: ObjectId;
  expectedSessionVersion: number;
  idempotencyKeyHash: string;
  requestHash: string;
  status: "reserved" | "provider-running" | "completed" | "refused" | "failed";
  quotaReservationKey: string;
  providerRouteId?: string;
  providerFailureDomainId?: string;
  fallbackKind?: "none" | "model" | "provider";
  providerReservationExpiresAt?: Date;
  chatSessionId?: ObjectId;
  messageId?: string;
  resultStatus?: "answered" | "refused";
  error?: SafeError;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};
```

Không lưu raw question, evidence text, model output, email/token hoặc provider payload. Unique identity là authenticated opaque `userId + sessionId + expectedSessionVersion + idempotencyKeyHash`; không lưu session token. Key chỉ nhận closed ASCII shape từ OpenAPI và được hash trước persistence. Transaction đầu tiên tạo/reuse attempt và reserve đúng một quota unit trước provider work; cùng session/key + request hash trả cùng logical result/reference, cùng key + hash khác trả `409`. Concurrent duplicate chỉ poll/reuse receipt. Nếu function mất sau khi đánh dấu `provider-running`, reservation hết hạn CAS attempt sang terminal `failed` với safe `ambiguous_provider_outcome`; cùng key trả cùng failure và không tự gọi provider lần hai. Receipt giữ 24 giờ; account deletion direct-delete/zero-verify receipt theo indexed `userId`, còn user quota bucket được derive và zero-verify theo mọi HMAC key version còn hiệu lực trước completion.

Indexes:

```text
unique { userId: 1, sessionId: 1, expectedSessionVersion: 1, idempotencyKeyHash: 1 }
{ userId: 1, createdAt: -1, _id: -1 }
{ expiresAt: 1, _id: 1 }
TTL { expiresAt: 1 } expireAfterSeconds: 0
```

### 13.2. `providerAdmissionStates`

```text
type ProviderAdmissionStateDocument = {
  _id: ObjectId;
  admissionDomainId: string;
  providerId: string;
  activeReservations: Array<{
    reservationId: string;
    routeId: string;
    attemptId: ObjectId;
    kind: "summary" | "embedding" | "answer-primary" | "answer-fallback" | "answer-support";
    expiresAt: Date;
  }>;
  maxConcurrency: number;
  budgetWindowStart: Date;
  spentUnits: number;
  budgetLimit: number;
  routeCircuits: Array<{
    routeId: string;
    state: "closed" | "open" | "half-open";
    consecutiveRetryableFailures: number;
    cooldownUntil?: Date;
    halfOpenProbeReservationId?: string;
  }>;
  updatedAt: Date;
};
```

Một credential/account pool có đúng một `admissionDomainId` document và bind đúng một `providerId`; mọi route dùng cùng `credentialEnvName` phải map vào cùng domain và có cùng provider ID. `activeReservations` bị giới hạn bởi domain `maxConcurrency<=8`; claim CAS đồng thời prune expiry, check aggregate budget/cap và exact route circuit. Route circuit cô lập một model/route. Một logical generation có tối đa hai external attempts: primary + đúng một model hoặc provider fallback theo failure class. Fallback/support vẫn pass source policy, privacy evidence và admission trên cùng immutable admitted input. Provider route/workload config là static deployment config, không là Mongo collection; embedding route config mang `embeddingDimensions`, `embeddingVersion` và `artifactCompatibilityId` chính xác. DB không lưu endpoint credential, secret hoặc raw payload.

Indexes:

```text
unique { admissionDomainId: 1 }
{ "routeCircuits.routeId": 1, _id: 1 }
```

### 13.3. `providerFailureDomainStates`

```text
type ProviderFailureDomainStateDocument = {
  _id: ObjectId;
  providerFailureDomainId: string;
  configVersion: number;
  state: "closed" | "open" | "half-open";
  consecutiveRetryableFailures: number;
  cooldownUntil?: Date;
  halfOpenProbeReservationId?: string;
  updatedAt: Date;
};
```

Một shared transport/control-plane domain có đúng một document, kể cả khi nhiều credential admission domains cùng dùng provider đó. Static failure-domain config sở hữu `configVersion`, threshold và cooldown; state phải match exact version khi cập nhật circuit. `provider-retryable` failure atomically cập nhật document này; open domain làm router skip mọi route tham chiếu domain trước admission claim. Chỉ một half-open probe được phép. Model-specific failure không mở provider-domain circuit. Config xóa/đổi provider domain không được làm mất open-state evidence trước bounded retirement.

Indexes:

```text
unique { providerFailureDomainId: 1 }
{ state: 1, cooldownUntil: 1, _id: 1 }
```

## 14. `takedownRequests`

```text
type TakedownRequestPrePurgeDocument = {
  _id: ObjectId;
  status: "received" | "reviewing" | "approved" | "rejected" | "completed";
  requesterName: string;
  requesterContact: string;
  targetType: "source" | "article";
  targetIds: ObjectId[];
  reason: string;
  evidenceNote?: string;
  requestedScope: Array<"metadata" | "media-metadata" | "summary" | "embedding">;
  decisionReasonCode?: AdminReasonCode;
  reviewedBy?: ObjectId;
  reviewedAt?: Date;
  completedAt?: Date;
  piiPurgeAfter?: Date;
  workflowPurgeAfter?: Date;
  completion: {
    hidden: boolean;
    metadataRemoved: boolean;
    mediaMetadataRemoved: boolean;
    summaryRemoved: boolean;
    embeddingRemoved: boolean;
    historicalChatCitationsRedacted: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
};

type TakedownRequestPostPurgeDocument = Omit<TakedownRequestPrePurgeDocument,
  "requesterName" | "requesterContact" | "reason" | "evidenceNote" | "piiPurgeAfter"
> & {
  status: "rejected" | "completed";
  completedAt: Date;
  workflowPurgeAfter: Date;
};

type TakedownRequestDocument = TakedownRequestPrePurgeDocument | TakedownRequestPostPurgeDocument;
```

Indexes:

```text
{ status: 1, createdAt: 1 }
{ targetType: 1, targetIds: 1 }
partial { piiPurgeAfter: 1, _id: 1 } where piiPurgeAfter exists
partial { workflowPurgeAfter: 1, _id: 1 } where workflowPurgeAfter exists
```

Requester contact là dữ liệu cá nhân; không đưa vào provider/log và chỉ admin đọc trước retention deadline. `rejected|completed` pre-purge bắt buộc `completedAt`, `piiPurgeAfter` và `workflowPurgeAfter` đều là `Date`; non-terminal có thể chưa có các deadline này. Sau `piiPurgeAfter`, fixed task unset toàn bộ requester name/contact/reason/evidence và deadline; detail endpoint chỉ trả canonical `TakedownRequestPostPurgeDocument` đến `workflowPurgeAfter`.

MVP duyệt toàn bộ hoặc từ chối toàn bộ `requestedScope`; không có partial approval. `status=completed` luôn yêu cầu `hidden=true` và `historicalChatCitationsRedacted=true`, kể cả khi scan xác nhận không có citation lịch sử; từng scope còn yêu cầu cleanup flag tương ứng. Takedown hide/redaction và delayed chat append serialize bằng article/takedown lifecycle fence để Q&A cũ không thể ghi lại URL/title sau cleanup. `piiPurgeAfter` là terminal time +90 ngày để bounded worker unset requester contact/reason/evidence; `workflowPurgeAfter` là terminal time +180 ngày cho non-PII lifecycle record. List query chỉ project thành takedown summary không chứa requester contact, reason hoặc evidence. Detail endpoint mới được hydrate các field PII này.

## 15. `accountDeletionRequests`

```text
type AccountDeletionRequestDocument = {
  _id: ObjectId;
  userId: ObjectId;
  actorScope: string;
  idempotencyKey: string;
  requestHash: string;
  status: "queued" | "running" | "completed" | "failed";
  attempt: number;
  priority: number;
  availableAt: Date;
  agingEligibleAt: Date;
  idempotencyExpiresAt: Date;
  leaseGeneration: number;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  safeReasonCategory: "user-request";
  completion: {
    sessionsRevoked: boolean;
    sessionsDeleted: boolean;
    savedArticlesDeleted: boolean;
    chatSessionsDeleted: boolean;
    answerAttemptsDeleted: boolean;
    userQuotaDataDeleted: boolean;
    identityAnonymized: boolean;
  };
  error?: SafeError;
  requestedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  purgeAfter?: Date;
  updatedAt: Date;
};
```

Rules:

- Đây là automatic workflow riêng, không phải `takedownRequests` và không cần admin approval.
- Deletion API không nhận/persist free-form reason; server ghi `safeReasonCategory=user-request`, atomically chuyển user sang `deletion-pending`, tăng `sessionVersion`, revoke sessions và ghi audit intent; response xóa session cookie.
- Cleanup idempotent theo từng flag. `sessionsRevoked` có thể true ở response `202`, nhưng `sessionsDeleted` chỉ true sau direct indexed delete + zero-match verification. `answerAttemptsDeleted` xóa/zero-verify PII-safe Q&A receipts; `userQuotaDataDeleted` derive mọi non-retired HMAC version để xóa answer quota, còn shared IP bucket không bị xóa. `completed` chỉ khi bảy flag đều true; retry chỉ chạy item còn false và không restore identity/session.
- Crash/expired lease recovery dùng exact owner/generation CAS để requeue cùng request document, tăng `attempt`, đặt lại `availableAt`, clear transient running/error timestamps nhưng giữ mọi completion flag. Không tạo `parentJobId` hoặc child request; admin retry dùng cùng model.
- Account deletion aged lane dùng `agingEligibleAt=requestedAt+5 phút` và được query trước normal priority lane; vẫn đi qua bounded fairness coordinator. Idempotency guarantee tối thiểu 14 ngày, nhưng completed workflow retention 90 ngày đã dài hơn.
- Completed request đặt `purgeAfter=completedAt+90 ngày`; failed/running request không có `purgeAfter` và giữ tới khi resolve. `identityAnonymized=true` chỉ sau raw tombstone projection đúng closed allowlist ở §4; email/password/role/preferences/moderation/session/chat/saved/answer-attempt/user-quota data không còn.
- Admin API chỉ expose request ID, status, priority/attempt/availableAt, safe completion/error/timestamps; không expose email hoặc deleted content.

Indexes:

```text
unique { userId: 1 }
unique { actorScope: 1, idempotencyKey: 1 }
{ status: 1, priority: -1, availableAt: 1, requestedAt: 1, _id: 1 }
{ status: 1, agingEligibleAt: 1, availableAt: 1, requestedAt: 1, _id: 1 }
partial { status: 1, leaseExpiresAt: 1, _id: 1 } where status="running" and leaseExpiresAt exists
partial { purgeAfter: 1, _id: 1 } where purgeAfter exists
```

Index recovery theo `status + leaseExpiresAt + _id` là ADR-0014 target chưa có trong current governance migration. Step 11 owner phải thêm migration/readiness/`db:verify explain` trước Step 12; repository query hiện tại không đủ để tuyên bố indexed recovery.

## 16. `adminAuditLogs`

```text
type AdminAuditLogDocument = {
  _id: ObjectId;
  eventId: string;
  actorType: "admin" | "user" | "system-worker";
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  changedFields: string[];
  stateTransition?: {
    from?: string;
    to?: string;
  };
  reasonCode: AuditReasonCode;
  ipAddressHmac?: string;
  ipHmacKeyVersion?: number;
  ipHmacPurgeAfter?: Date;
  purgeAfter?: Date;
  requestId: string;
  result: "pending" | "succeeded" | "failed";
  createdAt: Date;
};
```

Rules:

- `actorType=user` chỉ dùng cho user-initiated workflow như account deletion; `actorId` là opaque user ID, không lưu email/profile data.
- Không có update/delete endpoint cho audit log.
- Không có raw `before/after` snapshot hoặc arbitrary object. `changedFields` và lifecycle state value đều qua allowlist theo action/target trước persistence.
- `reasonCode` là category allowlist và còn bị giới hạn theo action; free-form admin note không tồn tại trong audit. Requester/account case text ở workflow document không được copy sang audit.
- Cấm email, requester contact, secret, passwordHash, session/token, connector credential, full text, provider payload và private chat.
- Failed mutation cũng có record nếu actor đã được xác thực và action đủ xa để audit.
- Direct admin mutation commit state + audit event trong một Mongo transaction ngắn. Workflow dài ghi `pending` intent trước side effect và append terminal event idempotently.
- `eventId` là deterministic identity theo request/workflow phase và bị unique index chặn duplicate. Một runtime Mongo client/credential/session có domain privileges nhưng chỉ `insert/find` trên `adminAuditLogs`; cùng session commit domain mutation + audit insert. Cùng role chỉ `insert/find` append-only HMAC lifecycle snapshots; audit/lifecycle update-delete đều bị deny. IP-HMAC field-unset dùng maintenance credential riêng và đúng fixed HTTP task, còn full event purge chỉ dùng owner-only offline signed-manifest path ở §19.1.
- Runtime MVP giữ signed suppression/checkpoint state trong `techpulse_governance` và fail closed khi live governance không khả dụng. Ordered digest bằng offline key, sidecar continuity và restored-old app verification thuộc recovery track hậu MVP.

Indexes:

```text
unique { eventId: 1 }
{ createdAt: -1, _id: -1 }
{ actorType: 1, actorId: 1, createdAt: -1 }
{ targetType: 1, targetId: 1, createdAt: -1 }
partial { ipHmacPurgeAfter: 1, _id: 1 } where ipHmacPurgeAfter exists
partial { purgeAfter: 1, _id: 1 } where purgeAfter exists
```

### 16.1. `techpulse_governance` collections

Runtime MVP dùng các collection này cho signed suppression, audit/checkpoint continuity và fail-closed terminal mutation. Export sidecar, offline checkpoint-key custody và replay vào restore target là operational contract hậu MVP; không yêu cầu thêm secret vào runtime environment.

```text
type GovernanceSuppressionDocument = {
  _id: ObjectId;
  eventId: string;
  kind: "account-deletion" | "takedown";
  requestId: ObjectId;
  userId?: ObjectId;
  targetType?: "source" | "article";
  targetIds?: ObjectId[];
  requestedScope?: string[];
  effectiveAt: Date;
  payloadDigest: string;
  signatureKeyVersion: number;
  signature: string;
  createdAt: Date;
};

type GovernanceCheckpointDocument = {
  _id: ObjectId;
  sequence: number;
  previousCheckpointDigest?: string;
  coveredThroughEventId: string;
  auditDigest: string;
  suppressionDigest: string;
  signerKeyId: string;
  signature: string;
  createdAt: Date;
};

type AuditRetentionManifestDocument = {
  _id: ObjectId;
  manifestId: string;
  cutoff: Date;
  eventIds: string[];
  eventIdsDigest: string;
  previousCheckpointDigest: string;
  resultingCheckpointDigest: string;
  signerKeyId: string;
  signature: string;
  createdAt: Date;
};

type RuntimeCapabilityProbeDocument = {
  _id: ObjectId;
  probeId: string; // runtime-capability:<uuid>
  probeKind: "commit" | "abort";
  expiresAt: Date;
  createdAt: Date;
};
```

Rules:

- Terminal account deletion/takedown tạo minimized suppression payload, ký HMAC bằng dedicated governance signing key từ Vercel environment rồi insert cùng domain/audit mutation trong **cùng client/session transaction** qua hai pre-created database. Insert fail làm terminal mutation rollback; không có eventual best-effort gap.
- Runtime custom role chỉ `insert/find` suppression, audit và HMAC lifecycle snapshots; không update/delete các collection này. Maintenance credential chỉ làm fixed IP-HMAC field-unset; owner operator credential ghi checkpoint/retention manifest và chạy offline purge.
- Governance runtime signing keyring tách quota/IP HMAC: đúng một current + tối đa một retiring version; DB chỉ giữ version/signature. Runtime key chỉ retire theo live governance lifecycle evidence. Offline checkpoint HMAC keyring, sidecar continuity và old-key custody thuộc recovery track hậu MVP; secret không vào repo/Vercel/Mongo, inventory chỉ ghi keyId/activatedAt/retireAfter.
- Governance database hoặc runtime signature unavailable làm terminal deletion/takedown fail closed. Backup inventory và signed read-only governance sidecar là recovery copy hậu MVP; sidecar không ghi đè live governance database trong app-only restore.
- Step 11 phải probe transaction thật trên Atlas deployment đã cấu hình: cùng runtime client/session/credential ghi rồi rollback/commit qua pre-created collection ở `techpulse_app` và `techpulse_governance`. Capability/role probe fail thì block handoff; không fallback sang eventual write, best-effort export hoặc persistence technology khác.
- Mỗi logical database có một strict `runtimeCapabilityProbes` collection với unique `probeId` và TTL `expiresAt` tối đa 5 phút. Probe chỉ ghi fixed opaque ID/kind/timestamps, không business field hoặc PII. Commit probe phải cleanup ngay; abort probe phải để zero residue. Runtime role có narrow `find|insert|remove` chỉ trên hai probe collections; quyền `remove` này không áp dụng audit, suppression hoặc business collections. `db:verify`/Step 12 require collection/index/role; current application startup không dùng probe như readiness dependency.

Indexes:

```text
governanceSuppressions: unique { eventId: 1 }; { kind: 1, requestId: 1 }
governanceCheckpoints: unique { sequence: 1 }; { coveredThroughEventId: 1 }
auditRetentionManifests: unique { manifestId: 1 }; { cutoff: 1, _id: 1 }
runtimeCapabilityProbes: unique { probeId: 1 }; TTL { expiresAt: 1 } expireAfterSeconds: 0
```

## 17. Cross-collection invariants

1. `savedArticles.userId`, `chatSessions.userId` và mọi `answerAttempts.userId` mới chỉ thuộc user `active`; mọi delayed/asynchronous user-owned write commit với exact `sessionVersion`, nếu không account deletion cleanup/anonymize có thể bị tái tạo.
2. Article user-visible cần source hiện tại `active` và license `permitted|metadata-only`.
3. Source chuyển blocked/review-needed atomically ghi durable reconciliation marker; query-time visibility fail-closed ngay và Step 9 materialize bounded reconciliation jobs bằng exact policy-version/status/cursor CAS.
4. Article hidden/removed đặt summary/embedding visibility thành removed hoặc bị loại bởi query ngay lập tức.
5. Provider call luôn reload current source policy; không chỉ tin rights snapshot cũ.
6. Vector comparison yêu cầu cùng model, dimensions, version.
7. Job/checkpoint/article/artifact commit conditionally touch persistent lease record với canonical resource key, exact active owner/generation và unexpired authoritative time trong cùng transaction; `generationHighWater` không giảm hoặc bị TTL xóa.
8. Direct admin mutation + audit insert dùng cùng transaction-capable runtime identity/session; terminal deletion/takedown còn insert signed suppression cross-database trong transaction. Audit/suppression permission hoặc insert fail làm domain mutation abort.
9. Takedown `completed` chỉ khi completion flags khớp toàn bộ requested scope và historical chat citations đã redacted/verified; account deletion dùng stable same-request recovery/completion model riêng.
10. Hard delete không được làm mất audit trail cần thiết; audit chỉ giữ opaque target và allowlisted non-sensitive `reasonCode`.
11. Rate-limit/quota check dùng shared Mongo bucket; nhiều Vercel instance không có counter riêng.
12. Media serializer reload current `mediaPolicy`; mode/host không còn hợp lệ trả `leadMedia=null` và giữ/đặt durable reconciliation marker cho current policy version.
13. Media `not-analyzed` không đi vào summary/embedding/Q&A input và không hỗ trợ citation claim.
14. `answered` không persist nếu paragraph citation ID không resolve tới visible non-community evidence hoặc exact evidence-block support verdict không phải `supported`; `refused` không persist factual paragraph.
15. `accountDeletionRequests.status=completed` yêu cầu mọi completion flag true, answer attempt theo `userId` và user quota theo mọi non-retired HMAC key version đã zero-match, raw user tombstone đúng closed allowlist.
16. Ingestion article/checkpoint commit phải khớp source ID, current policy/config version, active/eligible state và connector discriminant; mismatch không advance checkpoint.
17. Mỗi registered due queue được ít nhất một reserved selection attempt mỗi coordinator invocation; queue-local priority không được so trực tiếp giữa các queue.
18. Raw user question không được rời trust boundary nếu privacy gate phát hiện credential/high-risk identifier; current DeepSeek `deepseek-v4-flash` route dùng capability `nonconfidential` và chỉ nhận input đã qua privacy/Source Registry admission.
19. Mỗi Q&A idempotency identity chỉ reserve một quota unit, tối đa một DeepSeek generation + một support call trong graph hiện tại, rồi append tối đa một assistant message; không có model/provider fallback.
20. Online cleanup chỉ chạy qua closed maintenance task table; caller không thể chọn collection/filter/cutoff/cursor/batch size và browser/admin session không có machine authorization. Full audit-event purge là explicit owner-only offline signed-manifest exception ở §19.1.
21. `techpulse_governance` suppression state chỉ giữ signed actionable opaque deletion/takedown IDs, target scope và effective time; không giữ email/contact/reason/chat/source text. MVP terminal mutation fail closed nếu governance database unavailable, runtime signature sai hoặc entry thiếu actionable target. Checkpoint-chain verification cho restored serving là hậu MVP.
22. [Hậu MVP] Restored app database không được serve trước khi current governance suppression state đã replay; restored sessions/quota/answer-attempt/provider-admission state bị xóa, deleted-user/takedown targets zero-match và audit checkpoint verified. App-only restore không overwrite governance database.
23. Cross-database transaction là deployment capability phải được chứng minh trên Atlas cluster thật bằng runtime role trước handoff; document-level support hoặc mock không thay thế probe, và failure luôn fail closed.

## 18. Transaction và consistency strategy

MVP dùng transaction ngắn đúng chỗ và idempotent workflow cho work dài:

- single-document state transition dùng atomic `findOneAndUpdate` với expected current state;
- direct admin state mutation + safe audit event commit dùng một runtime Mongo client/credential/session; per-collection audit insert permission lỗi làm mutation abort;
- terminal account deletion/takedown + signed minimized suppression insert có thể span `techpulse_app` và `techpulse_governance` trong cùng pre-created-collection transaction;
- workflow dài tạo job/request + audit intent atomically, sau đó cleanup/reconcile và append terminal event;
- ingestion/indexing/reconciliation fenced commit conditionally touch exact unexpired `jobLeases.activeOwner` trong cùng transaction với target write; account deletion fenced commit dùng exact inline owner/generation/deadline trên request. Ingestion transaction match source state/version/config và AI artifact transaction match expected/current source policy version;
- unique index là lớp cuối chống duplicate;
- mỗi side effect lưu input hash/idempotency key;
- takedown/blocked source tắt visibility trước khi cleanup và serialize historical-citation redaction với delayed Q&A append;
- ingestion/indexing retry dùng immutable linked child; account deletion retry/recovery requeue same request và giữ completion flags;
- delayed provider output chỉ persist sau final user session-version và article/takedown lifecycle fence; CAS miss không persist answer-attempt result/chat/quota side effect mới.
- answer-attempt create/reuse + quota reservation commit atomically trước provider call; provider admission reservation được release idempotently sau terminal result.

MongoDB transaction chỉ bao quanh nhóm document nhỏ, không chứa fetch/provider call và phải retry write conflict/transient transaction error. Không dựa vào transaction để che workflow thiếu idempotency hoặc fencing.

## 19. Retention schedule

Mỗi owner phải tạo index/script retention cùng migration của collection; TTL là best-effort physical cleanup và request/worker path vẫn kiểm tra expiry/cutoff độc lập.

| Data | Duration | Enforcement | Owner |
|---|---|---|---|
| Active session | idle 24 giờ, absolute 7 ngày | `expiresAt` TTL + request-path check | Step 2 |
| Revoked session | tối đa 24 giờ sau `revokedAt` | rút `expiresAt`; TTL | Step 2 |
| Session của deleted user | xóa/verify ngay | direct indexed delete, không chờ TTL | Steps 2, 11 |
| Shared IP anti-abuse bucket | 24 giờ sau window end | TTL + query window check | Step 2 |
| User Q&A minute/daily quota | 2 giờ / 48 giờ sau window end | TTL; direct delete khi account deletion | Steps 2, 10, 11 |
| Q&A answer-attempt receipt | 24 giờ sau first acceptance | TTL + direct delete khi account deletion | Steps 10, 11 |
| Provider admission state | project lifetime | no TTL; bounded active reservation recovery | Step 9 |
| Provider failure-domain state | project lifetime | no TTL; bounded half-open recovery/controlled config retirement | Step 9 |
| Chat session | 30 ngày sau `updatedAt` | derive `expiresAt`, TTL + read-time cutoff | Step 10 |
| Succeeded/cancelled ingestion/indexing job | 14 ngày sau `finishedAt` | bounded cleanup script | Steps 4, 9 |
| Failed/partial ingestion/indexing job | 30 ngày sau `finishedAt` | bounded cleanup script | Steps 4, 9 |
| Completed account-deletion workflow | 90 ngày sau `completedAt` | state-aware cleanup script | Step 11 |
| Failed/running deletion workflow | tới khi resolve | không TTL | Step 11 |
| Takedown requester PII | 90 ngày sau terminal state | bounded field-unset script | Step 11 |
| Non-PII takedown lifecycle evidence | 180 ngày sau terminal state | state-aware cleanup/manual review | Step 11 |
| Audit IP HMAC | 30 ngày | bounded field-unset script | Steps 2, 3, 11 |
| Minimized audit event | 180 ngày | runtime retention evidence; owner-only offline fixed purge + signed retention manifest là hậu MVP | Steps 2, 3, 11; post-MVP recovery |
| `jobLeases` high-water | project lifetime | no TTL; controlled GC migration after proof | Step 4 |

Full text tạm giải phóng ngay sau job/request và không xuất hiện trong log/cache. Media metadata/URL chỉ giữ khi policy còn hợp lệ; summary/vector bị xóa theo takedown scope. Bounded cleanup phải indexed, idempotent, có dry-run, chạy được qua cron/manual và không dựa vào timing chính xác của Vercel Cron hoặc MongoDB TTL.

### 19.1. Fixed maintenance task table

Mỗi invocation dùng server `now`, batch tối đa 100 và stable `(deadline, _id)` pagination. HTTP caller chỉ chọn `taskName` từ OpenAPI enum; mapping dưới đây là code-owned constant, không nhận override.

| Task name | Collection | Fixed eligible predicate | Action |
|---|---|---|---|
| `purge-ingestion-jobs` | `ingestionJobs` | terminal + `purgeAfter<=now` | delete due documents |
| `purge-indexing-jobs` | `indexingJobs` | terminal + `purgeAfter<=now` | delete due documents |
| `purge-answer-attempts` | `answerAttempts` | `expiresAt<=now` | delete expired receipts |
| `purge-takedown-pii` | `takedownRequests` | terminal + `piiPurgeAfter<=now` | unset requester name/contact/reason/evidence and deadline |
| `purge-takedown-workflows` | `takedownRequests` | terminal + `workflowPurgeAfter<=now` | delete minimized workflow document |
| `purge-account-deletion-workflows` | `accountDeletionRequests` | completed + `purgeAfter<=now` | delete workflow document |
| `purge-audit-ip-hmac` | `adminAuditLogs` | `ipHmacPurgeAfter<=now` | unset IP HMAC/version/deadline |

Task cần `cronBearer`/machine identity, fixed maximum batch và safe aggregate audit. Browser/admin session bị từ chối; không endpoint nào nhận raw Mongo filter, collection name hoặc caller cutoff. Dry-run chỉ là deployment script mode dùng cùng constant table, không là public HTTP option.

`purge-audit-ip-hmac` dùng Mongo client riêng được resolve qua `MONGODB_MAINTENANCE_URI_ENV`; URI/credential phải khác runtime. Thiếu credential chỉ làm task này unavailable và làm maintenance-retention release gate fail. Runner không thay bằng runtime credential, đồng thời không dừng core runtime hoặc các fixed task khác đang có đúng capability.

Full minimized-audit-event deletion là ngoại lệ **không expose qua HTTP maintenance route**. Sau 180 ngày, owner-only offline script dùng fixed predicate `purgeAfter<=authoritativeNow`, exact `(purgeAfter,_id)` batch tối đa 100 và ghi signed retention manifest vào `techpulse_governance` trước khi xóa. Verifier chỉ chấp nhận missing event nằm trong manifest hợp lệ; governance sidecar backup giữ manifest/checkpoint continuity, mọi gap khác vẫn là tamper/rollback failure.

## 20. Schema/index migration

Mỗi thay đổi schema/index dùng script versioned và idempotent:

```text
scripts/migrations/001-create-core-indexes.js
scripts/migrations/002-seed-topics.js
scripts/migrations/003-seed-admin.js
```

Script phải:

- kiểm tra trạng thái trước khi tạo/đổi;
- không chứa credential;
- in summary không chứa dữ liệu nhạy cảm;
- có dry-run khi update/delete dữ liệu;
- được chạy và xác minh trên database demo trước deployment.
- `db:verify` assert exact validator/index definitions và `explain("executionStats")` cho due-work, retention, article/source citation paths; reject `COLLSCAN` hoặc blocking sort.

## 21. Data acceptance checklist

- [ ] Mongo validator và indexes được tạo bằng migration idempotent.
- [ ] Duplicate source/external article/save/idempotency key bị unique index chặn.
- [ ] Query visibility kiểm thử current source state.
- [ ] TTL chỉ cleanup session/rate-limit data; `jobLeases` không có TTL và high-water còn nguyên sau release/recovery.
- [ ] Rate-limit dùng atomic shared bucket và trả `Retry-After` đúng window.
- [ ] Login/register check fixed atomic IP bounds trước expensive/auth writes; spoofed forwarding header không tạo bucket mới.
- [ ] HMAC rotation giữ quota old-version, migration không double count và deletion zero-verifies old+current records trước retire key.
- [ ] Sample database scan không tìm thấy raw HTML/full text/token/API key.
- [ ] Sample database scan không tìm thấy binary/base64/GridFS media nguồn.
- [ ] `leadMedia` chỉ tồn tại với HTTPS allowlisted host/current policy; video luôn link-only và `not-analyzed`.
- [ ] Content takedown và automatic account deletion có completion evidence riêng, đúng retention policy.
- [ ] Audit không có raw snapshot/arbitrary object/PII và không có update/delete route.
- [ ] Same runtime identity/session rollback domain mutation khi audit/suppression insert fail; update/delete bị deny; live governance signature/checkpoint state fail closed.
- [ ] Deadline/source-citation/due-work `explain` dùng intended indexes, stable `_id` tie-break và không scan/sort blocking.
- [ ] Deleted raw user document chỉ còn closed tombstone allowlist; validator reject preferences, role và suspension context.
- [ ] Fixed maintenance task không chấp nhận caller filter/cutoff/batch/collection và browser/admin session không invoke được.
- [ ] Crash-after-claim được recovery thành terminal parent + linked retry đúng một lần; stale worker generation cũ không cập nhật job/checkpoint/article/artifact.
- [ ] Account deletion crash recovery requeue cùng request, tăng attempt và giữ completed flags; không tạo child request.
- [ ] Canonical lease-key tests chứng minh cron/manual cùng source contend; expired heartbeat không resurrect lease.
- [ ] Sustained ingestion backlog vẫn cho indexing và account deletion due work tiến triển hữu hạn.
- [ ] Policy đổi khi provider đang chạy làm artifact commit cũ thất bại và không persist provider output.
- [ ] Policy/block/config đổi trong ingestion external fetch làm candidate bị discard và checkpoint không advance.
- [ ] Reconciliation N→N+1 race không cho worker N mutate marker/cursor/completion N+1.
- [ ] Delayed Q&A sau account deletion/takedown không persist chat/quota hoặc tái tạo available URL/title.
- [ ] Concurrent same-key Q&A chỉ có một receipt/quota/provider/chat result; non-confidential route, community evidence và irrelevant block đều fail closed.
- [ ] Embedding length/hash/model/version được kiểm tra trước khi `ready`.

### Recovery track hậu MVP

- [ ] Offline checkpoint key custody, governance sidecar export/signature và ordered audit/checkpoint/suppression verification.
- [ ] Isolated app/governance restore, reconciliation, session/secret rotation và target-specific zero-match evidence trước serving.
