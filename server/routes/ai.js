// © 2026 Claude Hecker — ISMS Builder — AGPL-3.0
'use strict'
const express      = require('express')
const router       = express.Router()
const { requireAuth, authorize } = require('../auth')
const embeddingStore = require('../ai/embeddingStore')
const lexicalSearch  = require('../ai/lexicalSearch')
const auditStore     = require('../db/auditStore')

function aiEnabled() {
  try { return require('../db/orgSettingsStore').get().aiEnabled !== false } catch { return true }
}

function ollamaUrl() {
  try {
    const cfg = require('../db/orgSettingsStore').get()
    return (cfg.aiOllamaUrl && cfg.aiOllamaUrl.trim()) || process.env.OLLAMA_URL || 'http://localhost:11434'
  } catch { return process.env.OLLAMA_URL || 'http://localhost:11434' }
}

// ── GET /api/ai/search?q=...  ─────────────────────────────────────────────────
// Keyword-Suche funktioniert immer. Semantische Suche nur wenn KI aktiviert + Ollama erreichbar.
router.get('/api/ai/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim()
  if (!q) return res.json({ results: [] })

  // Semantische Suche nur wenn KI-Toggle aktiv UND Ollama erreichbar
  let semantic = false
  if (aiEnabled()) {
    try {
      const r = await fetch(ollamaUrl() + '/api/tags', { signal: AbortSignal.timeout(1500) })
      semantic = r.ok && (await embeddingStore.count()) > 0
    } catch {}
  }

  try {
    const results = semantic
      ? await embeddingStore.search(q)
      : await lexicalSearch.search(q)

    await auditStore.append({
      user:     req.user,
      action:   'ai_search',
      resource: 'ai',
      detail:   `Suche (${semantic ? 'semantisch' : 'Keyword'}): "${q}" → ${results.length} Treffer`,
    })
    res.json({ results, mode: semantic ? 'semantic' : 'keyword' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/ai/reindex  (admin only) ────────────────────────────────────────
router.post('/api/ai/reindex', requireAuth, authorize('admin'), async (req, res) => {
  if (!aiEnabled()) return res.status(503).json({ error: 'KI-Integration deaktiviert' })
  try {
    const stats = await embeddingStore.reindexAll()
    await auditStore.append({
      user:     req.user,
      action:   'ai_reindex',
      resource: 'ai',
      detail:   `Vektorindex neu aufgebaut: ${stats.indexed} indexiert, ${stats.skipped} übersprungen`,
    })
    res.json({ ok: true, ...stats })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/ai/status  ───────────────────────────────────────────────────────
// Status-Abfragen werden nicht geloggt (reines Monitoring, kein Datenzugriff)
router.get('/api/ai/status', requireAuth, async (req, res) => {
  const enabled = aiEnabled()
  let ollamaOk  = false
  if (enabled) {
    try {
      const r = await fetch(ollamaUrl() + '/api/tags', { signal: AbortSignal.timeout(2000) })
      ollamaOk = r.ok
    } catch {}
  }
  const indexed = await embeddingStore.count()
  res.json({
    enabled,
    ollama:   ollamaOk,
    model:    process.env.EMBED_MODEL || 'nomic-embed-text',
    indexed,
    mode:     enabled ? (ollamaOk && indexed > 0 ? 'semantic' : 'keyword') : 'disabled',
  })
})

module.exports = router
