/**
 * Vault v10 — Escenarios + movimientos + meta + reinvertir + tope capital
 */

const STORAGE_KEY = 'vault_cdt_v11';
const TIPOS = [
  { value: 'compuesto_diario', label: 'Compuesto diario' },
  { value: 'compuesto_mensual', label: 'Compuesto mensual' },
  { value: 'compuesto_anual', label: 'Compuesto anual' },
  { value: 'simple', label: 'Simple (prorrateado)' },
  { value: 'unico', label: 'Único al vencimiento' },
];

let estado = { activoId: null, escenarios: [] };
let deleteTarget = null;
let detalleId = null;
let aporteEditId = null;
let nuevoDraft = null;

/* ---------- utils ---------- */
const fmt = (n) => {
  if (!Number.isFinite(n)) return '$0';
  return new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'COP',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(Math.round(n));
};
const fmtShort = (n) => {
  if (!Number.isFinite(n)) return '$0';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'k';
  return fmt(n);
};
function hoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + Number(days));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function num(v, fb = 0) { const n = parseFloat(v); return Number.isFinite(n) ? n : fb; }

/* ---------- escenario activo ---------- */
function esc() {
  return estado.escenarios.find((e) => e.id === estado.activoId) || estado.escenarios[0];
}
function fechaSim() { return esc()?.fechaSim || hoyISO(); }

function nuevoEscenario(nombre) {
  return {
    id: uid(),
    nombre: nombre || `Escenario ${String.fromCharCode(65 + estado.escenarios.length)}`,
    fechaSim: hoyISO(),
    aportes: [{ id: uid(), fecha: hoyISO(), monto: 5e7, nota: 'Capital inicial' }],
    bolsillos: [],
    meta: { fecha: '', monto: 0 },
  };
}

/* ---------- motor ---------- */
function diasPlazo(b) {
  if (b.fechaInicio && b.fechaFin) return Math.max(0, daysBetween(b.fechaInicio, b.fechaFin));
  return Math.max(0, num(b.dias));
}
function valorBrutoEnDias(capital, tasaAnual, tipo, nDias) {
  if (nDias <= 0 || capital <= 0) return capital;
  const r = (tasaAnual || 0) / 100;
  switch (tipo) {
    case 'compuesto_diario': return capital * Math.pow(1 + r / 365, nDias);
    case 'compuesto_mensual': return capital * Math.pow(1 + r / 12, nDias / 30.4167);
    case 'compuesto_anual': return capital * Math.pow(1 + r, nDias / 365);
    default: return capital * (1 + r * (nDias / 365));
  }
}
function snapshotCDT(b, fecha) {
  const capital = num(b.capital);
  const tasa = num(b.tasa);
  const retPct = num(b.retencion, 4) / 100;
  const dias = diasPlazo(b);
  const tipo = b.tipo || 'simple';
  const out = {
    capital, dias, estado: 'sin_iniciar', diasTranscurridos: 0,
    bruto: 0, retencion: 0, neto: 0, total: capital, totalFinal: capital,
  };
  if (!b.fechaInicio || capital <= 0 || dias <= 0) return out;
  const brutoFinal = valorBrutoEnDias(capital, tasa, tipo, dias) - capital;
  out.totalFinal = capital + (brutoFinal - brutoFinal * retPct);
  if (fecha < b.fechaInicio) return out;
  const vencido = !!(b.fechaFin && fecha >= b.fechaFin);
  const diasTrans = Math.min(Math.max(0, daysBetween(b.fechaInicio, fecha)), dias);
  out.diasTranscurridos = diasTrans;
  out.estado = vencido ? 'vencido' : 'activo';
  const n = vencido ? dias : diasTrans;
  const bruto = valorBrutoEnDias(capital, tasa, tipo, n) - capital;
  const retencion = bruto * retPct;
  const neto = bruto - retencion;
  out.bruto = bruto; out.retencion = retencion; out.neto = neto; out.total = capital + neto;
  return out;
}
function disponibleEn(fecha, excludeId = null) {
  if (!fecha) return 0;
  const e = esc();
  if (!e) return 0;
  let d = 0;
  (e.aportes || []).forEach((a) => {
    if (a.fecha && a.fecha <= fecha) d += num(a.monto);
  });
  (e.bolsillos || []).forEach((b) => {
    if (excludeId && b.id === excludeId) return;
    if (!b.fechaInicio) return;
    const cap = num(b.capital);
    if (b.fechaInicio <= fecha) d -= cap;
    if (b.fechaFin && b.fechaFin <= fecha && cap > 0) d += snapshotCDT(b, b.fechaFin).totalFinal;
  });
  return d;
}
function enCdtEn(fecha) {
  let s = 0;
  (esc()?.bolsillos || []).forEach((b) => {
    if (snapshotCDT(b, fecha).estado === 'activo') s += num(b.capital);
  });
  return s;
}
function rendimientoEn(fecha) {
  let s = 0;
  (esc()?.bolsillos || []).forEach((b) => {
    const snap = snapshotCDT(b, fecha);
    if (snap.estado === 'activo' || snap.estado === 'vencido') s += snap.neto;
  });
  return s;
}
function patrimonioEn(fecha) {
  let pat = disponibleEn(fecha);
  (esc()?.bolsillos || []).forEach((b) => {
    const snap = snapshotCDT(b, fecha);
    if (snap.estado === 'activo') pat += snap.total;
  });
  return pat;
}
function detectarSobregiro() {
  const e = esc();
  if (!e) return null;
  const fechas = new Set();
  (e.aportes || []).forEach((a) => { if (a.fecha) fechas.add(a.fecha); });
  (e.bolsillos || []).forEach((b) => {
    if (b.fechaInicio) fechas.add(b.fechaInicio);
    if (b.fechaFin) fechas.add(b.fechaFin);
  });
  for (const f of [...fechas].sort()) {
    const d = disponibleEn(f);
    if (d < -0.5) return { fecha: f, monto: d };
  }
  return null;
}
function syncPlazo(b, changed) {
  if (!b.fechaInicio) b.fechaInicio = fechaSim();
  if (changed === 'dias' || (changed === 'inicio' && b.modoPlazo === 'dias')) {
    b.dias = Math.max(1, parseInt(b.dias, 10) || 1);
    b.fechaFin = addDays(b.fechaInicio, b.dias);
  } else if (changed === 'fin' || (changed === 'inicio' && b.modoPlazo === 'fecha')) {
    if (b.fechaFin && b.fechaInicio) {
      let d = daysBetween(b.fechaInicio, b.fechaFin);
      if (d < 1) { d = 1; b.fechaFin = addDays(b.fechaInicio, 1); }
      b.dias = d;
    }
  } else if (changed === 'modo') {
    if (b.modoPlazo === 'dias') {
      b.dias = Math.max(1, parseInt(b.dias, 10) || 90);
      b.fechaFin = addDays(b.fechaInicio, b.dias);
    } else {
      if (!b.fechaFin) b.fechaFin = addDays(b.fechaInicio, b.dias || 90);
      b.dias = Math.max(1, daysBetween(b.fechaInicio, b.fechaFin));
    }
  }
}

