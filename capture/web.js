'use strict';

/**
 * Interfaz web del calendario del grupo.
 *
 * Servidor propio y SEPARADO del HTTP interno (puerto 3000, que sigue
 * atado a localhost y expone cosas sensibles como /send). Aquí solo hay
 * calendario, y toda ruta exige un token firmado válido, así que se puede
 * publicar en Internet detrás de Coolify/Traefik con HTTPS.
 *
 * Es HTML renderizado en el servidor: sin frameworks ni build, funciona en
 * cualquier móvil y no requiere JavaScript.
 */

const express = require('express');
const tokens = require('./token');
const groups = require('./groups');
const calendario = require('./calendario');

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function esc(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

const ICONO = { cumple: '🎂', evento: '📅', efemeride: '📜' };

function pagina({ titulo, cuerpo, aviso }) {
  return `<!doctype html><html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(titulo)}</title>
<style>
  :root{--fondo:#f6f4ef;--tarjeta:#fff;--borde:#e2ddd2;--texto:#2c2519;
        --suave:#7a6f5d;--acento:#6b5b95;--peligro:#a3564f}
  *{box-sizing:border-box}
  body{margin:0;padding:16px;background:var(--fondo);color:var(--texto);
    font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .caja{max-width:560px;margin:0 auto}
  h1{font-size:21px;margin:0 0 2px}
  .sub{color:var(--suave);font-size:14px;margin-bottom:18px}
  .aviso{background:#e8f3e8;border:1px solid #c3ddc3;padding:10px 12px;
    border-radius:10px;margin-bottom:14px;font-size:14px}
  .aviso.err{background:#fbeceb;border-color:#e8c4c1}
  ul{list-style:none;padding:0;margin:0 0 22px}
  li{background:var(--tarjeta);border:1px solid var(--borde);border-radius:12px;
    padding:11px 13px;margin-bottom:9px;display:flex;align-items:center;gap:11px}
  .cuando{font-weight:600;min-width:66px;font-variant-numeric:tabular-nums}
  .qué{flex:1}
  .marcas{color:var(--suave);font-size:12.5px;margin-top:2px}
  button{font:inherit;border:0;border-radius:9px;padding:9px 13px;cursor:pointer}
  .borrar{background:transparent;color:var(--peligro);border:1px solid #e8c4c1;
    padding:7px 11px;font-size:14px}
  form.alta{background:var(--tarjeta);border:1px solid var(--borde);
    border-radius:12px;padding:15px}
  label{display:block;font-size:13px;color:var(--suave);margin:11px 0 4px}
  input,select{width:100%;font:inherit;padding:10px;border:1px solid var(--borde);
    border-radius:9px;background:#fff;color:inherit}
  .fila{display:flex;gap:9px}
  .fila>div{flex:1}
  .check{display:flex;align-items:center;gap:9px;margin-top:14px;font-size:15px}
  .check input{width:auto}
  .enviar{background:var(--acento);color:#fff;width:100%;margin-top:16px;
    padding:13px;font-weight:600;font-size:16px}
  .pie{color:var(--suave);font-size:12.5px;margin-top:20px;text-align:center}
  .vacio{color:var(--suave);font-style:italic;padding:6px 0 16px}
</style></head><body><div class="caja">
${aviso ? `<div class="aviso${aviso.err ? ' err' : ''}">${esc(aviso.texto)}</div>` : ''}
${cuerpo}
</div></body></html>`;
}

function cuando(e) {
  if (e.en === 0) return 'hoy';
  if (e.en === 1) return 'mañana';
  return `${String(e.day).padStart(2, '0')}/${String(e.month).padStart(2, '0')}`;
}

function vistaCalendario({ nombreGrupo, cfg, token, aviso, caduca }) {
  const lista = calendario.proximos(cfg, 400);

  const items = lista
    .map((e) => {
      const marcas = [];
      marcas.push(e.repite === 'anual' ? 'cada año' : 'una vez');
      marcas.push(e.aviso ? 'avisa en el grupo' : 'sin aviso');
      if (e.en > 1) marcas.push(`en ${e.en} días`);
      // La baja se identifica por contenido, no por posición: así no se
      // borra otra cosa si la lista cambió mientras la página estaba abierta.
      const firma = [e.clase, e.day, e.month, e.texto].join('|');
      return `<li>
        <span class="cuando">${esc(cuando(e))}</span>
        <span class="qué">${ICONO[e.clase] || '•'} ${esc(e.texto)}
          <div class="marcas">${esc(marcas.join(' · '))}</div></span>
        <form method="post" action="/c/${encodeURIComponent(token)}/del">
          <input type="hidden" name="firma" value="${esc(firma)}">
          <button class="borrar" type="submit">Borrar</button>
        </form>
      </li>`;
    })
    .join('');

  const opcionesMes = MESES.map(
    (m, i) => `<option value="${i + 1}">${m}</option>`
  ).join('');

  const cuerpo = `
  <h1>🗓️ ${esc(nombreGrupo)}</h1>
  <div class="sub">Calendario del grupo · ${lista.length} entrada${lista.length === 1 ? '' : 's'}</div>

  ${items ? `<ul>${items}</ul>` : '<div class="vacio">Todavía no hay nada apuntado.</div>'}

  <form class="alta" method="post" action="/c/${encodeURIComponent(token)}/add">
    <strong>Añadir</strong>
    <label for="texto">Qué es</label>
    <input id="texto" name="texto" required maxlength="120"
      placeholder="Cena de empresa, cumple de María...">
    <div class="fila">
      <div>
        <label for="dia">Día</label>
        <input id="dia" name="dia" type="number" min="1" max="31" required inputmode="numeric">
      </div>
      <div>
        <label for="mes">Mes</label>
        <select id="mes" name="mes">${opcionesMes}</select>
      </div>
    </div>
    <label for="clase">Tipo</label>
    <select id="clase" name="clase">
      <option value="evento">📅 Evento</option>
      <option value="cumple">🎂 Cumpleaños</option>
      <option value="efemeride">📜 Efeméride</option>
    </select>
    <label for="repite">¿Se repite?</label>
    <select id="repite" name="repite">
      <option value="anual">Cada año</option>
      <option value="unavez">Solo una vez</option>
    </select>
    <label for="anio">Año <span style="opacity:.7">(para "solo una vez", o el año histórico de una efeméride)</span></label>
    <input id="anio" name="anio" type="number" min="1000" max="2999" inputmode="numeric" placeholder="opcional">
    <div class="check">
      <input id="aviso" name="aviso" type="checkbox" value="1" checked>
      <label for="aviso" style="margin:0;color:inherit;font-size:15px">
        Avisar en el grupo ese día</label>
    </div>
    <button class="enviar" type="submit">Guardar</button>
  </form>

  <div class="pie">Enlace privado, válido hasta ${esc(caduca)}.<br>
  No lo compartas: quien lo tenga puede editar este calendario.</div>`;

  return pagina({ titulo: `Calendario · ${nombreGrupo}`, cuerpo, aviso });
}

function paginaError(texto) {
  return pagina({
    titulo: 'Enlace no válido',
    cuerpo: `<h1>Enlace no válido</h1>
      <div class="sub">${esc(texto)}</div>
      <p>Pide uno nuevo al bot por privado con <strong>@madaleno web</strong>.</p>`,
  });
}

/**
 * Arranca el servidor web.
 * @param {object} deps { db, docsDir, secreto, nombreDeGrupo(chatId), puerto }
 */
function arrancar({ db, docsDir, secreto, nombreDeGrupo, puerto, onCambio }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  // Toda ruta pasa por aquí: sin token válido no hay nada que ver.
  function auth(req, res, next) {
    const datos = tokens.verificar(secreto, req.params.token);
    if (!datos) {
      res.status(403).send(paginaError('Ha caducado o no es correcto.'));
      return;
    }
    req.acceso = datos;
    next();
  }

  const render = async (req, res, aviso) => {
    const cfg = groups.paraChat(docsDir, req.acceso.chatId);
    const nombreGrupo = (await nombreDeGrupo(req.acceso.chatId)) || 'Grupo';
    res.send(
      vistaCalendario({
        nombreGrupo,
        cfg,
        token: req.params.token,
        aviso,
        caduca: new Date(req.acceso.exp).toLocaleString('es-ES', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }),
      })
    );
  };

  app.get('/c/:token', auth, (req, res) => render(req, res, null));

  app.post('/c/:token/add', auth, async (req, res) => {
    const b = req.body || {};
    const texto = String(b.texto || '').trim().slice(0, 120);
    const dia = parseInt(b.dia, 10);
    const mes = parseInt(b.mes, 10);
    const anio = b.anio ? parseInt(b.anio, 10) : null;
    const clase = ['evento', 'cumple', 'efemeride'].includes(b.clase)
      ? b.clase
      : 'evento';
    const repite = b.repite === 'unavez' ? 'unavez' : 'anual';
    const aviso = b.aviso === '1';

    if (!texto || !dia || !mes) {
      return render(req, res, { texto: 'Faltan datos.', err: true });
    }

    // Se reutiliza el mismo camino que los comandos de WhatsApp para que
    // las validaciones (fechas imposibles, escritura atómica) sean idénticas.
    const frase =
      `${clase} ${dia}/${mes}${anio ? '/' + anio : ''} ${texto}` +
      (repite === 'anual' ? ' cada año' : ' una vez') +
      (aviso ? ' con aviso' : ' sin aviso');

    const r = await calendario.añadir(docsDir, req.acceso.chatId, frase);
    if (!r.error && onCambio) {
      onCambio({
        chatId: req.acceso.chatId,
        userId: req.acceso.userId,
        accion: 'añadió',
        texto: r.evento.texto,
      }).catch(() => {});
    }
    return render(
      req,
      res,
      r.error
        ? { texto: r.error, err: true }
        : { texto: `Añadido: ${r.evento.texto}` }
    );
  });

  app.post('/c/:token/del', auth, async (req, res) => {
    const partes = String((req.body || {}).firma || '').split('|');
    if (partes.length < 4) {
      return render(req, res, { texto: 'No he podido identificarlo.', err: true });
    }
    const evento = {
      clase: partes[0],
      day: parseInt(partes[1], 10),
      month: parseInt(partes[2], 10),
      texto: partes.slice(3).join('|'),
    };
    const r = await calendario.borrar(docsDir, req.acceso.chatId, evento);
    if (!r.error && onCambio) {
      onCambio({
        chatId: req.acceso.chatId,
        userId: req.acceso.userId,
        accion: 'quitó',
        texto: evento.texto,
      }).catch(() => {});
    }
    return render(
      req,
      res,
      r.error ? { texto: r.error, err: true } : { texto: `Borrado: ${evento.texto}` }
    );
  });

  app.get('/', (_req, res) => res.status(404).send(paginaError('Falta el enlace.')));

  return app.listen(puerto, () =>
    console.log(`[web] Calendario web en :${puerto}`)
  );
}

module.exports = { arrancar };
