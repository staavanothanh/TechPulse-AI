# TechPulse AI

> Ứng dụng web đọc tin công nghệ theo hướng Vietnamese-first: tóm tắt ngắn bằng tiếng Việt, tìm kiếm theo từ khóa/ngữ nghĩa và Q&A có citation để người đọc luôn mở được nguồn kiểm chứng.
>

## Tổng quan

TechPulse AI dành cho sinh viên CNTT Việt Nam, junior/mid-level developer và người theo dõi AI, AI Agent, Robotics hoặc Software Engineering. Sản phẩm gom nội dung từ các nguồn đã được quản trị, chuẩn hóa và chống trùng trước khi đưa vào feed; phần tóm tắt và trả lời AI không thay thế bài gốc và phải giữ đường dẫn/citation về bằng chứng.

MVP hiện là một modular monolith JavaScript/JSX gồm React, Node.js/Express, MongoDB và các connector AI/source. Phạm vi connector được cài đặt là RSS/Atom, arXiv và Hacker News. GitHub/social connector, lưu toàn văn, rehost media và phân tích hình/video bằng AI nằm ngoài phạm vi MVP.

## Tính năng hiện có

### Reader công khai

- Landing page giới thiệu sản phẩm và đăng nhập/đăng ký bằng email-mật khẩu hoặc Google OAuth (khi runtime OAuth được cấu hình).
- Feed bài viết có nguồn gốc, bài viết chi tiết, summary tiếng Việt và liên kết về bài gốc.
- Tìm kiếm hybrid: tín hiệu từ khóa kết hợp retrieval ngữ nghĩa khi embedding route khả dụng; text search vẫn là degradation path.
- Hỏi đáp theo ngữ cảnh bài viết hoặc tập bài đã truy xuất. Câu trả lời có citation theo đoạn; hệ thống từ chối khi không có evidence hỗ trợ.
- Lưu bài, xem tài khoản, cập nhật topic preferences, đổi mật khẩu và yêu cầu xóa tài khoản.
- Giao diện tiếng Việt, theme sáng/tối và các route reader: `/feed`, `/search`, `/saved`, `/article/:id`, `/qa`, `/account`, `/donate`.

### Vận hành và quản trị

- Dashboard admin với overview vận hành, ingestion/indexing jobs, articles & AI index, Source Registry, users, audit và governance.
- Admin có thể kiểm tra kỹ thuật nguồn, review policy, yêu cầu re-review, quản lý trạng thái bài/job, xử lý takedown và theo dõi workflow xóa tài khoản.
- Audit append-only cho các mutation quản trị; machine-only cron chạy bounded due work cho ingestion, indexing và account deletion.
- Policy source/media được kiểm tra ở server boundary. Media nguồn chỉ remote-preview khi policy cho phép; không lưu binary media như dữ liệu ứng dụng.

## Kiến trúc và luồng dữ liệu

```text
Browser (React/Vite)
        │ same-origin HTTP/JSON + server-side session cookie
        ▼
Express app (API, ingress, auth/CSRF, validation, services)
        ├── MongoDB Atlas (system of record)
        ├── RSS/Atom, arXiv, Hacker News (allowlisted source connectors)
        ├── LLM/embedding providers (admission + policy + evidence gates)
        └── Vercel Cron → bounded job runners (ingestion/indexing/deletion)
```

Luồng chính là `source registry → connector ingestion → normalization/deduplication → MongoDB → feed/search → summary hoặc retrieval → Q&A support verifier → citation`. React chỉ render và gọi generated API client; Express là policy enforcement point; domain logic không phụ thuộc Express, MongoDB SDK hay provider SDK. MongoDB Atlas giữ state bền vững; Vercel filesystem/memory không phải state store.

### Entry points quan trọng

| Entry point | Vai trò |
| --- | --- |
| `index.html` | HTML shell, locale `vi`, metadata và `/client/main.jsx` |
| `client/main.jsx` | Mount React `App` trong `BrowserRouter` |
| `client/App.jsx` | Session gate, public/admin surface và route integration |
| `client/features/public/PublicApp.jsx` | Landing, reader shell và các public views |
| `client/features/admin/ui/AdminShell.jsx` | Admin navigation và các admin views |
| `api/index.js` | Vercel function entrypoint, runtime validation và Express adapter |
| `server/dev.js` | Local HTTP server, Vite middleware và runtime bootstrap |
| `server/app.js` | Express composition root, middleware và API routers |
| `shared/generated/api-client.js` | JavaScript client được sinh từ OpenAPI contract |
| `docs/contracts/openapi.json` | HTTP contract canonical |

## Cấu trúc thư mục

```text
.
├── api/                 # Vercel function adapter
├── client/              # React/Vite UI, public reader, admin và integration state
├── server/              # Express app, HTTP, application/domain, connectors, AI, jobs, Mongo adapters
├── shared/              # Shared data và generated API schema/client
├── scripts/             # Contract, migration, seed, evaluation, smoke và verification scripts
├── test/                # Unit, integration, security, UI, contract, E2E và migration tests
├── public/              # Static assets/favicon
├── docs/                # Product, architecture, data model, API contract và runbooks
├── index.html           # Vite HTML entry
├── vite.config.js       # Vite build/dev server (port 3000, output `dist`)
├── vitest.config.js     # Vitest include và coverage thresholds
├── vercel.json          # Vercel build, routes, headers và cron
├── package.json         # Engines, dependencies và npm scripts
└── .env.example         # Mẫu biến môi trường, không chứa giá trị triển khai thật
```

