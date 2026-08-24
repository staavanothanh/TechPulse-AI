# Bằng chứng TDD: thuật ngữ kỹ thuật trong title summary

## Source và hành trình người dùng

Task này được rút ra từ điều tra production failure. Admin cần summary job giữ
nguyên các thuật ngữ kỹ thuật tiếng Anh an toàn trong article title, đồng thời tạo
nội dung summary bằng tiếng Việt.

## Báo cáo task

| Bảo đảm | Target kiểm thử | Loại | Kết quả | Bằng chứng |
|---|---|---|---|---|
| Thuật ngữ kỹ thuật tiếng Anh an toàn được chấp nhận trong `titleVi` | `test/unit/ai/summary.test.js` | Unit | PASS | RED lần đầu fail với `Vietnamese summary title must be plain Vietnamese text`; GREEN pass sau khi tách validation title và summary. |
| `summaryVi` vẫn yêu cầu nội dung tiếng Việt và từ chối markup hoặc độ dài quá mức | `test/unit/ai/summary.test.js` | Unit | PASS | `npm test -- --run test/unit/ai/summary.test.js` |
| Chuẩn hóa NFKC và whitespace an toàn được chấp nhận nhưng không chấp nhận markup | `test/unit/ai/summary.test.js` | Unit | PASS | RED lần đầu fail với `Vietnamese summary must be plain text`; GREEN pass sau khi so sánh output đã sanitize với input đã normalize. |
| Provider instruction giữ proper name và thuật ngữ kỹ thuật, đồng thời định nghĩa fallback metadata-only bằng tiếng Việt | `test/unit/ai/provider-adapters.test.js` | Unit | PASS | RED lần đầu fail vì thiếu yêu cầu prompt; GREEN pass sau khi cập nhật summary instruction. |
| DeepSeek và indexing artifact path vẫn tương thích | DeepSeek/provider/indexing focused tests | Integration | PASS | 5 test files và 59 tests pass trước khi thêm fallback test cuối. |

## Coverage và bằng chứng vận hành

- `npm test -- --run test/unit/ai/summary.test.js --coverage --coverage.include=server/ai/summary.js`: 100% statements, branches, functions và lines trước khi thêm fallback-only test cuối.
- Runtime local đã regenerate toàn bộ 20 summary artifact failed. Trạng thái Atlas cuối: zero queued jobs, zero published summary artifact failure và zero published embedding artifact failure.
- Failed job record lịch sử vẫn được giữ trong Atlas làm audit history.

## Khoảng trống đã biết

Metadata-only fallback là LLM instruction, không phải invariant deterministic ở application layer. Một Vietnamese summary an toàn khác vẫn có thể pass validation.