/** Genera movimientos del escenario activo */
function generarMovimientos() {
  const e = esc();
  if (!e) return [];
  const events = [];

  (e.aportes || []).forEach((a) => {
    if (!a.fecha) return;
    events.push({
      fecha: a.fecha,
      tipo: 'aporte',
      signo: '+',
      monto: num(a.monto),
      nombre: a.nota || 'Aporte',
      refId: a.id,
      orden: 0,
    });
  });
  (e.bolsillos || []).forEach((b) => {
    if (b.fechaInicio && num(b.capital) > 0) {
      events.push({
        fecha: b.fechaInicio,
        tipo: 'inversion',
        signo: '−',
        monto: num(b.capital),
        nombre: b.nombre || 'CDT',
        refId: b.id,
        orden: 1,
      });
    }
    if (b.fechaFin && num(b.capital) > 0) {
      const fin = snapshotCDT(b, b.fechaFin);
      events.push({
        fecha: b.fechaFin,
        tipo: 'liberacion',
        signo: '+',
        monto: fin.totalFinal,
        nombre: (b.nombre || 'CDT') + ' (vencimiento)',
        refId: b.id,
        orden: 0,
        extra: `neto ${fmt(fin.neto)}`,
      });
    }
  });

  events.sort((a, b) => {
    if (a.fecha !== b.fecha) return a.fecha.localeCompare(b.fecha);
    return a.orden - b.orden;
  });

  // Disponible acumulado después de cada movimiento
  let running = 0;
  return events.map((ev) => {
    running += ev.signo === '+' ? ev.monto : -ev.monto;
    return { ...ev, saldo: running };
  });
}

/* ---------- persistencia ---------- */
function guardar() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(estado)); }
  catch (err) { console.warn(err); }
}
function cargar() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      estado = JSON.parse(raw);
      if (!estado.escenarios?.length) throw new Error('empty');
      if (!estado.activoId) estado.activoId = estado.escenarios[0].id;
      estado.escenarios.forEach((e) => {
        if (!e.meta) e.meta = { fecha: '', monto: 0 };
        if (!e.aportes) e.aportes = [];
        if (!e.bolsillos) e.bolsillos = [];
      });
      return;
    }
  } catch { /* migrate */ }

  // Migrar v9 / anteriores
  const keys = ['vault_cdt_v9', 'vault_cdt_v8', 'vault_cdt_v7', 'vault_cdt_v5'];
  for (const k of keys) {
    const prev = localStorage.getItem(k);
    if (!prev) continue;
    try {
      const p = JSON.parse(prev);
      let e;
      if (p.aportes && p.bolsillos) {
        e = {
          id: uid(), nombre: 'Escenario A',
          fechaSim: p.fechaSim || hoyISO(),
          aportes: p.aportes, bolsillos: p.bolsillos,
          meta: { fecha: '', monto: 0 },
        };
      } else if (p.bolsillos) {
        const bolsillos = p.bolsillos;
        const inv = bolsillos.reduce((s, b) => s + num(b.capital), 0);
        const base = num(p.disponible ?? p.patrimonio, 5e7);
        e = {
          id: uid(), nombre: 'Escenario A', fechaSim: hoyISO(),
          aportes: [{ id: uid(), fecha: hoyISO(), monto: Math.max(base + inv, inv), nota: 'Capital inicial' }],
          bolsillos, meta: { fecha: '', monto: 0 },
        };
      }
      if (e) {
        estado = { activoId: e.id, escenarios: [e] };
        guardar();
        return;
      }
    } catch { /* next */ }
  }

  const e = nuevoEscenario('Escenario A');
  estado = { activoId: e.id, escenarios: [e] };
  guardar();
}

/* ---------- navegación (historial Android / botón atrás) ---------- */
const VISTAS = ['home', 'nuevo', 'detalle', 'aporte', 'movimientos', 'escenarios'];
let vistaActual = 'home';
let navSilent = false;
/** Pila propia: garantiza que "atrás" vuelva a la vista anterior y no cierre la app */
let navStack = ['home'];

function aplicarVista(nombre) {
  if (!VISTAS.includes(nombre)) nombre = 'home';
  vistaActual = nombre;
  VISTAS.forEach((v) => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('hidden', v !== nombre);
  });
  const footer = document.getElementById('footer-home');
  if (footer) footer.classList.toggle('hidden', nombre !== 'home');
  window.scrollTo(0, 0);
}

