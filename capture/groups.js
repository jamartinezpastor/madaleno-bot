'use strict';

/**
 * Configuración y datos POR GRUPO, leídos de los CSV de data/docs/.
 *
 * Cada fichero puede declarar a qué grupo pertenece. Añadir el bot a un
 * grupo nuevo = crear un CSV nuevo; no hace falta tocar variables de
 * entorno ni redesplegar.
 *
 * Formato (el nombre del fichero es libre: trabajo.csv, padel.csv...):
 *
 *   tipo,dia,mes,anio,texto
 *   grupo,,,,120363011112222@g.us     <- id del grupo (o su nombre exacto)
 *   admin,,,,34699111222@c.us         <- quién puede dar órdenes AQUÍ
 *   cumple,16,5,,María García
 *   evento,1,9,,Vuelta al cole        <- sin año = todos los años
 *   evento,3,10,2026,Cena de empresa  <- con año = solo ese día
 *   efemeride,20,7,1969,El Apolo 11 llega a la Luna
 *   dato,,,,Horario de oficina: de 9 a 17h
 *
 * Un fichero SIN línea "grupo" se considera común: se aplica a todos los
 * grupos. Útil para efemérides históricas o datos generales.
 *
 * Compatibilidad: los CSV del formato antiguo (cumples.csv con
 * nombre,dia,mes; efemerides.csv con dia,mes,anio,acontecimiento; y
 * cualquier otro como datos) se siguen leyendo y se tratan como comunes.
 */

const fs = require('fs');
const path = require('path');
const csv = require('./csv');
const util = require('./util');

let cache = { mtimeSum: -1, ficheros: [] };

const normaliza = util.norm;

function esIdGrupo(s) {
  return /@g\.us\s*$/.test(String(s || ''));
}

function parseFecha(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { day: +m[3], month: +m[2], year: +m[1] };
  m = t.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (m) return { day: +m[1], month: +m[2], year: m[3] ? +m[3] : null };
  return null;
}

