const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo'
const GMAIL_DOMAIN = 'gmail.com'

export class GoogleOAuthError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'GoogleOAuthError'
    this.status = status
    this.code = code
  }
}

function resolveClientId(clientId, clientIdEnv, values) {
  if (clientId) return clientId
  if (clientIdEnv && values[clientIdEnv]) return values[clientIdEnv]
  return undefined
}

function resolveClientSecret(clientSecret, clientSecretEnv, values) {
  if (clientSecret) return clientSecret
  if (clientSecretEnv && values[clientSecretEnv]) return values[clientSecretEnv]
  return undefined
}

export function createGoogleOAuthService({
  clientId,
  clientIdEnv,
  clientSecret,
  clientSecretEnv,
  redirectUri,
  redirectUriEnv,
  values = process.env,
} = {}) {
  function getClientId() {
    const resolved = resolveClientId(clientId, clientIdEnv, values)
    if (!resolved) throw new GoogleOAuthError(503, 'service_unavailable', 'Google OAuth is not configured')
    return resolved
  }

  function getClientSecret() {
    const resolved = resolveClientSecret(clientSecret, clientSecretEnv, values)
    if (!resolved) throw new GoogleOAuthError(503, 'service_unavailable', 'Google OAuth is not configured')
    return resolved
  }

  function getRedirectUri() {
    const resolved = redirectUri || (redirectUriEnv && values[redirectUriEnv])
    if (!resolved) throw new GoogleOAuthError(503, 'service_unavailable', 'Google OAuth redirect URI is not configured')
    return resolved
  }

  function generateAuthUrl({ state, scope = 'openid email profile' }) {
    const params = new URLSearchParams({
      client_id: getClientId(),
      redirect_uri: getRedirectUri(),
      response_type: 'code',
      scope,
      access_type: 'offline',
      prompt: 'consent',
    })
    if (state) params.set('state', state)
    return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`
  }

  async function exchangeCodeForTokens(code) {
    const body = new URLSearchParams({
      code,
      client_id: getClientId(),
      client_secret: getClientSecret(),
      redirect_uri: getRedirectUri(),
      grant_type: 'authorization_code',
    })
    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!response.ok) {
      throw new GoogleOAuthError(401, 'invalid_oauth_code', 'Failed to exchange authorization code')
    }
    return response.json()
  }

  async function getUserInfo(accessToken) {
    const response = await fetch(GOOGLE_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      throw new GoogleOAuthError(401, 'invalid_access_token', 'Failed to fetch user info')
    }
    return response.json()
  }

  async function verifyGoogleUser(code) {
    const tokens = await exchangeCodeForTokens(code)
    if (!tokens.access_token) {
      throw new GoogleOAuthError(401, 'invalid_access_token', 'No access token received')
    }
    const userInfo = await getUserInfo(tokens.access_token)
    if (!userInfo.email) {
      throw new GoogleOAuthError(422, 'invalid_user_info', 'Email not provided by Google')
    }
    const email = userInfo.email.toLowerCase().trim()
    const isGmail = email.endsWith(`@${GMAIL_DOMAIN}`)
    const isVerified = userInfo.verified === true
    if (!isGmail) {
      throw new GoogleOAuthError(422, 'non_gmail_address', 'Only Gmail addresses are supported')
    }
    if (!isVerified) {
      throw new GoogleOAuthError(422, 'unverified_email', 'Google email is not verified')
    }
    return {
      email,
      emailVerified: isVerified,
      name: userInfo.name ?? null,
      picture: userInfo.picture ?? null,
      sub: userInfo.id,
    }
  }

  return Object.freeze({
    generateAuthUrl,
    exchangeCodeForTokens,
    getUserInfo,
    verifyGoogleUser,
    isConfigured() {
      return Boolean(resolveClientId(clientId, clientIdEnv, values) && resolveClientSecret(clientSecret, clientSecretEnv, values) && (redirectUri || (redirectUriEnv && values[redirectUriEnv])))
    },
  })
}

export { GMAIL_DOMAIN }
