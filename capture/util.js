'use strict';

/**
 * Utilidades compartidas. Antes estaban duplicadas en media docena de
 * ficheros, con pequeñas variaciones que ya habían causado algún fallo.
 */

/** Minúsculas y sin tildes: la forma canónica para comparar texto. */
function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/** Solo los dígitos de un identificador de WhatsApp (34600...@c.us / @lid). */
function soloDigitos(id) {
  return String(id || '').split('@')[0].replace(/\D/g, '');
}

/** ¿Coincide el autor con alguno de la lista, sea cual sea el formato? */
function mismoNumero(a, b) {
  const x = soloDigitos(a);
  return x !== '' && x === soloDigitos(b);
}

/**
 * Limitador por clave con purga automática.
 * El anterior guardaba una entrada por usuario para siempre; en un bot que
 * corre meses, eso es una fuga de memoria lenta pero segura.
 */
function crearLimitador(porHora) {
  const mapa = new Map();
  let ultimaPurga = Date.now();

  return function permitir(clave, limite = porHora) {
    const ahora = Date.now();
    const desde = ahora - 3600_000;

    // Purga perezosa: cada 10 minutos se tiran las claves inactivas.
    if (ahora - ultimaPurga > 600_000) {
      for (const [k, v] of mapa) {
        const vivos = v.filter((t) => t > desde);
        if (vivos.length === 0) mapa.delete(k);
        else mapa.set(k, vivos);
      }
      ultimaPurga = ahora;
    }

    const usos = (mapa.get(clave) || []).filter((t) => t > desde);
    if (usos.length >= limite) return false;
    usos.push(ahora);
    mapa.set(clave, usos);
    return true;
  };
}

/**
 * Caché de sentencias preparadas.
 * better-sqlite3 recomienda preparar una vez y reutilizar: hacerlo en cada
 * llamada obliga a SQLite a analizar el SQL una y otra vez.
 */
const sentencias = new WeakMap();

function stmt(db, sql) {
  let porDb = sentencias.get(db);
  if (!porDb) {
    porDb = new Map();
    sentencias.set(db, porDb);
  }
  let s = porDb.get(sql);
  if (!s) {
    s = db.prepare(sql);
    porDb.set(sql, s);
  }
  return s;
}

module.exports = { norm, soloDigitos, mismoNumero, crearLimitador, stmt };
