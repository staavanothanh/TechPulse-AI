import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { QaView } from '../../../client/features/public/views/QaView.jsx'

function createHookRunner(component) {
  let hookIndex = 0
  const hooks = []
  const effectCleanups = []
  let pendingEffects = []
  let currentProps
  let latestResult

  const dispatcher = {
    useState(initial) {
      const index = hookIndex++
      if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
      const setState = (next) => {
        hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
        render()
      }
      return [hooks[index], setState]
    },
    useRef(initial) {
      const index = hookIndex++
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    useCallback(fn, deps) {
      const index = hookIndex++
      const previous = hooks[index]
      if (previous && deps && previous.deps.every((value, position) => Object.is(value, deps[position]))) return previous.fn
      hooks[index] = { fn, deps }
      return fn
    },
    useEffect(effect, deps) {
      const index = hookIndex++
      const previous = hooks[index]
      const changed = !previous || !deps || !previous.deps || !previous.deps.every((value, position) => Object.is(value, deps[position]))
      hooks[index] = { effect, deps }
      if (changed) pendingEffects.push({ index, effect })
    },
  }

  function render(props = currentProps) {
    currentProps = props
    hookIndex = 0
    pendingEffects = []
    const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
    const previousDispatcher = internals.H
    internals.H = dispatcher
    try {
      latestResult = component(props)
    } finally {
      internals.H = previousDispatcher
    }
    for (const { index, effect } of pendingEffects) {
      if (typeof effectCleanups[index] === 'function') effectCleanups[index]()
      const cleanup = effect()
      effectCleanups[index] = typeof cleanup === 'function' ? cleanup : undefined
    }
    return latestResult
  }

  return {
    render,
    get current() {
      return latestResult
    },
  }
}

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate)
      if (match) return match
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  return findElement(node.props?.children, predicate)
}

describe('QaView session deletion interaction', () => {
  it('deletes only the clicked session and stops event propagation', () => {
    const targetSession = { id: 'session-target', title: 'Phiên cần xóa', messageCount: 2 }
    const otherSession = { id: 'session-other', title: 'Phiên khác', messageCount: 1 }
    const onDeleteSession = vi.fn()
    const onSelectSession = vi.fn()
    const runner = createHookRunner(QaView)
    const tree = runner.render({
      sessions: [targetSession, otherSession],
      handlers: { onDeleteSession, onSelectSession },
    })

    const deleteButton = findElement(tree, (element) => element.type === 'button' && element.props?.className === 'public-session-delete')
    expect(deleteButton).not.toBeNull()

    const event = { stopPropagation: vi.fn() }
    deleteButton.props.onClick(event)

    expect(onDeleteSession).toHaveBeenCalledTimes(1)
    expect(onDeleteSession).toHaveBeenCalledWith(targetSession.id)
    expect(onSelectSession).not.toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
  })
})
