import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy } from '../../../server/http/articles/content-security-policy.js'
import { createContentSecurityPolicyMiddleware } from '../../../server/http/articles/content-security-policy.js'

describe('media content security policy', () => {
  it('emits only exact reviewed HTTPS image hosts', () => {
    expect(contentSecurityPolicy(['CDN.Example.com', 'cdn.example.com'])).toBe(
      "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' https://cdn.example.com",
    )
  })

  it('fails closed for malformed or wildcard hosts without opening blanket HTTPS', () => {
    const policy = contentSecurityPolicy(['*.example.com', 'https://evil.example.com', 'cdn.example.com'])

    expect(policy).toContain("img-src 'self' https://cdn.example.com")
    expect(policy).not.toContain('*')
    expect(policy).not.toContain('https:;')
    expect(policy).not.toContain('evil.example.com')
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
