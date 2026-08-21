# ADR-0015: Chuyen cac LLM workload sang Gemini

**Ngay**: 2026-08-21
**Trang thai**: accepted
**Nguoi quyet dinh**: Project owner
**Thay doi pham vi**: `summary`, `qa-generation`, `qa-support`; embedding khong thay doi

## Boi canh

Deployment baseline cu dung OpenCode Zen/DeepSeek cho LLM va OpenRouter/BGE-M3 cho embedding. Provider routing da duoc tach khoi business flow trong ADR-0013, nhung graph hien tai van tro cac LLM workload ve profile OpenCode.

Project owner muon dung model Gemini voi API key tu Google AI Studio cho summary va toan bo Q&A, dong thoi giu vector space BGE-M3 hien tai de tranh full re-index embedding.

## Quyet dinh

- Them trusted endpoint profile server-owned cho Gemini OpenAI-compatible endpoint.
- Tai su dung adapter protocol `openai-compatible` neu contract test xac nhan auth, payload va structured output tuong thich; neu khong, them adapter Gemini rieng thay vi them nhanh vendor vao adapter chung.
- `summary`, `qa-generation` va `qa-support` deu tro ve provider Gemini trong provider graph.
- `gemini-2.5-flash` la model chinh cho ca summary va hai workload Q&A; summary fallback dung `gemini-2.5-flash-lite` trong cung Gemini failure domain. Khong dung OpenRouter embedding credential lam LLM fallback.
- Q&A chi duoc bat khi Gemini project co evidence hien hanh cho capability `zdr-verified`; quota Google Pro khong tu dong thay the evidence nay.
- Embedding van dung OpenRouter `baai/bge-m3`, dimensions 1024, version 1 va compatibility identity `bge-m3-v1-1024`.
- Model, credential va route evidence van do server/operator quan ly trong env graph; khong expose cho client/admin va khong ghi secret vao log/DB.

## Hau qua

### Tich cuc

- Ba LLM workload dung chung provider Gemini va mot credential admission domain duoc quan ly tap trung.
- Business service, router, API contract va article schema khong phu thuoc vendor.
- Embedding hien tai khong bi invalid vector space; khong can re-embed toan bo corpus.

### Tieu cuc va gate

- Google AI Studio/OpenAI compatibility endpoint van la beta; phai co contract test cho response format, parser va error taxonomy.
- Q&A co the bi disable neu project khong co ZDR evidence phu hop; khong duoc ha capability xuong `nonconfidential` de lam cho chay.
- Neu can provider-level fallback, phai co Gemini project/credential doc lap voi privacy evidence tuong duong. Khi chua co, workload phai tra unavailable/refused an toan.
- Summary artifact cu can duoc regenerate co kiem soat; embedding artifact cu giu nguyen.

## Phuong an khong chon

1. Giu OpenRouter lam LLM fallback: khong dap ung yeu cau toan bo LLM workload dung Gemini va co the vi pham capability Q&A.
2. Goi Gemini SDK truc tiep trong indexing/Q&A service: lam payload/error vendor lan vao business flow va vi pham ADR-0013.
3. Doi embedding sang Gemini: tao vector space moi, bat buoc tang version va full re-index, khong thuoc pham vi migration nay.

## Merge gate

- Gemini adapter/profile unit tests pass, khong lo secret/raw provider payload.
- Provider graph validation pass cho ba LLM workload va OpenRouter embedding.
- Real smoke pass cho summary, answer va support verifier bang input synthetic an toan.
- Q&A route chi pass khi co ZDR evidence; neu thieu thi fail closed.
- Article summary regeneration ghi `summaryModel` Gemini va `summaryStatus=ready`; embedding model/version/compatibility khong doi.
- Integration, security, E2E, lint, build va docs evidence pass.
