'use strict';

/**
 * Quién puede dar órdenes al bot en cada grupo.
 *
 * El bot mantiene su PROPIO registro en la base de datos. No depende de
 * poder preguntárselo a WhatsApp: esa consulta (getChatById) se rompe con
 * cada cambio de WhatsApp Web y dejaría el bot sin dueño.
 *
 * Cómo se puebla el registro, por orden de importancia:
 *   1. Alta con código: un admin escribe en el grupo `@madaleno alta CÓDIGO`
 *      (el código lo pones tú en ADMIN_SETUP_CODE). Solo sirve para el
 *      primer administrador de cada grupo.
 *   2. Un administrador da de alta a otro: `@madaleno admin 34600111222`
 *      o respondiendo a un mensaje suyo con `@madaleno admin`.
 *   3. Si WhatsApp sí responde, sus administradores se incorporan solos.
 *   4. ADMIN_IDS del .env: válido en todos los grupos (emergencias).
 */

const util = require('./util');

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Lectura diferida: el código puede generarse al arrancar, después de
// cargar este módulo.
function codigoAlta() {
  return (process.env.ADMIN_SETUP_CODE || '').trim();
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      origen  TEXT,
      ts      INTEGER NOT NULL,
      PRIMARY KEY (chat_id, user_id)
    );
  `);
}

/** Administradores registrados de un grupo. */
function registrados(db, chatId) {
  return util
    .stmt(db, 'SELECT user_id FROM admins WHERE chat_id = ?')
    .all(chatId)
    .map((r) => r.user_id);
}

function hayAlguno(db, chatId) {
  return (
    util
      .stmt(db, 'SELECT COUNT(*) n FROM admins WHERE chat_id = ?')
      .get(chatId).n > 0
  );
}

function alta(db, chatId, userId, origen = 'manual') {
  util
    .stmt(
      db,
      `INSERT OR IGNORE INTO admins (chat_id, user_id, origen, ts)
       VALUES (?, ?, ?, ?)`
    )
    .run(chatId, userId, origen, Date.now());
}

function baja(db, chatId, userId) {
  const digitos = util.soloDigitos(userId);
  for (const id of registrados(db, chatId)) {
    if (util.soloDigitos(id) === digitos) {
      util
        .stmt(db, 'DELETE FROM admins WHERE chat_id = ? AND user_id = ?')
        .run(chatId, id);
      return true;
    }
  }
  return false;
}

/**
 * Lista efectiva de autorizados de un grupo.
 * Si WhatsApp devuelve sus administradores, se aprovechan y se guardan
 * (así una sola consulta con éxito vale para siempre).
 */
function autorizados(db, chatId, deWhatsApp) {
  const propios = registrados(db, chatId);

  if (Array.isArray(deWhatsApp) && deWhatsApp.length > 0) {
    const conocidos = new Set(propios.map(util.soloDigitos));
    for (const id of deWhatsApp) {
      if (!conocidos.has(util.soloDigitos(id))) {
        alta(db, chatId, id, 'whatsapp');
        propios.push(id);
      }
    }
  }

  return [...propios, ...ADMIN_IDS];
}

function esAdmin(db, chatId, userId, deWhatsApp) {
  return autorizados(db, chatId, deWhatsApp).some((x) =>
    util.mismoNumero(x, userId)
  );
}

/**
 * Comando de alta con código. Solo funciona mientras el grupo no tenga
 * ningún administrador registrado: una vez hay uno, es él quien da de
 * alta a los demás. Así, si el código se filtra, no sirve para colarse.
 */
function altaConCodigo(db, chatId, userId, codigo) {
  const CODIGO = codigoAlta();
  if (!CODIGO) {
    return { error: 'No hay código de alta configurado (ADMIN_SETUP_CODE).' };
  }
  if (hayAlguno(db, chatId)) {
    return {
      error:
        'Este grupo ya tiene administradores dados de alta. Pídele a uno ' +
        'que te añada con `admin` y tu número.',
    };
  }
  if (String(codigo).trim().toUpperCase() !== CODIGO.toUpperCase()) {
    console.log(`[admins] Código de alta incorrecto en ${chatId}`);
    return { error: 'Código incorrecto.' };
  }
  alta(db, chatId, userId, 'codigo');
  console.log(`[admins] Alta por código: ${userId} en ${chatId}`);
  return { ok: true };
}

module.exports = {
  initSchema,
  registrados,
  hayAlguno,
  alta,
  baja,
  autorizados,
  esAdmin,
  altaConCodigo,
  ADMIN_IDS,
};
