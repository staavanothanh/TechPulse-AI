# TechPulse AI — MongoDB Data Model

> Trạng thái: Persistence contract cho MVP  
> Phiên bản: 1.1  
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
| `rateLimitBuckets` | Shared rate-limit/quota counters có TTL | HTTP/AI operations |
| `sources` | Connector config, publisher/rights policy, health | Source Registry |
| `articles` | Normalized metadata, summary, vector, provenance | Content module |
| `savedArticles` | Quan hệ user–article | User library module |
| `ingestionJobs` | Durable connector run/checkpoint/counters | Job module |
| `indexingJobs` | Summary/embedding/re-index work | Job/AI module |
| `jobLeases` | Distributed lock có TTL | Job module |
| `chatSessions` | Question/answer/citation history tối thiểu | Q&A module |
| `takedownRequests` | Quy trình gỡ nội dung/dữ liệu | Governance module |
| `adminAuditLogs` | Append-only admin mutation evidence | Audit module |

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
```

## 4. `users`

```text
type UserDocument = {
  _id: ObjectId;
  emailNormalized: string;
  emailDisplay: string;
  passwordHash: string;
  role: "user" | "admin";
  status: "active" | "suspended" | "deletion-pending" | "deleted";
  topicPreferences: string[];
  suspendedAt?: Date;
  suspensionReason?: string;
  deletionRequestedAt?: Date;
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

Indexes:

```text
unique { emailNormalized: 1 }
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
  expiresAt: Date;
  lastSeenAt: Date;
  createdIpHash?: string;
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

## 6. `rateLimitBuckets`

```text
type RateLimitBucketDocument = {
  _id: ObjectId;
  scope: "login" | "answer-minute" | "answer-daily" | "admin-trigger" | "source-test";
  keyHash: string;
  windowStart: Date;
  count: number;
  limit: number;
  expiresAt: Date;
  updatedAt: Date;
};
```

Indexes:

```text
unique { scope: 1, keyHash: 1, windowStart: 1 }
TTL { expiresAt: 1 } expireAfterSeconds: 0
```

Rules:

- Increment/check dùng atomic upsert; không dùng counter trong process memory.
- `keyHash` là HMAC/hash ổn định của IP, user ID hoặc actor key theo scope; không lưu raw IP/email.
- `Retry-After` tính từ window hiện tại, không từ thời điểm TTL document thực sự bị cleanup.
- Daily AI quota dùng cùng collection với window dài hơn; provider call chỉ chạy sau khi reserve quota thành công.
- TTL chỉ cleanup; correctness dựa vào `windowStart`/`expiresAt` trong query.

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
- `allowedHosts` chỉ chứa hostname chính xác đã review; wildcard và URL có credential bị từ chối.

Indexes:

```text
unique { sourceKey: 1 }
{ connectorType: 1, operationalStatus: 1 }
{ licenseStatus: 1, reviewedAt: 1 }
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
- `embeddingStatus=ready` yêu cầu vector length khớp dimensions và đủ model/version/hash.
- Khi merge duplicate, canonical document giữ union provenance; document phụ trỏ `duplicateOfId` và không published.
- User query phải kết hợp status article với current source policy, không chỉ dựa vào snapshot.
- `leadMedia` chỉ giữ remote metadata. Ảnh yêu cầu `displayMode=remote-preview`; video yêu cầu `displayMode=link-only`; URL HTTPS và host phải còn nằm trong current source policy.
- `leadMediaStatus=available` yêu cầu có `leadMedia`; `hidden` giữ metadata phục vụ audit/khôi phục nhưng user serializer phải trả `leadMedia=null`; `none` nghĩa connector không có candidate hợp lệ.
- `sourcePageUrl` là trang nguồn để user kiểm chứng; `mediaEvidenceStatus=not-analyzed` ngăn summary/Q&A dùng media như evidence.
- Policy thay đổi hoặc takedown có thể unset `leadMedia` mà không cần ẩn toàn article.

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
```

Save dùng upsert; unsave là idempotent delete. Khi article không còn visible, saved list không trả content nhưng có thể cho biết item unavailable hoặc cleanup theo policy.

## 10. `ingestionJobs`

```text
type IngestionJobDocument = {
  _id: ObjectId;
  idempotencyKey: string;
  sourceId: ObjectId;
  connectorType: "rss" | "arxiv" | "hacker-news";
  trigger: "cron" | "admin" | "retry";
  requestedBy?: ObjectId;
  parentJobId?: ObjectId;
  status: "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
  attempt: number;
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
  updatedAt: Date;
};
```

Indexes:

```text
unique { idempotencyKey: 1 }
{ sourceId: 1, createdAt: -1 }
{ status: 1, createdAt: 1 }
```

Retry tạo job mới với idempotency key/attempt mới và `parentJobId`; không mutate failed history thành queued.

## 11. `indexingJobs`

```text
type IndexingJobDocument = {
  _id: ObjectId;
  idempotencyKey: string;
  articleId: ObjectId;
  sourceId: ObjectId;
  tasks: Array<"summary" | "embedding" | "visibility-reconcile">;
  trigger: "ingestion" | "admin" | "policy-change" | "model-change" | "retry";
  requestedBy?: ObjectId;
  parentJobId?: ObjectId;
  status: "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
  attempt: number;
  targetEmbeddingVersion?: number;
  inputHash?: string;
  error?: SafeError;
  createdAt: Date;
  startedAt?: Date;
  heartbeatAt?: Date;
  finishedAt?: Date;
  updatedAt: Date;
};
```

Indexes:

```text
unique { idempotencyKey: 1 }
{ articleId: 1, createdAt: -1 }
{ status: 1, createdAt: 1 }
```

Một job có thể hoàn thành summary nhưng lỗi embedding và kết thúc `partial`. Retry chỉ chạy task chưa hoàn thành hoặc có input/version thay đổi.

## 12. `jobLeases`

```text
type JobLeaseDocument = {
  _id: ObjectId;
  key: string;
  ownerTokenHash: string;
  jobId: ObjectId;
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
};
```

Indexes:

```text
unique { key: 1 }
TTL { expiresAt: 1 } expireAfterSeconds: 0
```

Acquire là atomic insert/update có điều kiện `expiresAt <= now`; release/heartbeat yêu cầu owner token khớp. TTL chỉ cleanup document, không thay thế điều kiện expiry trong code vì TTL monitor không chạy tức thời.

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
    citations?: Array<{
      id: string;
      articleId: ObjectId;
      sourceId: ObjectId;
      originalUrl: string;
      titleOriginal: string;
      publishedAt: Date;
    }>;
    refusalReason?: "insufficient-evidence" | "policy-blocked" | "provider-unavailable";
    createdAt: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
};
```

Không lưu retrieved full text/evidence body. User chỉ truy cập/xóa session của mình. Admin không có endpoint đọc nội dung chat trong MVP.

Indexes:

```text
{ userId: 1, updatedAt: -1, _id: -1 }
```

## 14. `takedownRequests`

```text
type TakedownRequestDocument = {
  _id: ObjectId;
  status: "received" | "reviewing" | "approved" | "rejected" | "completed";
  requesterName: string;
  requesterContact: string;
  targetType: "source" | "article" | "user-data";
  targetIds: ObjectId[];
  reason: string;
  evidenceNote?: string;
  requestedScope: Array<"metadata" | "media-metadata" | "summary" | "embedding" | "account-data">;
  decisionReason?: string;
  reviewedBy?: ObjectId;
  reviewedAt?: Date;
  completedAt?: Date;
  completion: {
    hidden: boolean;
    metadataRemoved: boolean;
    mediaMetadataRemoved: boolean;
    summaryRemoved: boolean;
    embeddingRemoved: boolean;
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

## 15. `adminAuditLogs`

```text
type AdminAuditLogDocument = {
  _id: ObjectId;
  adminId: ObjectId;
  action: string;
  targetType: string;
  targetId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason: string;
  ipAddressHash?: string;
  requestId: string;
  result: "succeeded" | "failed";
  createdAt: Date;
};
```

Rules:

- Không có update/delete endpoint cho audit log.
- Snapshot dùng allowlist field và redact secret, passwordHash, session/token, connector credential, full text và private chat.
- Failed mutation cũng có record nếu actor đã được xác thực và action đủ xa để audit.

Indexes:

```text
{ createdAt: -1, _id: -1 }
{ adminId: 1, createdAt: -1 }
{ targetType: 1, targetId: 1, createdAt: -1 }
```

## 16. Cross-collection invariants

1. `savedArticles.userId` và `chatSessions.userId` chỉ thuộc user đang tồn tại; account deletion cleanup/anonymize theo workflow.
2. Article user-visible cần source hiện tại `active` và license `permitted|metadata-only`.
3. Source chuyển blocked/review-needed tạo visibility reconciliation cho toàn bộ article liên quan.
4. Article hidden/removed đặt summary/embedding visibility thành removed hoặc bị loại bởi query ngay lập tức.
5. Provider call luôn reload current source policy; không chỉ tin rights snapshot cũ.
6. Vector comparison yêu cầu cùng model, dimensions, version.
7. Job mutation và lease acquisition dùng atomic conditional operation.
8. Admin mutation tạo audit record với cùng request ID; nếu không thể đảm bảo atomic multi-document write, service ghi rõ failed audit và reconcile.
9. Takedown `completed` chỉ khi completion flags khớp approved scope.
10. Hard delete không được làm mất audit trail cần thiết; audit chỉ giữ opaque target và non-sensitive reason.
11. Rate-limit/quota check dùng shared Mongo bucket; nhiều Vercel instance không có counter riêng.
12. Media serializer reload current `mediaPolicy`; mode/host không còn hợp lệ trả `leadMedia=null` và enqueue reconciliation.
13. Media `not-analyzed` không đi vào summary/embedding/Q&A input và không hỗ trợ citation claim.

## 17. Transaction và consistency strategy

MVP tránh distributed transaction và dùng idempotent workflow:

- single-document state transition dùng atomic `findOneAndUpdate` với expected current state;
- multi-document workflow ghi trạng thái chính trước theo hướng fail-closed, sau đó cleanup/reconcile;
- unique index là lớp cuối chống duplicate;
- mỗi side effect lưu input hash/idempotency key;
- takedown/blocked source tắt visibility trước khi cleanup;
- retry đọc checkpoint và không lặp provider call khi output hash/model/version đã hợp lệ.

MongoDB transaction chỉ dùng khi thật sự cần cập nhật một nhóm document nhỏ trong cùng cluster và test chứng minh giá trị; không dựa vào transaction để che workflow thiếu idempotency.

## 18. Retention baseline

Thời lượng cụ thể được chốt lúc triển khai, nhưng hành vi MVP phải có:

- expired session tự xóa bằng TTL; revoked session có thể cleanup sau khoảng audit vận hành ngắn;
- expired rate-limit bucket tự cleanup bằng TTL nhưng request path luôn kiểm tra window, không chờ TTL;
- chat/saved data xóa theo yêu cầu user;
- full text tạm giải phóng ngay sau job/request và không xuất hiện trong log/cache;
- media nguồn chỉ giữ metadata/URL khi policy còn hợp lệ; binary không được tải vào persistence và metadata bị unset theo takedown/media-policy change;
- summary/vector xóa cùng takedown scope;
- jobs giữ đủ lâu cho demo/debug rồi cleanup bằng script/policy;
- audit và rights evidence không bị xóa từ dashboard.

## 19. Schema/index migration

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

## 20. Data acceptance checklist

- [ ] Mongo validator và indexes được tạo bằng migration idempotent.
- [ ] Duplicate source/external article/save/idempotency key bị unique index chặn.
- [ ] Query visibility kiểm thử current source state.
- [ ] TTL hoạt động cho session/lease nhưng code không phụ thuộc TTL chạy tức thời.
- [ ] Rate-limit dùng atomic shared bucket và trả `Retry-After` đúng window.
- [ ] Sample database scan không tìm thấy raw HTML/full text/token/API key.
- [ ] Sample database scan không tìm thấy binary/base64/GridFS media nguồn.
- [ ] `leadMedia` chỉ tồn tại với HTTPS allowlisted host/current policy; video luôn link-only và `not-analyzed`.
- [ ] Takedown và account deletion test đúng retention policy.
- [ ] Audit snapshot đã redact và không có update/delete route.
- [ ] Embedding length/hash/model/version được kiểm tra trước khi `ready`.
