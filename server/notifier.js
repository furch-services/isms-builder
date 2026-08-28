// © 2026 Claude Hecker — ISMS Builder V 1.29 — AGPL-3.0
/**
 * notifier.js – Täglicher E-Mail-Benachrichtigungsdienst
 *
 * Sendet einmal täglich Digest-Mails an CISO, GDPO und Admin wenn:
 *   – Hohe/kritische Risiken offen sind          → cisoEmail
 *   – DSAR-Fristen in ≤ 3 Tagen ablaufen         → gdpoEmail
 *   – GDPR-Vorfälle > 48h offen sind              → gdpoEmail
 *   – BCM-Tests in ≤ 14 Tagen fällig sind         → cisoEmail
 *   – Verträge in ≤ 30 Tagen ablaufen             → adminEmail
 *   – Templates-Überprüfung in ≤ 14 Tagen fällig  → adminEmail
 *
 * Konfiguration: emailNotifications in org-settings.json
 * SMTP: SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM in .env
 */

const { sendMail, isConfigured } = require('./mailer')
const orgSettings   = require('./db/orgSettingsStore')
const rbacStore     = require('./rbacStore')
const riskStore     = require('./db/riskStore')
const gdprStore     = require('./db/gdprStore')
const legalStore    = require('./db/legalStore')
const bcmStore      = require('./db/bcmStore')

let storage = null  // lazy-load to avoid circular deps at startup

function getStorage() {
  if (!storage) storage = require('./storage')
  return storage
}

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

function daysFromNow(dateStr) {
  if (!dateStr) return Infinity
  return Math.floor((new Date(dateStr) - Date.now()) / 86400000)
}

function daysSince(dateStr) {
  if (!dateStr) return 0
  return Math.floor((Date.now() - new Date(dateStr)) / 86400000)
}

function fmt(dateStr) {
  if (!dateStr) return '–'
  return new Date(dateStr).toLocaleDateString('de-DE')
}

// ── HTML-Template ────────────────────────────────────────────────────────────

function buildDigest(orgName, sections) {
  const sectionHtml = sections.map(({ heading, items }) => `
    <h3 style="color:#de350b;margin:20px 0 8px">${heading}</h3>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <tbody>
        ${items.map(row => `<tr>
          <td style="padding:6px 12px 6px 0;border-bottom:1px solid #eee;font-weight:600">${row.label}</td>
          <td style="padding:6px 0;border-bottom:1px solid #eee;color:#666">${row.detail}</td>
        </tr>`).join('')}
      </tbody>
    </table>`).join('')

  return `<!DOCTYPE html>
<html lang="de">
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;color:#333;max-width:700px;margin:0 auto;padding:24px">
  <div style="background:#0052cc;padding:16px 24px;border-radius:6px 6px 0 0">
    <h2 style="color:#fff;margin:0">ISMS Builder – Tagesübersicht</h2>
    <p style="color:#bfdbfe;margin:4px 0 0">${orgName}</p>
  </div>
  <div style="background:#f9fafb;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 6px 6px">
    ${sectionHtml}
    <hr style="margin:24px 0;border:none;border-top:1px solid #e5e7eb">
    <p style="font-size:12px;color:#9ca3af">
      Diese Nachricht wurde automatisch vom ISMS Builder generiert.<br>
      Bitte nicht auf diese E-Mail antworten.
    </p>
  </div>
</body>
</html>`
}

// ── Einzelne Prüfungen ───────────────────────────────────────────────────────