function refrescarVista(nombre) {
  if (nombre === 'home') renderHome();
  else if (nombre === 'movimientos') renderMovimientos();
  else if (nombre === 'escenarios') renderEscenarios();
  else if (nombre === 'detalle') {
    if (detalleId) renderDetalle();
    else { nombre = 'home'; renderHome(); }
  } else if (nombre === 'nuevo') {
    if (!nuevoDraft) { nombre = 'home'; renderHome(); }
  } else if (nombre === 'aporte') {
    // inputs ya están en el DOM
  }
  return nombre;
}

/**
 * opts.replace  → sustituye la entrada actual (p.ej. al terminar wizard)
 * opts.skipHistory → solo UI
 */
function mostrarVista(nombre, opts = {}) {
  if (!VISTAS.includes(nombre)) nombre = 'home';
  if (opts.skipHistory || navSilent) {
    aplicarVista(nombre);
    return;
  }
  try {
    if (opts.replace || nombre === 'home') {
      // Al volver a home, reiniciar pila: el siguiente "atrás" puede salir de la app
      navStack = ['home'];
      history.replaceState({ vista: 'home', stack: ['home'] }, '', '#home');
      aplicarVista('home');
      return;
    }
    // Evitar duplicar la misma vista encima de sí misma
    if (navStack[navStack.length - 1] !== nombre) {
      navStack = navStack.concat([nombre]);
      history.pushState({ vista: nombre, stack: navStack.slice() }, '', '#' + nombre);
    } else {
      history.replaceState({ vista: nombre, stack: navStack.slice() }, '', '#' + nombre);
    }
  } catch (e) { /* ignore */ }
  aplicarVista(nombre);
}

/** Botón ← de la UI = mismo efecto que el atrás del sistema */
function volverAtras() {
  if (vistaActual === 'home' || navStack.length <= 1) {
    mostrarVista('home', { replace: true });
    renderHome();
    return;
  }
  try {
    history.back();
  } catch (e) {
    mostrarVista('home', { replace: true });
    renderHome();
  }
}

function initHistorial() {
  try {
    const hash = (location.hash || '').replace('#', '');
    const inicial = VISTAS.includes(hash) ? hash : 'home';
    navStack = inicial === 'home' ? ['home'] : ['home', inicial];
    history.replaceState({ vista: inicial, stack: navStack.slice() }, '', '#' + inicial);
    vistaActual = inicial;
  } catch (e) { /* ignore */ }

  window.addEventListener('popstate', (ev) => {
    let stack = (ev.state && Array.isArray(ev.state.stack)) ? ev.state.stack.slice() : null;
    let vista = (ev.state && ev.state.vista) || (stack && stack[stack.length - 1]) || 'home';
    if (!VISTAS.includes(vista)) vista = 'home';

    if (!stack || !stack.length) {
      stack = ['home'];
      vista = 'home';
    }

    navSilent = true;
    try {
      vista = refrescarVista(vista);
      // Si refrescarVista degradó a home, alinear pila
      if (vista === 'home') stack = ['home'];
      navStack = stack;
      aplicarVista(vista);
      // Si el estado del historial quedó inconsistente, normalizar sin empujar
      try {
        history.replaceState({ vista, stack: navStack.slice() }, '', '#' + vista);
      } catch (e) { /* ignore */ }
    } finally {
      navSilent = false;
    }
  });
}

/* ---------- instalación PWA ---------- */
let deferredInstall = null;

function initInstalar() {
  const btn = document.getElementById('btn-instalar');
  if (!btn) return;

  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;

  // En modo app ya instalada no mostrar el botón
  if (standalone) {
    btn.classList.add('hidden');
  } else {
    // Visible siempre para poder instalar o ver instrucciones
    btn.classList.remove('hidden');
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    if (!standalone) btn.classList.remove('hidden');
  });

  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    btn.classList.add('hidden');
  });

  btn.addEventListener('click', async () => {
    if (deferredInstall) {
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (e) { /* ignore */ }
      deferredInstall = null;
      btn.classList.add('hidden');
      return;
    }
    const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
    const isSecure = location.protocol === 'https:' || isLocal;
    if (!isSecure) {
      alert(
        'Para INSTALAR en Android la página debe abrirse en:\n\n' +
        '• http://localhost:PUERTO  (en este mismo teléfono con Termux)\n' +
        '• o HTTPS\n\n' +
        'Si entras por IP (ej. 192.168.x.x) con HTTP, Chrome bloquea la instalación.\n\n' +
        'Pasos recomendados:\n' +
        '1. En Termux: python -m http.server 8080 --bind 127.0.0.1\n' +
        '2. En Chrome del teléfono: http://localhost:8080\n' +
        '3. Menú ⋮ → "Instalar aplicación" / "Añadir a pantalla de inicio"'
      );
    } else {
      alert(
        'Para instalar:\n\n' +
        'Chrome → menú ⋮ → "Instalar aplicación" o "Añadir a pantalla de inicio".\n\n' +
        'Si no sale la opción, haz recarga forzada (⋮ → menú → recargar sin caché) y vuelve a intentar.'
      );
    }
  });
}

/* ---------- HOME ---------- */
function actualizarTotales() {
  const f = fechaSim();
  const disp = disponibleEn(f);
  document.getElementById('total-disponible').textContent = fmt(disp);
  document.getElementById('total-en-cdt').textContent = fmt(enCdtEn(f));
  document.getElementById('total-rendimientos').textContent = fmt(rendimientoEn(f));
  document.getElementById('total-general').textContent = fmt(patrimonioEn(f));
  const e = esc();
  document.getElementById('cdt-count').textContent = e?.bolsillos?.length || 0;
  document.getElementById('aporte-count').textContent = e?.aportes?.length || 0;
  document.getElementById('escenario-nombre').textContent = e?.nombre || '—';

  const card = document.querySelector('.total-card.disponible');
  if (card) card.classList.toggle('warning-over', disp < 0);

  const warn = document.getElementById('sim-warning');
  const sg = detectarSobregiro();
  if (sg) {
    warn.textContent = `Atención: el ${sg.fecha} el Disponible queda en ${fmt(sg.monto)}.`;
    warn.classList.remove('hidden');
  } else warn.classList.add('hidden');

  renderMeta();
}

