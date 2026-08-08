# TechPulse AI — HTTP Contract Guide

> Trạng thái: Contract-first baseline cho MVP  
> Canonical artifact: [contracts/openapi.json](./contracts/openapi.json)  
> Consumer: React user/admin application  
> Provider: Node.js/Express API  
> Approver: project owner; thay đổi architecture-sensitive cần ADR

## 1. Authority

`contracts/openapi.json` là nguồn duy nhất quyết định operation, field name, required/optional, nullability, enum, status code và error shape ở HTTP boundary.

Tài liệu này chỉ giải thích ownership, consumer jobs và change protocol. Nếu prose, mock, JSDoc contract hoặc implementation mâu thuẫn OpenAPI, OpenAPI thắng cho đến khi contract diff được duyệt.

Codebase dùng JavaScript/JSX. Không copy schema bằng tay sang frontend; sau khi scaffold, generator đã pin version sinh JavaScript client/JSDoc schema vào `shared/generated/api-client.js` và `shared/generated/api-schema.js`. Runtime validator và contract fixtures mới là lớp kiểm tra bắt buộc; JSDoc/`// @ts-check` chỉ là hỗ trợ editor và không tạo file `.ts`/`.tsx`.

## 2. Boundary owners

| Boundary | Consumer/owner | Provider/owner | Artifact |
|---|---|---|---|
| User API | React user UI | Express API | `contracts/openapi.json` |
| Admin API | React admin UI | Express API | `contracts/openapi.json` |
| Cron trigger | Vercel Cron | Express internal route | `contracts/openapi.json` |
| Source connector | Job runner | RSS/arXiv/HN adapters | JavaScript port + JSDoc/connector fixtures; không phải public HTTP |
| LLM/embedding | AI services | Provider adapters | JavaScript port + JSDoc/provider fixtures; không expose provider payload cho client |

Project owner phê duyệt breaking contract change. Frontend và backend đều phải review contract diff vì cùng phụ thuộc artifact.

## 3. Consumer jobs đã được contract hóa

### 3.1. User client

- đăng ký/login/logout và khôi phục session;
- bootstrap lại CSRF token từ `GET /api/v1/me` sau reload; token chỉ giữ trong memory;
- cập nhật topic preferences và quản lý saved articles;
- xem feed/filter/detail với cursor ổn định;
- render ảnh remote-preview hoặc video link-only đúng `leadMedia`; dùng fallback khi field null/lỗi;
- search text/hybrid và biết khi hệ thống fallback;
- gửi câu hỏi theo article/topic/time, render paragraph-level citations hoặc refusal;
- xóa chat và tạo automatic account-deletion workflow; request thành công revoke session, không đi qua content takedown.

### 3.2. Admin client

- xem exception overview;
- tạo/sửa/test/review/activate/pause source;
- trigger ingestion; xem, retry hoặc cancel bounded ingestion/indexing job trong cùng operational UI;
- xem safe article provenance/artifact diagnostics; đổi trạng thái/topic, ẩn/khôi phục lead media, regenerate summary/re-index và merge duplicate;
- xử lý content takedown all-or-nothing, theo dõi/retry account deletion, suspend/restore user và đọc safe structured audit log.

### 3.3. Cron caller

- gọi đúng một protected operation hằng ngày;
- dùng HTTP GET theo Vercel Cron; không dùng cookie/CSRF hoặc admin POST trust boundary;
- gửi bearer cron secret;
- nhận job result có thể là queued/running/succeeded/partial thay vì giả định request luôn hoàn tất toàn bộ backlog.

## 4. Contract conventions

- Base path là `/api/v1`; internal trigger là `/api/internal/cron`.
- JSON field dùng `camelCase`; identifier là opaque string.
- Success response có `data`; collection có `meta.nextCursor` và `meta.hasNext`.
- `null` chỉ xuất hiện ở field được khai báo nullable; field optional bị thiếu mang nghĩa chưa có/không áp dụng.
- Feed/list cursor là opaque và không được client parse.
- Error code là stable machine value; message dành cho người đọc và có thể thay đổi.
- `401` nghĩa session thiếu/hỏng; `403` nghĩa actor đã xác thực nhưng thiếu quyền.
- `409` dùng cho duplicate/idempotency/state conflict; `422` cho payload đúng JSON nhưng sai semantic.
- Mọi operation có JSON request body phải declare `400`; operation phụ thuộc MongoDB phải declare `503`, không dùng undocumented `500` thay thế.
- State-changing cookie-auth request gửi `X-CSRF-Token`.
- `GET /api/v1/me` trả `{ user, csrfToken }` cho session còn hiệu lực; CSRF token không persist ở `localStorage`.
- Manual ingestion/deletion/retry gửi `Idempotency-Key`; identity là actor scope + key + canonical request hash. Cùng intent trả cùng logical result, khác intent trả `409 idempotency_mismatch`.
- Sensitive mutation có `reason`; UI không tự tạo reason rỗng.
- `answered` và `refused` là hai schema loại trừ nhau. Runtime còn phải kiểm tra citation ID resolve tới retrieved article đang visible.
- Audit response chỉ có changed field names và safe state transition; raw before/after document không thuộc HTTP contract.

