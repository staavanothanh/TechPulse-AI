import { randomBytes } from 'node:crypto'
import { csrfTokenForSession, hashCsrfToken, hashSessionToken, createSessionToken, verifyCsrfToken } from '../../security/session-token.js'
import { hashPassword, verifyPassword } from '../../security/password.js'
import { createHmacKeyring } from '../../security/hmac-keyring.js'
import { createAuditEvent } from '../../audit/writer.js'
import { createGoogleOAuthService, GoogleOAuthError } from './google-oauth.js'
import { canonicalPreferenceIds, TOPIC_TAXONOMY_VERSION } from '../../../shared/topic-catalog.js'

/**
 * Auth service — tầng application điều phối toàn bộ luồng xác thực:
 * đăng ký, đăng nhập, phiên (session), CSRF, admin governance và Google OAuth.
 *
 * Các quy tắc kiến trúc được giữ ở đây:
 * - KHÔNG truy cập MongoDB trực tiếp — mọi đọc/ghi đi qua `repository`.
 * - Mọi method trả về đều là DTO đã chuẩn hoá (không lộ passwordHash, secret...).
 * - Rate limit, audit log và transaction là bắt buộc ở các mutation nhạy cảm.
 * - Lỗi chuẩn hoá thành `AuthError` (status/code) để HTTP layer serialize đúng
 *   theo canonical OpenAPI error envelope.
 */

// Thời gian hết hạn tuyệt đối của session: 7 ngày (không thể gia hạn vượt mốc này).
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000
// Thời gian hết hạn "idle": 24 giờ — session tự động đáo hạn nếu không hoạt động,
// nhưng mỗi request hợp lệ (qua /me) sẽ đẩy mốc này về tương lai.
const IDLE_MS = 24 * 60 * 60 * 1000
// A Google-only session must carry a recent server-verified Google login before it can enroll a local password.
const GOOGLE_STEP_UP_MS = 10 * 60 * 1000

/**
 * Password hash "mồi" dùng chung cho luồng đăng nhập sai email và cho user OAuth.
 *
 * Vì sao cần: khi email không tồn tại trong DB ta vẫn phải thực hiện một phép
 * `verifyPassword` trên một hash hợp lệ — nếu không, kẻ tấn công đo được qua
 * timing rằng email đó có tồn tại hay không (user enumeration).
 * Hash được sinh một lần lúc load module với nonce ngẫu nhiên, nên phép so sánh
 * luôn diễn ra với chi phí tương đương nhau ở mọi nhánh.
 */
const DUMMY_PASSWORD_HASH = hashPassword(`oauth-dummy:${randomBytes(32).toString('base64url')}`)

/**
 * Lỗi chuẩn hoá của auth service.
 * - `status`: HTTP status trả về.
 * - `code`: mã lỗi ổn định trong error envelope.
 * - `options.retryAfter`: giây cần chờ khi bị rate limit (429).
 * - `options.details`: chi tiết bổ sung nếu có.
 */
export class AuthError extends Error {
  constructor(status, code, message, options = {}) {
    super(message)
    this.name = 'AuthError'
    this.status = status
    this.code = code
    this.retryAfter = options.retryAfter
    this.details = options.details
  }
}

/**
 * Chuẩn hoá email: bắt buộc là chuỗi, trim + lowercase, có dấu `@`,
 * không rỗng và không vượt 254 ký tự (giới hạn chuẩn RFC cho email).
 */
function normalizeEmail(email) {
  if (typeof email !== 'string') throw new AuthError(422, 'validation_error', 'Email is invalid')
  const normalized = email.trim().toLowerCase()
  if (!normalized || normalized.length > 254 || !normalized.includes('@')) throw new AuthError(422, 'validation_error', 'Email is invalid')
  return normalized
}

/**
 * Chuyển user document thành DTO an toàn cho response.
 * Mọi trường nhạy cảm (passwordHash, googleSub, sessionVersion...) đều bị loại.
 * Nếu user đã bị xoá (status `deleted`), email/role trả về `null` — không để
 * lộ dữ liệu của tài khoản đã bị xoá.
 */
function serializeUser(user) {
  if (!user) return null
  return {
    id: String(user._id ?? user.id),
    email: user.status === 'deleted' ? null : user.emailDisplay ?? user.emailNormalized ?? user.email ?? null,
    role: user.status === 'deleted' ? null : user.role ?? null,
    status: user.status,
    topicPreferences: user.topicPreferences ?? [],
    hasPassword: user.passwordEnabled !== false,
    createdAt: new Date(user.createdAt).toISOString(),
  }
}

