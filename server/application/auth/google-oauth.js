  import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Dịch vụ Google OAuth 2.0 theo luồng Authorization Code + UserInfo.
 *
 * Module này chịu trách nhiệm toàn bộ phần "giao tiếp với Google":
 * - Sinh URL đăng nhập cùng state có chữ ký HMAC (chống CSRF/replay).
 * - Trao đổi authorization code lấy access token (chỉ gọi từ server).
 * - Lấy và kiểm tra thông tin người dùng từ endpoint userinfo.
 *
 * Đặc điểm bảo mật:
 * - Mọi lỗi từ nhà cung cấp đều được chuẩn hoá về `GoogleOAuthError`
 *   (status/code cố định) — không trả payload thô của Google lên API layer.
 * - Không lưu token, secret hay thông tin nhạy cảm vào log/DB.
 * - Toàn bộ input từ Google được coi là untrusted data và được kiểm tra
 *   định dạng/độ dài trước khi dùng.
 */

// Endpoint phục vụ màn hình đồng ý (consent screen) của Google.
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
// Endpoint trao đổi authorization code -> access token (chỉ gọi từ server, không bao giờ lộ client secret cho trình duyệt).
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
// Endpoint lấy profile người dùng bằng access token (header Bearer).
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo'
// Chỉ chấp nhận tài khoản Gmail (@gmail.com).
const GMAIL_DOMAIN = 'gmail.com'
// Thời gian sống của state: 10 phút — đủ cho vòng redirect của trình duyệt, đủ ngắn để thu hẹp cửa sổ tấn công replay.
const STATE_TTL_SECONDS = 10 * 60
// Định dạng state: <epochSeconds>.<nonceBase64url>.<signatureBase64url>.
const STATE_PATTERN = /^[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
// `sub` (hoặc `id`) của Google chỉ gồm ký tự an toàn, tối đa 255 ký tự.
const SUBJECT_PATTERN = /^[A-Za-z0-9._-]{1,255}$/
// Giới hạn thời gian chờ mỗi request HTTP đi Google (5 giây mặc định).
const DEFAULT_TIMEOUT_MS = 5_000
// Giới hạn kích thước input nhận từ client/provider để chặn payload khổng lồ.
const MAX_AUTH_CODE_LENGTH = 2_048
const MAX_ACCESS_TOKEN_LENGTH = 4_096
const MAX_EMAIL_LENGTH = 254
const MAX_NAME_LENGTH = 256
const MAX_PICTURE_LENGTH = 2_048

/**
 * Lỗi chuẩn hoá của Google OAuth.
 *
 * Mọi lỗi trong module này đều ném ra đối tượng `GoogleOAuthError` thay vì
 * lỗi gốc (network error, JSON parse error...) để lớp controller/service bên
 * trên có thể ánh xạ 1-1 sang error envelope chuẩn của OpenAPI mà không cần
 * hiểu chi tiết bên trong Google.
 *
 * - `status`: HTTP status nên trả về (4xx cho lỗi phía client, 5xx cho lỗi hạ tầng).
 * - `code`: mã lỗi ổn định (machine-readable), dùng trong response API.
 */
export class GoogleOAuthError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'GoogleOAuthError'
    this.status = status
    this.code = code
  }
}

/**
 * Giải quyết client id theo thứ tự ưu tiên:
 * giá trị cấu hình trực tiếp (test) -> biến môi trường (production).
 * Trả về `undefined` nếu không có nguồn nào được cấu hình.
 */
function resolveClientId(clientId, clientIdEnv, values) {
  if (clientId) return clientId
  if (clientIdEnv && values[clientIdEnv]) return values[clientIdEnv]
  return undefined
}

/**
 * Giải quyết client secret theo cùng quy tắc ưu tiên như `resolveClientId`.
 * Client secret chỉ được dùng ở phía server cho request tới token endpoint.
 */
function resolveClientSecret(clientSecret, clientSecretEnv, values) {
  if (clientSecret) return clientSecret
  if (clientSecretEnv && values[clientSecretEnv]) return values[clientSecretEnv]
  return undefined
}

/**
 * Giải quyết và kiểm tra state secret dùng để ký state.
 *
 * Yêu cầu tối thiểu 32 bytes UTF-8 — đủ dài để chống brute-force chữ ký HMAC.
 * Nếu secret chưa được cấu hình, trả 503 để không vô tình tạo state
 * "an toàn giả" bằng secret rỗng.
 */
