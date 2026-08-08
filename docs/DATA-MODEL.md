# TechPulse AI — MongoDB Data Model

> Trạng thái: Plan-of-Record persistence contract
> Phiên bản: 1.6
> Cập nhật: 08/08/2026  
> Architecture: [TECHNICAL-DESIGN.md](./TECHNICAL-DESIGN.md)  
> Product contract: [PRD.md](./PRD.md)

## 1. Nguyên tắc

- MongoDB Atlas là system of record cho mọi state bền vững.
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
| `sources` | Connector config, publisher/rights policy, health | Source Registry |
| `articles` | Normalized metadata, summary, vector, provenance | Content module |
| `savedArticles` | Quan hệ user–article | User library module |
| `ingestionJobs` | Durable connector run/checkpoint/counters | Job module |
| `indexingJobs` | Summary/embedding/re-index work | Job/AI module |
| `jobLeases` | Persistent fencing high-water + active distributed ownership | Job module |
| `chatSessions` | Question/answer/citation history tối thiểu | Q&A module |
| `takedownRequests` | Quy trình gỡ source/article do publisher/rights request | Governance module |
| `accountDeletionRequests` | Durable automatic user-data cleanup | Account/governance module |
| `adminAuditLogs` | Append-only safe mutation/workflow evidence | Audit module |

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
  role: "user" | "admin";
  status: "active" | "suspended" | "deletion-pending" | "deleted";
  topicPreferences: string[];
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
- Deleted account xóa/anonymize email/password theo privacy policy nhưng giữ opaque reference cần cho audit.
- `status=deleted` yêu cầu không còn `emailNormalized`, `emailDisplay`, `passwordHash`; admin serializer trả `email=null`.

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
  scope: "login" | "answer-minute" | "answer-daily" | "admin-trigger" | "source-test";
  subjectType: "user" | "ip" | "admin" | "source";
  keyHash: string;
  keyVersion: number;
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
TTL { expiresAt: 1 } expireAfterSeconds: 0
```

Rules:

- Increment/check dùng atomic upsert; không dùng counter trong process memory.
- `subjectType` là source of truth cho ownership: `login→ip`, `answer-minute|answer-daily→user`, `admin-trigger→admin`, `source-test→source`. Validator/key-derivation helper từ chối scope/subject pair khác mapping này.
- `keyHash` luôn là keyed HMAC + `keyVersion` của subject opaque: canonical IP cho `ip`, opaque `userId` cho user quota, opaque admin ID cho admin và opaque source ID cho source. Không dùng raw email hoặc plain hash.
- `Retry-After` tính từ window hiện tại, không từ thời điểm TTL document thực sự bị cleanup.
- Daily AI quota dùng cùng collection với window dài hơn; provider call chỉ chạy sau khi reserve quota thành công.
- TTL chỉ cleanup; correctness dựa vào `windowStart`/`expiresAt` trong query.
- Account deletion chỉ xóa/verify `subjectType=user` cho hai scope answer; shared `subjectType=ip` anti-abuse bucket không thuộc user data và không bị broad-delete.

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
type ArticleDocument = {
  _id: ObjectId;
  sourceId: ObjectId;
  connectorType: "rss" | "arxiv" | "hacker-news";
  externalId?: string;
  sourceType: string;
  authorityTier: AuthorityTier;
  status: "processing" | "review-needed" | "published" | "hidden" | "removed";

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
  summaryBasis?: "metadata" | "excerpt" | "fulltext-temporary";
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
```

Rules:

