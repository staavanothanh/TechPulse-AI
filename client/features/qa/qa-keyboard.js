export function handleQaQuestionKeyDown(event, submit) {
  const isComposing = event?.isComposing || event?.nativeEvent?.isComposing
  const isImeEnter = event?.keyCode === 229 || event?.nativeEvent?.keyCode === 229
  if (event?.key !== 'Enter' || event.shiftKey || isComposing || isImeEnter) return false
  event.preventDefault()
  submit?.(event)
  return true
}
