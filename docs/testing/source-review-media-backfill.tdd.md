# TDD: Media backfill cho RSS/Atom

## Phạm vi

Worktree: `fix/source-review-media-backfill-v2`.

Worker chỉ đọc metadata từ RSS/Atom connector đã được Source Registry duyệt. Worker không mở canonical article page, không lấy OpenGraph, không fetch/probe media asset và không lưu HTML thô, binary hoặc base64.

## User journeys và bằng chứng

| Bảo đảm | RED | GREEN | Test/command |
| --- | --- | --- | --- |
| Nguồn `active`, technical check passed, license hợp lệ và exact media allowlist mới được fetch feed | Test worker mới fail vì source paused vẫn gọi connector | Guard source/policy trước I/O | `test/unit/media/media-backfill-worker.test.js` |
| Worker chỉ dùng reviewed RSS connector; safe-fetch chỉ gọi feed URL, không gọi article/media URL | Test runtime connector mới fail trước flow worker | Live registry gọi `safeFetch` một lần với `connectorConfig.feedUrl` | `test/unit/media/media-backfill-worker.test.js` |
| RSS/Atom metadata có thể cung cấp image URL, nhưng HTTP/private URL, script bait và markup không được persist | Các test extractor fail trước normalizer | Chỉ persist candidate URL/alt HTTPS; raw markup không nằm trong output | `test/unit/media/rss-embedded-image.test.js` |
| Worker recheck source sau fetch; source/policy drift không commit | Test worker mới fail trước recheck | Report `source_policy_changed`, repository không được gọi | `test/unit/media/media-backfill-worker.test.js` |
| Repository chỉ cập nhật article cùng source, `published`, no-media và CAS exact row | Test repository mới fail trước dedicated method | Filter source/policy/config/article state; atomic `$set` media fields only | `test/integration/media/media-backfill-repository.test.js` |
| Generic dedupe không copy incoming media giữa source | Regression test mới fail nếu merge copy media | Dedupe giữ `leadMedia: null`, backfill dùng repository riêng | `test/unit/media/media-merge.test.js` |
| CLI bounded, dry-run mặc định và execute cần `--confirm --confirm-database` exact | Test script mới fail trước parser/runtime | Script chỉ nhận `--source-key`, limit 1..100 và confirmation database | `test/unit/media/backfill-media-script.test.js` |

## Verification

- RED commands đã chạy từng slice trước implementation. Ví dụ cuối: `npm test -- --run test/unit/media/rss-embedded-image.test.js -t "script block"` fail vì extractor chọn image trong `<script>`, sau đó pass khi bỏ script/style content.
- `npm test -- --run test/unit/media test/integration/media` — PASS, 5 files / 27 tests.
- `npm test -- --run test/unit/media test/integration/media test/ui/admin/source-media-policy.test.js test/unit/sources/state-machine.test.js test/unit/sources/service.test.js test/unit/articles/normalization.test.js test/unit/sources/policy-gates.test.js test/security/ssrf/safe-fetch.test.js test/unit/connectors/rss-media-ranking.test.js test/connectors/rss/rss.test.js test/unit/articles/dedupe.test.js test/unit/ingestion/runtime.test.js` — PASS, 15 files / 141 tests.
- `npm exec -- eslint server/application/media/backfill.js server/connectors/rss/normalizer.js server/repositories/mongo/article-repository.js scripts/backfill-media.js test/unit/media test/integration/media` — PASS.
- `node scripts/backfill-media.js --help` — PASS; usage printed and no database connection requested.
- `git diff --check` — PASS; only Git LF/CRLF warnings.

## Known operational limit

Backfill can enrich only current entries that remain in the reviewed RSS/Atom feed. Historical items that no longer appear in the feed are skipped rather than scraped from canonical pages. A source with `mediaPolicy` disabled or empty `allowedHosts` returns `media_policy_disabled` and makes no fetch or write.

Trong một lần chạy thật, repository cố ý tăng `sources.updatedAt` như một CAS fence trong cùng transaction với các cập nhật media. Fence này tuần tự hóa bước commit và fail closed khi source thay đổi; một transaction đồng thời có thể retry, đọc fence mới rồi tiếp tục nếu policy và cấu hình vẫn khớp. Vì vậy, fence không phải cơ chế tuyệt đối ngăn hai lần chạy dùng cùng snapshot policy. `sources.updatedAt` cũng có thể tăng khi không tìm thấy article phù hợp; đây là side effect đã chọn để ghi nhận lần kiểm tra và bảo vệ CAS. Không có payload nguồn hay nội dung bài viết nào được ghi thêm.

## Not run

- No real MongoDB, migration or production database command was run. The tests use repository doubles and do not write a database.
- `npm run lint` was run but failed on 9 existing `no-unused-vars` errors in unrelated `test/unit/admin-data-coverage.test.js` and `test/unit/repositories/**`. The scoped media lint command passed.
- No commit or push was created.