function renderMeta() {
  const e = esc();
  const box = document.getElementById('meta-resumen');
  if (!e?.meta?.fecha) {
    box.innerHTML = '<span class="meta-empty">Sin meta definida. Toca Editar para fijar una fecha y monto objetivo.</span>';
    return;
  }
  const pat = patrimonioEn(e.meta.fecha);
  const objetivo = num(e.meta.monto);
  let extra = '';
  if (objetivo > 0) {
    const gap = pat - objetivo;
    if (gap >= 0) extra = `<span class="meta-ok">Superas la meta por ${fmt(gap)}</span>`;
    else extra = `<span class="meta-bad">Te faltan ${fmt(-gap)}</span>`;
  }
  box.innerHTML = `
    <div class="meta-line"><span>Fecha</span><strong>${e.meta.fecha}</strong></div>
    <div class="meta-line"><span>Patrimonio proyectado</span><strong class="gold">${fmt(pat)}</strong></div>
    ${objetivo > 0 ? `<div class="meta-line"><span>Objetivo</span><strong>${fmt(objetivo)}</strong></div>` : ''}
    ${extra}
  `;
}

function renderHome() {
  const e = esc();
  const f = fechaSim();
  const lista = document.getElementById('lista-cdts');
  lista.innerHTML = '';

  if (!e.bolsillos.length) {
    lista.innerHTML = '<p class="empty-msg">Sin inversiones en este escenario.</p>';
  } else {
    const sorted = [...e.bolsillos].sort((a, b) => {
      const order = { activo: 0, sin_iniciar: 1, vencido: 2 };
      return (order[snapshotCDT(a, f).estado] ?? 9) - (order[snapshotCDT(b, f).estado] ?? 9);
    });
    sorted.forEach((b) => {
      const s = snapshotCDT(b, f);
      const badge = s.estado === 'activo' ? 'Activo' : s.estado === 'vencido' ? 'Vencido' : 'Por iniciar';
      const sub = s.estado === 'sin_iniciar' ? `Inicia ${b.fechaInicio}`
        : s.estado === 'vencido' ? `Venció ${b.fechaFin}`
        : `${Math.max(0, b.fechaFin ? daysBetween(f, b.fechaFin) : 0)} días rest.`;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `item-row estado-${s.estado}`;
      row.innerHTML = `
        <div class="item-left">
          <span class="item-name">${escapeHtml(b.nombre)}</span>
          <span class="item-meta"><span class="pill">${badge}</span> ${sub}</span>
        </div>
        <div class="item-right">
          <span class="item-val">${fmtShort(s.estado === 'sin_iniciar' ? s.capital : s.total)}</span>
          <span class="item-chevron">›</span>
        </div>`;
      row.addEventListener('click', () => abrirDetalle(b.id));
      lista.appendChild(row);
    });
  }

  const listaA = document.getElementById('lista-aportes');
  listaA.innerHTML = '';
  if (!e.aportes.length) {
    listaA.innerHTML = '<p class="empty-msg">Sin aportes.</p>';
  } else {
    [...e.aportes].sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '')).forEach((a) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'item-row';
      row.innerHTML = `
        <div class="item-left">
          <span class="item-name">${escapeHtml(a.nota || 'Aporte')}</span>
          <span class="item-meta">${a.fecha || '—'}</span>
        </div>
        <div class="item-right">
          <span class="item-val">${fmtShort(num(a.monto))}</span>
          <span class="item-chevron">›</span>
        </div>`;
      row.addEventListener('click', () => abrirAporte(a.id));
      listaA.appendChild(row);
    });
  }

  const inputF = document.getElementById('input-fecha-sim');
  if (inputF && document.activeElement !== inputF) inputF.value = fechaSim();
  actualizarTotales();
}

/* ---------- ESCENARIOS ---------- */
function renderEscenarios() {
  const lista = document.getElementById('lista-escenarios');
  lista.innerHTML = '';
  estado.escenarios.forEach((e) => {
    const activo = e.id === estado.activoId;
    const row = document.createElement('div');
    row.className = `item-row escenario-row ${activo ? 'activo' : ''}`;
    row.innerHTML = `
      <button type="button" class="esc-select">
        <div class="item-left">
          <span class="item-name">${escapeHtml(e.nombre)}</span>
          <span class="item-meta">${e.bolsillos.length} CDTs · ${e.aportes.length} aportes${activo ? ' · activo' : ''}</span>
        </div>
        <span class="item-chevron">${activo ? '●' : '○'}</span>
      </button>
      <input type="text" class="esc-rename" value="${escapeHtml(e.nombre)}" maxlength="30" />
      <button type="button" class="aporte-del esc-del" title="Eliminar">×</button>
    `;
    row.querySelector('.esc-select').addEventListener('click', () => {
      estado.activoId = e.id;
      guardar();
      mostrarVista('home');
      renderHome();
    });
    const rename = row.querySelector('.esc-rename');
    rename.addEventListener('change', () => {
      e.nombre = rename.value.trim() || e.nombre;
      guardar();
      renderEscenarios();
    });
    rename.addEventListener('click', (ev) => ev.stopPropagation());
    row.querySelector('.esc-del').addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (estado.escenarios.length <= 1) {
        alert('Debes conservar al menos un escenario.');
        return;
      }
      pedirEliminar('escenario', e.id, e.nombre);
    });
    lista.appendChild(row);
  });
}