async function checkRisks(cfg) {
  if (!cfg.risks) return null
  try {
    const all = (await riskStore.getAll()).filter(r => !r.deletedAt)
    const critical = all.filter(r => r.status !== 'closed' && r.score >= 15)
    const high     = all.filter(r => r.status !== 'closed' && r.score >= 10 && r.score < 15)
    if (!critical.length && !high.length) return null

    const items = [
      ...critical.slice(0, 10).map(r => ({
        label: `⛔ ${r.title}`,
        detail: `Score ${r.score} | Kritisch | ${r.category || '–'}`
      })),
      ...high.slice(0, 10).map(r => ({
        label: `⚠️ ${r.title}`,
        detail: `Score ${r.score} | Hoch | ${r.category || '–'}`
      })),
    ]
    return {
      heading: `Risikomanagement – ${critical.length} kritisch / ${high.length} hoch`,
      items
    }
  } catch { return null }
}

async function checkDsar(cfg, gdpoSettings) {
  if (!cfg.dsar) return null
  try {
    const deadline = gdpoSettings.dsarDeadlineDays || 30
    const all = (await gdprStore.dsar.getAll({})).filter(r => !r.deletedAt && r.status !== 'closed' && r.status !== 'completed')
    const urgent = all.filter(r => {
      const created = r.createdAt
      const dueInDays = deadline - daysSince(created)
      return dueInDays <= 3
    })
    if (!urgent.length) return null

    return {
      heading: `DSAR – ${urgent.length} Anfrage(n) mit Fristablauf in ≤ 3 Tagen`,
      items: urgent.slice(0, 10).map(r => ({
        label: r.title || r.subject || r.id,
        detail: `Eingegangen: ${fmt(r.createdAt)} | Status: ${r.status}`
      }))
    }
  } catch { return null }
}

async function checkGdprIncidents(cfg) {
  if (!cfg.gdprIncidents) return null
  try {
    const all = (await gdprStore.incidents.getAll({})).filter(r => !r.deletedAt)
    const overdue = all.filter(r => {
      const isOpen = r.status !== 'closed' && r.status !== 'notified'
      return isOpen && daysSince(r.createdAt) >= 2
    })
    if (!overdue.length) return null

    return {
      heading: `GDPR-Vorfälle – ${overdue.length} Vorfall/Vorfälle > 48h ohne Meldung`,
      items: overdue.slice(0, 10).map(r => ({
        label: r.title || r.id,
        detail: `Seit ${daysSince(r.createdAt)} Tagen offen | Status: ${r.status || '–'}`
      }))
    }
  } catch { return null }
}

async function checkBcm(cfg) {
  if (!cfg.bcm) return null
  try {
    const plans = (await bcmStore.getPlans()).filter(r => r.nextTest)
    const due   = plans.filter(r => daysFromNow(r.nextTest) <= 14 && daysFromNow(r.nextTest) >= 0)
    if (!due.length) return null

    return {
      heading: `BCM – ${due.length} Plan-Test(s) in ≤ 14 Tagen fällig`,
      items: due.slice(0, 10).map(r => ({
        label: r.title,
        detail: `Nächster Test: ${fmt(r.nextTest)} (in ${daysFromNow(r.nextTest)} Tagen) | Status: ${r.status || '–'}`
      }))
    }
  } catch { return null }
}

async function checkContracts(cfg) {
  if (!cfg.contracts) return null
  try {
    const all = (await legalStore.contracts.getAll({})).filter(r => !r.deletedAt && r.endDate)
    const expiring = all.filter(r => daysFromNow(r.endDate) <= 30 && daysFromNow(r.endDate) >= 0)
    if (!expiring.length) return null

    return {
      heading: `Verträge – ${expiring.length} Vertrag/Verträge läuft/laufen in ≤ 30 Tagen ab`,
      items: expiring.slice(0, 10).map(r => ({
        label: r.title,
        detail: `Ablauf: ${fmt(r.endDate)} (in ${daysFromNow(r.endDate)} Tagen) | ${r.counterparty || '–'}`
      }))
    }
  } catch { return null }
}

