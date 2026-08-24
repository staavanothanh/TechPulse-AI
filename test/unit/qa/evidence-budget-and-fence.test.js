import { createHash } from 'node:crypto'
import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { createQaService } from '../../../server/application/qa/service.js'
import { MongoChatRepository } from '../../../server/repositories/mongo/chat-repository.js'
import { evidenceCitationMetadataHash } from '../../../server/domain/qa/evidence.js'

const auth = {
  user: { id: 'user-1', status: 'active', sessionVersion: 3 },
  session: { id: 'session-1', userSessionVersion: 3 },
}

function qnaRecord(index, textLength = 2_400) {
  const articleId = `article-${index}`
  const sourceId = `source-${index}`
  return {
    article: {
      id: articleId,
      sourceId,
      titleOriginal: `Bài viết ${index}`,
      originalUrl: `https://example.com/articles/${index}`,
      publishedAt: '2026-08-10T00:00:00.000Z',
      excerptOriginal: `Đoạn trích ${index} ${'x'.repeat(textLength)}`,
      status: 'published',
      evidenceEligible: true,
      rightsSnapshot: { sourcePolicyVersion: 1, licenseStatus: 'permitted', llmInputScope: 'excerpt' },
    },
    source: {
      id: sourceId,
      name: `Nguồn ${index}`,
      authorityTier: 'editorial',
      operationalStatus: 'active',
      licenseStatus: 'permitted',
      policyVersion: 1,
      llmInputScope: 'excerpt',
      storageScope: { metadata: true, excerpt: true, summary: true, embedding: true },
      mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null },
      technicalCheck: { status: 'passed' },
    },
  }
}

function qaRepository(records) {
  const attempt = { _id: 'attempt-1', status: 'reserved' }
  return {
    attempt,
    reserveAnswerAttempt: vi.fn(async () => attempt),
    updateAnswerAttempt: vi.fn(async (_id, update) => Object.assign(attempt, update)),
    findQnaEvidence: vi.fn(async () => records),
    appendAnswer: vi.fn(async ({ answer }) => ({
      chatSessionId: 'chat-1',
      messageId: answer.id,
      answer: { ...answer, chatSessionId: 'chat-1' },
      attemptCommitted: true,
    })),
  }
}

