'use strict';

/**
 * Calendario del grupo. Unifica cumpleaños, eventos y efemérides.
 *
 * El almacenamiento sigue siendo el CSV del grupo (<id>.csv en data/docs/),
 * así que se puede editar igual desde Coolify. La novedad es que el bot
 * también escribe en él: cualquier admin puede dar de alta eventos desde
 * WhatsApp, sin tocar ficheros.
 *
 * Comandos (admins del grupo):
 *   @madaleno calendario                    -> próximos eventos
 *   @madaleno añade 3/10 Cena de empresa    -> alta
 *   @madaleno añade cumple 16/5 María       -> alta de cumpleaños
 *   @madaleno añade 1/9 Vuelta al cole sin aviso
 *   @madaleno borra 2                       -> baja (según la última lista)
 *
 * Cada evento tiene dos interruptores:
 *   repite: anual (todos los años) | unavez (solo esa fecha)
 *   aviso : si (el bot lo anuncia ese día en el grupo) | no
 */

const fs = require('fs');
const path = require('path');
const csv = require('./csv');

const CABECERA = 'tipo,dia,mes,anio,texto,repite,aviso';
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

// --- Fichero del grupo ---
function ficheroDe(docsDir, chatId) {
  const digitos = String(chatId).split('@')[0];
  return path.join(docsDir, `${digitos}.csv`);
}

// Escrituras en serie: dos altas simultáneas no deben pisarse.
let cola = Promise.resolve();
function enCola(fn) {
  const siguiente = cola.then(fn, fn);
  cola = siguiente.catch(() => {});
  return siguiente;
}

/** Escritura atómica: fichero temporal + rename. */
function escribir(ruta, contenido) {
  const tmp = `${ruta}.tmp`;
  fs.writeFileSync(tmp, contenido, 'utf8');
  fs.renameSync(tmp, ruta);
}

// --- Interpretación de fechas en lenguaje natural ---
function parseFecha(txt) {
  const t = norm(txt);
  const hoy = new Date();

  if (t === 'hoy') {
    return { day: hoy.getDate(), month: hoy.getMonth() + 1, year: hoy.getFullYear() };
  }
  if (t === 'manana' || t === 'mañana') {
    const d = new Date(hoy.getTime() + 86400000);
    return { day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear() };
  }

  // 16/5, 16-5-2026, 16.5.26
  let m = t.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?$/);
  if (m) {
    let year = m[3] ? parseInt(m[3], 10) : null;
    if (year && year < 100) year += 2000;
    return { day: +m[1], month: +m[2], year };
  }

  // "16 de mayo", "16 de mayo de 2026"
  m = t.match(/^(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?$/);
  if (m) {
    const mes = MESES.indexOf(m[2]) + 1;
    if (mes > 0) {
      return { day: +m[1], month: mes, year: m[3] ? parseInt(m[3], 10) : null };
    }
  }
  return null;
}

/**
 * Interpreta "añade [tipo] <fecha> <texto> [modificadores]".
 * Modificadores: "sin aviso", "con aviso", "cada año"/"anual", "una vez".
 */
