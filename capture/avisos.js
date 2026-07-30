'use strict';

/**
 * Avisos diarios de un grupo: cumpleaños y eventos/recordatorios.
 *
 * Los datos vienen del CSV del grupo (módulo groups.js), así que cada
 * grupo felicita a los suyos y recuerda sus propios eventos.
 *
 * La marca de "ya avisado" incluye el ID DEL CHAT: con varios grupos, un
 * aviso enviado en uno no debe silenciar el del otro (ese era el fallo de
 * la versión anterior, que marcaba solo por nombre y fecha).
 */

const gemini = require('./gemini');
const util = require('./util');

const HOUR_STR = process.env.BIRTHDAY_HOUR || '11:30';
const CHECK_MODE = (process.env.BIRTHDAY_CHECK_GREET || 'siempre').toLowerCase();
const STYLE = (process.env.BIRTHDAY_STYLE || 'generico').toLowerCase();

const [GH_H, GH_M] = HOUR_STR.split(':').map((x) => parseInt(x, 10));

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS avisos_enviados (
      chat_id TEXT NOT NULL,
      clave   TEXT NOT NULL,          -- p.ej. "cumple:María" o "evento:Cena"
      ymd     TEXT NOT NULL,
      PRIMARY KEY (chat_id, clave, ymd)
    );
  `);
}

function hoy() {
  const d = new Date();
  return {
    day: d.getDate(),
    month: d.getMonth() + 1,
    year: d.getFullYear(),
    ymd: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`,
  };
}

function esHora() {
  const n = new Date();
  return !(n.getHours() < GH_H || (n.getHours() === GH_H && n.getMinutes() < GH_M));
}

// --- ¿Ya lo han felicitado los humanos? (solo en modos ia/nombre) ---
function mensajesDeHoy(db, chatId) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return util
    .stmt(
      db,
      `SELECT body FROM messages
       WHERE chat_id = ? AND ts >= ? AND body != '' AND type = 'chat'
         AND from_me = 0
       ORDER BY ts ASC`
    )
    .all(chatId, Math.floor(d.getTime() / 1000))
    .map((r) => r.body);
}

async function yaFelicitado(db, chatId, nombre) {
  if (CHECK_MODE === 'siempre') return false;

  const bodies = mensajesDeHoy(db, chatId);
  if (bodies.length === 0) return false;

  if (CHECK_MODE === 'nombre') {
    const n = String(nombre).toLowerCase().split(/\s+/)[0];
    const felicita = /felici|cumplea|happy|enhorabuena|muchos a[ñn]os|feliz/i;
    return bodies.some((b) => b.toLowerCase().includes(n) && felicita.test(b));
  }

  try {
    const ans = await gemini.generate(
      'Te paso mensajes de hoy de un grupo de WhatsApp. Responde SOLO ' +
        `"SI" o "NO": ¿alguien ha felicitado el cumpleaños a ${nombre}? ` +
        'Di "SI" solo si hay una felicitación clara dirigida a esa persona.',
      bodies.slice(-120).join('\n'),
      { temperature: 0, maxTokens: 5 }
    );
    return /^\s*si/i.test(ans);
  } catch (e) {
    console.error('[avisos] Comprobación IA falló:', e.message);
    return false;
  }
}

async function textoFelicitacion(nombre) {
  if (STYLE === 'ia') {
    try {
      return await gemini.generate(
        'Escribe una felicitación de cumpleaños breve, cálida y variada en ' +
          'español para un grupo de WhatsApp. Una o dos frases, con algún ' +
          'emoji. Sin comillas.',
        `Felicita a ${nombre}.`,
        { temperature: 0.9, maxTokens: 100 }
      );
    } catch (e) {
      console.error('[avisos] Estilo IA falló, uso genérico:', e.message);
    }
  }
  return `🎉 ¡Feliz cumpleaños, ${nombre}! 🎉`;
}

/**
 * Avisos pendientes de un grupo concreto.
 * @param {object} cfg configuración del grupo (groups.paraChat)
 * @returns {Promise<string[]>} textos a enviar
 */
async function pendientes(db, chatId, cfg) {
  if (!esHora()) return [];

  const { day, month, year, ymd } = hoy();
  const salida = [];

  const visto = db.prepare(
    'SELECT 1 FROM avisos_enviados WHERE chat_id = ? AND clave = ? AND ymd = ?'
  );
  const marcar = db.prepare(
    'INSERT OR IGNORE INTO avisos_enviados (chat_id, clave, ymd) VALUES (?, ?, ?)'
  );

  const entradas = (cfg.calendario || []).filter((e) => {
    if (e.day !== day || e.month !== month) return false;
    if (e.aviso === false) return false;           // aviso desactivado
    if (e.repite === 'unavez' && e.year && e.year !== year) return false;
    return true;
  });

  // --- Cumpleaños ---
  for (const p of entradas.filter((e) => e.clase === 'cumple').map((e) => ({ name: e.texto }))) {
    const clave = `cumple:${p.name}`;
    if (visto.get(chatId, clave, ymd)) continue;
    if (await yaFelicitado(db, chatId, p.name)) {
      marcar.run(chatId, clave, ymd);
      console.log(`[avisos] ${p.name} ya tenía felicitación en ${chatId}.`);
      continue;
    }
    salida.push(await textoFelicitacion(p.name));
    marcar.run(chatId, clave, ymd);
    console.log(`[avisos] Felicitando a ${p.name} en ${chatId}.`);
  }

  // --- Eventos y efemérides con aviso activado ---
  for (const e of entradas.filter((e) => e.clase !== 'cumple')) {
    const clave = `${e.clase}:${e.texto}`;
    if (visto.get(chatId, clave, ymd)) continue;
    const icono = e.clase === 'efemeride' ? '📜' : '📅';
    salida.push(`${icono} *Hoy:* ${e.texto}`);
    marcar.run(chatId, clave, ymd);
    console.log(`[avisos] Recordando "${e.texto}" en ${chatId}.`);
  }

  return salida;
}

module.exports = { initSchema, pendientes };
