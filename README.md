# TechPulse AI

## Step 1–2 local commands

The repository uses Node.js `24.14.1` and npm `11`. Run `nvm use` or select an equivalent Node 24 installation before working.

```text
npm ci
npm run dev              # http://localhost:3000
npm run contract:validate
npm run contract:generate
npm run contract:test
npm run lint
npm test -- --run
npm run build
npm run db:migrate -- --to auth-core
npm run db:verify -- auth-core
npm run seed:admin
```

Step 2 thêm MongoDB driver `7.5.0`, auth-core migrations, repository boundary, opaque cookie session, CSRF/RBAC và auth/account surfaces. Cần `MONGODB_URI_ENV`, `MONGODB_DATABASE` và URI secret trước khi chạy migration/seed; full auth runtime cần thêm HMAC key env. Stable key version nằm trong env, còn lifecycle history nằm trong append-only Mongo `hmacKeyLifecycleSnapshots`: mỗi retirement giữ predecessor, chờ successor được Mongo quan sát ít nhất 30 ngày và zero-check rate-limit/session/audit trong transaction. Chạy migration trước `seed:admin`, vì seed chỉ kiểm tra readiness và không thực hiện DDL bằng runtime credential. Không ghi giá trị secret hoặc key material vào log/DB.
