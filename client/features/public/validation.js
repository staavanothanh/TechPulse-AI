const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateCredentials(value = {}) {
  const email = typeof value.email === 'string' ? value.email.trim() : ''
  const password = typeof value.password === 'string' ? value.password : ''
  const errors = {}

  if (!email) errors.email = 'Nhập email.'
  else if (email.length > 254 || !EMAIL_PATTERN.test(email)) errors.email = 'Nhập email hợp lệ.'

  if (!password) errors.password = 'Nhập mật khẩu.'
  else if (password.length < 8) errors.password = 'Mật khẩu cần ít nhất 8 ký tự.'
  else if (password.length > 128) errors.password = 'Mật khẩu không được vượt quá 128 ký tự.'

  return { valid: Object.keys(errors).length === 0, errors }
}

export function normalizeAuthMode(mode) {
  return mode === 'register' ? 'register' : 'login'
}