function resolveSecret(secret, secretEnv, values) {
  const resolved = secret || (secretEnv && values[secretEnv])
  if (typeof resolved !== 'string' || Buffer.byteLength(resolved, 'utf8') < 32) {
    throw new GoogleOAuthError(503, 'service_unavailable', 'Google OAuth state secret is not configured')
  }
  return resolved
}

/** Kiểm tra một giá trị "thời điểm hiện tại" có hợp lệ (dùng cho việc inject clock trong test). */
function validDate(now) {
  return now instanceof Date && Number.isFinite(now.getTime())
}

/**
 * Kiểm tra chuỗi bắt buộc (non-empty, không vượt độ dài tối đa).
 * Dùng cho mọi field nhận từ Google — dữ liệu nguồn là untrusted.
 */
function boundedString(value, maximum, code = 'invalid_user_info') {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new GoogleOAuthError(422, code, 'Google user information is invalid')
  }
  return value
}

/** Giống `boundedString` nhưng cho phép giá trị rỗng/khuyết (null) — dùng cho field optional. */
function optionalBoundedString(value, maximum) {
  if (value === undefined || value === null) return null
  return boundedString(value, maximum)
}

/**
 * Ghép payload state: `<thời điểm hết hạn (epoch giây)>.<nonce>`.
 * Phần chữ ký được nối vào sau bởi `createState`.
 */
function signedStatePayload(expiresAt, nonce) {
  return `${expiresAt}.${nonce}`
}

/** Tính chữ ký HMAC-SHA256 của payload state, mã hoá base64url (không có padding `=`). */
function stateSignature(payload, secret) {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url')
}

/**
 * So sánh an toàn (constant-time) giữa chữ ký nhận được và chữ ký kỳ vọng.
 *
 * Ngoài `timingSafeEqual`, hàm còn từ chối base64url không chuẩn: giải mã rồi
 * mã hoá lại khác chuỗi gốc nghĩa là chữ ký đã bị sửa trailing bits — nếu chỉ
 * so sánh bytes giải mã, một chữ ký bị biến đổi tương đương vẫn có thể lọt qua.
 */
function sameSecretValue(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false
  let receivedBuffer
  let expectedBuffer
  try {
    receivedBuffer = Buffer.from(received, 'base64url')
    expectedBuffer = Buffer.from(expected, 'base64url')
  } catch {
    return false
  }
  // Reject non-canonical base64url aliases. Comparing decoded bytes alone
  // would allow a modified signature with equivalent trailing bits.
  if (receivedBuffer.toString('base64url') !== received || expectedBuffer.toString('base64url') !== expected) return false
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer)
}

/**
 * Dựng lỗi state với HTTP status phù hợp:
 * - State bị dùng lại (replayed) -> 409 Conflict (xung đột trạng thái).
 * - Các lỗi state khác (sai định dạng/chữ ký) -> 403 Forbidden.
 */
function stateError(code, message) {
  return new GoogleOAuthError(code === 'oauth_state_replayed' ? 409 : 403, code, message)
}

/**
 * Factory tạo dịch vụ Google OAuth với dependency injection đầy đủ.
 *
 * @param {object} [options]
 * @param {string} [options.clientId]            Client ID cấu hình trực tiếp (dùng trong test).
 * @param {string} [options.clientIdEnv]         Tên env chứa Client ID (production).
 * @param {string} [options.clientSecret]        Client secret trực tiếp (test).
 * @param {string} [options.clientSecretEnv]     Tên env chứa client secret (production).
 * @param {string} [options.redirectUri]         Redirect URI trực tiếp (test).
 * @param {string} [options.redirectUriEnv]      Tên env chứa redirect URI.
 * @param {string} [options.stateSecret]         State secret trực tiếp (test).
 * @param {string} [options.stateSecretEnv]      Tên env chứa state secret.
 * @param {object} [options.values=process.env]  Nguồn giá trị env (inject để test).
 * @param {Function} [options.now]               Nguồn thời gian hiện tại (inject để test).
 * @param {Function} [options.randomBytesImpl]   Nguồn ngẫu nhiên (inject để test).
 * @param {Function} [options.fetchImpl]         Hàm fetch đi Google (mặc định global fetch).
 * @param {number} [options.timeoutMs=5000]      Thời gian chờ mỗi request HTTP (1..60000ms).
 * @param {number} [options.stateTtlSeconds=600] TTL của state (60..900 giây).
 *
 * Các giá trị cấu hình được ưu tiên: giá trị trực tiếp -> giá trị từ env —
 * nhờ đó test có thể inject giá trị mà không cần đụng biến môi trường thật.
 */