## Yêu cầu cục bộ

- Node.js `24.14.1` (package engine: `>=24.14.1 <25`).
- npm `11` (package engine: `>=11 <12`).
- MongoDB có thể truy cập từ môi trường chạy app, thường là MongoDB Atlas; database runtime mặc định trong mẫu là `techpulse_app`.
- Các credential/provider cần thiết chỉ được lấy từ secret manager hoặc file `.env` local; không đưa vào bundle React, README, log hay commit.

## Cài đặt và cấu hình

```sh
npm ci
cp .env.example .env
```

Trên PowerShell có thể dùng `Copy-Item .env.example .env`. Sau đó mở `.env` và thay **mọi** placeholder bằng giá trị của môi trường local; không copy credential thật vào tài liệu.

`.env.example` là contract cấu hình chi tiết. Các nhóm biến quan trọng:

- `PUBLIC_APP_ORIGINS`: origin chính xác, local thường là `http://localhost:3000`.
- `MONGODB_URI_ENV`, `MONGODB_DATABASE`: tên biến chứa URI và tên database runtime. Maintenance/operator URI phải dùng biến riêng, không dùng lại runtime credential.
- `QUOTA_HMAC_*`, `GOVERNANCE_SIGNING_*`, `OFFLINE_CHECKPOINT_KEY_IDS` và `INTERNAL_MACHINE_SECRET_ENV`: keyring, checkpoint và machine-auth được kiểm tra khi bootstrap.
- `PROVIDER_ADMISSION_DOMAINS_JSON`, cùng credential env tương ứng như `DEEPSEEK_API_KEY` và `EMBEDDING_API_KEY`, nếu cần chạy summary/Q&A/retrieval thật.
- `GOOGLE_OAUTH_CLIENT_ID_ENV`, `GOOGLE_OAUTH_CLIENT_SECRET_ENV`, `GOOGLE_OAUTH_REDIRECT_URI_ENV`, `GOOGLE_OAUTH_STATE_SECRET_ENV` và các biến giá trị tương ứng là tùy chọn cho Google OAuth. Redirect URI phải trỏ đúng origin đã cấu hình và path `/api/v1/auth/google/callback`.
- `E2E_*` chỉ dùng cho các runner E2E đã bật rõ ràng; không dùng tài khoản cá nhân hoặc credential production.

Runtime fail-closed khi origin, database, keyring, machine secret, provider admission hoặc OAuth config không hợp lệ. Không đặt private key/signing secret vào Vercel runtime nếu biến đó chỉ dành cho release verifier.

## Chạy local

```sh
npm run dev
```

Server local dùng Express + Vite middleware và mặc định nghe tại `http://localhost:3000`. Mở URL này trong trình duyệt. API health endpoint là `GET /api/v1/health`; health chỉ xác nhận process API và không tiết lộ dependency details.

Nếu chỉ cần kiểm tra bundle production:

```sh
npm run build
```

Build Vite ghi output vào `dist/` (thư mục generated, không commit theo `.gitignore`).

## Test, contract và kiểm tra chất lượng

Các lệnh dưới đây đều là npm scripts hiện có trong `package.json`:

| Mục đích | Lệnh |
| --- | --- |
| Vitest watch mặc định | `npm test` |
| Security suite | `npm run test:security` |
| UI suite | `npm run test:ui` |
| E2E suite trực tiếp | `npm run test:e2e` |
| Integration suite | `npm run test:integration` |
| MongoDB Atlas integration/coverage | `npm run test:atlas` / `npm run test:coverage:mongodb` |
| Local-host E2E (cần server và fixture/env) | `npm run test:e2e:local` |
| Vercel Preview E2E (chỉ HTTPS preview đã cấu hình) | `npm run test:e2e:vercel` |
| OpenAPI validate/generate/contract tests | `npm run contract:validate`, `npm run contract:generate`, `npm run contract:test` |
| Retrieval/groundedness/citation evaluations | `npm run eval:retrieval`, `npm run eval:groundedness`, `npm run eval:citations` |
| CLI QA và provider smoke tests | `npm run qa:cli`, `npm run smoke:gemini`, `npm run smoke:deepseek:v4-flash` |
| ESLint và Prettier check | `npm run lint`, `npm run format:check` |

`test:e2e:local` yêu cầu `E2E_ENABLED=true`, local server đang chạy, user/admin fixture, source/article ObjectId và query hợp lệ. `test:e2e:vercel` yêu cầu `E2E_VERCEL_ENABLED=true`, `E2E_BASE_URL` HTTPS và cron secret/preview protection config phù hợp. Atlas tests cần credential/test database được cấp riêng; không chạy chúng với production data.

## Database, seed và operator-only operations

