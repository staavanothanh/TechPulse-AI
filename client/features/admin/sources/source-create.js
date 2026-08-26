import { buildSourceCreateInput } from './source-form.js'

export const SOURCE_CREATE_ERROR = 'Không thể tạo source. Hãy kiểm tra dữ liệu và thử lại.'

export async function submitSourceCreate({ form, onSubmit, onClose, onError } = {}) {
  try {
    const response = await onSubmit(buildSourceCreateInput(form))
    if (response) onClose?.()
    return response
  } catch {
    onError?.(SOURCE_CREATE_ERROR)
    return null
  }
}