/** Lee un CSV en formato nuevo (con columna "tipo"). */
function leerUnificado(parsed) {
  const cfg = {
    grupoId: null,
    cumples: [],
    eventos: [],
    efemerides: [],
    datos: [],
    nombres: {}, // telefono -> nombre a mostrar (para la orla)
    calendario: [], // eventos unificados (cumple/evento/efemeride)
  };

  for (const fila of parsed.objects) {
    const tipo = normaliza(csv.get(fila, ['tipo']));
    const texto = csv.get(fila, ['texto', 'nombre', 'dato', 'valor']) || '';
    const dia = parseInt(csv.get(fila, ['dia', 'día', 'day']), 10);
    const mes = parseInt(csv.get(fila, ['mes', 'month']), 10);
    const anio = csv.get(fila, ['anio', 'año', 'ano', 'year']);
    const fechaLibre = csv.get(fila, ['fecha', 'date']);

    let d = dia;
    let m = mes;
    let y = anio ? parseInt(anio, 10) : null;
    if ((!d || !m) && fechaLibre) {
      const p = parseFecha(fechaLibre);
      if (p) {
        d = p.day;
        m = p.month;
        y = y || p.year;
      }
    }
    const fechaOk = d >= 1 && d <= 31 && m >= 1 && m <= 12;

    switch (tipo) {
      // 'grupo' y 'admin' ya no se usan: el grupo lo determina el nombre
      // del fichero y los admins los da WhatsApp. Se ignoran en silencio
      // para no romper ficheros antiguos.
      case 'grupo':
      case 'admin':
        break;
      case 'cumple':
      case 'cumpleanos':
      case 'cumpleaños':
      case 'evento':
      case 'recordatorio':
      case 'efemeride':
      case 'efemerides': {
        if (!fechaOk || !texto) break;
        const clase = tipo.startsWith('cumple')
          ? 'cumple'
          : tipo.startsWith('efemerid')
            ? 'efemeride'
            : 'evento';

        // repite: "anual" (todos los años) o "unavez" (solo esa fecha).
        // Por defecto: los cumpleaños y efemérides son anuales; un evento
        // con año concreto ocurre una sola vez.
        const repiteCol = normaliza(csv.get(fila, ['repite', 'repeticion', 'recurrente']));
        let repite = repiteCol.startsWith('anual') || repiteCol === 'si'
          ? 'anual'
          : repiteCol.startsWith('una') || repiteCol === 'no'
            ? 'unavez'
            : clase === 'evento' && y
              ? 'unavez'
              : 'anual';

        // aviso: ¿se anuncia en el grupo ese día? Por defecto sí, salvo
        // las efemérides (esas se consultan a demanda).
        const avisoCol = normaliza(csv.get(fila, ['aviso', 'recuerda', 'recordatorio_activo']));
        const aviso = avisoCol
          ? /^(si|s|1|true|yes)/.test(avisoCol)
          : clase !== 'efemeride';

        const entrada = {
          clase,
          texto,
          day: d,
          month: m,
          year: y || null,
          repite,
          aviso,
        };
        cfg.calendario.push(entrada);

        // Compatibilidad con los consumidores actuales
        if (clase === 'cumple') cfg.cumples.push({ name: texto, day: d, month: m, aviso });
        else if (clase === 'efemeride') cfg.efemerides.push(entrada);
        else cfg.eventos.push(entrada);
        break;
      }
      case 'nombre': {
        // "nombre,,,,34699111222 | María García" (también vale "=")
        const partes = String(texto).split(/\s*[|=]\s*/);
        if (partes.length >= 2) {
          const tel = partes[0].replace(/\D/g, '');
          const comoSeLlama = partes.slice(1).join(' ').trim();
          if (tel && comoSeLlama) cfg.nombres[tel] = comoSeLlama;
        }
        break;
      }
      case 'dato':
      case 'info':
        if (texto) cfg.datos.push(texto);
        break;
      default:
        // Fila sin tipo reconocido: se aprovecha como dato suelto.
        if (texto) cfg.datos.push(texto);
    }
  }
  return cfg;
}

/** Lee un CSV del formato antiguo, deducido por el nombre del fichero. */
function leerLegado(fichero, parsed) {
  const cfg = {
    grupoId: null,
    cumples: [],
    eventos: [],
    efemerides: [],
    datos: [],
    nombres: {},
    calendario: [],
  };
  const nombre = normaliza(fichero);

  const filas = parsed.objects.length
    ? parsed.objects
    : parsed.rows.map((r) => ({ c0: r[0], c1: r[1], c2: r[2], c3: r[3] }));

  for (const f of filas) {
    const dia = parseInt(csv.get(f, ['dia', 'día', 'day', 'c1']), 10);
    const mes = parseInt(csv.get(f, ['mes', 'month', 'c2']), 10);
    const anio = csv.get(f, ['anio', 'año', 'ano', 'year']);

    if (nombre.startsWith('cumple')) {
      const name = csv.get(f, ['nombre', 'name', 'c0']);
      let d = dia;
      let m = mes;
      const fecha = csv.get(f, ['fecha', 'date']);
      if ((!d || !m) && fecha) {
        const p = parseFecha(fecha);
        if (p) {
          d = p.day;
          m = p.month;
        }
      }
      if (name && d >= 1 && d <= 31 && m >= 1 && m <= 12) {
        cfg.cumples.push({ name, day: d, month: m, aviso: true });
        cfg.calendario.push({
          clase: 'cumple', texto: name, day: d, month: m,
          year: null, repite: 'anual', aviso: true,
        });
      }
    } else if (nombre.startsWith('efemerid')) {
      const texto = csv.get(f, [
        'acontecimiento',
        'evento',
        'hecho',
        'descripcion',
        'descripción',
        'texto',
        'c3',
      ]);
      if (texto && dia >= 1 && mes >= 1) {
        const e = {
          clase: 'efemeride', texto, day: dia, month: mes,
          year: anio ? parseInt(anio, 10) : null,
          repite: 'anual', aviso: false,
        };
        cfg.efemerides.push(e);
        cfg.calendario.push(e);
      }
    } else {
      // Cualquier otro CSV antiguo: conocimiento general.
      const partes = Object.entries(f)
        .filter(([, v]) => v !== '' && v !== undefined)
        .map(([k, v]) => `${k}: ${v}`);
      if (partes.length) cfg.datos.push(partes.join(' | '));
    }
  }
  return cfg;
}