export function createGoogleOAuthService({
  clientId,
  clientIdEnv,
  clientSecret,
  clientSecretEnv,
  redirectUri,
  redirectUriEnv,
  stateSecret,
  stateSecretEnv,
  values = process.env,
  now = () => new Date(),
  randomBytesImpl = randomBytes,
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  stateTtlSeconds = STATE_TTL_SECONDS,
} = {}) {
  // Validate cấu hình ngay khi khởi tạo (fail fast) thay vì để lỗi xuất hiện giữa luồng đăng nhập.
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Google OAuth timeout is invalid')
  if (!Number.isInteger(stateTtlSeconds) || stateTtlSeconds < 60 || stateTtlSeconds > 900) throw new Error('Google OAuth state TTL is invalid')

  /** Lấy client ID đã resolve; ném 503 nếu chưa cấu hình (OAuth là tính năng optional). */
  function getClientId() {
    const resolved = resolveClientId(clientId, clientIdEnv, values)
    if (!resolved) throw new GoogleOAuthError(503, 'service_unavailable', 'Google OAuth is not configured')
    return resolved
  }

  /** Lấy client secret đã resolve; client secret KHÔNG bao giờ được gửi xuống trình duyệt. */
  function getClientSecret() {
    const resolved = resolveClientSecret(clientSecret, clientSecretEnv, values)
    if (!resolved) throw new GoogleOAuthError(503, 'service_unavailable', 'Google OAuth is not configured')
    return resolved
  }

  /**
   * Lấy redirect URI đã đăng ký với Google. Phải khớp chính xác giá trị khai
   * báo trong Google Cloud Console, nếu không Google sẽ từ chối authorization code.
   */
  function getRedirectUri() {
    const resolved = redirectUri || (redirectUriEnv && values[redirectUriEnv])
    if (!resolved) throw new GoogleOAuthError(503, 'service_unavailable', 'Google OAuth redirect URI is not configured')
    return resolved
  }

  /** Lấy state secret đã được kiểm tra độ dài tối thiểu. */
  function getStateSecret() {
    return resolveSecret(stateSecret, stateSecretEnv, values)
  }

  /**
   * Tạo state mới: `<epochExpiry>.<nonce>.<signature>`.
   * - `expiresAt`: thời điểm hết hạn (epoch giây) = now + TTL.
   * - `nonce`: 24 bytes ngẫu nhiên (192 bit) — nguồn entropy đủ cho chống đoán.
   * - `signature`: HMAC-SHA256 của `<expiresAt>.<nonce>` bằng state secret.
   *
   * State được gửi kèm query param khi redirect sang Google và được Google
   * trả về nguyên vẹn sau khi người dùng xác nhận — nhờ đó server xác minh
   * callback có thực sự bắt nguồn từ luồng đăng nhập do chính nó khởi tạo.
   */
  function createState() {
    const current = now()
    if (!validDate(current)) throw new GoogleOAuthError(503, 'service_unavailable', 'Google OAuth clock is unavailable')
    const expiresAt = Math.floor(current.getTime() / 1000) + stateTtlSeconds
    const nonce = randomBytesImpl(24).toString('base64url')
    const payload = signedStatePayload(expiresAt, nonce)
    return `${payload}.${stateSignature(payload, getStateSecret())}`
  }

  /**
   * Kiểm tra state do client gửi lại trong callback:
   * 1. Đúng định dạng `<epoch>.<nonce>.<signature>` và độ dài hợp lý.
   * 2. Chữ ký HMAC khớp (state không bị giả mạo/trao đổi giữa các user).
   * 3. Chưa hết hạn theo đồng hồ hiện tại.
   *
   * Mọi trường hợp vi phạm đều ném `GoogleOAuthError` (403/409) — không có
   * nhánh "fail-open". Trả về `{ expiresAt, nonce }` nếu hợp lệ.
   */
  function verifyState(state) {
    if (typeof state !== 'string' || state.length > 512 || !STATE_PATTERN.test(state)) throw stateError('oauth_state_invalid', 'OAuth state is invalid')
    const [expiresAtText, nonce, signature] = state.split('.')
    const expiresAt = Number(expiresAtText)
    if (!Number.isSafeInteger(expiresAt) || !nonce || !signature) throw stateError('oauth_state_invalid', 'OAuth state is invalid')
    const payload = signedStatePayload(expiresAt, nonce)
    const expected = stateSignature(payload, getStateSecret())
    if (!sameSecretValue(signature, expected)) throw stateError('oauth_state_invalid', 'OAuth state is invalid')
    const current = now()
    if (!validDate(current)) throw new GoogleOAuthError(503, 'service_unavailable', 'Google OAuth clock is unavailable')
    if (expiresAt <= Math.floor(current.getTime() / 1000)) throw stateError('oauth_state_expired', 'OAuth state has expired')
    return { expiresAt, nonce }
  }

  /**
   * Sinh URL đưa người dùng sang màn hình đồng ý của Google.
   * Luôn yêu cầu `response_type=code` (Authorization Code Flow) — tuyệt đối
   * không dùng implicit flow vì sẽ lộ access token trong URL/history.
   * `state` (nếu có) được gắn vào để Google trả về nguyên vẹn ở bước callback.
   */
  function generateAuthUrl({ state, scope = 'openid email profile' } = {}) {
    const params = new URLSearchParams({
      client_id: getClientId(),
      redirect_uri: getRedirectUri(),
      response_type: 'code',
      scope,
    })
    if (state) params.set('state', state)
    return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`
  }

  /**
   * Gọi HTTP tới Google có kiểm soát:
   * - Bọc bằng `AbortController` + timer `timeoutMs` để chặn request treo vô hạn.
   * - Hỗ trợ huỷ từ ngoài qua `signal` của caller (khi request HTTP gốc bị abort).
   * - Mọi lỗi (timeout, mạng, server 5xx...) đều chuẩn hoá thành
   *   `GoogleOAuthError` 502 — không để exception lạ lọt ra ngoài.
   */
  async function fetchProvider(url, init = {}, signal) {
    const request = fetchImpl ?? globalThis.fetch
    if (typeof request !== 'function') throw new GoogleOAuthError(502, 'oauth_provider_error', 'Google OAuth provider is unavailable')
    const controller = new globalThis.AbortController()
    const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs)
    const forwardAbort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener?.('abort', forwardAbort, { once: true })
    try {
      return await request(url, { ...init, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new GoogleOAuthError(502, 'oauth_provider_timeout', 'Google OAuth provider timed out')
      }
      throw new GoogleOAuthError(502, 'oauth_provider_error', 'Google OAuth provider is unavailable')
    } finally {
      // Luôn dọn timer và listener, kể cả khi request thành công hay thất bại.
      globalThis.clearTimeout(timer)
      signal?.removeEventListener?.('abort', forwardAbort)
    }
  }

  /**
   * Đọc JSON từ response của Google nhưng chỉ chấp nhận object (không phải array),
   * trả `null` nếu response không thành công (HTTP != 2xx).
   * Lỗi JSON hỏng vẫn ném 502 — dữ liệu provider không hợp lệ.
   */
  async function parseProviderJson(response) {
    if (!response?.ok) return null
    try {
      const payload = await response.json()
      return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null
    } catch {
      throw new GoogleOAuthError(502, 'oauth_provider_error', 'Google OAuth provider returned invalid data')
    }
  }

  /**
   * Trao đổi authorization code lấy access token tại token endpoint.
   * Đây là bước duy nhất dùng client secret — request dạng
   * `application/x-www-form-urlencoded` theo đúng spec của Google.
   * Authorization code chỉ sống vài phút và dùng được đúng một lần.
   */
  async function exchangeCodeForTokens(code, { signal } = {}) {
    if (typeof code !== 'string' || code.length < 1 || code.length > MAX_AUTH_CODE_LENGTH) throw new GoogleOAuthError(422, 'validation_error', 'Authorization code is invalid')
    const body = new URLSearchParams({
      code,
      client_id: getClientId(),
      client_secret: getClientSecret(),
      redirect_uri: getRedirectUri(),
      grant_type: 'authorization_code',
    })
    const response = await fetchProvider(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, signal)
    if (!response?.ok) throw new GoogleOAuthError(401, 'invalid_oauth_code', 'Authorization code is invalid')
    const tokens = await parseProviderJson(response)
    // Chỉ giữ lại access token đã kiểm tra; phần còn lại của response (id_token, expires_in...)
    // được truyền tiếp nhưng không được dùng làm nguồn định danh người dùng.
    const accessToken = boundedString(tokens?.access_token, MAX_ACCESS_TOKEN_LENGTH, 'invalid_access_token')
    return { ...tokens, access_token: accessToken }
  }

  /**
   * Lấy thông tin người dùng từ endpoint userinfo bằng access token (Bearer).
   * Chỉ tin tưởng response HTTP 2xx; mọi response khác -> 401 (token lỗi/hết hạn).
   */
  async function getUserInfo(accessToken, { signal } = {}) {
    const token = boundedString(accessToken, MAX_ACCESS_TOKEN_LENGTH, 'invalid_access_token')
    const response = await fetchProvider(GOOGLE_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${token}` },
    }, signal)
    if (!response?.ok) throw new GoogleOAuthError(401, 'invalid_access_token', 'Google access token is invalid')
    const payload = await parseProviderJson(response)
    if (!payload) throw new GoogleOAuthError(422, 'invalid_user_info', 'Google user information is invalid')
    return payload
  }

  /**
   * Luồng chính: code -> token -> userinfo -> dữ liệu đã xác thực.
   *
   * Ràng buộc danh tính (quan trọng, không được nới lỏng):
   * - Email bắt buộc phải là Gmail (@gmail.com) và đã được Google xác thực.
   * - Identity key là `sub` (subject ổn định của Google), KHÔNG phải email —
   *   email có thể đổi chủ sở hữu còn `sub` thì không.
   * - `picture` phải là URL https không kèm username/password.
   *
   * Trả về `{ email, emailVerified: true, name, picture, sub }` — đã chuẩn hoá
   * và kiểm tra toàn bộ, sẵn sàng cho repository tạo user.
   */
  async function verifyGoogleUser(code, { signal } = {}) {
    const tokens = await exchangeCodeForTokens(code, { signal })
    const userInfo = await getUserInfo(tokens.access_token, { signal })
    const email = boundedString(userInfo.email, MAX_EMAIL_LENGTH).trim().toLowerCase()
    // The v2 userinfo endpoint returns `id`; OIDC-compatible deployments may
    // return the equivalent stable `sub` claim. Accept either, but never use
    // an email address as the identity key.
    const sub = boundedString(userInfo.sub ?? userInfo.id, 255)
    if (!SUBJECT_PATTERN.test(sub)) throw new GoogleOAuthError(422, 'invalid_user_info', 'Google user information is invalid')
    // `verified_email` phải là boolean tường minh; nếu thiếu/sai kiểu -> từ chối.
    // Chỉ chấp nhận tài khoản đã verify để chặn đăng ký bằng email không kiểm soát được.
    if (typeof userInfo.verified_email !== 'boolean') throw new GoogleOAuthError(422, 'invalid_user_info', 'Google user information is invalid')
    if (!userInfo.verified_email) throw new GoogleOAuthError(422, 'unverified_email', 'Google email is not verified')
    if (!email.endsWith(`@${GMAIL_DOMAIN}`)) throw new GoogleOAuthError(422, 'non_gmail_address', 'Only Gmail addresses are supported')
    const name = optionalBoundedString(userInfo.name, MAX_NAME_LENGTH)
    const picture = optionalBoundedString(userInfo.picture, MAX_PICTURE_LENGTH)
    // Ảnh đại diện là dữ liệu từ nguồn ngoài -> chỉ chấp nhận URL https thuần
    // (không có thông tin đăng nhập nhúng) để tránh SSRF/credential leak về sau.
    if (picture) {
      try {
        const parsed = new URL(picture)
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('invalid picture')
      } catch {
        throw new GoogleOAuthError(422, 'invalid_user_info', 'Google user information is invalid')
      }
    }
    return { email, emailVerified: true, name, picture, sub }
  }

  // Đóng băng đối tượng trả về: các hàm bên trong chỉ đọc closure, không thể bị
  // gán đè từ ngoài — đảm bảo service luôn dùng đúng secret/cấu hình đã inject.
  return Object.freeze({
    generateAuthUrl,
    createState,
    verifyState,
    exchangeCodeForTokens,
    getUserInfo,
    verifyGoogleUser,
    /**
     * Kiểm tra nhanh (không ném lỗi) xem toàn bộ cấu hình OAuth đã đủ chưa:
     * client id, client secret, redirect URI và state secret >= 32 bytes.
     * Dùng để quyết định có bật/tắt luồng Google Login trong runtime hay không.
     */
    isConfigured() {
      const configuredStateSecret = stateSecret || (stateSecretEnv && values[stateSecretEnv])
      return Boolean(
        resolveClientId(clientId, clientIdEnv, values) &&
        resolveClientSecret(clientSecret, clientSecretEnv, values) &&
        (redirectUri || (redirectUriEnv && values[redirectUriEnv])) &&
        typeof configuredStateSecret === 'string' &&
        Buffer.byteLength(configuredStateSecret, 'utf8') >= 32,
      )
    },
  })
}

// Export hằng số dùng chung để module khác (test, bootstrap) tham chiếu.
export { GMAIL_DOMAIN, STATE_TTL_SECONDS }
