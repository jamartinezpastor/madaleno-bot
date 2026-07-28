'use strict';

/**
 * Efemérides: acontecimientos históricos que coinciden en día y mes.
 *
 * Lee data/docs/efemerides.csv. Columnas admitidas (cabecera flexible):
 *   dia,mes,anio,acontecimiento
 *   dia,mes,acontecimiento
 *   fecha,acontecimiento          (fecha tipo 1969-07-20 o 20/07/1969)
 *
 * Es 100% determinista y gratis: no llama a la IA salvo que se active
 * EPHEMERIS_FALLBACK_AI=true y el CSV no tenga nada para hoy.
 */

const fs = require('fs');
const path = require('path');
const csv = require('./csv');
const gemini = require('./gemini');

const CSV_NAME = process.env.EPHEMERIS_CSV || 'efemerides.csv';
const FALLBACK_AI =
  String(process.env.EPHEMERIS_FALLBACK_AI || 'false').toLowerCase() === 'true';

function parseFecha(s) {
  if (!s) return null;
  let m = String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { day: +m[3], month: +m[2], year: +m[1] };
  m = String(s).match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (m) return { day: +m[1], month: +m[2], year: m[3] ? +m[3] : undefined };
  return null;
}

/** Devuelve las efemérides del día indicado (por defecto, hoy). */
function delDia(docsDir, when = new Date()) {
  const file = path.join(docsDir, CSV_NAME);
  if (!fs.existsSync(file)) return { found: [], missingFile: true };

  let parsed;
  try {
    parsed = csv.parseFile(file);
  } catch (e) {
    console.error('[efem] No pude leer el CSV:', e.message);
    return { found: [], missingFile: false };
  }

  const day = when.getDate();
  const month = when.getMonth() + 1;
  const out = [];

  // Con cabecera -> objetos; sin cabecera -> asume dia,mes,[anio],texto
  const filas = parsed.objects.length
    ? parsed.objects
    : parsed.rows.map((r) =>
        r.length >= 4
          ? { dia: r[0], mes: r[1], anio: r[2], acontecimiento: r[3] }
          : { dia: r[0], mes: r[1], acontecimiento: r[2] }
      );

  for (const f of filas) {
    let d = parseInt(csv.get(f, ['dia', 'día', 'day']), 10);
    let mo = parseInt(csv.get(f, ['mes', 'month']), 10);
    let year = csv.get(f, ['anio', 'año', 'ano', 'year']);
    const fecha = csv.get(f, ['fecha', 'date']);
    if ((!d || !mo) && fecha) {
      const p = parseFecha(fecha);
      if (p) {
        d = p.day;
        mo = p.month;
        if (!year && p.year) year = String(p.year);
      }
    }
    const texto = csv.get(f, [
      'acontecimiento',
      'evento',
      'hecho',
      'descripcion',
      'descripción',
      'texto',
    ]);
    if (d === day && mo === month && texto) {
      out.push({ year: year ? String(year).trim() : null, texto });
    }
  }

  // Ordena por año cuando lo hay
  out.sort((a, b) => (parseInt(a.year, 10) || 0) - (parseInt(b.year, 10) || 0));
  return { found: out, missingFile: false };
}

/** Texto listo para enviar al grupo. */
async function reporte(docsDir, when = new Date()) {
  const fecha = when.toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'long',
  });
  const { found, missingFile } = delDia(docsDir, when);

  if (missingFile) {
    return `No tengo fichero de efemérides todavía (falta ${CSV_NAME}).`;
  }

  if (found.length > 0) {
    const lineas = found.map(
      (e) => `• ${e.year ? `*${e.year}* — ` : ''}${e.texto}`
    );
    return `📜 *Un ${fecha} como hoy...*\n` + lineas.join('\n');
  }

  if (!FALLBACK_AI) {
    return `📜 No tengo ninguna efeméride apuntada para un ${fecha}.`;
  }

  try {
    const txt = await gemini.generate(
      'Eres un divulgador de historia. Responde en español, muy breve.',
      `Dime 2 acontecimientos históricos relevantes ocurridos un ${fecha} ` +
        `(cualquier año). Formato: "• AÑO — hecho", máximo 2 líneas, sin ` +
        `introducción. Si no estás seguro de una fecha, omítela.`,
      { temperature: 0.2, maxTokens: 200 }
    );
    return `📜 *Un ${fecha} como hoy...*\n${txt}\n_(no estaba en el CSV: de conocimiento general, puede fallar)_`;
  } catch (e) {
    console.error('[efem] Fallback IA falló:', e.message);
    return `📜 No tengo ninguna efeméride apuntada para un ${fecha}.`;
  }
}

module.exports = { reporte, delDia };