describe('Q&A evidence budget and final fence', () => {
  it('keeps the aggregate provider prompt below 30,000 chars while retaining valid citation/block pairs', async () => {
    const records = Array.from({ length: 16 }, (_, index) => qnaRecord(index + 1))
    const repo = qaRepository(records)
    let generationInput
    let supportInput
    let generationAdmittedInput
    const answerProvider = vi.fn(async ({ input }) => {
      generationInput = input
      const firstBlock = /<evidence-block id="(E\d+)" citation="(C\d+)">/.exec(input)
      return {
        status: 'answered',
        paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: [firstBlock[2]], evidenceBlockIds: [firstBlock[1]] }],
      }
    })
    const supportProvider = vi.fn(async ({ input }) => {
      supportInput = input
      const admittedInput = JSON.parse(input)
      return {
        verdict: 'supported',
        addressesQuestion: true,
        evidenceBlockIds: admittedInput.evidenceBlocks.map(({ id }) => id),
      }
    })
    const providerRouter = {
      async execute({ workloadId, admittedInput, invoke, validateOutput }) {
        if (workloadId === 'qa-generation') generationAdmittedInput = admittedInput
        const route = { routeId: 'qa-primary', providerFailureDomainId: 'domain-a', model: 'qa-model' }
        const output = await invoke({ route, admittedInput })
        return { output: validateOutput({ route, output, admittedInput }) }
      },
    }
    const service = createQaService({
      chatRepository: repo,
      articleRepository: repo,
      providerRouter,
      providerAdapters: { llmProvider: { answer: answerProvider, verifySupport: supportProvider } },
    })

    const result = await service.createAnswer({
      auth,
      question: 'Các bài viết này kết luận gì?',
      scope: { topics: ['ai'] },
      idempotencyKey: 'evidence-budget-1',
    })

    expect(answerProvider).toHaveBeenCalledTimes(1)
    expect(supportProvider).toHaveBeenCalledTimes(1)
    expect.soft(generationInput.length).toBeLessThan(30_000)
    expect.soft(supportInput.length).toBeLessThan(30_000)

    const generationBlocks = [...generationInput.matchAll(/<evidence-block id="(E\d+)" citation="(C\d+)">/g)]
    expect(generationBlocks.length).toBeGreaterThan(1)
    expect(generationBlocks.map(([, blockId]) => blockId)).toEqual(generationBlocks.map((_, index) => `E${index + 1}`))
    expect(generationBlocks.map(([, , citationId]) => citationId)).toEqual(generationBlocks.map((_, index) => `C${index + 1}`))
    expect(generationBlocks.every(([, blockId, citationId]) => blockId.slice(1) === citationId.slice(1))).toBe(true)
    expect(new Set(generationAdmittedInput.prompt.citations.map(({ sourceId }) => sourceId)).size).toBeGreaterThan(1)
    expect(new Set([...generationInput.matchAll(/\[source=([^\]]+)\]/g)].map(([, name]) => name)).size).toBeGreaterThan(1)

    const supportPayload = JSON.parse(supportInput)
    expect(supportPayload.evidenceBlocks.map(({ id }) => id)).toEqual(['E1'])
    expect(supportPayload.evidenceBlocks.map(({ citationId }) => citationId)).toEqual(['C1'])
    expect(supportPayload.evidenceMap).toEqual({ E1: 'C1' })
    expect(result.answer).toMatchObject({
      status: 'answered',
      paragraphs: [{ citationIds: ['C1'] }],
      citations: [{ id: 'C1', articleId: 'article-1', sourceId: 'source-1' }],
    })
  })

  it('checks the final evidence fence with one internal token write per article and unique source', async () => {
    const now = new Date('2026-08-12T00:00:00.000Z')
    const userId = new ObjectId('507f1f77bcf86cd799439021')
    const sessionId = new ObjectId('507f1f77bcf86cd799439022')
    const articleId = new ObjectId('507f1f77bcf86cd799439024')
    const secondArticleId = new ObjectId('507f1f77bcf86cd799439026')
    const sourceId = new ObjectId('507f1f77bcf86cd799439025')
    const article = {
      _id: articleId,
      sourceId,
      version: 1,
      status: 'published',
      evidenceEligible: true,
      titleOriginal: 'Bài viết',
      excerptOriginal: 'Nội dung',
      originalUrl: 'https://example.com/article',
      publishedAt: now,
      rightsSnapshot: { sourcePolicyVersion: 1, licenseStatus: 'permitted', llmInputScope: 'excerpt' },
    }
    const secondArticle = {
      ...article,
      _id: secondArticleId,
      titleOriginal: 'Bài viết thứ hai',
      excerptOriginal: 'Nội dung thứ hai',
      originalUrl: 'https://example.com/article-2',
    }
    const source = {
      _id: sourceId,
      name: 'Nguồn biên tập',
      authorityTier: 'editorial',
      operationalStatus: 'active',
      licenseStatus: 'permitted',
      policyVersion: 1,
      llmInputScope: 'excerpt',
      storageScope: { metadata: true, excerpt: true, summary: true, embedding: true },
      mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null },
      technicalCheck: { status: 'passed' },
    }
    const writes = []
    let chatDocument
    const articles = new Map([[articleId.toHexString(), article], [secondArticleId.toHexString(), secondArticle]])
    const collections = new Map()
    const collection = (name) => {
      if (collections.has(name)) return collections.get(name)
      const value = {
        findOne: vi.fn(async (filter = {}) => {
          if (name === 'users') return { _id: userId }
          if (name === 'sessions') return { _id: sessionId }
          if (name === 'articles') return articles.get(filter._id?.toHexString?.())
          if (name === 'sources') return source
          if (name === 'chatSessions') return chatDocument ?? null
          return null
        }),
        updateOne: vi.fn(async (filter, update) => {
          writes.push({ name, filter, update })
          return { matchedCount: 1 }
        }),
        insertOne: vi.fn(async (document) => {
          if (name === 'chatSessions') chatDocument = document
          return { acknowledged: true, insertedId: document._id }
        }),
        findOneAndUpdate: vi.fn(async (filter, update) => {
          if (name === 'chatSessions') {
            chatDocument = {
              ...chatDocument,
              messages: [...chatDocument.messages, ...update.$push.messages.$each],
              messageCount: chatDocument.messageCount + update.$inc.messageCount,
              ...update.$set,
            }
            return { value: chatDocument }
          }
          if (name === 'articles') {
            writes.push({ name, filter, update })
            const current = articles.get(filter._id?.toHexString?.())
            return { value: current ? { ...current, qnaFenceToken: update.$set?.qnaFenceToken } : null }
          }
          if (name === 'sources') {
            writes.push({ name, filter, update })
            return { value: { ...source, qnaFenceToken: update.$set?.qnaFenceToken } }
          }
          return { value: null }
        }),
      }
      collections.set(name, value)
      return value
    }
    const session = {
      withTransaction: async (work) => work(session),
      endSession: vi.fn(async () => undefined),
    }
    const repository = new MongoChatRepository({
      db: { collection },
      client: { startSession: () => session },
      now: () => now,
    })

    await repository.appendAnswer({
      actor: { userId, actorFence: { sessionId, sessionVersion: 1 } },
      scope: { articleId: articleId.toHexString() },
      question: 'Kết luận là gì?',
      answer: { id: 'answer-fence', status: 'answered', paragraphs: [{ text: 'Có căn cứ.', citationIds: ['C1', 'C2'] }] },
      citations: [
        { id: 'C1', status: 'available', articleId, sourceId, originalUrl: 'https://example.com/article', titleOriginal: 'Bài viết', publishedAt: now },
        { id: 'C2', status: 'available', articleId: secondArticleId, sourceId, originalUrl: 'https://example.com/article-2', titleOriginal: 'Bài viết thứ hai', publishedAt: now },
      ],
      expectedEvidenceFence: {
        articles: [
          {
            articleId: articleId.toHexString(),
            sourceId: sourceId.toHexString(),
            articleVersion: 1,
            sourcePolicyVersion: 1,
            evidenceTextHash: createHash('sha256').update('Bài viết\nNội dung').digest('hex'),
            citationMetadataHash: evidenceCitationMetadataHash(article, source),
          },
          {
            articleId: secondArticleId.toHexString(),
            sourceId: sourceId.toHexString(),
            articleVersion: 1,
            sourcePolicyVersion: 1,
            evidenceTextHash: createHash('sha256').update('Bài viết thứ hai\nNội dung thứ hai').digest('hex'),
            citationMetadataHash: evidenceCitationMetadataHash(secondArticle, source),
          },
        ],
      },
      now,
    })

    expect(collections.get('articles').findOneAndUpdate).toHaveBeenCalled()
    expect(collections.get('sources').findOneAndUpdate).toHaveBeenCalled()
    const fenceWrites = writes.filter(({ name }) => name === 'articles' || name === 'sources')
    expect(fenceWrites).toHaveLength(3)
    expect(fenceWrites.filter(({ name }) => name === 'articles')).toHaveLength(2)
    expect(fenceWrites.filter(({ name }) => name === 'sources')).toHaveLength(1)
    expect(fenceWrites.every(({ update }) => !Object.hasOwn(update.$set ?? {}, 'updatedAt'))).toBe(true)
    expect(fenceWrites.every(({ update }) => update.$set?.qnaFenceToken instanceof ObjectId)).toBe(true)
    expect(chatDocument.messageCount).toBe(2)
  })
})