async function checkTemplateReviews(cfg) {
  if (!cfg.templateReview) return null
  try {
    const s = getStorage()
    const all = ((await s.getTemplates?.({})) || []).filter(r => !r.deletedAt && r.nextReviewDate)
    const due = all.filter(r => daysFromNow(r.nextReviewDate) <= 14 && daysFromNow(r.nextReviewDate) >= 0)
    if (!due.length) return null

    return {
      heading: `Templates – ${due.length} Dokument(e) zur Überprüfung in ≤ 14 Tagen fällig`,
      items: due.slice(0, 10).map(r => ({
        label: r.title,
        detail: `Überprüfung bis: ${fmt(r.nextReviewDate)} (in ${daysFromNow(r.nextReviewDate)} Tagen) | Status: ${r.status}`
      }))
    }
  } catch { return null }
}

async function checkSupplierAudits(cfg) {
  if (!cfg.supplierAudits) return null
  try {
    const supplierStore = require('./db/supplierStore')
    const today   = new Date().toISOString().slice(0, 10)
    const upcoming = await supplierStore.getUpcomingAudits(14)
    const overdue  = (await supplierStore.getAll()).filter(s =>
      !s.deletedAt && s.nextAuditDate && s.nextAuditDate < today
    )
    if (!upcoming.length && !overdue.length) return null
    const items = [
      ...overdue.slice(0, 5).map(s => ({
        label:  `⛔ ${s.name}`,
        detail: `Audit überfällig seit ${fmt(s.nextAuditDate)} | ${s.criticality}`,
      })),
      ...upcoming.slice(0, 5).map(s => ({
        label:  `⚠️ ${s.name}`,
        detail: `Audit fällig: ${fmt(s.nextAuditDate)} (${daysFromNow(s.nextAuditDate)} Tage) | ${s.criticality}`,
      })),
    ]
    return {
      heading: `Lieferanten – ${overdue.length} überfällig / ${upcoming.length} in ≤ 14 Tagen fällig`,
      items,
    }
  } catch { return null }
}

async function checkDeletionLog(cfg) {
  if (!cfg.deletionLog) return null
  try {
    const overdue  = await gdprStore.deletionLog.getDue()          // Frist bereits abgelaufen
    const upcoming = await gdprStore.deletionLog.getUpcoming(90)   // fällig innerhalb 90 Tage

    if (!overdue.length && !upcoming.length) return null

    const items = [
      ...overdue.slice(0, 10).map(v => ({
        label:  `⛔ ${v.title || v.id}`,
        detail: `Löschfrist abgelaufen seit ${fmt(v.deletionDue)} | Aufbewahrung: ${v.retentionMonths} Monate`,
      })),
      ...upcoming.slice(0, 10).map(v => ({
        label:  `⚠️ ${v.title || v.id}`,
        detail: `Löschfrist: ${fmt(v.deletionDue)} (in ${daysFromNow(v.deletionDue)} Tagen) | Aufbewahrung: ${v.retentionMonths} Monate`,
      })),
    ]

    return {
      heading: `Art. 17 DSGVO Löschprotokoll – ${overdue.length} überfällig / ${upcoming.length} in ≤ 90 Tagen fällig`,
      items,
    }
  } catch { return null }
}

// ── Empfänger-Ermittlung ──────────────────────────────────────────────────────

/**
 * Gibt deduplizierte E-Mail-Adressen aller Nutzer mit einer bestimmten Funktion zurück.
 * Fallback: Org-Setting-Adresse, falls kein Nutzer mit dieser Funktion gefunden wird.
 */
async function getRecipients(fn, fallbackEmail) {
  try {
    const users = await rbacStore.getUsersByFunction(fn)
    const emails = users.map(u => u.email).filter(Boolean)
    if (emails.length) return [...new Set(emails)]
  } catch {}
  return fallbackEmail ? [fallbackEmail] : []
}

// ── Hauptfunktion ─────────────────────────────────────────────────────────────