/* ---------- MOVIMIENTOS ---------- */
function renderMovimientos() {
  const e = esc();
  document.getElementById('mov-escenario-label').textContent =
    `Línea de tiempo de «${e?.nombre || ''}». Cada escenario tiene la suya.`;
  const lista = document.getElementById('lista-movimientos');
  const movs = generarMovimientos();
  if (!movs.length) {
    lista.innerHTML = '<p class="empty-msg">Sin movimientos todavía.</p>';
    return;
  }
  lista.innerHTML = movs.map((m) => `
    <div class="mov-row tipo-${m.tipo}">
      <div class="mov-left">
        <span class="mov-fecha">${m.fecha}</span>
        <span class="mov-nombre">${escapeHtml(m.nombre)}</span>
        ${m.extra ? `<span class="mov-extra">${m.extra}</span>` : ''}
      </div>
      <div class="mov-right">
        <span class="mov-monto ${m.signo === '+' ? 'plus' : 'minus'}">${m.signo}${fmt(m.monto)}</span>
        <span class="mov-saldo">Disp. ${fmt(m.saldo)}</span>
      </div>
    </div>
  `).join('');
}

/* ---------- NUEVO CDT ---------- */
function abrirNuevoCDT(prefill = null) {
  const baseFecha = prefill?.fechaInicio || fechaSim();
  nuevoDraft = {
    fechaInicio: baseFecha,
    modoPlazo: prefill?.modoPlazo || 'dias',
    dias: prefill?.dias || 90,
    fechaFin: prefill?.fechaFin || addDays(baseFecha, prefill?.dias || 90),
    capital: prefill?.capital || 0,
    tasa: prefill?.tasa ?? 10.5,
    retencion: prefill?.retencion ?? 4,
    tipo: prefill?.tipo || 'simple',
    nombre: prefill?.nombre || `CDT ${(esc()?.bolsillos?.length || 0) + 1}`,
    reinversionDe: prefill?.reinversionDe || null,
  };
  document.getElementById('nuevo-titulo').textContent = prefill?.reinversionDe ? 'Reinvertir' : 'Nueva inversión';
  document.getElementById('nuevo-fecha-inicio').value = nuevoDraft.fechaInicio;
  document.querySelectorAll('#view-nuevo .wizard-step').forEach((s) => {
    s.classList.toggle('hidden', s.dataset.step !== '1');
  });
  actualizarPaso1Nuevo();
  mostrarVista('nuevo');
}

function actualizarPaso1Nuevo() {
  const fi = document.getElementById('nuevo-fecha-inicio').value;
  nuevoDraft.fechaInicio = fi || fechaSim();
  const disp = disponibleEn(nuevoDraft.fechaInicio);
  document.getElementById('nuevo-disponible').textContent = fmt(disp);
  const err = document.getElementById('nuevo-error');
  const btn = document.getElementById('btn-nuevo-siguiente');
  if (!fi) {
    err.textContent = 'Elige una fecha de inicio.';
    err.classList.remove('hidden');
    btn.disabled = true;
  } else if (disp <= 0) {
    err.textContent = 'No hay capital disponible en esa fecha.';
    err.classList.remove('hidden');
    btn.disabled = true;
  } else {
    err.classList.add('hidden');
    btn.disabled = false;
  }
}

function irPaso2Nuevo() {
  actualizarPaso1Nuevo();
  if (document.getElementById('btn-nuevo-siguiente').disabled) return;
  const disp = disponibleEn(nuevoDraft.fechaInicio);
  if (!nuevoDraft.capital || nuevoDraft.capital > disp) {
    nuevoDraft.capital = Math.min(disp, nuevoDraft.capital > 0 ? nuevoDraft.capital : 5e6);
  }
  if (nuevoDraft.modoPlazo === 'dias') {
    nuevoDraft.fechaFin = addDays(nuevoDraft.fechaInicio, nuevoDraft.dias);
  }
  document.getElementById('nuevo-nombre').value = nuevoDraft.nombre;
  document.getElementById('nuevo-capital').value = nuevoDraft.capital;
  document.getElementById('nuevo-tasa').value = nuevoDraft.tasa;
  document.getElementById('nuevo-retencion').value = nuevoDraft.retencion;
  document.getElementById('nuevo-tipo').value = nuevoDraft.tipo;
  document.getElementById('nuevo-dias').value = nuevoDraft.dias;
  document.getElementById('nuevo-fecha-fin').value = nuevoDraft.fechaFin;
  syncNuevoPlazoUI();
  actualizarPreviewNuevo();
  document.querySelectorAll('#view-nuevo .wizard-step').forEach((s) => {
    s.classList.toggle('hidden', s.dataset.step !== '2');
  });
}

function syncNuevoPlazoUI() {
  const modo = nuevoDraft.modoPlazo;
  document.querySelectorAll('#nuevo-plazo-mode button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === modo);
  });
  document.getElementById('nuevo-row-dias').classList.toggle('hidden', modo !== 'dias');
  document.getElementById('nuevo-row-fin').classList.toggle('hidden', modo !== 'fecha');
}

function leerDraftPaso2() {
  nuevoDraft.nombre = document.getElementById('nuevo-nombre').value.trim() || 'CDT';
  let capital = num(document.getElementById('nuevo-capital').value);
  const max = disponibleEn(nuevoDraft.fechaInicio);
  // Idea 5: tope automático
  if (capital > max) {
    capital = Math.max(0, max);
    document.getElementById('nuevo-capital').value = capital;
  }
  nuevoDraft.capital = capital;
  nuevoDraft.tasa = num(document.getElementById('nuevo-tasa').value);
  nuevoDraft.retencion = num(document.getElementById('nuevo-retencion').value, 4);
  nuevoDraft.tipo = document.getElementById('nuevo-tipo').value;
  if (nuevoDraft.modoPlazo === 'dias') {
    nuevoDraft.dias = Math.max(1, parseInt(document.getElementById('nuevo-dias').value, 10) || 1);
    nuevoDraft.fechaFin = addDays(nuevoDraft.fechaInicio, nuevoDraft.dias);
    document.getElementById('nuevo-fecha-fin').value = nuevoDraft.fechaFin;
  } else {
    nuevoDraft.fechaFin = document.getElementById('nuevo-fecha-fin').value;
    if (nuevoDraft.fechaFin && nuevoDraft.fechaInicio) {
      let d = daysBetween(nuevoDraft.fechaInicio, nuevoDraft.fechaFin);
      if (d < 1) {
        d = 1;
        nuevoDraft.fechaFin = addDays(nuevoDraft.fechaInicio, 1);
        document.getElementById('nuevo-fecha-fin').value = nuevoDraft.fechaFin;
      }
      nuevoDraft.dias = d;
      document.getElementById('nuevo-dias').value = d;
    }
  }
}

