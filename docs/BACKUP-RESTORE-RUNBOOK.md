# Runbook backup/restore hậu MVP

Trạng thái: chỉ lập kế hoạch hậu MVP và preflight local. Backup/restore không thuộc
MVP release gate. Repository này chưa thực hiện Atlas dump, governance sidecar,
restore rehearsal, reconciliation, key rotation hoặc credential revocation.

Runbook định nghĩa recovery track về sau. Nó không cấp quyền production restore và
không làm restore target an toàn để phục vụ traffic. MVP giữ database
`techpulse_governance` live cùng signed governance mutation runtime; MVP không cam
kết backup recoverability hoặc restore serving evidence.

## Ranh giới an toàn

- Backup `techpulse_app` bằng Atlas credential read-only riêng.
- Export `techpulse_governance` thành signed sidecar read-only riêng.
- Lưu cả hai artifact trong private encrypted storage chỉ owner truy cập, bên ngoài repository.
- Hủy cả hai artifact không muộn hơn bảy ngày sau khi tạo và ghi lại destruction evidence.
- Chỉ restore app dump vào database mới `techpulse_app_restore_*`.
- Giữ restore target isolated và không serving.
- Không bao giờ overwrite `techpulse_governance` live trong app-only rehearsal.
- Không bao giờ đặt Mongo URI, password, token, HMAC secret, private key hoặc key material trong inventory.

Local preflight cũng từ chối các secret field name phổ biến như `apiKey`, `mongoUri`,
`accessToken`, `hmacKey` và `credentials`. Nó từ chối Mongo URI, HTTP URL có user
information, bearer/API token, JWT và value opaque entropy cao dù value nằm dưới field
name không liên quan.

Serving gate vẫn đóng khi governance state thiếu, unavailable, stale hoặc có
signature/chain không hợp lệ.

## Role và authority bên ngoài

| Action | Authority bắt buộc | Trạng thái repository |
| --- | --- | --- |
| Tạo app dump | Backup user read-only do Atlas owner tạo và MongoDB Database Tools | Chờ external action |
| Export và sign governance sidecar | Atlas read-only access cùng owner-only offline checkpoint HMAC key | Chờ; signer/exporter chưa implement |
| Restore vào database isolated | Atlas owner/operator và target mới đã xác nhận | Chờ external action |
| Verify checkpoint, manifest và suppression chain | Offline verification key inventory cùng verifier | Chờ; integrity verifier chưa implement |
| Reconcile privacy/governance state đã restore | Restore-only mutation credential và runner được phê duyệt | Chờ; reconciliation runner chưa implement |
| Rotate secret và revoke credential cũ | Atlas/Vercel project owner | Chờ external action |
| Mở serving gate | Project owner sau khi toàn bộ zero-match và continuity evidence pass | Chờ owner approval |
| Hủy backup artifact | Storage owner | Chờ external action |

Runtime và maintenance credential không thay thế các authority này.
`MONGODB_MAINTENANCE_URI_ENV` chỉ sở hữu audit IP-HMAC cleanup task cố định. Runtime
credential không được thực hiện backup, restore hoặc checkpoint operation chỉ dành cho owner.

## 1. Chuẩn bị restore plan local

Tạo plan trong private temporary storage bên ngoài repository. Dùng opaque reference,
không dùng credential hoặc local secret path.

Mỗi storage reference phải đúng grammar `external-private:<backupId>/app` hoặc
`external-private:<backupId>/governance`. Preflight từ chối filesystem path, HTTP URL,
traversal segment, path dư và reference bind với backup ID khác.

```json
{
  "backupId": "step12-rehearsal-20260817",
  "createdAt": "2026-08-17T07:00:00.000Z",
  "destroyAt": "2026-08-24T07:00:00.000Z",
  "owner": "project-owner",
  "appDump": {
    "sourceDatabase": "techpulse_app",
    "readOnlyCredential": true,
    "encrypted": true,
    "storageClass": "private-external",
    "storageRef": "external-private:step12-rehearsal-20260817/app",
    "sha256": "<64 lowercase hex characters>"
  },
  "governanceSidecar": {
    "sourceDatabase": "techpulse_governance",
    "readOnly": true,
    "encrypted": true,
    "storageClass": "private-external",
    "storageRef": "external-private:step12-rehearsal-20260817/governance",
    "sha256": "<64 lowercase hex characters>",
    "signingAlgorithm": "HMAC-SHA-256",
    "signingKeyId": "<offline key ID, not the key>",
    "checkpointId": "<covered checkpoint ID>"
  },
  "restore": {
    "targetDatabase": "techpulse_app_restore_step12_20260817",
    "isolated": true,
    "serving": false,
    "overwriteGovernance": false
  }
}
```

Chạy preflight không network:

```powershell
node scripts/verify-restore-plan.js D:\private\restore-plan.json
```

`planValid: true` chỉ chứng minh inventory shape và safety flag local. Output luôn
giữ `restoreRehearsalVerified: false` và `serveGate: "closed"` vì script không gọi
Atlas hoặc verify offline signature.

