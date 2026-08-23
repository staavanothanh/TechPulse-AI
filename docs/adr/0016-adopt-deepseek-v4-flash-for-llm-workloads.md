# ADR-0016: Chuyen cac LLM workload sang DeepSeek V4 Flash

**Ngay**: 2026-08-23

**Trang thai**: accepted

**Nguoi quyet dinh**: Project owner

**Thay the**: [ADR-0015](0015-adopt-gemini-for-llm-workloads.md)
**Thay doi pham vi**: `summary`, `qa-generation`, `qa-support`; embedding khong thay doi

## Boi canh

ADR-0015 dua ba LLM workload ve Gemini. Quota theo model cua Gemini khong du cho backlog summary va Q&A, vi vay cac request co the cham gioi han theo phut/ngay. Project owner da chon DeepSeek cho ca summary va toan bo Q&A.

DeepSeek khong cung cap bang chung Zero Data Retention (ZDR) phu hop voi gate hien tai. Quyet dinh nay vi the thay doi privacy capability cua Q&A tu `zdr-verified` sang `nonconfidential`, voi su chap thuan ro rang cua project owner.

## Quyet dinh

- `summary`, `qa-generation` va `qa-support` deu dung provider DeepSeek va model chinh xac `deepseek-v4-flash`.
- Credential cua provider duoc resolve tu env name `DEEPSEEK_API_KEY`; application khong doc secret tu request, client, log hoac MongoDB.
- Provider graph dung trusted server-owned endpoint profile va protocol adapter da duoc kiem tra. Khong cho client/admin truyen arbitrary endpoint hoac model.
- Ba workload khong co model fallback hoac provider fallback trong graph hien tai. Loi retryable duoc xu ly bang job retry bounded hoac retry hint; khong tu dong gui cung input sang provider/model khac.
- Q&A route khai bao capability `nonconfidential`. Privacy gate van tu choi credential va high-risk identifier bang `sensitive-input`; sau gate, raw question va evidence co the duoc gui toi DeepSeek.
- Khong ghi raw question vao provider/admission/answer-attempt state hoac log. User-owned chat van luu question theo chat contract va account-deletion lifecycle hien tai. Khong persist raw evidence, prompt, provider payload, secret hoac key. Input van bi gioi han theo Source Registry va duoc lam sach/delimit truoc request.
- Article embedding giu OpenRouter `baai/bge-m3`, 1024 dimensions, version 1 va compatibility identity `bge-m3-v1-1024`. Thay doi nay khong tu dong yeu cau re-index vector space.
- Query embedding cua raw question van chi duoc bat khi embedding route co capability `zdr-verified`. OpenRouter/BGE-M3 hien la `nonconfidential`, vi vay Q&A dung keyword retrieval thay vi gui raw question toi OpenRouter.

## Hau qua

### Tich cuc

- Cac workload LLM dung mot provider/model co quota phu hop hon cho batch summary va Q&A.
- Business service va HTTP contract van doc lap voi vendor nho provider graph va adapter boundary.
- Embedding artifact hien tai van tuong thich, khong can cutover vector space.

### Rui ro va gate

- Raw question va evidence cua Q&A co the duoc xu ly boi DeepSeek non-ZDR. Khong duoc dung route nay cho credential, high-risk identifier, confidential input hoac input ngoai Source Registry scope.
- `nonconfidential` khong co nghia la duoc phep gui moi du lieu. Sensitive-input detector, source policy, support verifier, citation validation va lifecycle CAS van la gate bat buoc.
- Khong co fallback nen provider/model unavailable co the lam summary/Q&A tra unavailable va backlog retry. UI va job runner phai hien thi trang thai nay ro rang.
- Rate limit va chi phi DeepSeek phai duoc theo doi trong provider admission domain. Khong dua gia tri quota vao business invariant.
- Neu DeepSeek khong dap ung quality, cost, availability hoac privacy gate, rollback bang cach chuyen graph ve profile Gemini. Q&A chi duoc mo lai voi `zdr-verified` khi evidence Gemini con han; neu khong thi Q&A phai fail closed.

## Phuong an khong chon

1. Giu Gemini cho Q&A va chi doi summary: khong giai quyet quota cua Q&A.
2. Them fallback Gemini/OpenCode trong cung migration: tao provider call ngoai du kien va co the lam thay doi privacy capability.
3. Gui raw Q&A sang DeepSeek truoc sensitive-input/policy gate: vi pham boundary va khong duoc phep.
4. Doi embedding sang DeepSeek: tao vector space moi, bat buoc tang compatibility identity va full re-index, khong thuoc pham vi migration nay.

## Merge gate

- Provider graph dung `deepseek-v4-flash` cho ca ba LLM workload va credential reference `DEEPSEEK_API_KEY`.
- Q&A graph dung `nonconfidential`, khong co candidate fallback va startup validation pass.
- Sensitive-input, Source Registry, support/citation, idempotency, admission/circuit va no-raw-input tests pass.
- Synthetic smoke pass summary, answer va support khi DeepSeek credential co quyen; test khong ghi du lieu MongoDB.
- Live smoke ghi nhan model/provider/status an toan, khong ghi secret/raw provider payload. Ket qua chua chay khong duoc coi la pass.
- Article embedding van bao toan `bge-m3-v1-1024`; khong tron vector version va khong re-index ngoai ke hoach. Query embedding non-ZDR khong nhan raw question.
