'use strict';

/**
 * Orla conmemorativa del grupo: una imagen con el nombre del grupo y las
 * fotos + nombres de sus miembros, al estilo de una orla de graduación.
 *
 * Se renderiza como HTML/CSS y se captura con el Chromium que ya está
 * abierto para WhatsApp Web (no se lanza otro navegador). No usa IA: es
 * determinista y no consume API.
 *
 * Las fotos de perfil dependen de la privacidad de cada usuario: si no
 * está disponible, se dibuja un avatar con sus iniciales.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ANCHO = parseInt(process.env.ORLA_WIDTH || '1100', 10);

// Colores para los avatares de reserva (iniciales).
const COLORES = [
  '#7f5539', '#495867', '#5f7470', '#8d5a5a', '#3f4d6b',
  '#6b5b95', '#4a6741', '#8a6d3b', '#5c5470', '#7d6b7d',
];

function esc(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  );
}

function iniciales(nombre) {
  const partes = String(nombre || '?')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (partes.length === 0) return '?';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[1][0]).toUpperCase();
}

function colorDe(texto) {
  let h = 0;
  for (const c of String(texto || '')) h = (h * 31 + c.charCodeAt(0)) % 997;
  return COLORES[h % COLORES.length];
}

/** Rejilla adaptada al número de miembros. */
function dimensiones(n) {
  if (n <= 6) return { cols: 3, foto: 190, nombre: 21 };
  if (n <= 12) return { cols: 4, foto: 165, nombre: 19 };
  if (n <= 24) return { cols: 5, foto: 140, nombre: 17 };
  if (n <= 40) return { cols: 6, foto: 118, nombre: 15 };
  if (n <= 60) return { cols: 7, foto: 100, nombre: 13 };
  return { cols: 8, foto: 88, nombre: 12 };
}

function html({ titulo, subtitulo, pie, fotoGrupo, miembros }) {
  const { cols, foto, nombre } = dimensiones(miembros.length);

  const celdas = miembros
    .map((m) => {
      const ini = iniciales(m.nombre);
      const col = colorDe(m.nombre || m.id);
      const img = m.foto
        ? `<img src="${esc(m.foto)}" class="foto"
             onerror="this.parentNode.innerHTML='<div class=&quot;ini&quot; style=&quot;background:${col}&quot;>${esc(
            ini
          )}</div>'">`
        : `<div class="ini" style="background:${col}">${esc(ini)}</div>`;
      return `<div class="celda">
        <div class="marco">${img}</div>
        <div class="nombre">${esc(m.nombre)}</div>
      </div>`;
    })
    .join('');

  const medallon = fotoGrupo
    ? `<div class="medallon"><img src="${esc(fotoGrupo)}"
         onerror="this.style.display='none'"></div>`
    : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    width:${ANCHO}px;
    font-family:"Liberation Serif","DejaVu Serif",Georgia,serif;
    background:
      radial-gradient(circle at 50% 0%, #fdf8ee 0%, #f3e9d6 55%, #e8dcc3 100%);
    color:#2f2416; padding:46px 40px 34px;
  }
  .lamina{border:3px double #b08d57; padding:34px 26px 26px; position:relative}
  .lamina:before{content:"";position:absolute;inset:9px;border:1px solid #cbb083}
  .cabecera{text-align:center;margin-bottom:8px;position:relative}
  .kicker{font-size:16px;letter-spacing:6px;text-transform:uppercase;
    color:#8a6d3b;margin-bottom:8px}
  h1{font-size:52px;line-height:1.1;font-weight:700;letter-spacing:.5px}
  .sub{font-size:19px;color:#6b5a3e;margin-top:8px;font-style:italic}
  .medallon{margin:18px auto 0;width:104px;height:104px;border-radius:50%;
    overflow:hidden;border:3px solid #b08d57;background:#fff}
  .medallon img{width:100%;height:100%;object-fit:cover;display:block}
  .filete{width:170px;height:2px;background:#b08d57;margin:22px auto 26px;
    position:relative}
  .filete:after{content:"❧";position:absolute;top:-13px;left:50%;
    transform:translateX(-50%);background:#f7efe0;padding:0 10px;
    color:#b08d57;font-size:17px}
  .rejilla{display:grid;grid-template-columns:repeat(${cols},1fr);
    gap:26px 14px;justify-items:center}
  .celda{text-align:center;width:100%}
  .marco{width:${foto}px;height:${foto}px;margin:0 auto 9px;border-radius:50%;
    overflow:hidden;border:3px solid #b08d57;background:#fff;
    box-shadow:0 3px 9px rgba(0,0,0,.16)}
  .foto{width:100%;height:100%;object-fit:cover;display:block}
  .ini{width:100%;height:100%;display:flex;align-items:center;
    justify-content:center;color:#fff;font-size:${Math.round(foto * 0.34)}px;
    font-weight:700;letter-spacing:1px}
  .nombre{font-size:${nombre}px;line-height:1.25;font-weight:600;
    word-break:break-word;padding:0 3px}
  .pie{text-align:center;margin-top:30px;font-size:14px;color:#8a6d3b;
    letter-spacing:1.5px}
  </style></head><body>
  <div class="lamina">
    <div class="cabecera">
      <div class="kicker">Orla conmemorativa</div>
      <h1>${esc(titulo)}</h1>
      ${subtitulo ? `<div class="sub">${esc(subtitulo)}</div>` : ''}
      ${medallon}
    </div>
    <div class="filete"></div>
    <div class="rejilla">${celdas}</div>
    <div class="pie">${esc(pie)}</div>
  </div>
  </body></html>`;
}

/**
 * Crea la orla.
 * @param {Function} getBrowser  navegador de Puppeteer ya abierto
 * @param {object} datos {titulo, subtitulo, pie, fotoGrupo, miembros[]}
 * @returns {Promise<{path,mimetype,caption}>}
 */
async function crearOrla(getBrowser, datos) {
  if (!datos.miembros || datos.miembros.length === 0) {
    throw new Error('No he podido obtener los miembros del grupo');
  }

  const browser = getBrowser();
  if (!browser) throw new Error('El navegador de WhatsApp no está listo');

  const page = await browser.newPage();
  try {
    await page.setViewport({ width: ANCHO, height: 900, deviceScaleFactor: 1 });
    await page.setContent(html(datos), { waitUntil: 'load' });
    // Margen para que terminen de descargarse las fotos de perfil.
    await page
      .waitForNetworkIdle({ idleTime: 700, timeout: 20000 })
      .catch(() => {});

    const destino = path.join(os.tmpdir(), `orla-${Date.now()}.png`);
    await page.screenshot({ path: destino, fullPage: true, type: 'png' });

    return {
      path: destino,
      mimetype: 'image/png',
      caption: `🎓 ${datos.titulo}`,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { crearOrla, iniciales };
