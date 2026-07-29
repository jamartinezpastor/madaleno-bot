'use strict';

/**
 * Efemérides: acontecimientos que coinciden en día y mes.
 *
 * Los datos llegan ya cargados desde el CSV del grupo (groups.js), así que
 * cada grupo puede tener las suyas, además de las comunes a todos.
 *
 * Es determinista y gratis: no llama a la IA salvo que se active
 * EPHEMERIS_FALLBACK_AI=true y no haya nada para hoy.
 */

const gemini = require('./gemini');

const FALLBACK_AI =
  String(process.env.EPHEMERIS_FALLBACK_AI || 'false').toLowerCase() === 'true';

/** Filtra las efemérides de un día concreto (por defecto, hoy). */
function delDia(efemerides, when = new Date()) {
  const day = when.getDate();
  const month = when.getMonth() + 1;
  return (efemerides || [])
    .filter((e) => e.day === day && e.month === month)
    .sort((a, b) => (a.year || 0) - (b.year || 0));
}

/** Texto listo para enviar al grupo. */
async function reporte(efemerides, when = new Date()) {
  const fecha = when.toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'long',
  });
  const found = delDia(efemerides, when);

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
    return `📜 *Un ${fecha} como hoy...*\n${txt}\n_(no estaba en mis datos: conocimiento general, puede fallar)_`;
  } catch (e) {
    console.error('[efem] Fallback IA falló:', e.message);
    return `📜 No tengo ninguna efeméride apuntada para un ${fecha}.`;
  }
}

module.exports = { reporte, delDia };
