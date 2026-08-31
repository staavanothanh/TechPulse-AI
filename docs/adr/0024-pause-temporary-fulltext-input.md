# ADR-0024: Tạm dừng fulltext input tạm thời, quay về policy v2 metadata-only

- **Trạng thái**: accepted
- **Ngày**: 2026-08-31
- **Bên quyết định**: Project owner

## Bối cảnh

Luồng fulltext tạm thời (`llmInputScope: fulltext-temporary`) fetch nội dung
trang nguồn qua `createTemporaryFulltextResolver`, parse HTML, quét dữ liệu
nhạy cảm rồi mới đưa vào LLM summary. Đã thử nghiệm trên 3 demo source
(`demo:hn-topstories`, `demo:arxiv-cs-ai`, `demo:rss-the-verge`) và 7 source
real. Quá trình triển khai phát hiện các vấn đề cần thiết kế và kiểm thử thêm:

- Mỗi site RSS có cấu trúc HTML khác nhau; extractor generic chỉ hoạt động
  khi site có `<main>`/`<article>` chuẩn, còn Ars Technica chặn non-browser
  fetch (trả `202` + body rỗng), một số bài Verge chứa email newsletter trong
  body bị privacy scan chặn toàn bài.
- `CONNECTOR_HOSTS` từng hardcode host theo connector, cần nới theo
  `source.domain`; việc review host theo từng nguồn chưa đủ thời gian hoàn
  chỉnh và kiểm thử đầy đủ.
- Reconciliation khi đổi policy tạo lượng lớn indexing jobs cho toàn bộ bài
  cũ, vượt xa phạm vi "chỉ bài mới", gây áp lực cost và khó quan sát.

Chưa đủ thời gian thiết kế, thử nghiệm và vận hành an toàn cho toàn bộ các
trường hợp trên trước khi mở rộng ra production.

## Quyết định

- **Tạm dừng fulltext input**: không source nào dùng `llmInputScope:
  fulltext-temporary` trong vận hành. Toàn bộ 10 source (7 real + 3 demo) quay
  về policy v2 đã vận hành ổn định: `licenseStatus: metadata-only`,
  `llmInputScope: metadata`, `storageScope: { metadata: true, summary: true,
  embedding: true }` (summary/embedding sinh từ metadata qua basis
  `official-payload`).
- Giữ nguyên `mediaPolicy` theo từng source đã được review: arxiv/HN/
  HuggingFace/OpenAI không có media; Ars/DeepMind/Verge giữ
  `imageMode: remote-preview`, `videoMode: link-only` với host allowlist tương
  ứng.
- 3 demo source được activate lại để bài published hiển thị trên feed; 7 source
  real giữ `paused`.
- Code fulltext (`temporary-fulltext.js`, extractor, resolver) được **giữ
  nguyên trong worktree**, không xóa, không revert, nhưng không wire làm mặc
  định cho source nào (chặn bằng policy, không phải xóa code).
- Ghi nhận fulltext vào backlog hậu MVP; mọi triển khai lại phải hoàn thành
  thiết kế host allowlist theo source, extractor per-site, giới hạn scope job
  reconciliation và kiểm thử privacy scan trước khi bật.

## Phương án đã cân nhắc

- **Tiếp tục hoàn thiện fulltext ngay**: không chọn vì cần thêm thời gian
  thiết kế extractor cho từng site, xử lý anti-bot (Ars), quyết định chính
  sách email trong body, và giới hạn job scope; vượt thời hạn hiện tại.
- **Giữ fulltext chỉ cho demo source**: không chọn vì demo dùng chung code với
  production và cần cùng mức an toàn; tách hai luồng làm tăng chi phí bảo trì.
- **Xóa hoàn toàn code fulltext**: không chọn vì mất công sức đã đầu tư và
  không cho phép quay lại nhanh khi thiết kế hoàn tất.

## Hệ quả

### Tích cực

- Hệ thống trở về trạng thái vận hành ổn định đã kiểm chứng; summary/embedding
  sinh từ metadata không cần fetch ngoài, không có rủi ro SSRF/HTML/anti-bot.
- Không có source nào phụ thuộc vào resolver fulltext khi vận hành.
- 58 bài published (54 HN demo + 4 Verge demo) có summary/embedding khớp policy
  mới (basis `official-payload`), rightsSnapshot đồng bộ, hiển thị feed bình
  thường.

### Tiêu cực

- Mất khả năng tóm tắt dựa trên nội dung đầy đủ bài viết; summary chỉ dựa vào
  metadata (title/excerpt).
- Bài demo đã sinh summary từ fulltext trước đây được re-summary từ metadata,
  nội dung có thể ngắn gọn hơn.

### Rủi ro

- Nếu ai đó bật lại `fulltext-temporary` trên source mà chưa hoàn thiện thiết
  kế, các vấn đề SSRF/host/extractor/privacy tái xuất hiện; ADR này là tài liệu
  chặn và yêu cầu review lại trước khi bật.
- Jobs indexing cũ (policy cũ) vẫn nằm trong queue với trạng thái
  `failed`/`cancelled`; cần dọn dẹp trong quá trình vận hành tiếp.

## Phạm vi hậu MVP

Thiết kế tiếp theo cần chốt: host allowlist theo `source.domain` cho mọi
connector, extractor per-site có fallback, chính sách email/token trong body
(allow email domain-source hay fail-closed toàn bài), giới hạn reconciliation
chỉ tạo job cho bài thay đổi policy, và test end-to-end với nguồn có anti-bot.