function parseAlta(entrada) {
  let texto = entrada.trim();

  // Modificadores (se quitan del texto)
  let aviso = null;
  let repite = null;

  const quita = (re, accion) => {
    const m = texto.match(re);
    if (m) {
      accion();
      texto = (texto.slice(0, m.index) + ' ' + texto.slice(m.index + m[0].length)).trim();
    }
  };
  quita(/\bsin\s+aviso\b|\bsinaviso\b|\bsin\s+recordatorio\b/i, () => (aviso = false));
  quita(/\bcon\s+aviso\b|\bcon\s+recordatorio\b/i, () => (aviso = true));
  quita(/\bcada\s+a[nñ]o\b|\banual\b|\btodos\s+los\s+a[nñ]os\b/i, () => (repite = 'anual'));
  quita(/\buna\s+vez\b|\bunavez\b|\bsolo\s+este\s+a[nñ]o\b/i, () => (repite = 'unavez'));

  const palabras = texto.split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return { error: 'Falta la fecha y el texto.' };

  // ¿Tipo explícito al principio?
  let clase = 'evento';
  const primera = norm(palabras[0]);
  if (/^cumple/.test(primera)) {
    clase = 'cumple';
    palabras.shift();
  } else if (/^(evento|recordatorio)$/.test(primera)) {
    palabras.shift();
  } else if (/^efemerid/.test(primera)) {
    clase = 'efemeride';
    palabras.shift();
  }

  if (palabras.length === 0) return { error: 'Falta la fecha.' };

  // La fecha puede ser 1 token (16/5) o 3-5 ("16 de mayo [de 2026]")
  let fecha = null;
  let consumidos = 0;
  for (const n of [5, 3, 1]) {
    if (palabras.length >= n) {
      const cand = parseFecha(palabras.slice(0, n).join(' '));
      if (cand) {
        fecha = cand;
        consumidos = n;
        break;
      }
    }
  }
  if (!fecha) {
    return {
      error:
        'No entiendo la fecha. Usa `16/5`, `16/5/2026`, `16 de mayo`, `hoy` o `mañana`.',
    };
  }

  const cuerpo = palabras.slice(consumidos).join(' ').trim();
  if (!cuerpo) return { error: 'Falta el texto del evento.' };

  // El día debe existir en ese mes. Se admite el 29 de febrero (en años
  // no bisiestos, un evento anual simplemente no salta ese año).
  const DIAS_MES = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (fecha.month < 1 || fecha.month > 12) {
    return { error: 'Ese mes no existe.' };
  }
  if (fecha.day < 1 || fecha.day > DIAS_MES[fecha.month - 1]) {
    return {
      error: `El ${fecha.day} de ${MESES[fecha.month - 1]} no existe.`,
    };
  }
  // Con año concreto, se comprueba la fecha real (29/2/2027 no existe).
  if (fecha.year) {
    const d = new Date(fecha.year, fecha.month - 1, fecha.day);
    if (d.getMonth() + 1 !== fecha.month || d.getDate() !== fecha.day) {
      return {
        error: `El ${fecha.day}/${fecha.month}/${fecha.year} no existe.`,
      };
    }
  }

  // Valores por defecto coherentes con el tipo
  if (repite === null) {
    repite = clase === 'evento' && fecha.year ? 'unavez' : 'anual';
  }
  if (aviso === null) aviso = clase !== 'efemeride';
  // Un evento "unavez" necesita año para saber cuándo caduca
  const year =
    fecha.year || (repite === 'unavez' ? new Date().getFullYear() : null);

  return { evento: { clase, texto: cuerpo, day: fecha.day, month: fecha.month, year, repite, aviso } };
}

/** Da de alta un evento en el CSV del grupo. */
function añadir(docsDir, chatId, entrada) {
  const parsed = parseAlta(entrada);
  if (parsed.error) return { error: parsed.error };
  const e = parsed.evento;

  return enCola(() => {
    const ruta = ficheroDe(docsDir, chatId);
    let contenido = '';
    if (fs.existsSync(ruta)) {
      contenido = fs.readFileSync(ruta, 'utf8').replace(/\s*$/, '\n');
    }
    if (!contenido.trim()) {
      contenido = `# Calendario del grupo. Lo edita el bot y también puedes\n# editarlo a mano desde Coolify.\n${CABECERA}\n`;
    } else if (!/^\s*tipo\s*,/im.test(contenido)) {
      // Fichero antiguo sin cabecera compatible: se añade
      contenido = `${CABECERA}\n${contenido}`;
    }

    contenido +=
      csv.linea([
        e.clase,
        e.day,
        e.month,
        e.year || '',
        e.texto,
        e.repite,
        e.aviso ? 'si' : 'no',
      ]) + '\n';

    escribir(ruta, contenido);
    return { evento: e, fichero: path.basename(ruta) };
  });
}

