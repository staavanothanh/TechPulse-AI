# ADR-0013: Sử dụng configuration-driven provider routing và bounded failover

**Ngày**: 2026-08-15
**Trạng thái**: accepted
**Người quyết định**: Project owner
**Thay thế**: [ADR-0007](0007-isolate-ai-providers-behind-adapters.md)

## Bối cảnh

ADR-0007 đã tách provider payload khỏi business flow, nhưng vẫn khóa OpenCode Zen và hai model DeepSeek trong routing decision. Implementation sau Step 11 cho thấy hai route LLM dùng chung endpoint, credential và failure domain, nên chỉ là model fallback và không chống được provider outage. Project owner yêu cầu provider/model có thể được thay đổi bằng server config mà không cần sửa application / bootstrap routing logic, đồng thời vẫn giữ privacy, cost và bounded-call invariants.

## Quyết định

Application chỉ gọi workload routing policy và các normalized `LlmProvider` / `EmbeddingProvider` ports; không hard-code vendor, endpoint hoặc model. Provider boundary tách thành năm khái niệm server-owned:

1. installed adapter catalog ánh xạ protocol sang auth, request, response, timeout và safe error taxonomy;
2. provider instance / failure domain ánh xạ một dịch vụ vận hành cụ thể vào adapter;
3. admission domain ánh xạ credential / billing pool vào concurrency và budget;
4. route ánh xạ model + operation + capability evidence vào provider / admission domain;
5. workload policy sắp xếp thứ tự primary, model fallback và provider fallback cho summary, Q&A generation / support và embedding.

Model fallback phải sử dụng một model khác trong cùng provider failure domain. Provider fallback phải sử dụng failure domain khác và thông thường credential / admission domain khác. MVP Q&A generation và summary có `maxExternalAttempts=2`: một lỗi retryable ở cấp model sẽ chọn một model fallback; một lỗi retryable ở cấp provider hoặc provider-domain circuit sẽ chọn một provider fallback. Không gọi cả hai fallback trong cùng một logical operation. Policy / privacy / sensitive-input / config / schema / support failure và ambiguous in-flight outcome là terminal, không được fallback.

Mỗi candidate lặp lại current source-policy, privacy capability, evidence-expiry, admission / budget / circuit và output validation trên cùng immutable admitted input. Route circuit theo model vẫn tồn tại; provider failure domain có circuit riêng để transport outage không thử lần lượt từng model của cùng provider. Credential chỉ được resolve từ env name; provider payload, prompt và secret không được ghi vào log / state.

Embedding chỉ được provider-fallback khi hai route có cùng `artifactCompatibilityId` bao gồm model revision, dimensions, preprocessing / normalization và embedding version. Việc thay đổi embedding model / compatibility identity là controlled cutover, tăng version và full re-index; nếu không có route tương thích thì degrade về text search.

Việc swapping provider/model đã cài adapter chỉ là config-only. Adapter có thể là protocol-level như `openai-compatible-chat`, `openai-compatible-embedding` hoặc native như `gemini-native`. OpenCode Zen, DeepSeek, OpenAI, OpenRouter hoặc provider tương thích có thể được map vào adapter phù hợp qua provider-instance config. Thêm protocol mới cần một adapter plugin và contract tests, nhưng không cần sửa business service. Provider instance / endpoint config chỉ do server operator quản lý, không nhận từ HTTP / admin, không có URL credential / redirect và phải thông qua exact trusted HTTPS profile; client / admin không có model picker.

## Các phương án đã cân nhắc

### Phương án 1: Giữ OpenCode Zen primary và paid model fallback

- **Ưu điểm**: Không cần thay đổi code / config contract.
- **Nhược điểm**: Hai model chung failure domain; provider outage làm cả hai route đều hỏng.
- **Lý do không chọn**: Không đáp ứng yêu cầu provider-level fallback và portability NFR-008.

### Phương án 2: Cho phép admin / env truyền arbitrary provider URL và model

- **Ưu điểm**: Thêm provider mà không cần deployment.
- **Nhược điểm**: Có thể gửi credential / input đến sai endpoint, gây SSRF / exfiltration và tăng test surface.
- **Lý do không chọn**: Provider modularity phải là server-owned và allowlisted, không phải arbitrary runtime routing.

### Phương án 3: Gọi SDK vendor trực tiếp trong từng service

- **Ưu điểm**: Nhanh cho một provider.
- **Nhược điểm**: Vendor error / payload lan vào application và mỗi lần đổi provider phải sửa business flow.
- **Lý do không chọn**: Vi phạm dependency direction và khiến fallback không thể kiểm thử độc lập.

## Hệ quả

### Tích cực

- Việc đổi provider/model đã cài đặt chỉ cần config và evidence hiện hành.
- Model outage và provider outage có fallback semantics khác nhau, bounded và testable.
- Admission / budget / circuit hoạt động theo đúng credential và failure domain thay vì đồng nhất route với provider.
- Business services, HTTP contract và UI không phụ thuộc vendor.

### Tiêu cực

- Config graph và startup validation phức tạp hơn một danh sách route đơn giản.
- Mỗi adapter / protocol cần normalized schema, error taxonomy và privacy evidence tests.
- Provider fallback có thể thay đổi chất lượng / latency, do đó eval phải chạy theo workload policy và route class.

### Rủi ro

- Misclassify model / provider failure có thể gọi sai fallback; adapter chỉ trả về closed error taxonomy và router có table-driven tests.
- Provider fallback làm giảm privacy capability; startup và per-call gate yêu cầu capability không thấp hơn workload.
- Embedding khác vector space có thể bị trộn lẫn; `artifactCompatibilityId` là bắt buộc và mismatch chỉ cho phép text fallback / re-index.
- Config endpoint có thể làm lộ credential; chỉ exact trusted server-owned profile được phép, không redirect hoặc arbitrary URL.
