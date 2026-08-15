# ADR-0013: Use configuration-driven provider routing and bounded failover

**Date**: 2026-08-15
**Status**: accepted
**Deciders**: Project owner
**Supersedes**: [ADR-0007](0007-isolate-ai-providers-behind-adapters.md)

## Context

ADR-0007 tach provider payload khoi business flow, nhung van chot OpenCode Zen va hai model DeepSeek trong routing decision. Implementation sau Step 11 cho thay hai route LLM cung endpoint, credential va failure domain, nen chi la model fallback va khong chong duoc provider outage. Project owner yeu cau provider/model co the thay bang server config ma khong sua application/bootstrap routing logic, dong thoi van giu privacy, cost va bounded-call invariants.

## Decision

Application chi goi workload routing policy va normalized `LlmProvider`/`EmbeddingProvider` ports; khong hard-code vendor, endpoint hoac model. Provider boundary tach nam khai niem server-owned:

1. installed adapter catalog map protocol sang auth, request, response, timeout va safe error taxonomy;
2. provider instance/failure domain map mot dich vu van hanh cu the vao adapter;
3. admission domain map credential/billing pool vao concurrency va budget;
4. route map model + operation + capability evidence vao provider/admission domain;
5. workload policy sap thu tu primary, model fallback va provider fallback cho summary, Q&A generation/support va embedding.

Model fallback phai dung model khac trong cung provider failure domain. Provider fallback phai dung failure domain khac va thong thuong credential/admission domain khac. MVP Q&A generation va summary co `maxExternalAttempts=2`: mot loi retryable cap model chon mot model fallback; mot loi retryable cap provider hoac provider-domain circuit chon mot provider fallback. Khong goi ca hai fallback trong cung logical operation. Policy/privacy/sensitive-input/config/schema/support failure va ambiguous in-flight outcome la terminal, khong fallback.

Moi candidate lap lai current source-policy, privacy capability, evidence-expiry, admission/budget/circuit va output validation tren cung immutable admitted input. Route circuit theo model van ton tai; provider failure domain co circuit rieng de transport outage khong thu lan luot moi model cua cung provider. Credential chi duoc resolve tu env name; provider payload, prompt va secret khong vao log/state.

Embedding chi provider-fallback khi hai route co cung `artifactCompatibilityId` gom model revision, dimensions, preprocessing/normalization va embedding version. Doi embedding model/compatibility identity la controlled cutover, tang version va full re-index; neu khong co route tuong thich thi degrade ve text search.

Swapping provider/model da duoc cai adapter la config-only. Adapter co the la protocol-level nhu `openai-compatible-chat`, `openai-compatible-embedding` hoac native nhu `gemini-native`. OpenCode Zen, DeepSeek, OpenAI, OpenRouter hoac provider tuong thich co the map vao adapter phu hop qua provider-instance config. Them protocol moi can mot adapter plugin va contract tests, nhung khong sua business service. Provider instance/endpoint config chi do server operator quan ly, khong nhan tu HTTP/admin, khong co URL credential/redirect va phai qua exact trusted HTTPS profile; client/admin khong co model picker.

## Alternatives Considered

### Alternative 1: Giu OpenCode Zen primary va paid model fallback

- **Pros**: Khong doi code/config contract.
- **Cons**: Hai model chung failure domain; provider outage lam ca hai route hong.
- **Why not**: Khong dat yeu cau provider-level fallback va portability NFR-008.

### Alternative 2: Cho admin/env truyen arbitrary provider URL va model

- **Pros**: Them provider khong can deployment.
- **Cons**: Co the gui credential/input toi endpoint sai, mo SSRF/exfiltration va tang test surface.
- **Why not**: Provider modularity phai server-owned va allowlisted, khong phai arbitrary runtime routing.

### Alternative 3: Goi SDK vendor truc tiep trong tung service

- **Pros**: Nhanh cho mot provider.
- **Cons**: Vendor error/payload lan vao application va moi lan doi provider phai sua business flow.
- **Why not**: Trai dependency direction va lam fallback khong the kiem thu doc lap.

## Consequences

### Positive

- Doi provider/model da cai dat chi can config va evidence hien hanh.
- Model outage va provider outage co fallback semantics khac nhau, bounded va testable.
- Admission/budget/circuit theo dung credential va failure domain thay vi dong nhat route voi provider.
- Business services, HTTP contract va UI khong phu thuoc vendor.

### Negative

- Config graph va startup validation phuc tap hon mot danh sach route.
- Moi adapter/protocol can normalized schema, error taxonomy va privacy evidence tests.
- Provider fallback co the doi chat luong/latency, nen eval phai chay theo workload policy va route class.

### Risks

- Misclassify model/provider failure co the goi sai fallback; adapter chi tra closed error taxonomy va router co table-driven tests.
- Provider fallback ha privacy capability; startup va per-call gate yeu cau capability khong thap hon workload.
- Embedding khac vector space bi tron; `artifactCompatibilityId` bat buoc va mismatch chi cho phep text fallback/re-index.
- Config endpoint lam lo credential; chi exact trusted server-owned profile duoc phep, khong redirect hoac arbitrary URL.
