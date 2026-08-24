const VIETQR_IMAGE_HOST = 'img.vietqr.io'
const MB_BANK_BIN = '970422'

export const DONATION_DETAILS = Object.freeze({
  bankName: 'MB Bank',
  bankId: MB_BANK_BIN,
  accountNumber: '0392375486',
  accountName: 'Tạ Văn Thành',
  transferContent: 'User TechPulse-AI gửi Admin ly coffee',
})

function asciiAccountName(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
}

export function buildVietQrImageUrl(details = DONATION_DETAILS) {
  const values = [details.bankId, details.accountNumber, details.accountName, details.transferContent]
  if (values.some((value) => typeof value !== 'string' || value.trim() === '')) throw new Error('Donation details are incomplete')
  const query = new URLSearchParams({
    addInfo: details.transferContent,
    accountName: asciiAccountName(details.accountName),
  })
  return `https://${VIETQR_IMAGE_HOST}/image/${encodeURIComponent(details.bankId)}-${encodeURIComponent(details.accountNumber)}-compact2.png?${query.toString()}`
}

export const DONATION_QR_URL = buildVietQrImageUrl()
