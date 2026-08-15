# Step 1 TDD evidence

> Historical snapshot: operation counts below were correct when recorded. Current canonical OpenAPI has 55 operations.

Nguồn: [Step 1 blueprint](../plans/techpulse-ai-mvp.md#step-1). Đây là evidence cho scaffold/contract boundary, không phải bằng chứng Step 2 hoặc production release.

## RED → GREEN

| Guarantee | RED | GREEN | Kết quả |
|---|---|---|---|
| Generated client/schema không drift và tồn tại | `npm test -- --run test/contract/generated-artifact.test.js` trước generate: thiếu `shared/generated/api-client.js` | `npm run contract:generate` rồi chạy lại cùng command | PASS |
| OpenAPI completeness | Contract inventory fail nếu thiếu `x-persistence`, `400`, `413`, `415` hoặc `503` | `npm run contract:validate` | PASS |
| Health/error boundary | Health response và canonical error envelope | `npm test -- --run` | PASS |
| Browser/ingress boundary | Origin, cookie, target, query và body abuse fixtures | `npm test -- --run` | PASS |

Sau repair, focused boundary suite có 20 test pass; toàn bộ Step 1 suite có 29 test pass.

## Implemented guarantees

- 54 operation đều có `x-persistence=none|mongo`; JSON-body operation có `400/413/415`; Mongo operation có `503`.
- Generated artifacts chỉ được ghi bởi `npm run contract:generate` vào `shared/generated/`.
- Health trả `{ data: { status: "ok", timestamp } }`; mọi response có request ID và lỗi dùng canonical envelope.
- Origin được normalize exact, không phát credentialed CORS; session cookie/clear tuple dùng `__Host-techpulse_session` và auth cache là private/no-store.
- Request target 8 KiB, JSON body 64 KiB, JSON-only/identity encoding và flat query parser reject unknown/duplicate/operator-shaped input.
- Generated client kiểm tra required headers từ OpenAPI trước khi gọi fetch, encode path params và giữ canonical error mapping; `Origin` được đánh dấu browser-managed, còn `Authorization` được sinh từ security scheme `cronBearer`; generated source được loại khỏi coverage aggregate vì là artifact tái sinh, nhưng boundary tests vẫn kiểm tra hành vi public.
- Path ingress thực thi minLength/maxLength/enum/pattern; health payload thực tế được validate bằng schema OpenAPI; chunked body vượt giới hạn và mutation thiếu Origin đều bị từ chối.
- Runtime configuration chỉ kiểm tra origin, key-env names, checkpoint key IDs, provider admission metadata và machine secret env name; không đọc hoặc hardcode secret value.
- App shell giữ visual/accessibility primitives từ UX foundation local copy nhưng chưa triển khai business UI.

## Known scope

MongoDB, auth persistence, connector, provider thật, database migration, business UI, E2E browser suite và production deployment thuộc các blueprint step sau. Các script `test:integration`, `test:security`, `test:ui`, `test:e2e`, `eval:*` và `db:*` đã được khai báo nhưng chưa tự nhận là pass; suite tương ứng sẽ fail/được implement khi step sở hữu bắt đầu.

Coverage verification: `npm test -- --run --coverage` — 29 tests pass; statements 88.16%, branches 81.18%, functions 98.33%, lines 94.84% (generated artifacts excluded from aggregate).
