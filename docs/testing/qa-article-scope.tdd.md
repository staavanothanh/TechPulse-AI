# TDD Evidence Report — Q&A giới hạn theo bài từ trang chi tiết

## Nguồn plan

Không dùng `*.plan.md`; journeys được xác định trong phiên làm việc với project owner:

- Người dùng muốn hỏi Q&A **giới hạn theo đúng 1 bài** đang đọc, không cần tự lấy id từ DB.
- Người dùng cũng có thể **tự copy objectId** từ feed/detail và dán vào ô "Giới hạn theo bài".
- Ô "Giới hạn theo bài" **giữ 1 bài duy nhất** (không gộp nhiều bài trong đợt này).

## User journeys

1. As a user, tôi đang đọc bài chi tiết, bấm "Hỏi về bài này" → sang trang Q&A với ô giới hạn theo bài đã điền sẵn articleId, hiển thị indicator bài đang chọn + nút "Bỏ chọn".
2. As a user, tôi thấy mã bài viết (objectId rút gọn + nút sao chép) trên feed card và trang chi tiết → copy dán vào ô "Giới hạn theo bài".
3. As a user, tôi bấm "Bỏ chọn" → articleId bị xóa khỏi scope Q&A, giữ nguyên topics.

## Task report

| Task | Tóm tắt | Validation | RED/GREEN |
|---|---|---|---|
| Thêm handler scope article trong `useQa` | `onScopeArticleId` set/replace `articleId`; `onClearArticleScope` xóa `articleId` khỏi scope | `npx vitest run test/client/qa-article-scope.test.js` | RED: 4 fail (chưa có handler) → GREEN: 5 pass |
| Thêm `onAskAboutArticle` | `usePublicIntegration` navigate `qa` + preset `articleId` vào scope; ignore khi thiếu id | cùng lệnh | RED → GREEN |
| Hiển thị badge + nút | `ArticleIdBadge` (compact + copy) trên feed card + detail; nút "Hỏi về bài này" ở detail; indicator + "Bỏ chọn" ở QaView | browser E2E (headless Chromium, user thật) | verified trên UI thật |

## Guarantees (test spec)

| # | Guarantee | Test file | Type | Result | Evidence |
|---|-----------|-----------|------|--------|----------|
| 1 | `onScopeArticleId` set `articleId` vào scope, giữ topics | `test/client/qa-article-scope.test.js:onScopeArticleId sets articleId into Q&A scope` | unit (hook) | PASS | `npx vitest run test/client/qa-article-scope.test.js` |
| 2 | `onScopeArticleId` thay thế id cũ khi gọi lại | `...replaces a previously selected article id` | unit | PASS | cùng lệnh |
| 3 | `onAskAboutArticle` navigate sang qa + preset articleId | `...navigates to qa and presets the article id` | unit | PASS | cùng lệnh |
| 4 | `onAskAboutArticle` bỏ qua khi thiếu id | `...ignores missing article id` | unit | PASS | cùng lệnh |
| 5 | `onClearArticleScope` xóa articleId khỏi scope, giữ topics | `...removes articleId from Q&A scope` | unit | PASS | cùng lệnh |
| 6 | Không regression client | 83 tests `test/client/` | unit | PASS | `npx vitest run test/client/` (12 files, 83 tests) |

## Verify UI thật (browser)

Headless Chromium, user thật `qatest2@techpulse.local`:

- Feed: badge `Mã bài viết: 6a94de4…6f47` + nút "Sao chép" hiển thị trên card.
- Detail `/article/6a94de40bbba5017dafb6f47`: badge id + nút "Hỏi về bài này".
- Bấm nút → URL `/qa`, indicator "Đang hỏi về bài: 6a94de40bbba5017dafb6f47" + nút "Bỏ chọn".
- Bấm "Bỏ chọn" → indicator + id biến mất.

## Coverage

`npx vitest run test/client/ --coverage` cho coverage **lines 64.01%** — dưới ngưỡng 80% của repo. Đây là **baseline sẵn có** (chạy với worktree không có thay đổi feature cho ra cùng 64.01%), không phải regression do feature này. Test mới phủ đúng các handler hook mới; các file JSX (ArticleView/QaView/reader-primitives) được verify bằng browser E2E thay vì coverage vì repo chưa có test render component.

## Gaps / follow-up

- Ô "Giới hạn theo bài" chưa hỗ trợ gộp nhiều bài (quyết định owner: giới hạn 1 bài trong đợt này; multi-id là hướng sau).
- Chưa có test render component (jsdom) cho badge/nút; phủ bằng E2E browser thủ công.
- Khi bấm nút ở bài hidden giữa chừng, Q&A sẽ trả không có bằng chứng — chưa xử lý lỗi chuyên biệt (nhỏ, để follow-up).
