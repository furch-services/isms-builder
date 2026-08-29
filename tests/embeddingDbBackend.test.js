'use strict'
// © 2026 Claude Hecker — ISMS Builder — AGPL-3.0
//
// Regression test for the embeddingStore dual-mode fix (Helm/Kubernetes
// groundwork): before this fix, server/ai/embeddingStore.js always kept its
// vector index in an in-memory object backed by a local JSON file, regardless
// of STORAGE_BACKEND — multiple pods would each build up their own,
// independent search index and never see documents indexed by another pod.
// This test therefore deliberately runs against a real SQL backend (default:
// sqlite, self-contained, part of `npm test`).
//
// For mariadb/pg specifically (same as tests/dbBackendRoutes.test.js):
//   DB_STORES_TEST_BACKEND=mariadb DB_HOST=... DB_PORT=... DB_USER=... DB_PASS=... DB_NAME=... npx jest tests/embeddingDbBackend.test.js --runInBand
//   DB_STORES_TEST_BACKEND=pg      DB_HOST=... DB_PORT=... DB_USER=... DB_PASS=... DB_NAME=... npx jest tests/embeddingDbBackend.test.js --runInBand
const BACKEND = (process.env.DB_STORES_TEST_BACKEND || 'sqlite').toLowerCase()
process.env.STORAGE_BACKEND = BACKEND
process.env.EMBEDDING_CACHE_TTL_MS = '50' // short TTL so the eventual-consistency test stays fast

const { createTestDataDir, removeTestDataDir } = require('./setup/testEnv')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Deterministic stand-in for embedder.embed() — no real Ollama instance needed,
// only cares that identical/similar text yields a similar vector.
function fakeEmbed(text) {
  const v = new Array(8).fill(0)
  for (const ch of text) v[ch.charCodeAt(0) % 8] += 1
  return v
}

describe(`embeddingStore dual mode [${BACKEND}]`, () => {
  let dataDir

  beforeAll(async () => {
    dataDir = createTestDataDir()
    process.env.DATA_DIR   = dataDir
    process.env.JWT_SECRET = 'jest-test-secret-embedding-db-backend'
    process.env.NODE_ENV   = 'test'

    const embedder = require('../server/ai/embedder')
    embedder.embed = async (text) => fakeEmbed(text)

    const app = require('../server/index.js')
    await app.bootstrap?.()
  })

  afterAll(async () => {
    if (BACKEND !== 'json') await require('../server/db/knexDatabase').destroy()
    removeTestDataDir(dataDir)
  })

  test('indexDoc → search round trip finds the indexed document', async () => {
    const embeddingStore = require('../server/ai/embeddingStore')
    await embeddingStore.indexDoc(
      { id: 'risk-round-trip', title: 'Ransomware risk', description: 'Attack on server' },
      'Risiko', '#risks',
    )
    const results = await embeddingStore.search('Ransomware server attack')
    expect(results.some(r => r.id === 'risk-round-trip')).toBe(true)
  })

  test('removeDoc actually removes the document from subsequent searches', async () => {
    const embeddingStore = require('../server/ai/embeddingStore')
    await embeddingStore.indexDoc(
      { id: 'risk-to-remove', title: 'Temporary risk', description: 'Will be removed' },
      'Risiko', '#risks',
    )
    await embeddingStore.removeDoc('risk-to-remove')
    const results = await embeddingStore.search('Temporary risk removed')
    expect(results.some(r => r.id === 'risk-to-remove')).toBe(false)
  })

  test('core proof: a second, independent Knex client (simulating a second pod) ' +
       'eventually sees a document indexed by client 1, within one cache TTL cycle', async () => {
    const embeddingStore1 = require('../server/ai/embeddingStore')
    await embeddingStore1.indexDoc(
      { id: 'doc-pod1', title: 'Pod 1 document', description: 'Indexed on the first pod' },
      'Dokument', '#templates',
    )

    // "Pod 2": a fully independent Knex connection + its own local TTL cache,
    // simulating a second pod process sharing the same database.
    delete require.cache[require.resolve('../server/db/knexDatabase')]
    delete require.cache[require.resolve('../server/db/stores/embeddingStore')]
    const knexDb2 = require('../server/db/knexDatabase')
    await knexDb2.init()
    const embeddingStore2 = require('../server/db/stores/embeddingStore')

    // Give the cache TTL a chance to elapse at least once.
    await sleep(150)

    const results = await embeddingStore2.search('Pod 1 document indexed')
    expect(results.some(r => r.id === 'doc-pod1')).toBe(true)
  })
})