function actualizarPreviewNuevo() {
  leerDraftPaso2();
  const fake = { ...nuevoDraft };
  const s = snapshotCDT(fake, nuevoDraft.fechaFin || nuevoDraft.fechaInicio);
  const disp = disponibleEn(nuevoDraft.fechaInicio);
  document.getElementById('nuevo-preview').innerHTML = `
    <div class="result-item"><span class="r-label">Disponible ese día</span><span class="r-value">${fmt(disp)}</span></div>
    <div class="result-item"><span class="r-label">Capital (tope ${fmt(disp)})</span><span class="r-value">${fmt(nuevoDraft.capital)}</span></div>
    <div class="result-item"><span class="r-label">Rend. neto al venc.</span><span class="r-value">${fmt(s.neto)}</span></div>
    <div class="result-item total"><span class="r-label">Total al vencimiento</span><span class="r-value">${fmt(s.totalFinal)}</span></div>
  `;
}

function crearCDTDesdeDraft() {
  leerDraftPaso2();
  const err = document.getElementById('nuevo-error-2');
  const disp = disponibleEn(nuevoDraft.fechaInicio);
  if (nuevoDraft.capital <= 0) {
    err.textContent = 'El capital debe ser mayor a 0.'; err.classList.remove('hidden'); return;
  }
  if (nuevoDraft.capital > disp + 0.01) {
    err.textContent = `Solo hay ${fmt(disp)} disponible.`; err.classList.remove('hidden'); return;
  }
  if (!nuevoDraft.fechaFin || nuevoDraft.dias < 1) {
    err.textContent = 'Define un plazo válido.'; err.classList.remove('hidden'); return;
  }
  err.classList.add('hidden');
  esc().bolsillos.unshift({
    id: uid(),
    nombre: nuevoDraft.nombre,
    capital: nuevoDraft.capital,
    tasa: nuevoDraft.tasa,
    retencion: nuevoDraft.retencion,
    tipo: nuevoDraft.tipo,
    fechaInicio: nuevoDraft.fechaInicio,
    fechaFin: nuevoDraft.fechaFin,
    dias: nuevoDraft.dias,
    modoPlazo: nuevoDraft.modoPlazo,
  });
  guardar();
  nuevoDraft = null;
  mostrarVista('home', { replace: true });
  renderHome();
}

/* ---------- DETALLE + REINVERTIR ---------- */
function abrirDetalle(id) {
  detalleId = id;
  renderDetalle();
  mostrarVista('detalle');
}