- Không có field `rawHtml`, `body`, `fullText`, `translatedFullText`, media binary/base64 hoặc GridFS reference.
- `published` yêu cầu provenance tối thiểu, source policy snapshot và metadata hợp lệ.
- `summaryStatus=ready` yêu cầu summary, basis, model, hash và timestamp.
- `summaryStatus=ready` còn yêu cầu `summarySourcePolicyVersion` khớp policy đã kiểm tra tại commit.
- `embeddingStatus=ready` yêu cầu vector length khớp dimensions, đủ model/version/hash và có `embeddingSourcePolicyVersion` hợp lệ.
- Khi merge duplicate, canonical document giữ union provenance; document phụ trỏ `duplicateOfId` và không published.
- User query phải kết hợp status article với current source policy, không chỉ dựa vào snapshot.
- `leadMedia` chỉ giữ remote metadata. Ảnh yêu cầu `displayMode=remote-preview`; video yêu cầu `displayMode=link-only`; URL HTTPS và host phải còn nằm trong current source policy.
- `leadMedia.attribution` luôn là sanitized canonical display value: media credit → source `attributionText` → source name. UI không tự suy luận từ nullable `credit`.
- `leadMediaStatus=available` yêu cầu có `leadMedia`; `hidden` giữ metadata phục vụ audit/khôi phục nhưng user serializer phải trả `leadMedia=null`; `none` nghĩa connector không có candidate hợp lệ.
- `sourcePageUrl` là trang nguồn để user kiểm chứng; `mediaEvidenceStatus=not-analyzed` ngăn summary/Q&A dùng media như evidence.
- Policy thay đổi hoặc takedown có thể unset `leadMedia` mà không cần ẩn toàn article.
- `summaryStatus=removed` bắt buộc unset `summaryVi`, basis/model/hash/generatedAt/error`; `embeddingStatus=removed` bắt buộc unset vector/model/dimensions/hash/version/embeddedAt/error.
- Public serializer chỉ trả summary khi status `ready`; `removed` không phải public artifact status ngay cả khi article document chưa cleanup xong.

Indexes:

```text
unique partial { sourceId: 1, externalId: 1 } where externalId exists
{ canonicalUrlHash: 1 }
{ dedupeKey: 1 }
{ status: 1, publishedAt: -1, _id: -1 }
{ status: 1, topics: 1, publishedAt: -1 }
{ status: 1, sourceId: 1, publishedAt: -1 }
{ embeddingStatus: 1, embeddingModel: 1, embeddingVersion: 1 }
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
{ status: 1, availableAt: 1, priority: -1, createdAt: 1 }
```

`expectedSourcePolicyVersion` được capture trước external fetch; `policyVersion` đại diện cả rights policy và connector configuration ảnh hưởng ingestion, nên mọi thay đổi đó phải increment version. Final article/checkpoint transaction conditionally touch exact source `_id`, version, `operationalStatus=active`, eligible license và connector discriminant cùng lease fence; CAS miss discard candidate, không tăng counter/advance checkpoint và chỉ ghi safe `policy_version_mismatch` ở workflow hợp lệ.

Retry tạo job mới với idempotency key/attempt mới và `parentJobId`; không mutate failed history thành queued. Automatic crash recovery derive deterministic identity `system-recovery:<parentJobId>:<nextAttempt>` nên transaction/retry lặp chỉ tạo một child job. Reuse cùng actor/key nhưng `requestHash` khác là conflict, không trả generic duplicate.

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
  leaseGeneration: number;
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
{ articleId: 1, createdAt: -1 }
{ sourceId: 1, status: 1, availableAt: 1 }
{ status: 1, availableAt: 1, priority: -1, createdAt: 1 }
```

Một indexing job chỉ sở hữu một task. Summary thành công và embedding thất bại là hai job có state độc lập; retry không phải suy luận partial state bên trong một task array. Worker capture `expectedSourcePolicyVersion` khi tạo job và phải đối chiếu current source policy ngay tại commit; mismatch kết thúc job bằng safe `policy_version_mismatch`, discard output và để reconciliation/current policy quyết định work thay thế.

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
| Account deletion | `account-deletion:user:<userId>` | automatic deletion, recovery và admin retry cùng user |

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
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    paragraphs?: Array<{
      text: string;
      citationIds: string[];
    }>;
    citations?: Array<
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
    refusalReason?: "insufficient-evidence" | "policy-blocked" | "provider-unavailable";
    createdAt: Date;
  }>;
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
- citation tới article bị takedown bị chuyển atomically sang union branch `unavailable`: branch này cấm `originalUrl`, `titleOriginal`, `publishedAt`; giữ opaque citation ID và lý do allowlisted. Answer text không được dùng lại trong retrieval.
- delayed Q&A capture `userId + expectedSessionVersion` trước provider call. Final chat/quota append transaction phải conditionally touch user `status=active` + exact session version và current visible article/takedown lifecycle; CAS miss discard provider result và không tạo lại user-owned data.

Indexes:

```text
{ userId: 1, updatedAt: -1, _id: -1 }
{ "messages.citations.articleId": 1, userId: 1 }
TTL { expiresAt: 1 } expireAfterSeconds: 0
```

## 14. `takedownRequests`

```text
type TakedownRequestDocument = {
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
```

Indexes:

```text
{ status: 1, createdAt: 1 }
{ targetType: 1, targetIds: 1 }
```