/** Carga todos los CSV (con caché por fecha de modificación). */
function cargar(docsDir) {
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
    return [];
  }
  const ficheros = fs
    .readdirSync(docsDir)
    .filter((f) => f.toLowerCase().endsWith('.csv'));

  let mtimeSum = 0;
  for (const f of ficheros) {
    mtimeSum += Math.floor(fs.statSync(path.join(docsDir, f)).mtimeMs);
  }
  if (mtimeSum === cache.mtimeSum) return cache.ficheros;

  const salida = [];
  for (const f of ficheros) {
    try {
      const parsed = csv.parseFile(path.join(docsDir, f));
      const tieneTipo =
        parsed.headers && parsed.headers.some((h) => normaliza(h) === 'tipo');
      const cfg = tieneTipo ? leerUnificado(parsed) : leerLegado(f, parsed);
      cfg.fichero = f;

      // ÚNICA forma de asociar un CSV a un grupo: el nombre del fichero
      // es el id del grupo ("120363011112222.csv", con o sin @g.us).
      // Cualquier otro nombre = fichero común a todos los grupos.
      const base = f.replace(/\.csv$/i, '').trim();
      if (esIdGrupo(base)) cfg.grupoId = base;
      else if (/^[\d-]{5,}$/.test(base)) cfg.grupoId = `${base}@g.us`;

      salida.push(cfg);
    } catch (e) {
      console.error(`[grupos] No pude leer ${f}:`, e.message);
    }
  }

  cache = { mtimeSum, ficheros: salida };
  const conGrupo = salida.filter((c) => c.grupoId);
  console.log(
    `[grupos] ${salida.length} CSV cargados ` +
      `(${conGrupo.length} de grupo, ${salida.length - conGrupo.length} comunes)`
  );
  return salida;
}

/** ¿Este fichero es de este chat? Solo por id. */
function esDeEsteChat(cfg, chatId) {
  return !!cfg.grupoId && cfg.grupoId === chatId;
}

/**
 * Configuración efectiva de un chat: lo común + lo propio del grupo.
 * Común (todos los CSV sueltos) + lo propio del grupo, si tiene fichero.
 */
function paraChat(docsDir, chatId) {
  const todos = cargar(docsDir);
  // Comunes = todos los CSV que no son de un grupo concreto.
  const comunes = todos.filter((c) => !c.grupoId);
  const propios = todos.filter((c) => esDeEsteChat(c, chatId));

  const unir = (clave) =>
    [...comunes, ...propios].flatMap((c) => c[clave] || []);

  const nombres = Object.assign(
    {},
    ...comunes.map((c) => c.nombres || {}),
    ...propios.map((c) => c.nombres || {})
  );

  return {
    tieneFichero: propios.length > 0,
    ficheros: propios.map((c) => c.fichero),
    nombres,
    calendario: unir('calendario'),
    cumples: unir('cumples'),
    eventos: unir('eventos'),
    efemerides: unir('efemerides'),
    datos: unir('datos'),
  };
}

/** Grupos que tienen CSV propio (para los avisos diarios). */
function gruposConFichero(docsDir) {
  return cargar(docsDir)
    .filter((c) => c.grupoId)
    .map((c) => ({ grupoId: c.grupoId, fichero: c.fichero }));
}

module.exports = { cargar, paraChat, gruposConFichero, esDeEsteChat };