function renderDetalle() {
  const b = esc().bolsillos.find((x) => x.id === detalleId);
  if (!b) { mostrarVista('home'); renderHome(); return; }
  document.getElementById('detalle-titulo').textContent = b.nombre || 'CDT';
  const f = fechaSim();
  const s = snapshotCDT(b, f);
  const maxCap = disponibleEn(b.fechaInicio, b.id);

  const body = document.getElementById('detalle-body');
  body.innerHTML = `
    <div class="detalle-status estado-${s.estado}">
      <span class="pill">${s.estado === 'activo' ? 'Activo' : s.estado === 'vencido' ? 'Vencido · liberado' : 'Por iniciar'}</span>
      <span class="detalle-status-val">${fmt(s.estado === 'sin_iniciar' ? s.capital : s.total)}</span>
    </div>

    ${s.estado === 'vencido' ? `
      <button type="button" class="btn-primary" id="btn-reinvertir" style="margin:14px 0 4px">
        Reinvertir ${fmtShort(s.totalFinal)}
      </button>
      <p class="pat-hint">Crea un nuevo CDT con este capital liberado. Tú eliges desde qué fecha.</p>
    ` : ''}

    <div class="progress-wrap" style="margin:14px 0">
      <div class="progress-bar">
        <div class="progress-fill ${s.estado === 'vencido' ? 'done' : ''}" style="width:${s.dias > 0 ? Math.min(100, (s.diasTranscurridos / s.dias) * 100) : 0}%"></div>
      </div>
      <div class="progress-meta">
        <span>${s.diasTranscurridos} / ${s.dias} días</span>
        <span>${s.dias > 0 ? ((s.diasTranscurridos / s.dias) * 100).toFixed(0) : 0}%</span>
      </div>
    </div>

    <div class="field-group">
      <div class="field full"><label>Nombre</label>
        <input type="text" data-d="nombre" value="${escapeHtml(b.nombre)}" maxlength="40" /></div>
      <div class="field"><label>Capital (máx ${fmtShort(maxCap)})</label>
        <input type="number" inputmode="decimal" min="0" step="any" data-d="capital" value="${b.capital}" /></div>
      <div class="field"><label>Tasa E.A. %</label>
        <input type="number" inputmode="decimal" min="0" step="0.01" data-d="tasa" value="${b.tasa}" /></div>
      <div class="field"><label>Retención %</label>
        <input type="number" inputmode="decimal" min="0" max="100" step="0.01" data-d="retencion" value="${b.retencion ?? 4}" /></div>
      <div class="field"><label>Tipo</label>
        <select data-d="tipo">
          ${TIPOS.map((t) => `<option value="${t.value}" ${t.value === b.tipo ? 'selected' : ''}>${t.label}</option>`).join('')}
        </select></div>
      <div class="field full"><label>Fecha de inicio</label>
        <input type="date" data-d="fechaInicio" value="${b.fechaInicio || ''}" /></div>
      <div class="field full"><label>Plazo</label>
        <div class="plazo-mode" id="det-plazo-mode">
          <button type="button" data-mode="dias" class="${b.modoPlazo === 'dias' ? 'active' : ''}">Por días</button>
          <button type="button" data-mode="fecha" class="${b.modoPlazo === 'fecha' ? 'active' : ''}">Fecha fin</button>
        </div></div>
      <div class="field full ${b.modoPlazo === 'fecha' ? 'hidden' : ''}" id="det-row-dias">
        <label>Días</label><input type="number" inputmode="numeric" min="1" data-d="dias" value="${b.dias}" /></div>
      <div class="field full ${b.modoPlazo === 'dias' ? 'hidden' : ''}" id="det-row-fin">
        <label>Fecha fin</label><input type="date" data-d="fechaFin" value="${b.fechaFin || ''}" /></div>
    </div>
    <p id="detalle-error" class="form-error hidden"></p>
    <div class="result-box" style="margin-top:16px">
      <div class="result-item"><span class="r-label">Capital</span><span class="r-value">${fmt(s.capital)}</span></div>
      <div class="result-item"><span class="r-label">Rend. bruto</span><span class="r-value">${fmt(s.bruto)}</span></div>
      <div class="result-item deduction"><span class="r-label">Retención</span><span class="r-value">−${fmt(s.retencion)}</span></div>
      <div class="result-item net"><span class="r-label">Rend. neto</span><span class="r-value">${fmt(s.neto)}</span></div>
      <div class="result-item total"><span class="r-label">Total neto al vencimiento</span><span class="r-value">${fmt(s.totalFinal)}</span></div>
    </div>
  `;

  const btnRe = body.querySelector('#btn-reinvertir');
  if (btnRe) {
    btnRe.addEventListener('click', () => {
      const liberado = snapshotCDT(b, b.fechaFin).totalFinal;
      // Día siguiente al vencimiento por defecto (el dinero ya está libre el día del vencimiento; puede reinvertir ese mismo día o después)
      const inicioSug = b.fechaFin;
      abrirNuevoCDT({
        fechaInicio: inicioSug,
        capital: liberado,
        tasa: b.tasa,
        retencion: b.retencion,
        tipo: b.tipo,
        dias: b.dias || 90,
        modoPlazo: b.modoPlazo || 'dias',
        nombre: (b.nombre || 'CDT') + ' (reinversión)',
        reinversionDe: b.id,
      });
    });
  }

  body.querySelectorAll('#det-plazo-mode button').forEach((btn) => {
    btn.addEventListener('click', () => {
      b.modoPlazo = btn.dataset.mode;
      syncPlazo(b, 'modo');
      guardar();
      renderDetalle();
    });
  });

  body.querySelectorAll('[data-d]').forEach((input) => {
    const field = input.dataset.d;
    const ev = input.tagName === 'SELECT' || input.type === 'date' ? 'change' : 'input';
    input.addEventListener(ev, () => {
      let val = input.value;
      if (['capital', 'tasa', 'dias', 'retencion'].includes(field)) val = num(val);

      // Idea 5: tope automático de capital
      if (field === 'capital') {
        const max = disponibleEn(b.fechaInicio, b.id);
        if (val > max) {
          val = Math.max(0, max);
          input.value = val;
        }
      }
      b[field] = val;
      if (field === 'fechaInicio') {
        syncPlazo(b, 'inicio');
        // Re-tope capital si cambia inicio
        const max = disponibleEn(b.fechaInicio, b.id);
        if (num(b.capital) > max) b.capital = Math.max(0, max);
      } else if (field === 'fechaFin') syncPlazo(b, 'fin');
      else if (field === 'dias') syncPlazo(b, 'dias');

      if (field === 'nombre') document.getElementById('detalle-titulo').textContent = b.nombre || 'CDT';
      guardar();
      if (['fechaInicio', 'fechaFin', 'tipo', 'dias'].includes(field)) renderDetalle();
      else {
        const snap = snapshotCDT(b, fechaSim());
        const vals = body.querySelectorAll('.result-box .r-value');
        if (vals.length >= 5) {
          vals[0].textContent = fmt(snap.capital);
          vals[1].textContent = fmt(snap.bruto);
          vals[2].textContent = '−' + fmt(snap.retencion);
          vals[3].textContent = fmt(snap.neto);
          vals[4].textContent = fmt(snap.totalFinal);
        }
      }
    });
  });
}

/* ---------- APORTES ---------- */
function abrirAporte(id = null) {
  aporteEditId = id;
  const a = id ? esc().aportes.find((x) => x.id === id) : null;
  document.getElementById('aporte-titulo').textContent = a ? 'Editar aporte' : 'Nuevo aporte';
  document.getElementById('aporte-fecha').value = a ? a.fecha : fechaSim();
  document.getElementById('aporte-monto').value = a ? a.monto : 0;
  document.getElementById('aporte-nota').value = a ? (a.nota || '') : '';
  document.getElementById('btn-eliminar-aporte').classList.toggle('hidden', !a);
  mostrarVista('aporte');
}
function guardarAporte() {
  const fecha = document.getElementById('aporte-fecha').value || fechaSim();
  const monto = num(document.getElementById('aporte-monto').value);
  const nota = document.getElementById('aporte-nota').value.trim() || 'Aporte';
  if (aporteEditId) {
    const a = esc().aportes.find((x) => x.id === aporteEditId);
    if (a) { a.fecha = fecha; a.monto = monto; a.nota = nota; }
  } else {
    esc().aportes.push({ id: uid(), fecha, monto, nota });
  }
  guardar();
  aporteEditId = null;
  mostrarVista('home', { replace: true });
  renderHome();
}

