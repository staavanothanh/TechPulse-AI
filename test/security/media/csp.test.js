import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy } from '../../../server/http/articles/content-security-policy.js'
import { createContentSecurityPolicyMiddleware } from '../../../server/http/articles/content-security-policy.js'

describe('media content security policy', () => {
  it('emits only exact reviewed HTTPS image hosts', () => {
    expect(contentSecurityPolicy(['CDN.Example.com', 'cdn.example.com', 'cdn.example.com.'])).toBe(
      "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' https://cdn.example.com https://img.vietqr.io",
    )
  })
  it('allows the exact VietQR donation image host without weakening other directives', () => {
    expect(contentSecurityPolicy()).toBe(
      "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' https://img.vietqr.io",
    )
  })

  it('fails closed for malformed or wildcard hosts without opening blanket HTTPS', () => {
    const policy = contentSecurityPolicy([
      '*.example.com',
      'https://evil.example.com',
      'http://evil.example.com',
      'https://user:pass@evil.example.com',
      'evil.example.com/path',
      'evil.example.com:443',
      'cdn.example.com.',
    ])

    expect(policy).toBe(
      "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' https://cdn.example.com https://img.vietqr.io",
    )
    expect(policy).not.toContain('https://evil.example.com')
    expect(policy).not.toContain('http://')
    expect(policy).not.toContain('*')
  })

  it('refreshes exact hosts when the deployed host provider changes', () => {
    let hosts = ['cdn.example.com']
    let headerValue
    const response = {
      setHeader(name, value) {
        if (name === 'Content-Security-Policy') headerValue = value
      },
      writeHead() {
        return this
      },
    }
    const middleware = createContentSecurityPolicyMiddleware({ imageHosts: () => hosts })
    middleware({}, response, () => {})
    response.writeHead(200)
    expect(headerValue).toContain('https://cdn.example.com')
    hosts = ['media.example.com']
    response.writeHead(200)
    expect(headerValue).toContain('https://media.example.com')
    expect(headerValue).not.toContain('https://cdn.example.com')
  })
})