Các lệnh sau có thể thay đổi schema/data hoặc gọi hệ thống ngoài. Chỉ operator/release owner được chạy sau khi xem runbook và xác nhận đúng database/credential:

```sh
npm run db:migrate:dry-run
npm run db:migrate -- --to <migration-target>
npm run db:verify -- <migration-target>
npm run seed:admin
npm run seed:e2e-user
npm run seed:sources
npm run seed:demo
npm run verify:demo
npm run reconcile:source-policy
```

Migration dùng credential operator riêng; không dùng runtime URI để thực hiện schema mutation. Với Google OAuth, tài liệu local setup yêu cầu apply và verify target `google-oauth` trước khi bật flow. Không chạy migration/seed/reconcile trên production trong quá trình đọc README này.

`npm run setup:hooks` chỉ cấu hình Git hooks local. `npm run attestation:local` cập nhật local attestation và chỉ nên chạy trong release workflow đã được phê duyệt.

## Ghi chú triển khai Vercel

`vercel.json` xác nhận topology hiện tại:

- `npm run build` là build command và `dist` là output directory.
- `api/index.js` là function với `maxDuration: 300`.
- `/api/**` được route tới function; các request còn lại phục vụ filesystem hoặc fallback về `index.html`.
- Cron gọi `/api/internal/cron/due-work` theo schedule `0 21 * * *`; endpoint machine-only này cần secret cấu hình trong Vercel.
- MongoDB Atlas là system of record; Vercel Environment Variables phải chứa các reference/secret cần thiết và không được đưa secret vào client bundle.

> Deployment/release là thao tác operator-only. README này không chạy deploy, không thay đổi Vercel project, database hay production state. `.vercel/` là metadata local và bị ignore; không commit thư mục này.

## Hành trình người dùng cơ bản

1. Mở landing page, chọn đăng ký/đăng nhập hoặc Google OAuth nếu đã cấu hình. Feed yêu cầu server-side session.
2. Sau khi có session, đọc feed, lọc/tìm kiếm theo chủ đề, mở một bài và đi tới original URL để kiểm chứng.
3. Lưu bài cần quay lại; mở `/qa` để đặt câu hỏi trong phạm vi evidence đã truy xuất. Citation xuất hiện cùng câu trả lời; thiếu evidence thì câu trả lời bị từ chối thay vì đoán.
4. Trong `/account`, chỉnh topic preferences, đổi mật khẩu hoặc gửi yêu cầu xóa tài khoản.
5. User có role `admin` được server gate vào `/admin`; từ đó theo dõi overview, sources, jobs, articles, governance, users và audit. Role không do client tự quyết định.

## Troubleshooting

### Không đăng nhập được hoặc session không khôi phục

- Kiểm tra `PUBLIC_APP_ORIGINS` khớp chính xác URL đang mở, gồm scheme/host/port; local mặc định là `http://localhost:3000`.
- Kiểm tra Mongo URI được tham chiếu bởi `MONGODB_URI_ENV`, database name và các keyring/machine secret đều có giá trị thật, không phải placeholder; sau khi sửa `.env`, restart `npm run dev`.
- Khi Mongo/runtime chưa sẵn sàng, local server có thể khởi động nhưng auth service bị unavailable. Đây là lỗi cấu hình runtime, không phải tín hiệu để bỏ qua validation.
- Google OAuth cần đủ bốn env-name và giá trị tương ứng; callback phải đúng `/api/v1/auth/google/callback` và cùng origin. Khi migration OAuth chưa được apply/verify, không bật flow.
- API auth dùng cookie session và CSRF token trong memory. Nếu nhận 401 sau reload, tải lại session/đăng nhập lại; không đặt CSRF token vào localStorage.

### Migration hoặc database verification thất bại

- Bắt đầu bằng `npm run db:migrate:dry-run` và đọc target được hỗ trợ trong `scripts/db-migrate.js`.
- Xác nhận đang dùng credential operator/maintenance đúng scope, database đúng tên và không phải production ngoài change window.
- Sau migration, chạy `npm run db:verify -- <migration-target>` theo runbook. Không tự ý downgrade target hoặc chạy lại bằng runtime credential.

## Tài liệu liên quan

- [Documentation Index](docs/README.md) — authority map và trạng thái implementation.
- [Product Brief](docs/PRODUCT-BRIEF.md) — audience, thesis, MVP scope và anti-goals.
- [Technical Design](docs/TECHNICAL-DESIGN.md) — component boundaries, trust rules và deployment topology.
- [Data Model](docs/DATA-MODEL.md) — collections, indexes và lifecycle rules.
- [API Contract](docs/API-CONTRACT.md) và [OpenAPI](docs/contracts/openapi.json) — HTTP contract canonical.
- [Demo Runbook](docs/DEMO-RUNBOOK.md) — quy trình demo/operator evidence.

## Bản quyền và phạm vi dữ liệu

TechPulse AI không crawl toàn Internet, không vượt paywall/CAPTCHA/login, không lưu full text lâu dài và không rehost binary media nguồn trong MVP. Source rights, media policy và citation là một phần của runtime contract; hãy kiểm tra policy hiện hành trước khi thêm source hoặc bật provider mới.
