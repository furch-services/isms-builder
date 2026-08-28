'use strict'
// © 2026 Claude Hecker — ISMS Builder — AGPL-3.0
//
// Regression test found by ultrareview on the Helm/Kubernetes branch: every
// check* function in server/notifier.js called now-async Knex-backed store
// methods synchronously (.filter()/.length on a Promise), so under any SQL
// backend the daily digest silently shipped empty — no exception, no log,
// just an empty section list every single day. This test therefore
// deliberately runs against a real SQL backend (default: sqlite,
// self-contained, part of `npm test`).
//
// For mariadb/pg specifically (same as tests/dbBackendRoutes.test.js):
//   DB_STORES_TEST_BACKEND=mariadb DB_HOST=... DB_PORT=... DB_USER=... DB_PASS=... DB_NAME=... npx jest tests/notifierDbBackend.test.js --runInBand
//   DB_STORES_TEST_BACKEND=pg      DB_HOST=... DB_PORT=... DB_USER=... DB_PASS=... DB_NAME=... npx jest tests/notifierDbBackend.test.js --runInBand
const BACKEND = (process.env.DB_STORES_TEST_BACKEND || 'sqlite').toLowerCase()
process.env.STORAGE_BACKEND = BACKEND

const { createTestDataDir, removeTestDataDir } = require('./setup/testEnv')

describe(`notifier.js check* functions [${BACKEND}]`, () => {
  let dataDir, app

  beforeAll(async () => {
    dataDir = createTestDataDir()
    process.env.DATA_DIR   = dataDir
    process.env.JWT_SECRET = 'jest-test-secret-notifier-db-backend'
    process.env.NODE_ENV   = 'test'
    app = require('../server/index.js')
    await app.bootstrap?.()
  })

  afterAll(async () => {
    if (BACKEND !== 'json') await require('../server/db/knexDatabase').destroy()
    removeTestDataDir(dataDir)
  })

  test('checkRisks resolves a real section for a critical risk, not a thrown TypeError', async () => {
    const riskStore = require('../server/db/riskStore')
    await riskStore.create({ title: 'Kritisches Testrisiko', probability: 5, impact: 5, status: 'open' }, 'system')

    const notifier = require('../server/notifier')
    const section = await notifier.checkRisks({ risks: true })

    expect(section).not.toBeNull()
    expect(section.items.length).toBeGreaterThan(0)
  })

  test('checkBcm resolves a real section for a plan due for testing', async () => {
    const bcmStore = require('../server/db/bcmStore')
    const dueDate = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) // in 5 days
    await bcmStore.createPlan({ title: 'Testplan', nextTest: dueDate })

    const notifier = require('../server/notifier')
    const section = await notifier.checkBcm({ bcm: true })

    expect(section).not.toBeNull()
    expect(section.items.length).toBeGreaterThan(0)
  })

  test('checkDeletionLog reflects real overdue/upcoming data instead of a silent false-negative', async () => {
    // Regression detail: under the pre-fix code, `overdue`/`upcoming` were
    // Promises, so `!overdue.length && !upcoming.length` evaluated
    // `!undefined && !undefined` === true and the function returned null
    // *without ever throwing* — the most dangerous variant of this bug class,
    // since it looks identical to "nothing is due" instead of "this is broken".
    // Seeding a genuinely-overdue deletion-log entry through the public API
    // would require backdating a VVT record's createdAt by months, so this
    // stubs the two store methods directly to prove checkDeletionLog awaits
    // and uses their resolved values rather than the Promise objects.
    const gdprStore = require('../server/db/gdprStore')
    const originalGetDue      = gdprStore.deletionLog.getDue
    const originalGetUpcoming = gdprStore.deletionLog.getUpcoming
    gdprStore.deletionLog.getDue      = async () => ([{ id: 'v1', title: 'Überfällige VVT', deletionDue: '2020-01-01', retentionMonths: 12 }])
    gdprStore.deletionLog.getUpcoming = async () => ([])

    try {
      const notifier = require('../server/notifier')
      const section = await notifier.checkDeletionLog({ deletionLog: true })

      expect(section).not.toBeNull()
      expect(section.items).toHaveLength(1)
    } finally {
      gdprStore.deletionLog.getDue      = originalGetDue
      gdprStore.deletionLog.getUpcoming = originalGetUpcoming
    }
  })
})
