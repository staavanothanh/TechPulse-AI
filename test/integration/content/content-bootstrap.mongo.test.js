import { MongoClient } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertArticlesReady } from '../../../server/bootstrap/content.js'
import { ARTICLE_COLLECTIONS, ARTICLE_INDEXES, runArticlesMigration } from '../../../scripts/migrations/articles.js'
import { runAuthCoreMigration } from '../../../scripts/migrations/auth-core.js'
import { runDurableJobsMigration } from '../../../scripts/migrations/durable-jobs.js'
import { runSourcesMigration } from '../../../scripts/migrations/sources.js'

const hasMongo = Boolean(process.env.MONGODB_TEST_URI)
const describeMongo = hasMongo ? describe : describe.skip

describeMongo('Step 8 disposable Mongo content bootstrap readiness', () => {
  let client
  let db

  beforeAll(async () => {
    client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    db = client.db(`techpulse_step8_bootstrap_${Date.now()}_${Math.random().toString(16).slice(2)}`)
    await runAuthCoreMigration({ db })
    await runSourcesMigration({ db })
    await runDurableJobsMigration({ db })
    await runArticlesMigration({ db })
  })

  afterAll(async () => {
    if (db) await db.dropDatabase()
    if (client) await client.close()
  })

  it('fails closed against real Mongo when an exact article index or validator setting drifts', async () => {
    await expect(assertArticlesReady({ db, client })).resolves.toBeUndefined()
    await db.collection('articles').dropIndex('articles_search_text')
    await expect(assertArticlesReady({ db, client })).rejects.toThrow(/article indexes/i)
    const textIndex = ARTICLE_INDEXES.articles.find((index) => index.name === 'articles_search_text')
    await db.collection('articles').createIndex(textIndex.key, { ...textIndex.options, name: textIndex.name })
    await db.command({ collMod: 'articles', validator: ARTICLE_COLLECTIONS.articles.validator, validationLevel: 'moderate', validationAction: 'error' })
    await expect(assertArticlesReady({ db, client })).rejects.toThrow(/article validator/i)
  })
})