## 5. Endpoint inventory

| Surface | Operations |
|---|---|
| Auth/account | register, login, logout, current user, preferences, account deletion |
| Saved/chat | list/save/unsave saved article; list/delete chat session |
| Content | article list/detail, search results, grounded answers |
| Sources | list/create/read/update, technical check, policy review |
| Jobs | create/list/read/retry/cancel ingestion và indexing jobs; account-deletion progress/retry |
| Admin articles | list/update, summary job, indexing job, duplicate merge |
| Governance | content takedown list/create/update; account-deletion list/detail/retry; user list/update; audit list |
| Internal | protected GET daily cron adapter gọi bounded coordinator |

Exact method/path/status nằm trong OpenAPI, không lặp lại ở đây để tránh drift.

## 6. Authentication, CSRF và rate limit

- Session cookie tên triển khai có thể đổi mà không breaking nếu browser behavior không đổi; contract dùng security scheme `cookieAuth`.
- Login/register kiểm tra Origin và rate limit; mutation sau login thêm CSRF header.
- Session cookie sống qua reload nhưng CSRF token được bootstrap lại từ `/me`; không yêu cầu login lại và không hạ protection.
- Admin operation dùng session thường cộng role check server-side.
- Cron route không nhận cookie và chỉ dùng `cronBearer`.
- `429` phải có `Retry-After`; client hiển thị trạng thái retry được thay vì lặp request ngay.

## 7. Compatibility rules

Non-breaking:

- thêm optional response field;
- thêm optional query parameter;
- thêm endpoint;
- thêm error detail không đổi stable error code.

Breaking:

- xóa/đổi tên field hoặc operation;
- đổi required/nullability/type/enum theo cách consumer cũ không xử lý;
- repurpose field với semantic khác;
- đổi auth/cookie-CSRF behavior;
- đổi status/error code làm client rẽ nhánh khác.

MVP duy trì `/api/v1`; breaking change phải tạo proposal, đánh giá consumer impact và chỉ tạo `/api/v2` khi thật sự cần. Không version database model qua public API.

## 8. Change protocol

1. Mô tả consumer job và compatibility impact.
2. Sửa canonical OpenAPI trước implementation.
3. Review contract diff với frontend/backend owner.
4. Validate OpenAPI và regenerate JavaScript client/JSDoc artifact/fixture.
5. Cập nhật provider serializer và consumer.
6. Chạy contract tests trên success, error, empty, nullable và role path.
7. Chạy ít nhất một E2E happy path liên quan.
8. Chỉ merge khi không còn consumer dùng field undocumented.

Architecture/product intent đổi thì cập nhật PRD/ADR trước bước 2. Không âm thầm biến storage document thành response DTO.

## 9. Generation và verification target

Khi code scaffold hoàn tất, `package.json` cần pin tool và cung cấp các script tương đương:

```text
npm run contract:validate
npm run contract:generate
npm run contract:test
```

Expected behavior:

- `contract:validate`: parse OpenAPI 3.1, chỉ cho `$ref` nội bộ dưới `docs/contracts`, chặn remote/path-traversal ref;
- `contract:generate`: ghi JavaScript client/JSDoc schema duy nhất vào `shared/generated/`;
- `contract:test`: validate fixture và serialized Express response với cùng schema.

Generator chạy không network/secret và generated diff phải được review. Cho đến khi scaffold tồn tại, JSON parse và local `$ref` audit là validation tối thiểu.

## 10. Contract acceptance gate

- [ ] OpenAPI parse được và không có remote `$ref`.
- [ ] Mọi P0 consumer job có operation.
- [ ] Required/nullability/enum/error được khai báo rõ.
- [ ] Contract lint không còn JSON-body operation thiếu `400` hoặc Mongo-backed operation thiếu `503`.
- [ ] User/admin/cron security scheme không bị trộn.
- [ ] Empty collection và refusal answer có fixture hợp lệ.
- [ ] Invalid answer fixtures bị reject: answered rỗng/không citation, refused có paragraph hoặc thiếu refusal reason.
- [ ] Source policy/connector fixture mâu thuẫn bị reject; technical check `passed` thiếu evidence bị reject.
- [ ] Content takedown không nhận `user-data/account-data`; account deletion chỉ completed khi mọi cleanup flag true.
- [ ] Frontend client/JSDoc/mock được derive, không copy tay.
- [ ] `leadMedia` nullable, `leadMediaStatus` và `mediaPolicy` được kiểm thử với remote-preview, link-only, hide/restore, host bị chặn và fallback.
- [ ] `leadMedia.attribution` luôn non-empty và do server resolve; UI không phụ thuộc nullable `credit`.
- [ ] Express response thực được runtime-validate trong test.
- [ ] Không response nào leak password hash, session token, secret, full text hoặc private chat cho admin.
- [ ] Audit response không có arbitrary object; takedown list không trả requester contact/reason/evidence.
