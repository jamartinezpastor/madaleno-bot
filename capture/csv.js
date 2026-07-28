'use strict';

/**
 * Parser CSV mínimo pero robusto, compartido por todo el bot.
 * Soporta: comillas dobles ("a,b"), comillas escapadas (""), separador
 * coma o punto y coma (autodetectado), BOM de Excel y cabecera opcional.
 *
 * Todos los datos del bot (conocimiento, cumpleaños, efemérides) usan CSV
 * para poder editarlos desde la interfaz de Coolify sin entrar por SSH.
 */

const fs = require('fs');

function detectDelimiter(line) {
  const commas = (line.match(/,/g) || []).length;
  const semis = (line.match(/;/g) || []).length;
  return semis > commas ? ';' : ',';
}

function splitLine(line, delim) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out;
}

/**
 * Parsea texto CSV.
 * @returns {{headers: string[]|null, rows: string[][], objects: object[]}}
 */
function parse(text) {
  const clean = text.replace(/^\uFEFF/, ''); // BOM de Excel
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#')); // permite comentarios con #
  if (lines.length === 0) return { headers: null, rows: [], objects: [] };

  const delim = detectDelimiter(lines[0]);
  const all = lines.map((l) => splitLine(l, delim));

  // ¿La primera fila es cabecera? Lo es si NO contiene números sueltos
  // típicos de datos (dia/mes) y sí palabras.
  const first = all[0].map((s) => s.toLowerCase());
  const looksLikeHeader =
    first.some((h) =>
      /nombre|name|fecha|dia|día|mes|month|day|pregunta|respuesta|tema|clave|valor|dato|acontecimiento|evento|hecho|a[nñ]o|year|descripcion|descripción/.test(
        h
      )
    ) && !first.every((h) => /^\d+$/.test(h));

  const headers = looksLikeHeader ? all[0] : null;
  const rows = looksLikeHeader ? all.slice(1) : all;
  const objects = headers
    ? rows.map((r) => {
        const o = {};
        headers.forEach((h, i) => {
          o[h.toLowerCase()] = r[i] !== undefined ? r[i] : '';
        });
        return o;
      })
    : [];

  return { headers, rows, objects };
}

function parseFile(filePath) {
  return parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Busca el valor de una columna probando varios nombres posibles.
 * Ej: get(obj, ['nombre','name']) -> valor de la que exista.
 */
function get(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== '') return obj[k];
  }
  return undefined;
}

module.exports = { parse, parseFile, get };
