'use strict'

const { getDb, init: initDb } = require('../knexDatabase')
const { embed, cosine } = require('../../ai/embedder')

// How long a pod's local read cache may serve stale results before it
// re-reads the full embeddings table. Keeps search() as cheap as the
// original in-memory linear scan (no per-request DB round-trip) while still
// letting a pod pick up documents indexed by another pod within one TTL
// cycle. A write on this pod invalidates its own cache immediately, so this
// pod always sees its own writes right away.
const CACHE_TTL_MS = parseInt(process.env.EMBEDDING_CACHE_TTL_MS || '30000', 10)

function _json(val, fallback) { if (!val) return fallback; try { return JSON.parse(val) } catch { return fallback } }
function nowISO() { return new Date().toISOString() }

let _cache = { loadedAt: 0, index: {} }

function _stale() { return Date.now() - _cache.loadedAt > CACHE_TTL_MS }
function _invalidate() { _cache.loadedAt = 0 }

async function _reload() {
  const rows = await getDb()('embeddings').select()
  const index = {}
  for (const row of rows) {
    index[row.id] = {
      type: row.doc_type,
      title: row.title,
      text: row.preview,
      url: row.url,
      vector: _json(row.vector, []),
      updatedAt: row.updated_at,
    }
  }
  _cache = { loadedAt: Date.now(), index }
}

async function _ensureFresh() {
  if (_stale()) await _reload()
}

module.exports = {
  init: async () => { await initDb() },

  indexDoc: async (doc, type, url) => {
    if (!doc?.id) return
    const text = [doc.title, doc.description, doc.content, doc.scope, doc.notes]
      .filter(Boolean).join(' ').slice(0, 4000)
    const vector = await embed(text)
    if (!vector) return   // Ollama unavailable — skip silently

    const row = {
      id: doc.id,
      doc_type: type,
      title: doc.title || doc.name || doc.id,
      preview: text.slice(0, 200),
      url: url || null,
      vector: JSON.stringify(vector),
      updated_at: nowISO(),
    }
    const db = getDb()
    const existing = await db('embeddings').where('id', doc.id).first()
    if (existing) await db('embeddings').where('id', doc.id).update(row)
    else await db('embeddings').insert(row)
    _invalidate()
  },

  removeDoc: async (id) => {
    await getDb()('embeddings').where('id', id).del()
    _invalidate()
  },

  search: async (query, topK = 8, threshold = 0.50) => {
    const qVec = await embed(query)
    if (!qVec) return []

    await _ensureFresh()

    const scores = Object.entries(_cache.index).map(([id, doc]) => ({
      id, type: doc.type, title: doc.title, text: doc.text, url: doc.url,
      score: cosine(qVec, doc.vector),
    }))

    return scores
      .filter(r => r.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(r => ({ ...r, score: Math.round(r.score * 100) }))
  },

  reindexAll: async () => {
    const results = { indexed: 0, skipped: 0 }
    const self = module.exports

    async function indexMany(items, type, urlFn) {
      for (const item of items) {
        try {
          await self.indexDoc(item, type, urlFn(item))
          results.indexed++
        } catch { results.skipped++ }
      }
    }

    try {
      const storage = require('../../storage')
      const types = ['policy', 'procedure', 'record', 'guideline', 'template']
      for (const t of types) {
        const items = (await storage.getTemplates?.({ type: t })) || []
        await indexMany(items, 'Dokument', () => '#templates')
      }
    } catch {}

    try {
      const riskStore = require('../riskStore')
      await indexMany((await riskStore.getAll?.()) || [], 'Risiko', () => '#risks')
    } catch {}

    try {
      const goalsStore = require('../goalsStore')
      await indexMany((await goalsStore.getAll?.()) || [], 'Sicherheitsziel', () => '#goals')
    } catch {}

    try {
      const guidanceStore = require('../guidanceStore')
      await indexMany((await guidanceStore.getAll?.()) || [], 'Systemhandbuch', () => '#guidance')
    } catch {}

    try {
      const trainingStore = require('../trainingStore')
      await indexMany((await trainingStore.getAll?.()) || [], 'Schulung', () => '#training')
    } catch {}

    try {
      const assetStore = require('../assetStore')
      await indexMany((await assetStore.getAll?.()) || [], 'Asset', () => '#assets')
    } catch {}

    try {
      const supplierStore = require('../supplierStore')
      await indexMany((await supplierStore.getAll?.()) || [], 'Lieferant', () => '#suppliers')
    } catch {}

    try {
      const bcmStore = require('../bcmStore')
      await indexMany((await bcmStore.getBia?.()) || [], 'BCM-BIA', () => '#bcm')
      await indexMany((await bcmStore.getPlans?.()) || [], 'BCM-Plan', () => '#bcm')
    } catch {}

    return results
  },

  count: async () => {
    const { c } = await getDb()('embeddings').count('id as c').first()
    return Number(c)
  },
}
