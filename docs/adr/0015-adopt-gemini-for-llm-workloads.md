# ADR-0015: Chuyển các workload LLM sang Gemini

**Ngày**: 2026-08-21
**Trạng thái**: accepted
**Người quyết định**: Project owner
**Thay đổi phạm vi**: `summary`, `qa-generation`, `qa-support`; embedding không thay đổi

## Bối cảnh

Baseline triển khai cũ dùng OpenCode Zen/DeepSeek cho LLM và OpenRouter/BGE-M3 cho embedding. Provider routing đã được tách khỏi business flow trong ADR-0013, nhưng graph hiện tại vẫn trỏ các workload LLM về profile OpenCode.

Project owner muốn dùng model Gemini với API key từ Google AI Studio cho summary và toàn bộ Q&A, đồng thời giữ vector space BGE-M3 hiện tại để tránh full re-index embedding.

## Quyết định

- Thêm trusted endpoint profile do server sở hữu cho Gemini OpenAI-compatible endpoint.
- Tái sử dụng adapter protocol `openai-compatible` nếu contract test xác nhận auth, payload và structured output tương thích; nếu không, thêm adapter Gemini riêng thay vì thêm nhanh vendor vào adapter chung.
- `summary`, `qa-generation` và `qa-support` đều trỏ về provider Gemini trong provider graph.
- `gemini-2.5-flash` là model chính cho cả summary và hai workload Q&A; summary fallback dùng `gemini-2.5-flash-lite` trong cùng Gemini failure domain. Không dùng OpenRouter embedding credential làm LLM fallback.
- Q&A chỉ được bật khi Gemini project có evidence hiện hành cho capability `zdr-verified`; quota Google Pro không tự động thay thế evidence này.
- Embedding vẫn dùng OpenRouter `baai/bge-m3`, dimensions 1024, version 1 và compatibility identity `bge-m3-v1-1024`.
- Model, credential và route evidence vẫn do server/operator quản lý trong env graph; không expose cho client/admin và không ghi secret vào log/DB.

## Hệ quả

### Tích cực

- Ba workload LLM dùng chung provider Gemini và một credential admission domain được quản lý tập trung.
- Business service, router, API contract và article schema không phụ thuộc vendor.
- Embedding hiện tại không bị invalid vector space; không cần re-embed toàn bộ corpus.

### Tiêu cực và gate

- Google AI Studio/OpenAI compatibility endpoint vẫn là beta; phải có contract test cho response format, parser và error taxonomy.
- Q&A có thể bị disable nếu project không có ZDR evidence phù hợp; không được hạ capability xuống `nonconfidential` để làm cho chạy.
- Nếu cần provider-level fallback, phải có Gemini project/credential độc lập với privacy evidence tương đương. Khi chưa có, workload phải trả unavailable/refused an toàn.
- Summary artifact cũ cần được regenerate có kiểm soát; embedding artifact cũ giữ nguyên.

## Phương án không chọn

1. Giữ OpenRouter làm LLM fallback: không đáp ứng yêu cầu toàn bộ workload LLM dùng Gemini và có thể vi phạm capability Q&A.
2. Gọi Gemini SDK trực tiếp trong indexing/Q&A service: làm payload/error vendor lan vào business flow và vi phạm ADR-0013.
3. Đổi embedding sang Gemini: tạo vector space mới, bắt buộc tăng version và full re-index, không thuộc phạm vi migration này.

## Merge gate

- Gemini adapter/profile unit tests pass, không lộ secret/raw provider payload.
- Provider graph validation pass cho ba workload LLM và OpenRouter embedding.
- Real smoke pass cho summary, answer và support verifier bằng input synthetic an toàn.
- Q&A route chỉ pass khi có ZDR evidence; nếu thiếu thì fail closed.
- Article summary regeneration ghi `summaryModel` Gemini và `summaryStatus=ready`; embedding model/version/compatibility không đổi.
- Integration, security, E2E, lint, build và docs evidence pass.