/** Borra un evento del CSV del grupo (por su contenido exacto). */
function borrar(docsDir, chatId, evento) {
  return enCola(() => {
    const ruta = ficheroDe(docsDir, chatId);
    if (!fs.existsSync(ruta)) {
      return { error: 'Ese evento no está en el fichero de este grupo.' };
    }
    const lineas = fs.readFileSync(ruta, 'utf8').split(/\r?\n/);
    const objetivo = norm(evento.texto);
    let idx = -1;
    for (let i = 0; i < lineas.length; i++) {
      const l = lineas[i];
      if (!l.trim() || l.trim().startsWith('#')) continue;
      const campos = csv.campos(l);
      if (
        campos.length >= 5 &&
        norm(campos[0]).startsWith(evento.clase.slice(0, 6)) &&
        parseInt(campos[1], 10) === evento.day &&
        parseInt(campos[2], 10) === evento.month &&
        norm(campos[4]) === objetivo
      ) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      return {
        error:
          'No lo encuentro en el fichero de este grupo. Si viene de un ' +
          'fichero común, hay que quitarlo desde Coolify.',
      };
    }
    lineas.splice(idx, 1);
    escribir(ruta, lineas.join('\n').replace(/\n+$/, '\n'));
    return { ok: true };
  });
}

// --- Consulta ---
function diasHasta(evento, desde = new Date()) {
  const hoy = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate());
  let objetivo;
  if (evento.repite === 'unavez') {
    if (!evento.year) return null;
    objetivo = new Date(evento.year, evento.month - 1, evento.day);
    if (objetivo < hoy) return null; // ya pasó y no se repite
  } else {
    objetivo = new Date(hoy.getFullYear(), evento.month - 1, evento.day);
    if (objetivo < hoy) objetivo = new Date(hoy.getFullYear() + 1, evento.month - 1, evento.day);
  }
  return Math.round((objetivo - hoy) / 86400000);
}

const ICONO = { cumple: '🎂', evento: '📅', efemeride: '📜' };

/** Próximos eventos ordenados por cercanía. */
function proximos(cfg, dias = 60) {
  return (cfg.calendario || [])
    .map((e) => ({ ...e, en: diasHasta(e) }))
    .filter((e) => e.en !== null && e.en <= dias)
    .sort((a, b) => a.en - b.en);
}

function cuando(e) {
  if (e.en === 0) return 'hoy';
  if (e.en === 1) return 'mañana';
  const f = `${String(e.day).padStart(2, '0')}/${String(e.month).padStart(2, '0')}`;
  return `${f} (en ${e.en} días)`;
}

function informe(cfg, dias = 60, opciones = {}) {
  const lista = proximos(cfg, dias);
  const total = (cfg.calendario || []).length;

  if (lista.length === 0) {
    if (total === 0) {
      return opciones.publico
        ? '🗓️ No hay nada apuntado en el calendario del grupo.'
        : '🗓️ El calendario está vacío. Añade algo: `@madaleno añade 16/5 Lo que sea`.';
    }
    return `🗓️ Nada en los próximos ${dias} días (hay ${total} entradas en total).`;
  }

  const lineas = lista.map((e, i) => {
    const marcas = [];
    if (e.repite === 'anual') marcas.push('cada año');
    if (!e.aviso) marcas.push('sin aviso');
    const extra = marcas.length ? ` _(${marcas.join(', ')})_` : '';
    return `*${i + 1}.* ${ICONO[e.clase] || '•'} ${cuando(e)} — ${e.texto}${extra}`;
  });

  const pie = opciones.conAyuda
    ? '\n\n_Alta: `añade 3/10 Cena` · Baja: `borra 2`_'
    : '';
  return (
    `🗓️ *Próximos ${dias} días*\n` + lineas.join('\n') + pie
  );
}

module.exports = { informe, proximos, añadir, borrar, parseAlta, diasHasta };
