// © 2026 Claude Hecker — ISMS Builder V 1.29 — AGPL-3.0
// Simple JSON-file based store for per-user section permissions (RBAC admin)
const fs = require('fs')
const path = require('path')
const bcrypt = require('bcryptjs')

const DB_ROOT = process.env.DATA_DIR || path.join(__dirname, '../data')
const DB_FILE = path.join(DB_ROOT, 'rbac_users.json')

const BCRYPT_ROUNDS = 12

function ensureDir() {
  if (!fs.existsSync(DB_ROOT)) fs.mkdirSync(DB_ROOT, { recursive: true })
}

function createSeed() {
  // Default-Passwörter werden gehasht gespeichert.
  // WICHTIG: Diese Passwörter müssen nach dem ersten Start geändert werden!
  return {
    admin: {
      username: 'admin',
      email: 'admin@example.com',
      domain: 'Global',
      role: 'admin',
      functions: ['ciso', 'dso'],
      passwordHash: bcrypt.hashSync('adminpass', BCRYPT_ROUNDS),
      totpSecret: '',
      sections: ['Guidance','Risk','Admin','Legal','Incident','Privacy','Training','Reports','Settings']
    },
    alice: {
      username: 'alice',
      email: 'alice@it.example',
      domain: 'IT',
      role: 'dept_head',
      functions: [],
      passwordHash: bcrypt.hashSync('alicepass', BCRYPT_ROUNDS),
      totpSecret: '',
      sections: ['Guidance','Risk']
    },
    bob: {
      username: 'bob',
      email: 'bob@hr.example',
      domain: 'HR',
      role: 'reader',
      functions: [],
      passwordHash: bcrypt.hashSync('bobpass', BCRYPT_ROUNDS),
      totpSecret: '',
      sections: []
    }
  }
}

function loadUsers() {
  ensureDir()
  if (!fs.existsSync(DB_FILE)) {
    const seed = createSeed()
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2))
    return seed
  }
  const raw = fs.readFileSync(DB_FILE, 'utf8')
  try { return JSON.parse(raw) } catch { return {} }
}

function saveUsers(data) {
  ensureDir()
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2))
}

let USERS = loadUsers()

// Passwort eines Benutzers prüfen (async, bcrypt)
async function verifyPassword(username, plaintext) {
  const u = USERS[username]
  if (!u || !u.passwordHash) return false
  return bcrypt.compare(plaintext, u.passwordHash)
}

// Passwort-Hash setzen (z.B. nach Passwortänderung)
async function setPasswordHash(username, plaintext) {
  const hash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS)
  if (!USERS[username]) return false
  USERS[username].passwordHash = hash
  saveUsers(USERS)
  return true
}

function getUserSections(username) {
  return (USERS[username] && USERS[username].sections) || []
}

function setUserSections(username, sections) {
  const u = USERS[username] || { username, domain: 'Global', role: 'reader' }
  const updated = { ...u, username, sections }
  USERS[username] = updated
  saveUsers(USERS)
  return { username, sections, domain: updated.domain, role: updated.role }
}

function getAllUsers() {
  // passwordHash wird NICHT nach außen gegeben
  return Object.values(USERS).map(u => ({
    username: u.username,
    email: u.email,
    sections: u.sections || [],
    domain: u.domain,
    role: u.role,
    functions: u.functions || []
  }))
}

function getUserByUsername(username) {
  return USERS[username] || null
}

function getUsernameByEmail(email) {
  if (!email) return null
  const found = Object.values(USERS).find(
    u => (u.email || '').toLowerCase() === String(email).toLowerCase()
  )
  return found ? found.username : null
}

// Secret speichern (unverified) — wird von 2faSetup.js aufgerufen
function setUserTotpSecret(username, secret) {
  if (!USERS[username]) return null
  USERS[username].totpSecret = secret
  // Secret leeren → auch verified-Flag zurücksetzen
  if (!secret) USERS[username].totpVerified = false
  saveUsers(USERS)
  return { username, totpSecret: secret }
}

// 2FA als verifiziert markieren — erst nach erfolgreichem Code-Check
function confirmTotpVerified(username) {
  if (!USERS[username]) return false
  USERS[username].totpVerified = true
  saveUsers(USERS)
  return true
}

async function createUser({ username, email, domain, role, functions, password }) {
  if (USERS[username]) throw new Error('User already exists')
  const passwordHash = await bcrypt.hash(password || 'changeme', BCRYPT_ROUNDS)
  USERS[username] = {
    username, email: email || '', domain: domain || 'Global',
    role: role || 'reader', functions: Array.isArray(functions) ? functions : [],
    passwordHash, totpSecret: '', sections: []
  }
  saveUsers(USERS)
  return getAllUsers().find(u => u.username === username)
}

async function updateUser(username, { email, domain, role, functions, password }) {
  const u = USERS[username]
  if (!u) return null
  if (email     !== undefined) u.email     = email
  if (domain    !== undefined) u.domain    = domain
  if (role      !== undefined) u.role      = role
  if (functions !== undefined) u.functions = Array.isArray(functions) ? functions : []
  if (password) u.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  saveUsers(USERS)
  return getAllUsers().find(uu => uu.username === username)
}

// Alle Benutzer mit einer bestimmten Funktion finden
function getUsersByFunction(fn) {
  return Object.values(USERS)
    .filter(u => Array.isArray(u.functions) && u.functions.includes(fn))
    .map(u => ({ username: u.username, email: u.email, role: u.role, functions: u.functions || [] }))
}

function deleteUser(username) {
  if (!USERS[username]) return false
  delete USERS[username]
  saveUsers(USERS)
  return true
}

const _jsonExports = {
  init: async () => { USERS = loadUsers() },
  verifyPassword,
  setPasswordHash,
  getUserSections,
  setUserSections,
  getAllUsers,
  getUserByUsername,
  getUsernameByEmail,
  getUsersByFunction,
  setUserTotpSecret,
  confirmTotpVerified,
  createUser,
  updateUser,
  deleteUser
}

// Dual-mode, same pattern as server/db/riskStore.js etc.: under STORAGE_BACKEND
// sqlite/mariadb/postgres, persistence is delegated entirely to
// server/db/stores/rbacStore.js (Knex, against the already-existing
// rbac_users table) — otherwise every pod would only ever see its own JSON
// snapshot, and password/role changes on one pod would stay invisible to
// every other pod until it restarts.
//
// Unlike the other Knex stores, `init()` is deliberately NOT triggered here
// at require() time: server/index.js already calls `rbacStore.init()`
// explicitly once (around line 77). An extra call here would race with that
// one — both would see an empty table at startup and both would try to
// insert the seed (admin/alice/bob) concurrently, and the second attempt
// would fail with a UNIQUE constraint error on `username`.
const STORAGE_BACKEND = (process.env.STORAGE_BACKEND || 'json').toLowerCase()

module.exports = STORAGE_BACKEND !== 'json'
  ? require('./db/stores/rbacStore')
  : _jsonExports
