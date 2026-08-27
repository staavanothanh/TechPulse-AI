# ADR-0016: Chuyển các workload LLM sang DeepSeek V4 Flash

**Ngày**: 2026-08-23

**Trạng thái**: accepted

**Người quyết định**: Project owner

**Thay thế**: [ADR-0015](0015-adopt-gemini-for-llm-workloads.md)
**Thay đổi phạm vi**: `summary`, `qa-generation`, `qa-support`; embedding không thay đổi

## Bối cảnh

ADR-0015 đưa ba workload LLM về Gemini. Quota theo model của Gemini không đủ cho backlog summary và Q&A, vì vậy các request có thể chạm giới hạn theo phút/ngày. Project owner đã chọn DeepSeek cho cả summary và toàn bộ Q&A.

DeepSeek không cung cấp bằng chứng Zero Data Retention (ZDR) phù hợp với gate hiện tại. Quyết định này vì thế thay đổi privacy capability của Q&A từ `zdr-verified` sang `nonconfidential`, với sự chấp thuận rõ ràng của project owner.

## Quyết định

- `summary`, `qa-generation` và `qa-support` đều dùng provider DeepSeek và model chính xác `deepseek-v4-flash`.
- Credential của provider được resolve từ env name `DEEPSEEK_API_KEY`; application không đọc secret từ request, client, log hoặc MongoDB.
- Provider graph dùng trusted server-owned endpoint profile và protocol adapter đã được kiểm tra. Không cho client/admin truyền arbitrary endpoint hoặc model.
- Ba workload không có model fallback hoặc provider fallback trong graph hiện tại. Lỗi retryable được xử lý bằng job retry bounded hoặc retry hint; không tự động gửi cùng input sang provider/model khác.
- Q&A route khai báo capability `nonconfidential`. Privacy gate vẫn từ chối credential và high-risk identifier bằng `sensitive-input`; sau gate, raw question và evidence có thể được gửi tới DeepSeek.
- Không ghi raw question vào provider/admission/answer-attempt state hoặc log. User-owned chat vẫn lưu question theo chat contract và account-deletion lifecycle hiện tại. Không persist raw evidence, prompt, provider payload, secret hoặc key. Input vẫn bị giới hạn theo Source Registry và được làm sạch/delimit trước request.
- Article embedding giữ OpenRouter `baai/bge-m3`, 1024 dimensions, version 1 và compatibility identity `bge-m3-v1-1024`. Thay đổi này không tự động yêu cầu re-index vector space.
- Query embedding của raw question được bật sau privacy admission khi embedding route có capability bằng hoặc mạnh hơn `qa-generation.requiredCapability`. OpenRouter/BGE-M3 hiện là `nonconfidential`, tương thích với Q&A `nonconfidential`, nên semantic retrieval được dùng; nếu embedding unavailable/incompatible thì fallback về lexical + taxonomy retrieval. Không được dùng route khác capability hoặc vector space khác compatibility.

## Hệ quả

### Tích cực

- Các workload LLM dùng một provider/model có quota phù hợp hơn cho batch summary và Q&A.
- Business service và HTTP contract vẫn độc lập với vendor nhờ provider graph và adapter boundary.
- Embedding artifact hiện tại vẫn tương thích, không cần cutover vector space.

### Rủi ro và gate

- Raw question và evidence của Q&A có thể được xử lý bởi DeepSeek non-ZDR. Không được dùng route này cho credential, high-risk identifier, confidential input hoặc input ngoài Source Registry scope.
- `nonconfidential` không có nghĩa là được phép gửi mọi dữ liệu. Sensitive-input detector, source policy, support verifier, citation validation và lifecycle CAS vẫn là gate bắt buộc.
- Không có fallback nên provider/model unavailable có thể làm summary/Q&A trả unavailable và backlog retry. UI và job runner phải hiển thị trạng thái này rõ ràng.
- Rate limit và chi phí DeepSeek phải được theo dõi trong provider admission domain. Không đưa giá trị quota vào business invariant.
- Nếu DeepSeek không đáp ứng quality, cost, availability hoặc privacy gate, rollback bằng cách chuyển graph về profile Gemini. Q&A chỉ được mở lại với `zdr-verified` khi evidence Gemini còn hạn; nếu không thì Q&A phải fail closed.

## Phương án không chọn

1. Giữ Gemini cho Q&A và chỉ đổi summary: không giải quyết quota của Q&A.
2. Thêm fallback Gemini/OpenCode trong cùng migration: tạo provider call ngoài dự kiến và có thể làm thay đổi privacy capability.
3. Gửi raw Q&A sang DeepSeek trước sensitive-input/policy gate: vi phạm boundary và không được phép.
4. Đổi embedding sang DeepSeek: tạo vector space mới, bắt buộc tăng compatibility identity và full re-index, không thuộc phạm vi migration này.

## Merge gate

- Provider graph dùng `deepseek-v4-flash` cho cả ba workload LLM và credential reference `DEEPSEEK_API_KEY`.
- Q&A graph dùng `nonconfidential`, không có candidate fallback và startup validation pass.
- Sensitive-input, Source Registry, support/citation, idempotency, admission/circuit và no-raw-input tests pass.
- Synthetic smoke pass summary, answer và support khi DeepSeek credential có quyền; test không ghi dữ liệu MongoDB.
- Live smoke ghi nhận model/provider/status an toàn, không ghi secret/raw provider payload. Kết quả chưa chạy không được coi là pass.
- Article embedding vẫn bảo toàn `bge-m3-v1-1024`; không trộn vector version và không re-index ngoài kế hoạch. Query embedding chỉ dùng admitted question sau privacy admission và route có capability tương thích; không persist vector/provider payload và luôn có lexical + taxonomy fallback khi embedding không khả dụng.