Requester contact là dữ liệu cá nhân; không đưa vào provider/log và chỉ admin đọc.

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
  leaseGeneration: number;
  safeReasonCategory: "user-request";
  completion: {
    sessionsRevoked: boolean;
    sessionsDeleted: boolean;
    savedArticlesDeleted: boolean;
    chatSessionsDeleted: boolean;
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
- Cleanup idempotent theo từng flag. `sessionsRevoked` có thể true ở response `202`, nhưng `sessionsDeleted` chỉ true sau direct indexed delete + zero-match verification. `userQuotaDataDeleted` chỉ xóa `subjectType=user` answer quota; shared IP bucket không bị xóa. `completed` chỉ khi sáu flag đều true; retry chỉ chạy item còn false và không restore identity/session.
- Crash/expired lease recovery dùng exact owner/generation CAS để requeue cùng request document, tăng `attempt`, đặt lại `availableAt`, clear transient running/error timestamps nhưng giữ mọi completion flag. Không tạo `parentJobId` hoặc child request; admin retry dùng cùng model.
- Account deletion có queue-local priority allowlisted và aging; safety work quá hạn được nâng priority nhưng vẫn đi qua bounded fairness coordinator.
- Completed request đặt `purgeAfter=completedAt+90 ngày`; failed/running request không có `purgeAfter` và giữ tới khi resolve. User tombstone giữ opaque `_id`, role/status/deletedAt/deletionRequestId; email/password/chat/saved/user quota data không còn.
- Admin API chỉ expose request ID, status, priority/attempt/availableAt, safe completion/error/timestamps; không expose email hoặc deleted content.

Indexes:

```text
unique { userId: 1 }
unique { actorScope: 1, idempotencyKey: 1 }
{ status: 1, availableAt: 1, priority: -1, requestedAt: 1 }
```

## 16. `adminAuditLogs`

```text
type AdminAuditLogDocument = {
  _id: ObjectId;
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

Indexes:

```text
{ createdAt: -1, _id: -1 }
{ actorType: 1, actorId: 1, createdAt: -1 }
{ targetType: 1, targetId: 1, createdAt: -1 }
```

## 17. Cross-collection invariants

1. `savedArticles.userId` và `chatSessions.userId` chỉ thuộc user `active`; mọi delayed/asynchronous user-owned write commit với exact `sessionVersion`, nếu không account deletion cleanup/anonymize có thể bị tái tạo.
2. Article user-visible cần source hiện tại `active` và license `permitted|metadata-only`.
3. Source chuyển blocked/review-needed atomically ghi durable reconciliation marker; query-time visibility fail-closed ngay và Step 9 materialize bounded reconciliation jobs bằng exact policy-version/status/cursor CAS.
4. Article hidden/removed đặt summary/embedding visibility thành removed hoặc bị loại bởi query ngay lập tức.
5. Provider call luôn reload current source policy; không chỉ tin rights snapshot cũ.
6. Vector comparison yêu cầu cùng model, dimensions, version.
7. Job/checkpoint/article/artifact commit conditionally touch persistent lease record với canonical resource key, exact active owner/generation và unexpired authoritative time trong cùng transaction; `generationHighWater` không giảm hoặc bị TTL xóa.
8. Direct admin mutation và audit event cùng transaction; long workflow có durable audit intent trước side effect và terminal event idempotent.
9. Takedown `completed` chỉ khi completion flags khớp toàn bộ requested scope và historical chat citations đã redacted/verified; account deletion dùng stable same-request recovery/completion model riêng.
10. Hard delete không được làm mất audit trail cần thiết; audit chỉ giữ opaque target và allowlisted non-sensitive `reasonCode`.
11. Rate-limit/quota check dùng shared Mongo bucket; nhiều Vercel instance không có counter riêng.
12. Media serializer reload current `mediaPolicy`; mode/host không còn hợp lệ trả `leadMedia=null` và giữ/đặt durable reconciliation marker cho current policy version.
13. Media `not-analyzed` không đi vào summary/embedding/Q&A input và không hỗ trợ citation claim.
14. `answered` không persist nếu paragraph citation ID không resolve tới visible evidence set; `refused` không persist factual paragraph.
15. `accountDeletionRequests.status=completed` yêu cầu mọi completion flag true và user tombstone không còn identity credential.
16. Ingestion article/checkpoint commit phải khớp source ID, current policy/config version, active/eligible state và connector discriminant; mismatch không advance checkpoint.
17. Mỗi registered due queue được ít nhất một reserved selection attempt mỗi coordinator invocation; queue-local priority không được so trực tiếp giữa các queue.

## 18. Transaction và consistency strategy

MVP dùng transaction ngắn đúng chỗ và idempotent workflow cho work dài:

- single-document state transition dùng atomic `findOneAndUpdate` với expected current state;
- direct admin state mutation + safe audit event commit trong cùng Mongo transaction; audit lỗi làm mutation abort;
- workflow dài tạo job/request + audit intent atomically, sau đó cleanup/reconcile và append terminal event;
- fenced job commit conditionally touch exact unexpired `jobLeases.activeOwner` trong cùng transaction với target write; ingestion transaction match source state/version/config và AI artifact transaction match expected/current source policy version;
- unique index là lớp cuối chống duplicate;
- mỗi side effect lưu input hash/idempotency key;
- takedown/blocked source tắt visibility trước khi cleanup và serialize historical-citation redaction với delayed Q&A append;
- ingestion/indexing retry dùng immutable linked child; account deletion retry/recovery requeue same request và giữ completion flags;
- delayed provider output chỉ persist sau final user session-version và article/takedown lifecycle fence.

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
| Chat session | 30 ngày sau `updatedAt` | derive `expiresAt`, TTL + read-time cutoff | Step 10 |
| Succeeded/cancelled ingestion/indexing job | 14 ngày sau `finishedAt` | bounded cleanup script | Steps 4, 9 |
| Failed/partial ingestion/indexing job | 30 ngày sau `finishedAt` | bounded cleanup script | Steps 4, 9 |
| Completed account-deletion workflow | 90 ngày sau `completedAt` | state-aware cleanup script | Step 11 |
| Failed/running deletion workflow | tới khi resolve | không TTL | Step 11 |
| Takedown requester PII | 90 ngày sau terminal state | bounded field-unset script | Step 11 |
| Non-PII takedown lifecycle evidence | 180 ngày sau terminal state | state-aware cleanup/manual review | Step 11 |
| Audit IP HMAC | 30 ngày | bounded field-unset script | Steps 2, 3, 11 |
| Minimized audit event | 180 ngày | bounded cleanup/manual review | Steps 2, 3, 11 |
| `jobLeases` high-water | project lifetime | no TTL; controlled GC migration after proof | Step 4 |

Full text tạm giải phóng ngay sau job/request và không xuất hiện trong log/cache. Media metadata/URL chỉ giữ khi policy còn hợp lệ; summary/vector bị xóa theo takedown scope. Bounded cleanup phải indexed, idempotent, có dry-run, chạy được qua cron/manual và không dựa vào timing chính xác của Vercel Cron hoặc MongoDB TTL.

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

## 21. Data acceptance checklist

- [ ] Mongo validator và indexes được tạo bằng migration idempotent.
- [ ] Duplicate source/external article/save/idempotency key bị unique index chặn.
- [ ] Query visibility kiểm thử current source state.
- [ ] TTL chỉ cleanup session/rate-limit data; `jobLeases` không có TTL và high-water còn nguyên sau release/recovery.
- [ ] Rate-limit dùng atomic shared bucket và trả `Retry-After` đúng window.
- [ ] Sample database scan không tìm thấy raw HTML/full text/token/API key.
- [ ] Sample database scan không tìm thấy binary/base64/GridFS media nguồn.
- [ ] `leadMedia` chỉ tồn tại với HTTPS allowlisted host/current policy; video luôn link-only và `not-analyzed`.
- [ ] Content takedown và automatic account deletion có completion evidence riêng, đúng retention policy.
- [ ] Audit không có raw snapshot/arbitrary object/PII và không có update/delete route.
- [ ] Crash-after-claim được recovery thành terminal parent + linked retry đúng một lần; stale worker generation cũ không cập nhật job/checkpoint/article/artifact.
- [ ] Account deletion crash recovery requeue cùng request, tăng attempt và giữ completed flags; không tạo child request.
- [ ] Canonical lease-key tests chứng minh cron/manual cùng source contend; expired heartbeat không resurrect lease.
- [ ] Sustained ingestion backlog vẫn cho indexing và account deletion due work tiến triển hữu hạn.
- [ ] Policy đổi khi provider đang chạy làm artifact commit cũ thất bại và không persist provider output.
- [ ] Policy/block/config đổi trong ingestion external fetch làm candidate bị discard và checkpoint không advance.
- [ ] Reconciliation N→N+1 race không cho worker N mutate marker/cursor/completion N+1.
- [ ] Delayed Q&A sau account deletion/takedown không persist chat/quota hoặc tái tạo available URL/title.
- [ ] Embedding length/hash/model/version được kiểm tra trước khi `ready`.
