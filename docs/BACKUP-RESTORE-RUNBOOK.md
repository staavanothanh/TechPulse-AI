# Post-MVP backup/restore runbook

Status: post-MVP planning and local preflight only. Backup/restore is not part of the MVP release gate. No Atlas dump, governance sidecar, restore rehearsal, reconciliation, key rotation or credential revocation has been performed from this repository.

This runbook defines the later recovery track. It does not authorize a production restore and does not make a restore target safe to serve. The MVP keeps the live `techpulse_governance` database and runtime signed governance mutations; it does not promise backup recoverability or restore serving evidence.

## Safety boundary

- Back up `techpulse_app` with a dedicated read-only Atlas credential.
- Export `techpulse_governance` as a separate read-only signed sidecar.
- Store both artifacts in owner-only encrypted private storage outside the repository.
- Destroy both artifacts no later than seven days after creation and record the destruction evidence.
- Restore the app dump only to a new `techpulse_app_restore_*` database.
- Keep the restore target isolated and non-serving.
- Never overwrite live `techpulse_governance` during an app-only rehearsal.
- Never put a Mongo URI, password, token, HMAC secret, private key or key material in the inventory.

The local preflight also rejects common secret field names such as `apiKey`, `mongoUri`, `accessToken`, `hmacKey` and `credentials`. It rejects Mongo URIs, HTTP URLs with user information, bearer/API tokens, JWTs and long opaque high-entropy values even when they appear under an unrelated field name.

The serving gate stays closed when governance state is missing, unavailable, stale or has an invalid signature/chain.

## Roles and external authority

| Action | Required authority | Repository status |
| --- | --- | --- |
| Create the app dump | Atlas owner-created read-only backup user and MongoDB Database Tools | Pending external action |
| Export and sign the governance sidecar | Atlas read-only access plus the owner-only offline checkpoint HMAC key | Pending; signer/exporter is not implemented |
| Restore to an isolated database | Atlas owner/operator and a confirmed new target database | Pending external action |
| Verify checkpoint, manifest and suppression chains | Offline verification key inventory plus a verifier | Pending; integrity verifier is not implemented |
| Reconcile restored privacy/governance state | Restore-only mutation credential and approved runner | Pending; reconciliation runner is not implemented |
| Rotate secrets and revoke stale credentials | Atlas/Vercel project owner | Pending external action |
| Open the serving gate | Project owner after all zero-match and continuity evidence passes | Pending external approval |
| Destroy backup artifacts | Storage owner | Pending external action |

Runtime and maintenance credentials are not substitutes for these authorities. `MONGODB_MAINTENANCE_URI_ENV` only owns the fixed audit IP-HMAC cleanup task. Runtime credentials must not perform owner-only backup, restore or checkpoint operations.

## 1. Prepare a local restore plan

Create the plan in private temporary storage outside the repository. Use opaque references, not credentials or local secret paths.

Each storage reference must use the exact grammar `external-private:<backupId>/app` or `external-private:<backupId>/governance`. The preflight rejects filesystem paths, HTTP URLs, traversal segments, extra path segments and references bound to another backup ID.

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

Run the non-network preflight:

```powershell
node scripts/verify-restore-plan.js D:\private\restore-plan.json
```

`planValid: true` proves only the local inventory shape and safety flags. The output always keeps `restoreRehearsalVerified: false` and `serveGate: "closed"` because the script does not contact Atlas or verify an offline signature.

## 2. Create the external inventory

The project owner must complete these steps outside the application runtime:

1. Create a dedicated read-only Atlas backup identity scoped to `techpulse_app`.
2. Record the Atlas project/cluster, MongoDB Database Tools version, backup time and access owner without recording the URI or password.
3. Create a manual `mongodump` of `techpulse_app` in owner-only encrypted storage.
4. Compute the encrypted artifact SHA-256 digest and record it in the private inventory.
5. Export `governanceSuppressions`, `governanceCheckpoints` and `auditRetentionManifests` read-only.
6. Bind the sidecar inventory to the current checkpoint and offline signing key ID, then sign it with the owner-only offline key.
7. Verify the signature with the approved verify-only key before restore.

Step 6 cannot be claimed complete until a reviewed sidecar signer and audit-integrity verifier exist. The current Mongo validators prove document shape, not ordered audit continuity or signature authenticity.

## 3. Restore to an isolated target

Before any restore command:

1. Resolve the exact target database name.
2. Confirm it matches `techpulse_app_restore_*`.
3. Confirm the target does not exist or contains no data owned by another rehearsal.
4. Confirm no Vercel or local serving environment references the target.
5. Confirm the operation will not target `techpulse_app` or `techpulse_governance`.

Restore the app archive into the isolated target with owner-approved MongoDB Database Tools. Do not use a broad namespace mapping or destructive option until the resolved target has been checked. For whole-Atlas loss simulation, restore the governance sidecar first to the approved governance recovery target, then verify its signature and chain before app reconciliation.

No restore command was executed while preparing this runbook.

## 4. Required reconciliation before serving

An approved restore runner must complete all items below against the isolated target:

1. Delete all restored `sessions`.
2. Delete restored `rateLimitBuckets`, including quota state.
3. Delete restored `answerAttempts`.
4. Clear active reservations in `providerAdmissionStates`.
5. Reconcile `providerFailureDomainStates` against the current provider configuration version; do not trust old circuit state.
6. Remove audit IP-HMAC fields when key continuity cannot be proven.
7. Replay every current account-deletion suppression. Remove restored saved articles and chat data, and re-apply the closed user tombstone.
8. Replay every current takedown suppression. Remove or hide restored artifacts and redact available citations.
9. Verify target-specific zero matches for deleted-user PII, sessions, answer attempts, user quota data and available suppressed citations.
10. Verify that the signed checkpoint covers the latest terminal governance event and that every retention gap has a valid signed manifest.

The repository does not yet contain `scripts/verify-audit-integrity.*` or `scripts/reconcile-restored-governance.*`. Until both tools and their restore tests exist, the post-MVP recovery tasks remain pending. They do not block the MVP release gate.

## 5. Rotate authority before traffic

For a real production recovery, the owner must rotate session, CSRF, quota/IP HMAC, governance signing and runtime Mongo material as required by the approved recovery plan. Revoke stale Mongo credentials before any traffic can reach the target. Rehearse HMAC rotation and retirement against durable `hmacKeyLifecycleSnapshots`; do not remove a predecessor until the 30-day successor and zero-dependent-record gates pass.

The offline checkpoint key never enters `.env`, Vercel, MongoDB, command output or this inventory. Retiring offline verification keys remain available until all retained checkpoints, manifests and sidecars are expired or re-anchored.

## 6. Record evidence and destroy artifacts

Record these facts in private release evidence:

- backup ID, creation time and destruction deadline;
- source cluster/database and isolated target database;
- Database Tools version;
- encrypted artifact digests and private storage references;
- app checkpoint and governance sidecar checkpoint/key IDs;
- signature verification result;
- restore start/end time and operator;
- reconciliation and zero-match command results;
- secret rotation and stale-credential revocation evidence;
- owner serving decision;
- final destruction time and storage-owner confirmation.

Do not attach dumps, sidecars, signatures, secrets or raw customer data to Git, CI logs or issue comments.