async function runDailyChecks() {
  if (!isConfigured()) return

  const settings = orgSettings.get()
  const cfg      = settings.emailNotifications || {}

  if (!cfg.enabled) return

  const orgName      = settings.orgName || 'ISMS Builder'
  const gdpoSettings = settings.gdpoSettings || {}

  // Empfänger nach Funktion — mit Org-Setting als Fallback
  const cisoRecipients  = await getRecipients('ciso',  settings.cisoSettings?.escalationEmail || '')
  const dsoRecipients   = await getRecipients('dso',   '')
  const adminRecipients = await getRecipients('admin_notify', cfg.adminEmail || '')

  // Admin-E-Mail immer als letzten Fallback für alle Digest-Typen hinzufügen
  if (cfg.adminEmail && !adminRecipients.includes(cfg.adminEmail)) adminRecipients.push(cfg.adminEmail)

  const today = new Date().toLocaleDateString('de-DE')

  // ── CISO-Digest (Risiken + BCM + Lieferanten) ────────────────────────────
  const cisoSections = (await Promise.all([checkRisks(cfg), checkBcm(cfg), checkSupplierAudits(cfg)])).filter(Boolean)
  if (cisoSections.length) {
    // Deduplizierte Gesamtliste: CISO + DSO falls Person beide Funktionen hat
    const allCisoRecips = [...new Set([...cisoRecipients])]
    for (const to of allCisoRecips) {
      await sendMail(to, `[ISMS] Tagesübersicht CISO – ${today}`, buildDigest(orgName, cisoSections))
    }
  }

  // ── DSB/GDPO-Digest (DSAR + GDPR-Vorfälle + Löschprotokoll) ─────────────
  const dsoSections = (await Promise.all([checkDsar(cfg, gdpoSettings), checkGdprIncidents(cfg), checkDeletionLog(cfg)])).filter(Boolean)
  if (dsoSections.length) {
    // DSO-Empfänger ohne Duplikate (eine Person kann CISO+DSO sein → bekommt beide Digests)
    for (const to of dsoRecipients) {
      await sendMail(to, `[ISMS] Tagesübersicht DSB/GDPO – ${today}`, buildDigest(orgName, dsoSections))
    }
    // Fallback auf CISO-Empfänger wenn keine DSO-Funktion vergeben
    if (!dsoRecipients.length) {
      for (const to of cisoRecipients) {
        await sendMail(to, `[ISMS] Tagesübersicht DSB/GDPO – ${today}`, buildDigest(orgName, dsoSections))
      }
    }
  }

  // ── Admin-Digest (Verträge + Template-Reviews) ────────────────────────────
  const adminSections = (await Promise.all([checkContracts(cfg), checkTemplateReviews(cfg)])).filter(Boolean)
  if (adminSections.length) {
    for (const to of adminRecipients) {
      await sendMail(to, `[ISMS] Tagesübersicht Admin – ${today}`, buildDigest(orgName, adminSections))
    }
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

const INTERVAL_MS = 24 * 60 * 60 * 1000   // 24 Stunden

function start() {
  if (!isConfigured()) {
    console.log('[notifier] SMTP nicht konfiguriert — E-Mail-Benachrichtigungen deaktiviert')
    return
  }

  console.log('[notifier] E-Mail-Benachrichtigungsdienst gestartet (täglich)')

  // Erster Lauf nach 1 Minute (nicht sofort beim Start)
  setTimeout(() => {
    runDailyChecks().catch(e => console.error('[notifier] Fehler:', e.message))
    setInterval(() => {
      runDailyChecks().catch(e => console.error('[notifier] Fehler:', e.message))
    }, INTERVAL_MS)
  }, 60_000)
}

module.exports = {
  start, runDailyChecks,
  // Exported for testability (see tests/notifierDbBackend.test.js), same
  // rationale as art23Watcher.js exporting runCheck/buildMail.
  checkRisks, checkDsar, checkGdprIncidents, checkBcm, checkContracts,
  checkTemplateReviews, checkSupplierAudits, checkDeletionLog,
}
