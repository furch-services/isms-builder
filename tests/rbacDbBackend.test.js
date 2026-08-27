'use strict'
// © 2026 Claude Hecker — ISMS Builder — AGPL-3.0
//
// Regression test for the rbacStore dual-mode fix (Helm/Kubernetes groundwork):
// before this fix, server/rbacStore.js ALWAYS read data/rbac_users.json,
// regardless of STORAGE_BACKEND — multiple pods sharing a real database under
// a SQL backend would never see another pod's user changes until they
// restarted themselves. This test therefore deliberately runs against a real
// SQL backend (default: sqlite, self-contained, part of `npm test`).
//
// For mariadb/pg specifically (same as tests/dbBackendRoutes.test.js):
//   DB_STORES_TEST_BACKEND=mariadb DB_HOST=... DB_PORT=... DB_USER=... DB_PASS=... DB_NAME=... npx jest tests/rbacDbBackend.test.js --runInBand
//   DB_STORES_TEST_BACKEND=pg      DB_HOST=... DB_PORT=... DB_USER=... DB_PASS=... DB_NAME=... npx jest tests/rbacDbBackend.test.js --runInBand
const BACKEND = (process.env.DB_STORES_TEST_BACKEND || 'sqlite').toLowerCase()
process.env.STORAGE_BACKEND = BACKEND

const { createTestDataDir, removeTestDataDir } = require('./setup/testEnv')
const { loginAs, authedPut } = require('./setup/authHelper')

describe(`rbacStore dual mode [${BACKEND}]`, () => {
  let dataDir, app

  beforeAll(async () => {
    dataDir = createTestDataDir()
    process.env.DATA_DIR   = dataDir
    process.env.JWT_SECRET = 'jest-test-secret-rbac-db-backend'
    process.env.NODE_ENV   = 'test'
    app = require('../server/index.js')
    await app.bootstrap?.()
  })

  afterAll(async () => {
    if (BACKEND !== 'json') await require('../server/db/knexDatabase').destroy()
    removeTestDataDir(dataDir)
  })

  test('login with the automatically seeded production admin works', async () => {
    const cookie = await loginAs(app, 'admin')
    expect(cookie).toMatch(/^sm_session=/)
  })

  test('password change is actually persisted (not just held in process memory)', async () => {
    const cookie = await loginAs(app, 'admin')
    const res = await authedPut(app, cookie, '/me/password', {
      currentPassword: 'adminpass', newPassword: 'newAdminPass123',
    })
    expect(res.status).toBe(200)

    const rbacStore = require('../server/rbacStore')
    const ok = await rbacStore.verifyPassword('admin', 'newAdminPass123')
    expect(ok).toBe(true)

    // Clean up for the remaining tests in this file
    await rbacStore.setPasswordHash('admin', 'adminpass')
  })

  test('getAllUsers() returns a resolved array, not a serialized promise ({})', async () => {
    const rbacStore = require('../server/rbacStore')
    const all = await rbacStore.getAllUsers()
    expect(Array.isArray(all)).toBe(true)
    expect(all.find(u => u.username === 'admin')).toBeTruthy()
  })

  test('core proof: a second, independent Knex client (simulating a second pod) ' +
       'sees a user created by client 1 immediately — without its own restart', async () => {
    const rbacStore1 = require('../server/rbacStore')
    await rbacStore1.createUser({
      username: 'pod1-user', email: 'pod1@example.com', domain: 'Global',
      role: 'reader', functions: [], password: 'pod1pass123',
    })

    // "Pod 2": a fully independent Knex connection against the same DB —
    // simulates a second pod that opens its own connection on startup instead
    // of (as before, JSON mode) only ever knowing its own in-memory snapshot.
    delete require.cache[require.resolve('../server/db/knexDatabase')]
    delete require.cache[require.resolve('../server/db/stores/rbacStore')]
    const knexDb2 = require('../server/db/knexDatabase')
    await knexDb2.init()
    const rbacStore2 = require('../server/db/stores/rbacStore')

    const seenByPod2 = await rbacStore2.getUserByUsername('pod1-user')
    expect(seenByPod2).toBeTruthy()
    expect(seenByPod2.email).toBe('pod1@example.com')
  })
})
