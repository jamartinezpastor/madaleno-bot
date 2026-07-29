'use strict';

/**
 * Enlaces de acceso firmados (sin cuentas ni contraseñas).
 *
 * El bot entrega por privado a un administrador un enlace con un token
 * firmado (HMAC-SHA256) que dice: "el usuario X puede editar el calendario
 * del grupo Y hasta la hora Z". El servidor web no guarda sesiones: le
 * basta verificar la firma.
 *
 * Ventajas para este caso: nadie tiene que registrarse, el enlace caduca,
 * y solo sirve para el grupo concreto que lo generó.
 */

const crypto = require('crypto');

const TTL_MS = parseInt(process.env.WEB_TOKEN_HORAS || '24', 10) * 3600_000;

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function deB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function firma(secreto, cuerpo) {
  return b64url(crypto.createHmac('sha256', secreto).update(cuerpo).digest());
}

/** Crea un token para (usuario, grupo). */
function crear(secreto, { userId, chatId }, ttlMs = TTL_MS) {
  const datos = { u: userId, g: chatId, exp: Date.now() + ttlMs };
  const cuerpo = b64url(JSON.stringify(datos));
  return `${cuerpo}.${firma(secreto, cuerpo)}`;
}

/** Verifica y devuelve {userId, chatId} o null. */
function verificar(secreto, token) {
  try {
    const [cuerpo, mac] = String(token).split('.');
    if (!cuerpo || !mac) return null;

    const esperado = firma(secreto, cuerpo);
    // Comparación en tiempo constante: evita filtrar la firma a base de
    // medir cuánto tarda en fallar.
    const a = Buffer.from(mac);
    const b = Buffer.from(esperado);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const datos = JSON.parse(deB64url(cuerpo).toString('utf8'));
    if (!datos.exp || Date.now() > datos.exp) return null;
    return { userId: datos.u, chatId: datos.g, exp: datos.exp };
  } catch (_) {
    return null;
  }
}

/** Secreto persistente: se genera solo la primera vez. */
function secretoDe(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS config (clave TEXT PRIMARY KEY, valor TEXT)'
  );
  const fila = db.prepare('SELECT valor FROM config WHERE clave = ?').get('web_secret');
  if (fila && fila.valor) return fila.valor;

  const nuevo = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)').run(
    'web_secret',
    nuevo
  );
  console.log('[web] Secreto de firma generado.');
  return nuevo;
}

module.exports = { crear, verificar, secretoDe, TTL_MS };