/* ---------- eliminar ---------- */
function pedirEliminar(type, id, nombre) {
  deleteTarget = { type, id };
  document.getElementById('modal-delete-name').textContent = `"${nombre}"`;
  document.getElementById('modal-delete').classList.remove('hidden');
}
function eliminarConfirmado() {
  if (!deleteTarget) return;
  if (deleteTarget.type === 'cdt') {
    esc().bolsillos = esc().bolsillos.filter((b) => b.id !== deleteTarget.id);
  } else if (deleteTarget.type === 'aporte') {
    esc().aportes = esc().aportes.filter((a) => a.id !== deleteTarget.id);
  } else if (deleteTarget.type === 'escenario') {
    estado.escenarios = estado.escenarios.filter((e) => e.id !== deleteTarget.id);
    if (!estado.escenarios.find((e) => e.id === estado.activoId)) {
      estado.activoId = estado.escenarios[0]?.id || null;
    }
  }
  deleteTarget = null;
  document.getElementById('modal-delete').classList.add('hidden');
  guardar();
  if (document.getElementById('view-escenarios') && !document.getElementById('view-escenarios').classList.contains('hidden')) {
    renderEscenarios();
  } else {
    mostrarVista('home');
    renderHome();
  }
}

/* ---------- init ---------- */
function init() {
  cargar();
  initHistorial();
  initInstalar();
  renderHome();
  mostrarVista('home', { skipHistory: true });

  document.getElementById('btn-nuevo-cdt').addEventListener('click', () => abrirNuevoCDT());
  document.getElementById('btn-nuevo-aporte').addEventListener('click', () => abrirAporte(null));
  document.getElementById('btn-movimientos').addEventListener('click', () => {
    renderMovimientos();
    mostrarVista('movimientos');
  });
  document.getElementById('btn-volver-mov').addEventListener('click', volverAtras);

  document.getElementById('btn-escenarios').addEventListener('click', () => {
    renderEscenarios();
    mostrarVista('escenarios');
  });
  document.getElementById('btn-volver-escenarios').addEventListener('click', volverAtras);
  document.getElementById('btn-crear-escenario').addEventListener('click', () => {
    const e = nuevoEscenario();
    estado.escenarios.push(e);
    estado.activoId = e.id;
    guardar();
    renderEscenarios();
  });

  document.getElementById('btn-cancel-nuevo').addEventListener('click', volverAtras);
  document.getElementById('btn-nuevo-siguiente').addEventListener('click', irPaso2Nuevo);
  document.getElementById('btn-nuevo-atras').addEventListener('click', () => {
    document.querySelectorAll('#view-nuevo .wizard-step').forEach((s) => {
      s.classList.toggle('hidden', s.dataset.step !== '1');
    });
    actualizarPaso1Nuevo();
  });
  document.getElementById('btn-nuevo-crear').addEventListener('click', crearCDTDesdeDraft);
  document.getElementById('nuevo-fecha-inicio').addEventListener('change', actualizarPaso1Nuevo);
  document.getElementById('nuevo-fecha-inicio').addEventListener('input', actualizarPaso1Nuevo);
  ['nuevo-capital', 'nuevo-tasa', 'nuevo-retencion', 'nuevo-dias', 'nuevo-nombre'].forEach((id) => {
    document.getElementById(id).addEventListener('input', actualizarPreviewNuevo);
  });
  document.getElementById('nuevo-tipo').addEventListener('change', actualizarPreviewNuevo);
  document.getElementById('nuevo-fecha-fin').addEventListener('change', actualizarPreviewNuevo);
  document.querySelectorAll('#nuevo-plazo-mode button').forEach((btn) => {
    btn.addEventListener('click', () => {
      nuevoDraft.modoPlazo = btn.dataset.mode;
      syncNuevoPlazoUI();
      actualizarPreviewNuevo();
    });
  });

  document.getElementById('btn-volver-detalle').addEventListener('click', volverAtras);
  document.getElementById('btn-eliminar-detalle').addEventListener('click', () => {
    const b = esc().bolsillos.find((x) => x.id === detalleId);
    if (b) pedirEliminar('cdt', b.id, b.nombre);
  });

  document.getElementById('btn-volver-aporte').addEventListener('click', volverAtras);
  document.getElementById('btn-guardar-aporte').addEventListener('click', guardarAporte);
  document.getElementById('btn-eliminar-aporte').addEventListener('click', () => {
    const a = esc().aportes.find((x) => x.id === aporteEditId);
    if (a) pedirEliminar('aporte', a.id, a.nota || 'Aporte');
  });

  document.getElementById('btn-cancel-delete').addEventListener('click', () => {
    document.getElementById('modal-delete').classList.add('hidden');
    deleteTarget = null;
  });
  document.getElementById('btn-confirm-delete').addEventListener('click', eliminarConfirmado);

  const inputF = document.getElementById('input-fecha-sim');
  inputF.addEventListener('change', () => {
    esc().fechaSim = inputF.value || hoyISO();
    guardar();
    renderHome();
  });
  inputF.addEventListener('input', () => {
    esc().fechaSim = inputF.value || hoyISO();
    actualizarTotales();
  });

  // Meta
  document.getElementById('btn-toggle-meta').addEventListener('click', () => {
    const form = document.getElementById('meta-form');
    const e = esc();
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) {
      document.getElementById('meta-fecha').value = e.meta?.fecha || '';
      document.getElementById('meta-monto').value = e.meta?.monto || '';
    }
  });
  document.getElementById('btn-guardar-meta').addEventListener('click', () => {
    const e = esc();
    e.meta = {
      fecha: document.getElementById('meta-fecha').value || '',
      monto: num(document.getElementById('meta-monto').value),
    };
    guardar();
    document.getElementById('meta-form').classList.add('hidden');
    renderMeta();
  });
}

document.addEventListener('DOMContentLoaded', init);
