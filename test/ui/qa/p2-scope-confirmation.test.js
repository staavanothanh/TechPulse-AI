import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import PublicApp, { QaView } from '../../../client/features/public/index.js'

const QUESTION = 'Các mô hình AI mới nhất đang được quan tâm thế nào?'
const PROPOSED_SCOPE = Object.freeze({ topics: ['ai'] })
const SCOPE_CONFIRMATION = Object.freeze({
  version: 'qa-scope-confirmation-v1',
  token: 'opaque-confirmation-token',
  scopeDigest: 'scope-digest-1',
  expiresAt: '2026-09-06T12:00:00.000Z',
})

function createHookRunner() {
  let hookIndex = 0
  const hooks = []
  const dispatcher = {
    useState(initial) {
      const index = hookIndex++
      if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], (next) => {
        hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
      }]
    },
    useRef(initial) {
      const index = hookIndex++
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    useCallback(fn) {
      hookIndex += 1
      return fn
    },
    useMemo(fn) {
      hookIndex += 1
      return fn()
    },
    useEffect() {
      hookIndex += 1
    },
    useLayoutEffect() {
      hookIndex += 1
    },
  }

  return {
    render(Component, props) {
      hookIndex = 0
      const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
      const previous = internals.H
      internals.H = dispatcher
      try {
        return Component(props)
      } finally {
        internals.H = previous
      }
    },
  }
}

function findElement(element, predicate) {
  if (!element || typeof element !== 'object') return null
  if (predicate(element)) return element
  const children = element.props?.children
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findElement(child, predicate)
      if (found) return found
    }
  } else if (children && typeof children === 'object') {
    return findElement(children, predicate)
  }
  return null
}

function expandTree(element) {
  if (element === null || element === undefined || typeof element === 'string' || typeof element === 'number') return element
  if (Array.isArray(element)) return element.map(expandTree)
  if (typeof element !== 'object') return null
  if (element.type === React.Fragment) return expandTree(element.props?.children)
  if (typeof element.type === 'function') return expandTree(createHookRunner().render(element.type, element.props))
  return {
    ...element,
    props: {
      ...element.props,
      children: expandTree(element.props?.children),
    },
  }
}

function textContent(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map(textContent).join('')
  return textContent(element.props?.children)
}

function findButton(tree, name) {
  return findElement(tree, (element) => {
    if (element.type !== 'button') return false
    return name.test(textContent(element))
  })
}

function renderQaElement(qa) {
  const app = PublicApp({
    session: { status: 'ready', user: { id: 'reader-qa', role: 'user', topicPreferences: [] } },
    route: 'qa',
    theme: 'light',
    api: { createGroundedAnswer: vi.fn() },
    csrfToken: 'csrf-token',
    qa,
  })
  return findElement(app, (element) => element.type === QaView)
}

describe('P2 Q&A scope confirmation contract', () => {
  it('previews a natural-language-only question without provider handoff, then confirms an exact versioned scope', () => {
    const providerApi = { createGroundedAnswer: vi.fn() }
    let qa = {
      state: 'empty',
      sessions: [],
      messages: [],
      scope: {},
      topics: ['AI'],
      scopeMode: 'natural-language',
      scopeProposal: null,
      scopeConfirmation: null,
      allowNaturalLanguageScope: true,
      onAsk: vi.fn((payload) => {
        if (payload.scopeMode !== 'preview') return
        qa = {
          ...qa,
          scopeMode: 'preview',
          scopeProposal: PROPOSED_SCOPE,
          scopeConfirmation: SCOPE_CONFIRMATION,
        }
      }),
      handlers: {
        onConfirmScope: vi.fn((payload) => providerApi.createGroundedAnswer(payload)),
      },
    }

    let qaElement = renderQaElement(qa)
    const runner = createHookRunner()
    let tree = runner.render(qaElement.type, qaElement.props)
    const questionInput = findElement(tree, (element) => element.type === 'textarea' && element.props.id === 'public-qa-question')
    const form = findElement(tree, (element) => element.type === 'form')
    questionInput.props.onChange({ target: { value: QUESTION } })
    tree = runner.render(qaElement.type, qaElement.props)
    const updatedForm = findElement(tree, (element) => element.type === 'form')

    updatedForm.props.onSubmit({ defaultPrevented: false, preventDefault: vi.fn() })

    expect.soft(providerApi.createGroundedAnswer).not.toHaveBeenCalled()
    expect.soft(qa.onAsk).toHaveBeenCalledWith({ question: QUESTION, scopeMode: 'preview' })

    qaElement = renderQaElement(qa)
    tree = expandTree(createHookRunner().render(qaElement.type, qaElement.props))
    const renderedText = textContent(tree)
    expect.soft(renderedText).toContain('Phạm vi đề xuất')
    expect.soft(renderedText).toContain('AI')

    const confirmButton = findButton(tree, /Xác nhận phạm vi/i)
    expect.soft(confirmButton).not.toBeNull()
    if (confirmButton) confirmButton.props.onClick()

    expect.soft(qa.handlers.onConfirmScope).toHaveBeenCalledWith({
      question: QUESTION,
      scopeMode: 'confirmed',
      scopeConfirmation: SCOPE_CONFIRMATION,
    })
    expect.soft(providerApi.createGroundedAnswer).toHaveBeenCalledTimes(1)
  })
})