/** Biến thể dành cho admin (thêm `updatedAt`); các quy tắc ẩn dữ liệu giống `serializeUser`. */
function serializeAdminUser(user) {
  return {
    id: String(user._id ?? user.id),
    email: user.status === 'deleted' ? null : user.emailDisplay ?? user.emailNormalized ?? user.email ?? null,
    role: user.status === 'deleted' ? null : user.role ?? null,
    status: user.status,
    createdAt: new Date(user.createdAt).toISOString(),
    updatedAt: new Date(user.updatedAt ?? user.createdAt).toISOString(),
  }
}

/** Lấy IP client thông qua adapter (tránh phụ thuộc trực tiếp vào Express). */
function clientIp(request, adapter) {
  return adapter?.getClientIp?.(request) ?? null
}

/** Kiểm tra chuỗi có phải Mongo ObjectId 24 hex ký tự không. */
function validMongoId(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value)
}

/** Validate userId mà admin thao tác; lỗi 404 nếu không phải ObjectId hợp lệ. */
function requireAdminTargetId(userId) {
  if (!validMongoId(userId)) throw new AuthError(404, 'not_found', 'User not found')
  return userId
}

/**
 * Factory tạo auth service với dependency injection (phục vụ test).
 *
 * @param {object} [options]
 * @param {object} options.repository       Repository auth — bắt buộc (mọi IO đi qua đây).
 * @param {object} [options.runtime]        Runtime config (quotaKeyring, googleOAuth...).
 * @param {object} [options.environment=process.env] Nguồn biến môi trường (inject khi test).
 * @param {Function} [options.clock]        Nguồn thời gian (inject khi test).
 * @param {object} [options.clientIpAdapter] Adapter lấy IP client (tránh phụ thuộc Express).
 * @param {object} [options.quotaKeyring]   HMAC keyring cho rate limit (dùng chung runtime).
 * @param {object} [options.rateLimitAdmission] Cổng admission thay thế cho admin actions.
 */
