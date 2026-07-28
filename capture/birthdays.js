'use strict';

/**
 * Felicitaciones de cumpleaños.
 *
 * Lee data/docs/<BIRTHDAY_CSV> (por defecto "cumples.csv") con formato
 * nombre,dia,mes  (también admite nombre,fecha). Cada día, a partir de
 * BIRTHDAY_HOUR (11:30), felicita a quien cumpla años. Solo una vez por
 * persona y año.
 *
 * Con la configuración por defecto (siempre + genérico) NO llama a la IA:
 * es determinista y gratis.
 */

const fs = require('fs');
const path = require('path');
const csvLib = require('./csv');
const gemini = require('./gemini');

const CSV_NAME = process.env.BIRTHDAY_CSV || 'cumples.csv';
const HOUR_STR = process.env.BIRTHDAY_HOUR || '11:30';
const CHECK_MODE = (process.env.BIRTHDAY_CHECK_GREET || 'siempre').toLowerCase();
const STYLE = (process.env.BIRTHDAY_STYLE || 'generico').toLowerCase();

const [GH_H, GH_M] = HOUR_STR.split(':').map((x) => parseInt(x, 10));

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS birthdays_greeted (
      name TEXT NOT NULL,
      ymd  TEXT NOT NULL,
      PRIMARY KEY (name, ymd)
    );
  `);
}

// --- Parseo ---
function parseDate(s) {
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { day: +m[3], month: +m[2] };
  m = t.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (m) return { day: +m[1], month: +m[2] };
  return null;
}

function parseCsv(text) {
  const parsed = csvLib.parse(text);
  const filas = parsed.objects.length
    ? parsed.objects
    : parsed.rows.map((r) =>
        r.length >= 3
          ? { nombre: r[0], dia: r[1], mes: r[2] }
          : { nombre: r[0], fecha: r[1] }
      );

  const out = [];
  for (const f of filas) {
    const name = csvLib.get(f, ['nombre', 'name']);
    let day = parseInt(csvLib.get(f, ['dia', 'día', 'day']), 10);
    let month = parseInt(csvLib.get(f, ['mes', 'month']), 10);
    const fecha = csvLib.get(f, ['fecha', 'date']);
    if ((!day || !month) && fecha) {
      const p = parseDate(fecha);
      if (p) {
        day = p.day;
        month = p.month;
      }
    }
    if (name && day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      out.push({ name, day, month });
    }
  }
  return out;
}

function todayParts() {
  const d = new Date();
  return {
    day: d.getDate(),
    month: d.getMonth() + 1,
    ymd: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`,
  };
}

// --- ¿Ya le han felicitado? ---
function messagesToday(db, chatId) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const since = Math.floor(d.getTime() / 1000);
  return db
    .prepare(
      `SELECT body FROM messages
       WHERE chat_id = ? AND ts >= ? AND body != '' AND type = 'chat'
       ORDER BY ts ASC`
    )
    .all(chatId, since)
    .map((r) => r.body);
}

async function alreadyGreeted(db, chatId, name) {
  if (CHECK_MODE === 'siempre') return false; // no comprueba nada

  const bodies = messagesToday(db, chatId);
  if (bodies.length === 0) return false;

  if (CHECK_MODE === 'nombre') {
    const n = String(name).toLowerCase().split(/\s+/)[0];
    const greetWords = /felici|cumplea|happy|enhorabuena|muchos a[ñn]os|feliz/i;
    return bodies.some((b) => b.toLowerCase().includes(n) && greetWords.test(b));
  }

  // CHECK_MODE === 'ia'
  try {
    const ans = await gemini.generate(
      'Te paso mensajes de hoy de un grupo de WhatsApp. Responde SOLO ' +
        `"SI" o "NO": ¿alguien ha felicitado el cumpleaños a ${name}? ` +
        'Di "SI" solo si hay una felicitación clara dirigida a esa persona.',
      bodies.slice(-120).join('\n'),
      { temperature: 0, maxTokens: 5 }
    );
    return /^\s*si/i.test(ans);
  } catch (e) {
    console.error('[bday] Comprobación IA falló, asumo no felicitado:', e.message);
    return false;
  }
}

async function buildGreeting(name) {
  if (STYLE === 'ia') {
    try {
      return await gemini.generate(
        'Escribe una felicitación de cumpleaños breve, cálida y variada en ' +
          'español para un grupo de WhatsApp. Una o dos frases, con algún ' +
          'emoji. Sin comillas.',
        `Felicita a ${name}.`,
        { temperature: 0.9, maxTokens: 100 }
      );
    } catch (e) {
      console.error('[bday] Estilo IA falló, uso genérico:', e.message);
    }
  }
  return `🎉 ¡Feliz cumpleaños, ${name}! 🎉`;
}

/**
 * Devuelve los textos de felicitación a enviar (normalmente 0 o 1).
 */
async function checkBirthdays(db, chatId, docsDir) {
  const now = new Date();
  if (now.getHours() < GH_H || (now.getHours() === GH_H && now.getMinutes() < GH_M)) {
    return [];
  }

  const csvPath = path.join(docsDir, CSV_NAME);
  if (!fs.existsSync(csvPath)) return [];

  let people;
  try {
    people = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  } catch (e) {
    console.error('[bday] No pude leer/parsear el CSV:', e.message);
    return [];
  }

  const { day, month, ymd } = todayParts();
  const birthdayPeople = people.filter((p) => p.day === day && p.month === month);
  if (birthdayPeople.length === 0) return [];

  const seen = db.prepare(
    'SELECT 1 FROM birthdays_greeted WHERE name = ? AND ymd = ?'
  );
  const mark = db.prepare(
    'INSERT OR IGNORE INTO birthdays_greeted (name, ymd) VALUES (?, ?)'
  );

  const out = [];
  for (const p of birthdayPeople) {
    if (seen.get(p.name, ymd)) continue;
    if (await alreadyGreeted(db, chatId, p.name)) {
      mark.run(p.name, ymd);
      console.log(`[bday] ${p.name} ya tenía felicitación, no insisto.`);
      continue;
    }
    out.push(await buildGreeting(p.name));
    mark.run(p.name, ymd);
    console.log(`[bday] Felicitando a ${p.name}.`);
  }
  return out;
}

module.exports = { initSchema, checkBirthdays };