## 2. Tạo inventory bên ngoài

Project owner phải hoàn tất các bước sau bên ngoài application runtime:

1. Tạo Atlas backup identity read-only riêng, chỉ scope vào `techpulse_app`.
2. Ghi Atlas project/cluster, MongoDB Database Tools version, thời điểm backup và
   access owner nhưng không ghi URI hoặc password.
3. Tạo `mongodump` thủ công của `techpulse_app` trong owner-only encrypted storage.
4. Tính digest SHA-256 của artifact đã mã hóa và ghi vào private inventory.
5. Export read-only `governanceSuppressions`, `governanceCheckpoints` và
   `auditRetentionManifests`.
6. Bind sidecar inventory với checkpoint hiện tại và offline signing key ID, sau đó
   sign bằng owner-only offline key.
7. Verify signature bằng verify-only key đã được phê duyệt trước restore.

Không được claim bước 6 hoàn tất cho tới khi có sidecar signer và audit-integrity
verifier đã review. Mongo validator hiện chỉ chứng minh document shape, không chứng
minh audit continuity theo thứ tự hoặc signature authenticity.

## 3. Restore vào target isolated

Trước mọi restore command:

1. Resolve chính xác target database name.
2. Xác nhận tên khớp `techpulse_app_restore_*`.
3. Xác nhận target chưa tồn tại hoặc không chứa data thuộc rehearsal khác.
4. Xác nhận không có Vercel hoặc local serving environment nào tham chiếu target.
5. Xác nhận operation không target `techpulse_app` hoặc `techpulse_governance`.

Restore app archive vào target isolated bằng MongoDB Database Tools đã được owner
phê duyệt. Không dùng broad namespace mapping hoặc destructive option cho tới khi
đã kiểm tra target được resolve. Trong whole-Atlas loss simulation, restore
governance sidecar trước vào governance recovery target được phê duyệt, sau đó verify
signature và chain trước app reconciliation.

Không có restore command nào được thực thi khi chuẩn bị runbook này.

## 4. Reconciliation bắt buộc trước khi serving

Restore runner được phê duyệt phải hoàn tất toàn bộ mục dưới đây trên target isolated:

1. Xóa toàn bộ `sessions` đã restore.
2. Xóa `rateLimitBuckets` đã restore, gồm quota state.
3. Xóa `answerAttempts` đã restore.
4. Clear active reservation trong `providerAdmissionStates`.
5. Reconcile `providerFailureDomainStates` với provider configuration version hiện
   tại; không tin circuit state cũ.
6. Loại audit IP-HMAC field khi không thể chứng minh key continuity.
7. Replay mọi account-deletion suppression hiện tại. Xóa saved article và chat data
   đã restore, rồi apply lại closed user tombstone.
8. Replay mọi takedown suppression hiện tại. Xóa hoặc hide artifact đã restore và
   redact citation còn khả dụng.
9. Verify target-specific zero match cho deleted-user PII, session, answer attempt,
   user quota data và citation bị suppress còn khả dụng.
10. Verify signed checkpoint bao phủ governance event terminal mới nhất và mọi
    retention gap đều có signed manifest hợp lệ.

Repository hiện chưa có `scripts/verify-audit-integrity.*` hoặc
`scripts/reconcile-restored-governance.*`. Cho tới khi cả hai tool và restore test
của chúng tồn tại, post-MVP recovery task vẫn pending. Chúng không block MVP release gate.

## 5. Rotate authority trước traffic

Trong production recovery thực tế, owner phải rotate session, CSRF, quota/IP HMAC,
governance signing và runtime Mongo material theo recovery plan đã phê duyệt. Revoke
Mongo credential cũ trước khi traffic có thể tới target. Rehearse HMAC rotation và
retirement với `hmacKeyLifecycleSnapshots` durable; không remove predecessor cho tới
khi successor 30 ngày và zero-dependent-record gate pass.

Offline checkpoint key không bao giờ vào `.env`, Vercel, MongoDB, command output hoặc
inventory này. Offline verification key đang retiring vẫn phải khả dụng cho tới khi
mọi checkpoint, manifest và sidecar được giữ lại đã expire hoặc re-anchor.

## 6. Ghi evidence và hủy artifact

Ghi các thông tin sau vào private release evidence:

- backup ID, thời điểm tạo và destruction deadline;
- source cluster/database và isolated target database;
- Database Tools version;
- encrypted artifact digest và private storage reference;
- app checkpoint và governance sidecar checkpoint/key ID;
- kết quả signature verification;
- restore start/end time và operator;
- kết quả reconciliation và zero-match command;
- bằng chứng secret rotation và stale-credential revocation;
- serving decision của owner;
- thời điểm hủy cuối cùng và xác nhận của storage owner.

Không đính kèm dump, sidecar, signature, secret hoặc raw customer data vào Git, CI log
hoặc issue comment.