export function createAuthService({ repository, runtime, environment = process.env, clock = () => new Date(), clientIpAdapter, quotaKeyring, rateLimitAdmission } = {}) {
  if (!repository) throw new Error('auth repository is required')
  // Dùng keyring được inject riêng nếu có, nếu không thì dựng từ runtime quotaKeyring.
  const keyring = quotaKeyring ?? (runtime?.quotaKeyring ? createHmacKeyring({ ...runtime.quotaKeyring }) : null)

  /** Lấy keyring rate limit hoặc ném 503 nếu service chưa được cấu hình đầy đủ. */
  function requireKeyring() {
    if (!keyring) throw new AuthError(503, 'service_unavailable', 'Authentication service is not configured')
    return keyring
  }

  /**
   * Dành riêng (reserve) một phần quota rate limit theo scope (login, register...).
   * - Subject là IP client; hash bằng HMAC để không lưu IP thô vào DB.
   * - Có hỗ trợ key rotation: băm cả theo các version key cũ để bucket cũ
   *   vẫn tính chung một quota trong lúc xoay vòng key.
   * - Khi hết quota: ném 429 kèm `retryAfter` để client biết thời điểm thử lại.
   */
  async function reserve(scope, request) {
    const currentKeyring = requireKeyring()
    const subject = clientIp(request, clientIpAdapter)
    if (!subject) throw new AuthError(503, 'service_unavailable', 'Client identity is unavailable')
    const keyHash = currentKeyring.digest(subject)
    const rotationKeyHashes = []
    for (const version of currentKeyring.versions ?? []) if (version !== currentKeyring.currentVersion) rotationKeyHashes.push(currentKeyring.digest(subject, version))
    const result = await repository.reserveRateLimit({ scope, subjectType: 'ip', keyHash, keyVersion: currentKeyring.currentVersion, keyring: currentKeyring, rotationKeyHashes, now: clock() })
    if (!result.allowed) throw new AuthError(429, 'rate_limit_exceeded', 'Too many attempts', { retryAfter: result.retryAfterSeconds })
  }

  /**
   * Admission riêng cho các hành động admin (nhạy cảm hơn login thường).
   * Ưu tiên dùng `rateLimitAdmission` được inject nếu có; nếu không thì fallback
   * về repository với subject là userId (không phải IP — admin có thể dùng chung NAT).
   */
  async function reserveAdmin(userId, session) {
    try {
      if (rateLimitAdmission?.reserve) return await rateLimitAdmission.reserve({ scope: 'admin-trigger', subject: String(userId), session })
      const currentKeyring = requireKeyring()
      const raw = String(userId)
      const rotationKeyHashes = (currentKeyring.versions ?? []).filter((version) => version !== currentKeyring.currentVersion).map((version) => currentKeyring.digest(raw, version))
      return await repository.reserveRateLimit({ scope: 'admin-trigger', subjectType: 'admin', keyHash: currentKeyring.digest(raw), keyVersion: currentKeyring.currentVersion, keyring: currentKeyring, rotationKeyHashes, now: clock() }, { session })
    } catch (error) {
      // Lỗi AuthError (vd hết quota) truyền nguyên trạng; lỗi hạ tầng -> 503.
      if (error instanceof AuthError) throw error
      throw new AuthError(503, 'service_unavailable', 'Admin admission is unavailable')
    }
  }

  /**
   * Tạo session mới cho user sau khi xác thực thành công.
   * - Token rõ chỉ tồn tại trong response duy nhất này; DB chỉ lưu hash.
   * - CSRF token được dẫn xuất từ session token (bí mật riêng cho từng session).
   * - `absoluteExpiresAt` = now + 7 ngày, `expiresAt` (idle) = now + 24 giờ.
   * - Repository dùng CAS (`expectedUserSessionVersion`) để từ chối tạo session
   *   nếu user vừa bị thu hồi session (sessionVersion đã tăng) giữa chừng.
   */
  async function createSession(user, request, transactionSession, { googleAuthenticatedAt } = {}) {
    const clearToken = createSessionToken()
    const csrfToken = csrfTokenForSession(clearToken)
    const createdAt = clock()
    try {
      await repository.createSession({
        userId: user._id,
        userSessionVersion: user.sessionVersion,
        tokenHash: hashSessionToken(clearToken),
        csrfSecretHash: hashCsrfToken(csrfToken),
        absoluteExpiresAt: new Date(createdAt.getTime() + ABSOLUTE_MS),
        expiresAt: new Date(createdAt.getTime() + IDLE_MS),
        createdAt,
        ...(googleAuthenticatedAt ? { googleAuthenticatedAt } : {}),
        userAgentSummary: request?.get?.('User-Agent')?.slice(0, 256),
      }, { session: transactionSession, expectedUserSessionVersion: user.sessionVersion, expectedUserStatus: 'active' })
    } catch (error) {
      if (error?.message === 'session user fence mismatch') throw new AuthError(401, 'unauthorized', 'Session is no longer active')
      throw error
    }
    return { sessionToken: clearToken, csrfToken, maxAgeSeconds: Math.floor(ABSOLUTE_MS / 1000) }
  }

  /**
   * Chạy một khối công việc trong transaction Mongo nếu repository hỗ trợ;
   * nếu không, chạy trực tiếp (test dùng repository in-memory).
   */
  async function inTransaction(work) {
    return typeof repository.withTransaction === 'function' ? repository.withTransaction(work) : work(undefined)
  }

  /**
   * Đăng ký tài khoản mới bằng email + password.
   * - Email chuẩn hoá, password 10..128 ký tự.
   * - Chống trùng email: kiểm tra trước + bắt lỗi unique index 11000 trong
   *   transaction (race giữa hai request đồng thời).
   * - Tạo user + session + audit log trong CÙNG một transaction để không bao
   *   giờ rơi vào trạng thái "có user nhưng chưa có session".
   */
  async function register({ email, password, request } = {}) {
    await reserve('register', request)
    const emailNormalized = normalizeEmail(email)
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw new AuthError(422, 'validation_error', 'Password is invalid')
    const existing = await repository.findUserByEmail(emailNormalized)
    if (existing) throw new AuthError(409, 'conflict', 'Account already exists')
    const passwordHash = await hashPassword(password)
    return inTransaction(async (session) => {
      let user
      try {
        user = await repository.createUser({ emailNormalized, emailDisplay: email.trim(), passwordHash, passwordEnabled: true, role: 'user', status: 'active', topicPreferences: [], topicPreferenceIds: [], topicPreferenceTaxonomyVersion: TOPIC_TAXONOMY_VERSION, sessionVersion: 0 }, { session })
      } catch (error) {
        // Unique index vẫn có thể nổ 11000 nếu có user khác chen vào giữa
        // bước kiểm tra `existing` và lúc insert — xử lý như trùng email.
        if (error?.code === 11000) throw new AuthError(409, 'conflict', 'Account already exists')
        throw error
      }
      const sessionData = await createSession(user, request, session)
      await repository.insertAudit(createAuditEvent({ actor: user, action: 'user_registered', targetId: user._id, changedFields: ['status'], reasonCode: 'user_registered', request }), { session })
      return { user: serializeUser(user), ...sessionData }
    })
  }

  /**
   * Đăng nhập bằng email + password.
   *
   * Chống user enumeration bằng timing: kể cả khi email không tồn tại, vẫn chạy
   * `verifyPassword` với DUMMY_PASSWORD_HASH nên thời gian phản hồi của hai
   * nhánh "email sai" và "password sai" là gần như nhau. Lỗi trả về cũng giống
   * hệt nhau (401 — không tiết lộ email có tồn tại hay không).
   */
  async function login({ email, password, request } = {}) {
    await reserve('login', request)
    const emailNormalized = normalizeEmail(email)
    const user = await repository.findUserByEmail(emailNormalized)
    const candidateHash = user?.passwordHash ?? await DUMMY_PASSWORD_HASH
    const passwordMatches = await verifyPassword(password, candidateHash)
    const valid = Boolean(user && user.status === 'active' && passwordMatches)
    if (!valid) throw new AuthError(401, 'unauthorized', 'Email or password is invalid')
    return inTransaction(async (session) => {
      const sessionData = await createSession(user, request, session)
      await repository.insertAudit(createAuditEvent({ actor: user, action: 'user_logged_in', targetId: user._id, reasonCode: 'user_login', request }), { session })
      return { user: serializeUser(user), ...sessionData }
    })
  }

  /**
   * Xác thực session token (từ cookie HttpOnly) -> trả về context đã xác thực.
   * Từ chối khi: session không tồn tại, user bị xoá/không active,
   * `sessionVersion` thay đổi (user bị thu hồi session / đổi mật khẩu...),
   * hoặc session hết hạn idle/absolute.
   */
  async function authenticate({ token, tokenHash = hashSessionToken(token), request } = {}) {
    const session = await repository.findSessionByTokenHash(tokenHash)
    if (!session) throw new AuthError(401, 'unauthorized', 'Session is invalid or expired')
    const user = await repository.findUserById(session.userId)
    const now = clock()
    if (!user || user.status !== 'active' || user.sessionVersion !== session.userSessionVersion || new Date(session.expiresAt) <= now || new Date(session.absoluteExpiresAt) <= now) {
      throw new AuthError(401, 'unauthorized', 'Session is invalid or expired')
    }
    return { token, session, user, request }
  }

  /**
   * Trả thông tin user hiện tại (endpoint /me) kèm CSRF token mới.
   * Đồng thời "chạm" session (sliding expiration): mỗi request hợp lệ đẩy mốc
   * idle-expiry về tương lai. Nếu session vừa bị thu hồi (CAS fail) -> 401.
   */
  async function currentUser({ token, request } = {}) {
    const auth = await authenticate({ token, request })
    const csrfToken = csrfTokenForSession(token)
    const touched = await inTransaction((session) => repository.touchSession(auth.session._id, clock(), {
      session,
      userId: auth.user._id,
      expectedSessionVersion: auth.session.userSessionVersion,
    }))
    if (!touched) throw new AuthError(401, 'unauthorized', 'Session is invalid or expired')
    return { user: serializeUser(auth.user), csrfToken }
  }

  /** Kiểm tra CSRF token của request so với secret đã lưu theo session. */
  async function verifyCsrf({ auth, token } = {}) {
    if (!auth?.session || !verifyCsrfToken(token, auth.session.csrfSecretHash)) throw new AuthError(403, 'csrf_invalid', 'CSRF token is invalid')
    return true
  }
  function requireRecentGoogleStepUp(auth) {
    const authenticatedAt = new Date(auth?.session?.googleAuthenticatedAt)
    const now = clock()
    if (!Number.isFinite(authenticatedAt.getTime()) || !Number.isFinite(now?.getTime?.()) || authenticatedAt > now || now.getTime() - authenticatedAt.getTime() > GOOGLE_STEP_UP_MS) throw new AuthError(403, 'google_reauth_required', 'Recent Google authentication is required')
  }

  /**
   * Đăng xuất: xoá session (revoke) + ghi audit trong một transaction.
   * Trước khi xoá còn kiểm tra session còn "sống" (CAS theo sessionVersion)
   * để không vô tình xoá session mới hơn do user vừa đăng nhập lại.
   */
  async function logout({ auth, csrfToken, request } = {}) {
    await verifyCsrf({ auth, token: csrfToken })
    await inTransaction(async (session) => {
      if (repository.assertActiveSessionForUser && !(await repository.assertActiveSessionForUser({ sessionId: auth.session._id, userId: auth.user._id, sessionVersion: auth.session.userSessionVersion }, { session }))) throw new AuthError(401, 'unauthorized', 'Session is no longer active')
      await repository.revokeSession(auth.session._id, { session })
      await repository.insertAudit(createAuditEvent({ actor: auth.user, action: 'user_logged_out', targetId: auth.user._id, reasonCode: 'user_logout', request: request ?? auth.request }), { session })
    })
  }

  /**
   * Cập nhật topic preferences của user.
   * - Tối đa 20 chủ đề, không trùng lặp, mỗi chủ đề 1..64 ký tự.
   * - Chuẩn hoá qua `canonicalPreferenceIds` (gắn version taxonomy hiện tại)
   *   để sau này đổi taxonomy vẫn biết preference được chọn theo version nào.
   */
  async function updatePreferences({ auth, csrfToken, topicPreferences, request } = {}) {
    await verifyCsrf({ auth, token: csrfToken })
    if (!Array.isArray(topicPreferences) || new Set(topicPreferences).size !== topicPreferences.length || topicPreferences.length > 20 || topicPreferences.some((topic) => typeof topic !== 'string' || topic.length < 1 || topic.length > 64)) {
      throw new AuthError(422, 'validation_error', 'Topic preferences are invalid')
    }
    const topicPreferenceIds = canonicalPreferenceIds(topicPreferences, { max: 20 })
    return inTransaction(async (session) => {
      const updated = await repository.updatePreferences(auth.user._id, topicPreferences, { session, expectedSessionId: auth.session._id, expectedSessionVersion: auth.session.userSessionVersion, topicPreferenceIds, topicPreferenceTaxonomyVersion: TOPIC_TAXONOMY_VERSION })
      if (!updated) throw new AuthError(401, 'unauthorized', 'Session is invalid or expired')
      await repository.insertAudit(createAuditEvent({ actor: auth.user, action: 'user_preferences_updated', targetId: auth.user._id, changedFields: ['topicPreferences'], reasonCode: 'preferences_updated', request }), { session })
      return serializeUser(updated)
    })
  }

  /**
   * Đổi mật khẩu của chính user đang đăng nhập.
   * - Bảo vệ bằng CSRF + session hợp lệ (route đã gọi authenticate trước khi tới đây).
   * - Tài khoản đã có mật khẩu thật (`passwordEnabled !== false`): bắt buộc nhập đúng
   *   `currentPassword`. Tài khoản Google-only (`passwordEnabled === false`, chỉ mang
   *   hash "mồi" không dùng để đăng nhập): cho phép ĐẶT mật khẩu lần đầu mà không cần
   *   currentPassword — người dùng đã chứng minh quyền sở hữu qua session + CSRF.
   * - Mật khẩu mới dùng chung ràng buộc 10..128 ký tự như khi đăng ký.
   * - Thành công: `updatePassword` tăng `sessionVersion` (khiến mọi session cũ mất hiệu
   *   lực), thu hồi session cũ, rồi cấp lại MỘT session mới cho chính request này và ghi
   *   audit — tất cả trong một transaction. Trả về DTO kèm session/CSRF token mới (giống
   *   login) để client cập nhật cookie và giữ phiên trên thiết bị hiện tại.
   */
  async function changePassword({ auth, csrfToken, currentPassword, newPassword, request } = {}) {
    await verifyCsrf({ auth, token: csrfToken })
    if (typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 128) throw new AuthError(422, 'validation_error', 'Password is invalid')
    const user = auth.user
    if (user.passwordEnabled === false) requireRecentGoogleStepUp(auth)
    await reserve('password-change', request)
    // Chỉ kiểm tra mật khẩu hiện tại khi tài khoản đã có mật khẩu thật; OAuth-only đã được step-up bằng Google.
    if (user.passwordEnabled !== false) {
      const matches = await verifyPassword(currentPassword, user.passwordHash)
      if (!matches) throw new AuthError(403, 'forbidden', 'Current password is incorrect')
    }
    const passwordHash = await hashPassword(newPassword)
    return inTransaction(async (session) => {
      if (typeof repository.assertActiveSessionForUser !== 'function' || !(await repository.assertActiveSessionForUser({ sessionId: auth.session?._id, userId: user._id, sessionVersion: auth.session?.userSessionVersion }, { session }))) throw new AuthError(401, 'unauthorized', 'Session is no longer active')
      const updated = await repository.updatePassword(user._id, passwordHash, { session, expectedSessionVersion: user.sessionVersion })
      if (!updated) throw new AuthError(401, 'unauthorized', 'Session is invalid or expired')
      await repository.revokeSessionsByUserId(user._id, { session })
      const sessionData = await createSession(updated, request, session)
      await repository.insertAudit(createAuditEvent({ actor: user, action: 'user_password_changed', targetId: user._id, changedFields: ['passwordHash', 'sessionVersion'], reasonCode: 'password_changed', request }), { session })
      return { user: serializeUser(updated), ...sessionData }
    })
  }

  /** Kiểm tra role admin — chỉ dựa trên dữ liệu trong auth context. */
  function requireAdmin(auth) {
    if (auth?.user?.role !== 'admin') throw new AuthError(403, 'forbidden', 'Admin role is required')
  }

  /**
   * Như `requireAdmin` nhưng kiểm tra thêm session còn "sống" trên DB
   * (admin có thể vừa bị thu hồi quyền ở một request khác). Dùng cho các
   * endpoint admin có dữ liệu nhạy cảm.
   */
  async function requireLiveAdmin(auth) {
    requireAdmin(auth)
    if (repository.assertActiveSessionForUser && !(await repository.assertActiveSessionForUser({ sessionId: auth.session._id, userId: auth.user._id, sessionVersion: auth.session.userSessionVersion }))) throw new AuthError(401, 'unauthorized', 'Session is no longer active')
  }

  /**
   * Liệt kê user (chỉ admin) với phân trang keyset bằng cursor base64url.
   * - `limit`: 1..100; lấy dư 1 bản ghi để biết `hasNext`.
   * - Bộ lọc: status (enum cố định) và email (khớp chuẩn hoá, không regex).
   * - Cursor encode `{ createdAt, id }` để phân trang ổn định kể cả khi có
   *   bản ghi mới chèn — tránh lỗi skip/offset bị trùng/lệch trang.
   */
  async function listAdminUsers({ auth, query } = {}) {
    await requireLiveAdmin(auth)
    const limit = Number(query?.limit ?? 20)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AuthError(422, 'validation_error', 'Limit is invalid')
    if (query?.status && !['active', 'suspended', 'deletion-pending', 'deleted'].includes(query.status)) throw new AuthError(422, 'validation_error', 'Status is invalid')
    if (query?.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query.email)) throw new AuthError(422, 'validation_error', 'Email is invalid')
    let cursor
    if (query?.cursor) {
      try {
        // Giải mã và kiểm tra chặt cấu trúc cursor — không tin tưởng input client.
        const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))
        if (!decoded || typeof decoded.createdAt !== 'string' || !Number.isFinite(Date.parse(decoded.createdAt)) || typeof decoded.id !== 'string' || !/^[a-f0-9]{24}$/i.test(decoded.id)) throw new Error('invalid cursor')
        cursor = decoded
      } catch {
        throw new AuthError(422, 'validation_error', 'Cursor is invalid')
      }
    }
    const rows = await repository.listUsers({ limit: limit + 1, status: query?.status, emailNormalized: query?.email?.trim().toLowerCase(), cursor })
    // Dư đúng 1 dòng nghĩa là còn trang sau: cắt bớt và sinh nextCursor từ bản ghi cuối.
    const hasNext = rows.length > limit
    const users = hasNext ? rows.slice(0, limit) : rows
    const last = users.at(-1)
    const nextCursor = hasNext && last ? Buffer.from(JSON.stringify({ createdAt: new Date(last.createdAt).toISOString(), id: last.id })).toString('base64url') : null
    return { users, hasNext, nextCursor }
  }

  /** Xem chi tiết một user (chỉ admin) — trả DTO admin có `updatedAt`. */
  async function getAdminUser({ auth, userId } = {}) {
    await requireLiveAdmin(auth)
    const targetId = requireAdminTargetId(userId)
    const user = await repository.findUserById(targetId)
    if (!user) throw new AuthError(404, 'not_found', 'User not found')
    return serializeAdminUser(user)
  }

  /**
   * Đổi trạng thái user (admin): `active` <-> `suspended`.
   * Ràng buộc: suspend phải kèm reasonCode `user_suspended`, restore kèm
   * `user_restored` — từ chối mọi transition lạ (vd suspend user đã suspended).
   *
   * Toàn bộ trong transaction: verify session admin, admission (rate limit
   * theo userId), cập nhật status, thu hồi MỌI session của user bị ảnh hưởng
   * (tăng `sessionVersion` khiến các session cũ mất hiệu lực) và ghi audit —
   * hoặc rollback toàn bộ nếu xảy ra conflict/race.
   */
  async function updateUserStatus({ auth, userId, status, reasonCode, csrfToken, request } = {}) {
    requireAdmin(auth)
    await verifyCsrf({ auth, token: csrfToken })
    const targetId = requireAdminTargetId(userId)
    if (!['active', 'suspended'].includes(status) || (status === 'active' && reasonCode !== 'user_restored') || (status === 'suspended' && reasonCode !== 'user_suspended')) throw new AuthError(422, 'validation_error', 'Status transition is invalid')
    const action = status === 'suspended' ? 'user_suspended' : 'user_restored'
    const stateTransition = { from: status === 'suspended' ? 'active' : 'suspended', to: status }
    const outcome = await inTransaction(async (session) => {
      if (repository.assertActiveSessionForUser && !(await repository.assertActiveSessionForUser({ sessionId: auth.session._id, userId: auth.user._id, sessionVersion: auth.session.userSessionVersion, role: 'admin' }, { session }))) throw new AuthError(401, 'unauthorized', 'Session is no longer active')
      const admission = await reserveAdmin(auth.user._id ?? auth.user.id, session)
      if (admission?.allowed === false) throw new AuthError(429, 'rate_limit_exceeded', 'Request rate limit exceeded', { retryAfter: admission.retryAfterSeconds })
      const updated = await repository.updateUserStatus(targetId, status, reasonCode, { session })
      // Repository báo conflict (vd user vừa bị đổi trạng thái ở nơi khác) —
      // thoát transaction sạch rồi trả 409 thay vì rollback nửa chừng.
      if (updated?.conflict) return { conflict: true }
      if (!updated) throw new AuthError(404, 'not_found', 'User not found')
      await repository.revokeSessionsByUserId(targetId, { session })
      await repository.insertAudit(createAuditEvent({ actor: auth.user, action, targetId, changedFields: ['status', 'sessionVersion'], reasonCode, stateTransition, request }), { session })
      return { user: serializeAdminUser(updated) }
    })
    if (outcome.conflict) {
      throw new AuthError(409, 'conflict', 'User status transition conflicts with current state')
    }
    return outcome.user
  }

  /**
   * Ánh xạ lỗi từ Google OAuth sang `AuthError` để HTTP layer xử lý thống nhất.
   * Lỗi không thuộc hai loại trên trả `null` (caller tự quyết định xử lý).
   */
  function mapGoogleOAuthError(error) {
    if (error instanceof GoogleOAuthError) return new AuthError(error.status, error.code, error.message)
    if (error instanceof AuthError) return error
    return null
  }

  /**
   * Ánh xạ lỗi repository: lỗi Mongo (network/not-primary/shard...) và các
   * error code đặc trưng của driver -> 503; mọi lỗi khác giữ nguyên để
   * framework log chi tiết. `AuthError` truyền nguyên trạng.
   */
  function mapRepositoryError(error) {
    if (error instanceof AuthError) return error
    if (error?.name?.startsWith('Mongo') || [6, 7, 89, 91, 189].includes(error?.code)) return new AuthError(503, 'service_unavailable', 'Authentication service is temporarily unavailable')
    return error
  }

  /**
   * Dựng Google OAuth service từ runtime config — các tham số được truyền dạng
   * TÊN env (clientIdEnv...) và service sẽ tự đọc từ `environment` mỗi lần gọi.
   * Nhờ đó giá trị env thay đổi giữa chừng (test) vẫn được phản ánh đúng.
   */
  function googleOAuthService() {
    return createGoogleOAuthService({
      clientIdEnv: runtime?.googleOAuth?.clientIdEnv,
      clientSecretEnv: runtime?.googleOAuth?.clientSecretEnv,
      redirectUriEnv: runtime?.googleOAuth?.redirectUriEnv,
      stateSecretEnv: runtime?.googleOAuth?.stateSecretEnv,
      values: environment,
    })
  }

  /**
   * Bước 1 luồng Google Login: sinh URL đăng nhập + state đã ký.
   * State được trả về để HTTP layer đặt vào cookie HttpOnly (ràng buộc trình
   * duyệt) — chỉ mình server biết, dùng để chống CSRF ở bước callback.
   */
  function generateGoogleAuthUrl() {
    const googleOAuth = googleOAuthService()
    const state = googleOAuth.createState()
    return { authUrl: googleOAuth.generateAuthUrl({ state }), state }
  }

  /**
   * Bước 2 luồng Google Login — xác minh state khi Google redirect về:
   * 1. `verifyState`: chữ ký HMAC + chưa hết hạn (state không bị giả mạo).
   * 2. Cookie phải tồn tại và KHỚP CHÍNH XÁC state trong query — ràng buộc
   *    callback đến từ chính trình duyệt đã khởi tạo luồng (chống CSRF login).
   * Nếu cookie khác state -> nghi vấn replay: trả 409 `oauth_state_replayed`.
   * Lỗi Google được ánh xạ sang AuthError; lỗi khác ném nguyên trạng.
   */
  function verifyGoogleState({ state, stateCookie } = {}) {
    const googleOAuth = googleOAuthService()
    try {
      googleOAuth.verifyState(state)
      if (typeof stateCookie !== 'string' || stateCookie.length === 0) throw new AuthError(403, 'oauth_state_invalid', 'OAuth state cookie is missing')
      if (stateCookie !== state) throw new AuthError(409, 'oauth_state_replayed', 'OAuth state has already been used')
    } catch (error) {
      const mapped = mapGoogleOAuthError(error)
      if (mapped) throw mapped
      throw error
    }
  }

  /**
   * Google Login hoàn chỉnh: state hợp lệ -> đổi code lấy user -> tìm/liên kết/tạo user.
   *
   * Luồng xử lý user:
   * - Tìm theo `googleSub` trước (identity key ổn định nhất).
   * - Chưa có -> tìm theo email; nếu email đã tồn tại phải có cùng `googleSub`
   *   (liên kết tường minh trước đó) nếu không báo `oauth_identity_conflict` —
   *   từ chối "chiếm" email của tài khoản password thuần.
   * - Chưa có gì -> tạo user mới với password hash "dummy" (không dùng được
   *   để đăng nhập password, tránh tạo tài khoản mật khẩu ẩn).
   *
   * Các trạng thái lạ của user theo googleSub (suspended/deletion) bị chặn.
   * User mới được tạo trong transaction cùng session + audit.
   */
  async function googleLogin({ code, state, stateCookie, request } = {}) {
    const googleOAuth = googleOAuthService()
    verifyGoogleState({ state, stateCookie })
    // Do not spend the shared login quota on cross-site callbacks that fail
    // the browser-bound state check before this point.
    await reserve('login', request)
    let googleUser
    try {
      googleUser = await googleOAuth.verifyGoogleUser(code)
    } catch (error) {
      const mapped = mapGoogleOAuthError(error)
      if (mapped) throw mapped
      throw new AuthError(502, 'oauth_provider_error', 'Google OAuth verification failed')
    }
    const emailNormalized = normalizeEmail(googleUser.email)
    // Định danh chính là `googleSub` — email chỉ là thông tin bổ trợ để liên kết.
    const existingBySubject = repository.findUserByGoogleSub ? await repository.findUserByGoogleSub(googleUser.sub) : null
    if (existingBySubject && (existingBySubject.emailNormalized !== emailNormalized || existingBySubject.status !== 'active')) {
      // Tài khoản của sub này đang không active hoặc email đã đổi sang sub khác
      // (Google không cho đổi sub) -> từ chối rõ ràng thay vì tạo user trùng.
      if (existingBySubject.status === 'suspended') throw new AuthError(403, 'forbidden', 'This account has been suspended')
      if (existingBySubject.status === 'deletion-pending' || existingBySubject.status === 'deleted') throw new AuthError(403, 'forbidden', 'This account has been suspended')
      throw new AuthError(409, 'oauth_identity_conflict', 'Google identity is linked to another account')
    }
    let user = existingBySubject
    if (!user) {
      const existingByEmail = await repository.findUserByEmail(emailNormalized)
      if (existingByEmail) {
        // Email đã có tài khoản password: chỉ cho phép nếu tài khoản đó đã được
        // liên kết Google (cùng sub) — không bao giờ tự ý chiếm email.
        if (existingByEmail.googleSub !== googleUser.sub) throw new AuthError(409, 'oauth_identity_conflict', 'Email account requires explicit Google linking')
        user = existingByEmail
      }
    }
    if (!user) {
      // User hoàn toàn mới: tạo kèm googleSub + password hash dummy.
      return inTransaction(async (session) => {
        try {
          user = await repository.createUser({ emailNormalized, emailDisplay: googleUser.email, passwordHash: await hashPassword(`oauth-dummy:${randomBytes(32).toString('base64url')}`), passwordEnabled: false, role: 'user', status: 'active', topicPreferences: [], topicPreferenceIds: [], topicPreferenceTaxonomyVersion: TOPIC_TAXONOMY_VERSION, sessionVersion: 0, googleSub: googleUser.sub }, { session })
        } catch (error) {
          // Race: hai request OAuth đồng thời cùng tạo — một bên trúng unique index.
          if (error?.code === 11000) throw new AuthError(409, 'conflict', 'Account already exists')
          throw error
        }
        const sessionData = await createSession(user, request, session, { googleAuthenticatedAt: clock() })
        await repository.insertAudit(createAuditEvent({ actor: user, action: 'google_oauth_registered', targetId: user._id, changedFields: ['status'], reasonCode: 'google_oauth_registered', request }), { session })
        return { user: serializeUser(user), ...sessionData }
      })
    }
    // User đã tồn tại (theo sub hoặc theo email đã liên kết): tạo session + audit.
    return inTransaction(async (session) => {
      const sessionData = await createSession(user, request, session, { googleAuthenticatedAt: clock() })
      await repository.insertAudit(createAuditEvent({ actor: user, action: 'google_oauth_login', targetId: user._id, reasonCode: 'google_oauth_login', request }), { session })
      return { user: serializeUser(user), ...sessionData }
    })
  }

  /**
   * Bọc mọi method public bằng `mapRepositoryError`: lỗi hạ tầng Mongo bị
   * chuẩn hoá thành 503 ngay tại biên service, các method gọi nhau bên trong
   * vẫn ném lỗi gốc để giữ nguyên ngữ nghĩa (chỉ map một lần ở biên ngoài).
   */
  const expose = (method) => async (...args) => {
    try { return await method(...args) } catch (error) { throw mapRepositoryError(error) }
  }
  return Object.freeze({
    register: expose(register), login: expose(login), authenticate: expose(authenticate), currentUser: expose(currentUser),
    verifyCsrf: expose(verifyCsrf), logout: expose(logout), updatePreferences: expose(updatePreferences), changePassword: expose(changePassword), listAdminUsers: expose(listAdminUsers),
    getAdminUser: expose(getAdminUser), updateUserStatus: expose(updateUserStatus), googleLogin: expose(googleLogin), verifyGoogleState: expose(verifyGoogleState), generateGoogleAuthUrl,
  })
}

// Export helper dùng chung cho các module khác (route serializer, test...).
export { normalizeEmail, serializeUser, serializeAdminUser }
