'use strict'
// 2FA-Provisioning: generiert echtes TOTP-Secret + scannierbaren QR-Code
const crypto = require('crypto')
const QRCode = require('qrcode')
const { getUserByUsername, setUserTotpSecret } = require('./rbacStore')

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function generateSecret() {
  // 20 zufällige Bytes → Base32 (160 Bit, Standard-TOTP-Länge)
  const bytes = crypto.randomBytes(20)
  let bits = 0, value = 0, output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

async function setupForUser(username) {
  const user = await getUserByUsername(username)
  if (!user) return null

  // Bestehendes Secret wiederverwenden oder neues generieren
  let secret = user.totpSecret
  if (!secret || secret.length < 16) {
    secret = generateSecret()
    await setUserTotpSecret(username, secret)
  }

  const issuer = 'ISMS-Build'
  const label = `${issuer}:${encodeURIComponent(username)}`
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`

  const qrDataUri = await QRCode.toDataURL(uri, { width: 200, margin: 2, color: { dark: '#000', light: '#fff' } })

  return { username, secret, provisioning_uri: uri, qrDataUri }
}

async function disableForUser(username) {
  const user = await getUserByUsername(username)
  if (!user) return false
  await setUserTotpSecret(username, '')
  return true
}

module.exports = { setupForUser, disableForUser }
