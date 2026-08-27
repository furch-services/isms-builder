'use strict'

const bcrypt = require('bcryptjs')
const { getDb, init: initDb } = require('../knexDatabase')

const BCRYPT_ROUNDS = 12

function nowISO() { return new Date().toISOString() }
function makeId(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,6)}` }
function _json(val, fallback) { if (!val) return fallback; try { return JSON.parse(val) } catch { return fallback } }

// Full internal object (incl. passwordHash/totpSecret) — read directly on
// these fields by auth.js/2faSetup.js, matching the JSON-mode shape.
function rowToUser(row) {
  if (!row) return null
  return {
    username: row.username,
    email: row.email,
    domain: row.domain,
    role: row.role,
    functions: _json(row.functions, []),
    passwordHash: row.password_hash,
    totpSecret: row.totp_secret || '',
    totpVerified: !!row.totp_verified,
    sections: _json(row.sections, []),
  }
}

// Public view without passwordHash/totpSecret — matches getAllUsers() in JSON mode.
function rowToPublicUser(row) {
  return {
    username: row.username,
    email: row.email,
    sections: _json(row.sections, []),
    domain: row.domain,
    role: row.role,
    functions: _json(row.functions, []),
  }
}

async function seedIfEmpty(db) {
  const { c } = await db('rbac_users').count('id as c').first()
  if (Number(c) > 0) return

  // Identical seed data to server/rbacStore.js createSeed() — first-boot
  // behavior stays the same across every STORAGE_BACKEND.
  const now = nowISO()
  const seed = [
    { username: 'admin', email: 'admin@example.com', domain: 'Global', role: 'admin',
      functions: ['ciso', 'dso'], password: 'adminpass',
      sections: ['Guidance','Risk','Admin','Legal','Incident','Privacy','Training','Reports','Settings'] },
    { username: 'alice', email: 'alice@it.example', domain: 'IT', role: 'dept_head',
      functions: [], password: 'alicepass', sections: ['Guidance','Risk'] },
    { username: 'bob', email: 'bob@hr.example', domain: 'HR', role: 'reader',
      functions: [], password: 'bobpass', sections: [] },
  ]
  for (const u of seed) {
    await db('rbac_users').insert({
      id: makeId('user'),
      username: u.username,
      email: u.email,
      domain: u.domain,
      role: u.role,
      functions: JSON.stringify(u.functions),
      password_hash: bcrypt.hashSync(u.password, BCRYPT_ROUNDS),
      totp_secret: '',
      totp_enabled: false,
      totp_verified: false,
      sections: JSON.stringify(u.sections),
      created_at: now,
      updated_at: now,
    })
  }
}

module.exports = {
  init: async () => {
    await initDb()
    await seedIfEmpty(getDb())
  },

  verifyPassword: async (username, plaintext) => {
    const row = await getDb()('rbac_users').where('username', username).first()
    if (!row || !row.password_hash) return false
    return bcrypt.compare(plaintext, row.password_hash)
  },

  setPasswordHash: async (username, plaintext) => {
    const hash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS)
    const affected = await getDb()('rbac_users').where('username', username)
      .update({ password_hash: hash, updated_at: nowISO() })
    return affected > 0
  },

  getUserSections: async (username) => {
    const row = await getDb()('rbac_users').where('username', username).first()
    return row ? _json(row.sections, []) : []
  },

  setUserSections: async (username, sections) => {
    const db = getDb()
    const row = await db('rbac_users').where('username', username).first()
    const now = nowISO()
    if (!row) {
      // Auto-vivify like the JSON original: an unknown username gets a
      // placeholder record with an empty (validly-failing) password hash.
      await db('rbac_users').insert({
        id: makeId('user'), username, email: '', domain: 'Global', role: 'reader',
        functions: '[]', password_hash: '', totp_secret: '', totp_enabled: false,
        totp_verified: false, sections: JSON.stringify(sections),
        created_at: now, updated_at: now,
      })
      return { username, sections, domain: 'Global', role: 'reader' }
    }
    await db('rbac_users').where('username', username)
      .update({ sections: JSON.stringify(sections), updated_at: now })
    return { username, sections, domain: row.domain, role: row.role }
  },

  getAllUsers: async () => {
    const rows = await getDb()('rbac_users').select()
    return rows.map(rowToPublicUser)
  },

  getUserByUsername: async (username) => {
    const row = await getDb()('rbac_users').where('username', username).first()
    return rowToUser(row)
  },

  getUsernameByEmail: async (email) => {
    if (!email) return null
    const rows = await getDb()('rbac_users').select('username', 'email')
    const found = rows.find(r => (r.email || '').toLowerCase() === String(email).toLowerCase())
    return found ? found.username : null
  },

  getUsersByFunction: async (fn) => {
    const rows = await getDb()('rbac_users').select('username', 'email', 'role', 'functions')
    return rows
      .map(r => ({ username: r.username, email: r.email, role: r.role, functions: _json(r.functions, []) }))
      .filter(u => u.functions.includes(fn))
  },

  setUserTotpSecret: async (username, secret) => {
    const db = getDb()
    const row = await db('rbac_users').where('username', username).first()
    if (!row) return null
    const patch = { totp_secret: secret, updated_at: nowISO() }
    if (!secret) patch.totp_verified = false
    await db('rbac_users').where('username', username).update(patch)
    return { username, totpSecret: secret }
  },

  confirmTotpVerified: async (username) => {
    const affected = await getDb()('rbac_users').where('username', username)
      .update({ totp_verified: true, updated_at: nowISO() })
    return affected > 0
  },

  createUser: async ({ username, email, domain, role, functions, password }) => {
    const db = getDb()
    const existing = await db('rbac_users').where('username', username).first()
    if (existing) throw new Error('User already exists')
    const passwordHash = await bcrypt.hash(password || 'changeme', BCRYPT_ROUNDS)
    const now = nowISO()
    await db('rbac_users').insert({
      id: makeId('user'), username,
      email: email || '', domain: domain || 'Global', role: role || 'reader',
      functions: JSON.stringify(Array.isArray(functions) ? functions : []),
      password_hash: passwordHash, totp_secret: '', totp_enabled: false, totp_verified: false,
      sections: '[]', created_at: now, updated_at: now,
    })
    const row = await db('rbac_users').where('username', username).first()
    return rowToPublicUser(row)
  },

  updateUser: async (username, { email, domain, role, functions, password }) => {
    const db = getDb()
    const row = await db('rbac_users').where('username', username).first()
    if (!row) return null
    const patch = { updated_at: nowISO() }
    if (email     !== undefined) patch.email     = email
    if (domain    !== undefined) patch.domain    = domain
    if (role      !== undefined) patch.role      = role
    if (functions !== undefined) patch.functions = JSON.stringify(Array.isArray(functions) ? functions : [])
    if (password) patch.password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS)
    await db('rbac_users').where('username', username).update(patch)
    const updated = await db('rbac_users').where('username', username).first()
    return rowToPublicUser(updated)
  },

  deleteUser: async (username) => {
    const affected = await getDb()('rbac_users').where('username', username).del()
    return affected > 0
  },
}
