/**
 * Monsallve Financiero — Escenarios + movimientos + meta + reinvertir + tope capital
 */

const STORAGE_KEY = 'monsallve_v1';
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
let metaEditId = null;
let nuevoDraft = null;

/* Firebase */
let fbAuth = null;
let fbDb = null;
let usuario = null;       // firebase.User | null
let syncStatus = 'local'; // local | syncing | synced | error
let saveTimer = null;
let firebaseListo = false;
let perfilUsuario = null; // { username, email }



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
    metas: [],
    // Caja / Disponible (estilo Cajitas NU)
    caja: {
      tasa: 4,
      retencion: 7,
      umbral: 2881,
    },
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
  // "Único al vencimiento" no devenga hasta la fecha fin.
  let n = vencido ? dias : diasTrans;
  if (tipo === 'unico' && !vencido) n = 0;
  const bruto = valorBrutoEnDias(capital, tasa, tipo, n) - capital;
  const retencion = bruto * retPct;
  const neto = bruto - retencion;
  out.bruto = bruto; out.retencion = retencion; out.neto = neto; out.total = capital + neto;
  return out;
}
function cajaCfg(e) {
  const c = e?.caja || {};
  return {
    tasa: num(c.tasa, 4),
    retencion: num(c.retencion, 7),
    umbral: num(c.umbral, 2881),
  };
}

/** Cache de simulación (misma fecha / exclude en un mismo ciclo de render) */
let _simCacheKey = '';
let _simCacheVal = null;
function invalidarSimCache() { _simCacheKey = ''; _simCacheVal = null; }

/** Interés compuesto diario del Disponible a partir de tasa E.A. */
function interesDiarioCaja(saldo, cfg) {
  if (!(saldo > 0) || !(cfg.tasa > 0)) {
    return { bruto: 0, retencion: 0, neto: 0 };
  }
  const r = Math.pow(1 + cfg.tasa / 100, 1 / 365) - 1;
  const bruto = saldo * r;
  // Regla tipo NU Cajitas: retención solo si el bruto diario supera el umbral (0,055 UVT ≈ $2.881)
  const retencion = bruto > cfg.umbral ? bruto * (cfg.retencion / 100) : 0;
  return { bruto, retencion, neto: bruto - retencion };
}

/**
 * Simula día a día hasta fechaInclusive.
 * Orden de cada día D:
 *   1) Interés sobre el saldo de APERTURA (lo que había al cierre de D-1)
 *      → el día que creas un CDT aún no “pierde” ese día de rendimiento del disponible
 *   2) Movimientos del día (aportes, liberaciones, inversiones)
 * CDT creado el día D: su primer rendimiento aparece el día D+1 (daysBetween >= 1).
 */
function simularCaja(fechaInclusive, excludeId = null) {
  const cacheKey = fechaInclusive + '|' + (excludeId || '') + '|' + (esc()?.id || '');
  if (_simCacheKey === cacheKey && _simCacheVal) return _simCacheVal;

  const e = esc();
  const empty = {
    balance: 0,
    interesNetoAcum: 0,
    interesBrutoAcum: 0,
    retencionAcum: 0,
    interesHoy: { bruto: 0, retencion: 0, neto: 0, apertura: 0 },
    dias: [],
  };
  if (!e || !fechaInclusive) return empty;

  const cfg = cajaCfg(e);
  const aportes = (e.aportes || []).filter((a) => a.fecha);
  const bolsillos = (e.bolsillos || []).filter((b) => b.fechaInicio && !(excludeId && b.id === excludeId));

  let minF = fechaInclusive;
  aportes.forEach((a) => { if (a.fecha < minF) minF = a.fecha; });
  bolsillos.forEach((b) => {
    if (b.fechaInicio && b.fechaInicio < minF) minF = b.fechaInicio;
    if (b.fechaFin && b.fechaFin < minF) minF = b.fechaFin;
  });

  // Mapas por fecha
  const porFecha = {};
  const ensure = (f) => {
    if (!porFecha[f]) porFecha[f] = { aportes: [], inicios: [], fines: [] };
  };

  aportes.forEach((a) => {
    if (a.fecha > fechaInclusive) return;
    ensure(a.fecha);
    porFecha[a.fecha].aportes.push(a);
  });
  bolsillos.forEach((b) => {
    const cap = num(b.capital);
    if (cap <= 0) return;
    if (b.fechaInicio && b.fechaInicio <= fechaInclusive) {
      ensure(b.fechaInicio);
      porFecha[b.fechaInicio].inicios.push(b);
    }
    if (b.fechaFin && b.fechaFin <= fechaInclusive) {
      ensure(b.fechaFin);
      porFecha[b.fechaFin].fines.push(b);
    }
  });

  let balance = 0;
  let interesNetoAcum = 0;
  let interesBrutoAcum = 0;
  let retencionAcum = 0;
  let interesHoy = { bruto: 0, retencion: 0, neto: 0, apertura: 0 };
  const dias = [];

  let cursor = minF;
  // Si no hay eventos, no hay nada que simular
  if (!Object.keys(porFecha).length && balance === 0) {
    return empty;
  }

  // Tope ~80 años: una fecha lejana no puede congelar la pantalla
  const topeSim = addDays(minF, 366 * 80);
  if (fechaInclusive > topeSim) fechaInclusive = topeSim;

  const MAX_PASOS = 366 * 80 + 2;
  let pasos = 0;
  while (cursor <= fechaInclusive && pasos < MAX_PASOS) {
    pasos += 1;
    const apertura = balance;
    const inter = interesDiarioCaja(apertura, cfg);
    balance += inter.neto;
    interesNetoAcum += inter.neto;
    interesBrutoAcum += inter.bruto;
    retencionAcum += inter.retencion;

    const movs = [];
    const day = porFecha[cursor];
    if (day) {
      day.aportes.forEach((a) => {
        const m = num(a.monto);
        balance += m;
        movs.push({ tipo: 'aporte', monto: m, nombre: a.nota || 'Aporte' });
      });
      day.fines.forEach((b) => {
        const fin = snapshotCDT(b, b.fechaFin);
        balance += fin.totalFinal;
        movs.push({ tipo: 'liberacion', monto: fin.totalFinal, nombre: (b.nombre || 'Inversión') + ' (vencimiento)', extra: fin.neto });
      });
      day.inicios.forEach((b) => {
        const cap = num(b.capital);
        balance -= cap;
        movs.push({ tipo: 'inversion', monto: cap, nombre: b.nombre || 'Inversión' });
      });
    }

    if (cursor === fechaInclusive) {
      interesHoy = { ...inter, apertura };
    }

    if (inter.neto > 0.005 || movs.length) {
      dias.push({
        fecha: cursor,
        apertura,
        bruto: inter.bruto,
        retencion: inter.retencion,
        neto: inter.neto,
        cierre: balance,
        movs,
      });
    }

    const prev = cursor;
    cursor = addDays(cursor, 1);
    if (!cursor || cursor <= prev) break;
  }

  const result = {
    balance,
    interesNetoAcum,
    interesBrutoAcum,
    retencionAcum,
    interesHoy,
    dias,
  };
  _simCacheKey = cacheKey;
  _simCacheVal = result;
  return result;
}

function disponibleEn(fecha, excludeId = null) {
  return simularCaja(fecha, excludeId).balance;
}

function enCdtEn(fecha) {
  let s = 0;
  (esc()?.bolsillos || []).forEach((b) => {
    if (snapshotCDT(b, fecha).estado === 'activo') s += num(b.capital);
  });
  return s;
}

function rendimientoEn(fecha) {
  let s = simularCaja(fecha).interesNetoAcum;
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
  let maxF = fechaSim();
  (e.aportes || []).forEach((a) => { if (a.fecha && a.fecha > maxF) maxF = a.fecha; });
  (e.bolsillos || []).forEach((b) => {
    if (b.fechaInicio && b.fechaInicio > maxF) maxF = b.fechaInicio;
    if (b.fechaFin && b.fechaFin > maxF) maxF = b.fechaFin;
  });
  const sim = simularCaja(maxF);
  for (const d of sim.dias) {
    if (d.cierre < -0.5) return { fecha: d.fecha, monto: d.cierre };
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

/** Movimientos + rendimientos diarios de caja del escenario activo */
function generarMovimientos() {
  const e = esc();
  if (!e) return [];
  const sim = simularCaja(fechaSim());
  const events = [];

  sim.dias.forEach((d) => {
    if (d.neto > 0.005) {
      events.push({
        fecha: d.fecha,
        tipo: 'rendimiento',
        signo: '+',
        monto: d.neto,
        nombre: 'Rendimiento Disponible',
        extra: d.retencion > 0.005
          ? `bruto ${fmt(d.bruto)} · ret. −${fmt(d.retencion)}`
          : `bruto ${fmt(d.bruto)} · sin retención`,
        orden: -1,
        saldo: null,
      });
    }
    d.movs.forEach((m) => {
      if (m.tipo === 'aporte') {
        events.push({
          fecha: d.fecha, tipo: 'aporte', signo: '+', monto: m.monto,
          nombre: m.nombre, orden: 0, saldo: null,
        });
      } else if (m.tipo === 'liberacion') {
        events.push({
          fecha: d.fecha, tipo: 'liberacion', signo: '+', monto: m.monto,
          nombre: m.nombre, orden: 0,
          extra: m.extra != null ? `neto ${fmt(m.extra)}` : '',
          saldo: null,
        });
      } else if (m.tipo === 'inversion') {
        events.push({
          fecha: d.fecha, tipo: 'inversion', signo: '−', monto: m.monto,
          nombre: m.nombre, orden: 1, saldo: null,
        });
      }
    });
  });

  // Saldo corrido usando el cierre diario del simulador
  const cierrePorFecha = {};
  sim.dias.forEach((d) => { cierrePorFecha[d.fecha] = d.cierre; });

  let running = 0;
  const sorted = events.sort((a, b) => {
    if (a.fecha !== b.fecha) return a.fecha.localeCompare(b.fecha);
    return a.orden - b.orden;
  });

  // Recalcular saldo paso a paso
  return sorted.map((ev) => {
    running += ev.signo === '+' ? ev.monto : -ev.monto;
    return { ...ev, saldo: running };
  });
}

/* ---------- persistencia ---------- */
function normalizarEstado(raw) {
  if (!raw || !raw.escenarios?.length) return false;
  estado = raw;
  if (!estado.activoId) estado.activoId = estado.escenarios[0].id;
  estado.escenarios.forEach((e) => {
    if (!e.fechaSim) e.fechaSim = hoyISO();
    if (!e.aportes) e.aportes = [];
    if (!e.bolsillos) e.bolsillos = [];
    if (!e.caja) e.caja = { tasa: 4, retencion: 7, umbral: 2881 };
    else {
      if (e.caja.tasa == null) e.caja.tasa = 4;
      if (e.caja.retencion == null) e.caja.retencion = 7;
      if (e.caja.umbral == null) e.caja.umbral = 2881;
    }
    if (!Array.isArray(e.metas)) {
      e.metas = [];
      if (e.meta && (e.meta.fecha || e.meta.monto)) {
        e.metas.push({
          id: uid(),
          nombre: e.meta.nombre || 'Meta principal',
          fecha: e.meta.fecha || '',
          monto: num(e.meta.monto),
        });
      }
      delete e.meta;
    }
    e.aportes.forEach((a) => { a.monto = num(a.monto); });
    e.metas.forEach((m) => { m.monto = num(m.monto); });
    e.bolsillos.forEach((b) => {
      b.capital = num(b.capital);
      b.tasa = num(b.tasa);
      b.retencion = b.retencion == null ? 4 : num(b.retencion, 4);
      if (!TIPOS.some((t) => t.value === b.tipo)) b.tipo = 'simple';
      if (b.modoPlazo !== 'fecha') b.modoPlazo = 'dias';
      if (!b.fechaInicio) b.fechaInicio = e.fechaSim || hoyISO();
      if (!b.fechaFin) b.fechaFin = addDays(b.fechaInicio, Math.max(1, parseInt(b.dias, 10) || 90));
      syncPlazo(b, b.modoPlazo === 'dias' ? 'dias' : 'fin');
    });
  });
  return true;
}

function guardarLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(estado)); }
  catch (err) { console.warn(err); }
}

function guardar() {
  invalidarSimCache();
  if (!usuario) return; // sin sesión no se persiste uso de la app
  guardarLocal();
  if (fbDb) {
    syncStatus = 'syncing';
    actualizarAuthChip();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { guardarNube().catch((e) => console.warn(e)); }, 600);
  }
}

function estadoDesdeLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && normalizarEstado(JSON.parse(raw))) return true;
  } catch { /* migrar */ }

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
          metas: [],
        };
      } else if (p.bolsillos) {
        const bolsillos = p.bolsillos;
        const inv = bolsillos.reduce((s, b) => s + num(b.capital), 0);
        const base = num(p.disponible ?? p.patrimonio, 5e7);
        e = {
          id: uid(), nombre: 'Escenario A', fechaSim: hoyISO(),
          aportes: [{ id: uid(), fecha: hoyISO(), monto: Math.max(base + inv, inv), nota: 'Capital inicial' }],
          bolsillos, metas: [],
        };
      }
      if (e) {
        estado = { activoId: e.id, escenarios: [e] };
        return normalizarEstado(estado);
      }
    } catch { /* next */ }
  }
  return false;
}

function cargarLocalONuevo() {
  if (!estadoDesdeLocal()) {
    const e = nuevoEscenario('Escenario A');
    estado = { activoId: e.id, escenarios: [e] };
    normalizarEstado(estado);
  }
  guardarLocal();
}

/* ---------- navegación (historial Android / botón atrás) ---------- */
const VISTAS = ['gate', 'verify', 'home', 'nuevo', 'detalle', 'aporte', 'aportes', 'inversiones', 'metas', 'meta', 'movimientos', 'escenarios', 'cuenta'];
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
  else if (nombre === 'aportes') renderAportesLista();
  else if (nombre === 'inversiones') renderInversionesLista();
  else if (nombre === 'metas') renderMetasLista();
  else if (nombre === 'cuenta') renderCuenta();
  else if (nombre === 'meta') {
    if (metaEditId) abrirMeta(metaEditId, true);
  } else if (nombre === 'detalle') {
    if (detalleId) renderDetalle();
    else { nombre = 'home'; renderHome(); }
  } else if (nombre === 'nuevo') {
    if (!nuevoDraft) { nombre = 'home'; renderHome(); }
  } else if (nombre === 'aporte') {
    if (aporteEditId) abrirAporte(aporteEditId, true);
  }
  return nombre;
}

/**
 * opts.replace  → sustituye la entrada actual (p.ej. al terminar wizard)
 * opts.skipHistory → solo UI
 */
function mostrarVista(nombre, opts = {}) {
  if (!VISTAS.includes(nombre)) nombre = 'home';
  // Sin sesión solo se permite el gate
  if (!usuario && nombre !== 'gate') nombre = 'gate';
  if (usuario && necesitaVerificarEmail(usuario) && nombre !== 'verify' && nombre !== 'gate') nombre = 'verify';
  if (opts.skipHistory || navSilent) {
    aplicarVista(nombre);
    return;
  }
  try {
    if (opts.replace || nombre === 'home' || nombre === 'gate') {
      navStack = [nombre];
      history.replaceState({ vista: nombre, stack: [nombre] }, '', '#' + nombre);
      aplicarVista(nombre);
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
    history.replaceState({ vista: 'gate', stack: ['gate'] }, '', '#gate');
    navStack = ['gate'];
    vistaActual = 'gate';
  } catch (e) { /* ignore */ }

  window.addEventListener('popstate', (ev) => {
    if (!ev.state || !ev.state.vista) {
      const vista = usuario ? (navStack[navStack.length - 1] || 'home') : 'gate';
      const stack = usuario ? (navStack.length ? navStack.slice() : ['home']) : ['gate'];
      navStack = stack;
      try { history.pushState({ vista, stack }, '', '#' + vista); } catch (e) { /* ignore */ }
      aplicarVista(vista);
      return;
    }
    if (!usuario) {
      navSilent = true;
      try {
        aplicarVista('gate');
        navStack = ['gate'];
        history.pushState({ vista: 'gate', stack: ['gate'] }, '', '#gate');
      } finally { navSilent = false; }
      return;
    }
    let stack = (ev.state && Array.isArray(ev.state.stack)) ? ev.state.stack.slice() : null;
    let vista = (ev.state && ev.state.vista) || (stack && stack[stack.length - 1]) || 'home';
    if (!VISTAS.includes(vista) || vista === 'gate') vista = 'home';

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

/* install eliminado — espacio para login/perfil */

/* ---------- HOME ---------- */
function actualizarTotales() {
  const f = fechaSim();
  const sim = simularCaja(f);
  const disp = sim.balance;
  document.getElementById('total-disponible').textContent = fmt(disp);
  document.getElementById('total-en-cdt').textContent = fmt(enCdtEn(f));
  document.getElementById('total-rendimientos').textContent = fmt(rendimientoEn(f));
  document.getElementById('total-general').textContent = fmt(patrimonioEn(f));
  const e = esc();
  const cc = document.getElementById('cdt-count'); if (cc) cc.textContent = e?.bolsillos?.length || 0;
  const ac = document.getElementById('aporte-count'); if (ac) ac.textContent = e?.aportes?.length || 0;
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
  renderCaja(sim);
}

function renderCaja(sim) {
  const e = esc();
  const box = document.getElementById('caja-resumen');
  if (!box || !e) return;
  const cfg = cajaCfg(e);
  const hoy = sim?.interesHoy || { bruto: 0, retencion: 0, neto: 0, apertura: 0 };
  const retTxt = hoy.bruto > cfg.umbral
    ? `Retención aplicada (−${fmt(hoy.retencion)})`
    : (hoy.bruto > 0 ? 'Sin retención (bajo umbral)' : 'Sin rendimiento');
  box.innerHTML = `
    <div class="meta-line"><span>Tasa caja</span><strong>${cfg.tasa}% E.A.</strong></div>
    <div class="meta-line"><span>Rend. neto del día</span><strong class="gold">${fmt(hoy.neto)}</strong></div>
    <div class="meta-line"><span>Sobre saldo apertura</span><strong>${fmt(hoy.apertura)}</strong></div>
    <div class="meta-line"><span>Acum. neto caja</span><strong>${fmt(sim?.interesNetoAcum || 0)}</strong></div>
    <span class="meta-empty" style="display:block;margin-top:6px">${retTxt} · umbral ${fmt(cfg.umbral)}/día</span>
  `;
}

function renderMeta() {
  const e = esc();
  const box = document.getElementById('meta-resumen');
  if (!box) return;
  const metas = e?.metas || [];
  if (!metas.length) {
    box.innerHTML = '<span class="meta-empty">Sin metas. Entra a Metas para crear la primera.</span>';
    return;
  }
  // Mostrar hasta 3 metas resumidas
  const f = fechaSim();
  const lines = metas.slice(0, 3).map((m) => {
    if (!m.fecha) {
      return `<div class="meta-line"><span>${escapeHtml(m.nombre || 'Meta')}</span><strong>—</strong></div>`;
    }
    const pat = patrimonioEn(m.fecha);
    const obj = num(m.monto);
    let tag = '';
    if (obj > 0) {
      const gap = pat - obj;
      tag = gap >= 0 ? ' · ok' : ' · falta ' + fmtShort(-gap);
    }
    return `<div class="meta-line"><span>${escapeHtml(m.nombre || 'Meta')} (${m.fecha})</span><strong class="gold">${fmtShort(pat)}${tag}</strong></div>`;
  }).join('');
  const more = metas.length > 3 ? `<span class="meta-empty">${metas.length - 3} más…</span>` : '';
  box.innerHTML = lines + more;
}

function renderHome() {
  const inputF = document.getElementById('input-fecha-sim');
  if (inputF && document.activeElement !== inputF) inputF.value = fechaSim();
  actualizarTotales();
}

function renderInversionesLista() {
  const e = esc();
  const f = fechaSim();
  const lista = document.getElementById('lista-cdts');
  if (!lista) return;
  lista.innerHTML = '';

  if (!e || !e.bolsillos || !e.bolsillos.length) {
    lista.innerHTML = '<p class="empty-msg">Sin inversiones en este escenario.</p>';
    return;
  }

  const sorted = [...e.bolsillos].sort((a, b) => {
    const order = { activo: 0, sin_iniciar: 1, vencido: 2 };
    return (order[snapshotCDT(a, f).estado] ?? 9) - (order[snapshotCDT(b, f).estado] ?? 9);
  });
  sorted.forEach((b) => {
    const s = snapshotCDT(b, f);
    const badge = s.estado === 'activo' ? 'Activa' : s.estado === 'vencido' ? 'Vencida' : 'Por iniciar';
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

/* ---------- ESCENARIOS ---------- */
function renderEscenarios() {
  const lista = document.getElementById('lista-escenarios');
  if (!lista) return;
  lista.innerHTML = '';
  (estado.escenarios || []).forEach((e) => {
    const activo = e.id === estado.activoId;
    const row = document.createElement('div');
    row.className = `item-row escenario-row ${activo ? 'activo' : ''}`;
    row.innerHTML = `
      <button type="button" class="esc-select">
        <div class="item-left">
          <span class="item-name">${escapeHtml(e.nombre)}</span>
          <span class="item-meta">${e.bolsillos.length} inversiones · ${e.aportes.length} aportes${activo ? ' · activo' : ''}</span>
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

/* ---------- NUEVA INVERSIÓN ---------- */
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
    nombre: prefill?.nombre || `Inversión ${(esc()?.bolsillos?.length || 0) + 1}`,
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
  nuevoDraft.nombre = document.getElementById('nuevo-nombre').value.trim() || 'Inversión';
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
  const destino = esc();
  if (!destino) return;
  if (!destino.bolsillos) destino.bolsillos = [];
  destino.bolsillos.unshift({
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

function pintarResultadoDetalle(b) {
  const body = document.getElementById('detalle-body');
  if (!body || !b) return;
  const s = snapshotCDT(b, fechaSim());
  const vals = body.querySelectorAll('.result-box .r-value');
  if (vals.length >= 5) {
    vals[0].textContent = fmt(s.capital);
    vals[1].textContent = fmt(s.bruto);
    vals[2].textContent = '−' + fmt(s.retencion);
    vals[3].textContent = fmt(s.neto);
    vals[4].textContent = fmt(s.totalFinal);
  }
  const fill = body.querySelector('.progress-fill');
  const pct = s.dias > 0 ? Math.min(100, (s.diasTranscurridos / s.dias) * 100) : 0;
  if (fill) {
    fill.style.width = pct + '%';
    fill.classList.toggle('done', s.estado === 'vencido');
  }
  const meta = body.querySelectorAll('.progress-meta span');
  if (meta.length >= 2) {
    meta[0].textContent = s.diasTranscurridos + ' / ' + s.dias + ' días';
    meta[1].textContent = (s.dias > 0 ? pct.toFixed(0) : '0') + '%';
  }
  const pill = body.querySelector('.detalle-status .pill');
  const val = body.querySelector('.detalle-status-val');
  const status = body.querySelector('.detalle-status');
  if (pill) pill.textContent = s.estado === 'activo' ? 'Activo' : s.estado === 'vencido' ? 'Vencido · liberado' : 'Por iniciar';
  if (val) val.textContent = fmt(s.estado === 'sin_iniciar' ? s.capital : s.total);
  if (status) {
    status.classList.remove('estado-activo', 'estado-vencido', 'estado-sin_iniciar');
    status.classList.add('estado-' + s.estado);
  }
  const diasInput = body.querySelector('[data-d="dias"]');
  const finInput = body.querySelector('[data-d="fechaFin"]');
  const capInput = body.querySelector('[data-d="capital"]');
  if (diasInput && document.activeElement !== diasInput) diasInput.value = b.dias;
  if (finInput && document.activeElement !== finInput) finInput.value = b.fechaFin || '';
  if (capInput && document.activeElement !== capInput) capInput.value = b.capital;
  if (capInput && capInput.parentElement) {
    const lab = capInput.parentElement.querySelector('label');
    if (lab) lab.textContent = 'Capital (máx ' + fmtShort(disponibleEn(b.fechaInicio, b.id)) + ')';
  }
  const btnRe = body.querySelector('#btn-reinvertir');
  if (btnRe && b.fechaFin) btnRe.textContent = 'Reinvertir ' + fmtShort(snapshotCDT(b, b.fechaFin).totalFinal);
}

function renderDetalle() {
  const actual = esc();
  const b = actual && actual.bolsillos.find((x) => x.id === detalleId);
  if (!b) { mostrarVista('home'); renderHome(); return; }
  document.getElementById('detalle-titulo').textContent = b.nombre || 'Inversión';
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
      <p class="pat-hint">Crea una nueva inversión con este capital liberado. Tú eliges desde qué fecha.</p>
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
        nombre: (b.nombre || 'Inversión') + ' (reinversión)',
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
      const estadoAntes = snapshotCDT(b, fechaSim()).estado;
      let val = input.value;
      if (['capital', 'tasa', 'dias', 'retencion'].includes(field)) val = num(val);

      if (field === 'capital') {
        const max = disponibleEn(b.fechaInicio, b.id);
        if (val > max) {
          val = Math.max(0, max);
          input.value = val;
        }
      }
      b[field] = val;
      if (field === 'fechaInicio') {
        if (!b.fechaInicio) b.fechaInicio = fechaSim();
        syncPlazo(b, 'inicio');
        const max = disponibleEn(b.fechaInicio, b.id);
        if (num(b.capital) > max) b.capital = Math.max(0, max);
      } else if (field === 'fechaFin') syncPlazo(b, 'fin');
      else if (field === 'dias') syncPlazo(b, 'dias');

      if (field === 'nombre') document.getElementById('detalle-titulo').textContent = b.nombre || 'Inversión';
      guardar();
      if (snapshotCDT(b, fechaSim()).estado !== estadoAntes) {
        renderDetalle();
        return;
      }
      pintarResultadoDetalle(b);
    });
  });
}


/* ---------- METAS ---------- */
function renderMetasLista() {
  const e = esc();
  const lista = document.getElementById('lista-metas');
  if (!lista) return;
  lista.innerHTML = '';
  const metas = [...(e?.metas || [])].sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
  if (!metas.length) {
    lista.innerHTML = '<p class="empty-msg">Sin metas. Crea la primera para proyectar tu patrimonio.</p>';
    return;
  }
  metas.forEach((m) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'item-row';
    let sub = m.fecha || 'Sin fecha';
    let val = num(m.monto) > 0 ? fmtShort(num(m.monto)) : '—';
    if (m.fecha) {
      const pat = patrimonioEn(m.fecha);
      const obj = num(m.monto);
      if (obj > 0) {
        const gap = pat - obj;
        sub += gap >= 0 ? ' · superada' : ' · faltan ' + fmtShort(-gap);
      } else {
        sub += ' · proy. ' + fmtShort(pat);
      }
    }
    row.innerHTML = `
      <div class="item-left">
        <span class="item-name">${escapeHtml(m.nombre || 'Meta')}</span>
        <span class="item-meta">${sub}</span>
      </div>
      <div class="item-right">
        <span class="item-val">${val}</span>
        <span class="item-chevron">›</span>
      </div>`;
    row.addEventListener('click', () => abrirMeta(m.id));
    lista.appendChild(row);
  });
}

function abrirMeta(id = null, silent = false) {
  metaEditId = id;
  const m = id ? (esc().metas || []).find((x) => x.id === id) : null;
  document.getElementById('meta-titulo').textContent = m ? (m.nombre || 'Meta') : 'Nueva meta';
  document.getElementById('meta-nombre').value = m ? (m.nombre || '') : '';
  document.getElementById('meta-fecha').value = m ? (m.fecha || '') : '';
  document.getElementById('meta-monto').value = m ? (m.monto || 0) : 0;
  document.getElementById('btn-eliminar-meta').classList.toggle('hidden', !m);

  const montoEl = document.getElementById('meta-status-monto');
  if (montoEl) montoEl.textContent = fmt(num(m ? m.monto : 0));
  const pill = document.getElementById('meta-status-pill');
  if (pill) pill.textContent = m ? 'Meta' : 'Nueva';

  actualizarInfoMeta();

  if (silent) aplicarVista('meta');
  else mostrarVista('meta');
}

function actualizarInfoMeta() {
  const info = document.getElementById('meta-info');
  if (!info) return;
  const fecha = document.getElementById('meta-fecha').value;
  const monto = num(document.getElementById('meta-monto').value);
  if (!fecha) {
    info.innerHTML = '<p class="pat-hint">Elige una fecha objetivo para ver el patrimonio proyectado.</p>';
    return;
  }
  const pat = patrimonioEn(fecha);
  let extra = '';
  if (monto > 0) {
    const gap = pat - monto;
    extra = gap >= 0
      ? `<div class="result-item net"><span class="r-label">Resultado</span><span class="r-value">Superada por ${fmt(gap)}</span></div>`
      : `<div class="result-item deduction"><span class="r-label">Resultado</span><span class="r-value">Faltan ${fmt(-gap)}</span></div>`;
  }
  info.innerHTML = `
    <div class="result-item"><span class="r-label">Patrimonio proyectado</span><span class="r-value">${fmt(pat)}</span></div>
    <div class="result-item"><span class="r-label">Objetivo</span><span class="r-value">${monto > 0 ? fmt(monto) : '—'}</span></div>
    ${extra}
  `;
}

function guardarMeta() {
  const e = esc();
  if (!e) return;
  const nombre = document.getElementById('meta-nombre').value.trim() || 'Meta';
  const fecha = document.getElementById('meta-fecha').value || '';
  const monto = num(document.getElementById('meta-monto').value);
  if (!e.metas) e.metas = [];
  if (metaEditId) {
    const m = e.metas.find((x) => x.id === metaEditId);
    if (m) { m.nombre = nombre; m.fecha = fecha; m.monto = monto; }
  } else {
    e.metas.push({ id: uid(), nombre, fecha, monto });
  }
  guardar();
  metaEditId = null;
  renderMetasLista();
  mostrarVista('metas', { replace: true });
}

/* ---------- APORTES ---------- */
function renderAportesLista() {
  const e = esc();
  const lista = document.getElementById('lista-aportes');
  const sum = document.getElementById('aportes-summary');
  if (!lista) return;

  const aportes = [...(e?.aportes || [])].sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
  const total = aportes.reduce((s, a) => s + num(a.monto), 0);
  if (sum) {
    sum.innerHTML = `
      <div class="meta-line"><span>Cantidad de aportes</span><strong>${aportes.length}</strong></div>
      <div class="meta-line"><span>Suma de capital aportado</span><strong class="gold">${fmt(total)}</strong></div>
      <p class="pat-hint" style="margin-top:8px">Capital que has inyectado (sin contar rendimientos generados).</p>
    `;
  }

  lista.innerHTML = '';
  if (!aportes.length) {
    lista.innerHTML = '<p class="empty-msg">Aún no hay aportes. Agrega el primero para tener Disponible.</p>';
    return;
  }

  aportes.forEach((a) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'item-row';
    const f = fechaSim();
    const activo = a.fecha && a.fecha <= f;
    row.innerHTML = `
      <div class="item-left">
        <span class="item-name">${escapeHtml(a.nota || 'Aporte')}</span>
        <span class="item-meta">${a.fecha || '—'} · ${activo ? 'ya cuenta en Disponible' : 'fecha futura'}</span>
      </div>
      <div class="item-right">
        <span class="item-val">${fmtShort(num(a.monto))}</span>
        <span class="item-chevron">›</span>
      </div>`;
    row.addEventListener('click', () => abrirAporte(a.id));
    lista.appendChild(row);
  });
}

function abrirAporte(id = null, silent = false) {
  aporteEditId = id;
  const a = id ? esc().aportes.find((x) => x.id === id) : null;
  document.getElementById('aporte-titulo').textContent = a ? (a.nota || 'Aporte') : 'Nuevo aporte';
  document.getElementById('aporte-fecha').value = a ? a.fecha : fechaSim();
  document.getElementById('aporte-monto').value = a ? a.monto : 0;
  document.getElementById('aporte-nota').value = a ? (a.nota || '') : '';
  document.getElementById('btn-eliminar-aporte').classList.toggle('hidden', !a);

  const montoEl = document.getElementById('aporte-status-monto');
  if (montoEl) montoEl.textContent = fmt(num(a ? a.monto : 0));
  const pill = document.getElementById('aporte-status-pill');
  if (pill) pill.textContent = a ? 'Aporte registrado' : 'Nuevo';

  const info = document.getElementById('aporte-info');
  if (info) {
    if (a && a.fecha) {
      const f = fechaSim();
      const cuenta = a.fecha <= f;
      info.innerHTML = `
        <div class="result-item"><span class="r-label">Estado a la fecha de simulación</span>
          <span class="r-value">${cuenta ? 'Incluido en Disponible' : 'Aún no cuenta (fecha futura)'}</span></div>
        <div class="result-item"><span class="r-label">Monto</span>
          <span class="r-value">${fmt(num(a.monto))}</span></div>
        <div class="result-item"><span class="r-label">Fecha</span>
          <span class="r-value">${a.fecha}</span></div>
      `;
    } else {
      info.innerHTML = `<p class="pat-hint">Desde su fecha, este capital alimenta el Disponible y puede generar interés de caja día a día.</p>`;
    }
  }

  if (silent) aplicarVista('aporte');
  else mostrarVista('aporte');
}

function guardarAporte() {
  const e = esc();
  if (!e) return;
  const fecha = document.getElementById('aporte-fecha').value || fechaSim();
  const monto = num(document.getElementById('aporte-monto').value);
  const nota = document.getElementById('aporte-nota').value.trim() || 'Aporte';
  if (!e.aportes) e.aportes = [];
  if (aporteEditId) {
    const a = e.aportes.find((x) => x.id === aporteEditId);
    if (a) { a.fecha = fecha; a.monto = monto; a.nota = nota; }
  } else {
    e.aportes.push({ id: uid(), fecha, monto, nota });
  }
  guardar();
  aporteEditId = null;
  renderAportesLista();
  mostrarVista('aportes', { replace: true });
}

/* ---------- eliminar ---------- */
function pedirEliminar(type, id, nombre) {
  deleteTarget = { type, id };
  document.getElementById('modal-delete-name').textContent = `"${nombre}"`;
  document.getElementById('modal-delete').classList.remove('hidden');
}
function eliminarConfirmado() {
  if (!deleteTarget) return;
  const tipo = deleteTarget.type;
  const e = esc();
  if (tipo === 'cdt') {
    if (!e) return;
    e.bolsillos = (e.bolsillos || []).filter((b) => b.id !== deleteTarget.id);
  } else if (tipo === 'aporte') {
    if (!e) return;
    e.aportes = (e.aportes || []).filter((a) => a.id !== deleteTarget.id);
    aporteEditId = null;
  } else if (tipo === 'meta') {
    if (!e) return;
    e.metas = (e.metas || []).filter((m) => m.id !== deleteTarget.id);
    metaEditId = null;
  } else if (tipo === 'escenario') {
    estado.escenarios = estado.escenarios.filter((e) => e.id !== deleteTarget.id);
    if (!estado.escenarios.find((e) => e.id === estado.activoId)) {
      estado.activoId = estado.escenarios[0]?.id || null;
    }
  }
  deleteTarget = null;
  document.getElementById('modal-delete').classList.add('hidden');
  guardar();
  if (tipo === 'escenario') {
    renderEscenarios();
    mostrarVista('escenarios', { replace: true });
  } else if (tipo === 'aporte') {
    renderAportesLista();
    mostrarVista('aportes', { replace: true });
  } else if (tipo === 'meta') {
    renderMetasLista();
    mostrarVista('metas', { replace: true });
  } else if (tipo === 'cdt') {
    renderInversionesLista();
    mostrarVista('inversiones', { replace: true });
  } else {
    mostrarVista('home');
    renderHome();
  }
}

/* ---------- init ---------- */

/* ---------- Firebase Auth + Firestore ---------- */
function firebaseConfigurado() {
  const c = window.FIREBASE_CONFIG;
  if (!c || typeof c !== 'object') return false;
  if (!c.apiKey || !c.projectId || !c.appId) return false;
  if (String(c.apiKey).indexOf('PEGAR') >= 0) return false;
  if (String(c.projectId).indexOf('PEGAR') >= 0) return false;
  return true;
}

function initFirebase() {
  const hint = document.getElementById('firebase-config-hint');
  if (typeof firebase === 'undefined') {
    if (hint) hint.textContent = 'No se cargó el SDK de Firebase. Revisa internet o bloqueadores.';
    return false;
  }
  if (!firebaseConfigurado()) {
    if (hint) hint.textContent = 'Config de Firebase incompleta.';
    return false;
  }
  try {
    if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
    fbAuth = firebase.auth();
    fbDb = firebase.firestore();
    try { fbDb.enableNetwork(); } catch (e) {}
    firebaseListo = true;
    if (hint) hint.textContent = '';
    return true;
  } catch (err) {
    console.error(err);
    if (hint) hint.textContent = 'Error Firebase: ' + err.message;
    return false;
  }
}

function setAuthLoading(on, text) {
  const el = document.getElementById('auth-loading');
  const t = document.getElementById('auth-loading-text');
  if (!el) return;
  if (t && text) t.textContent = text;
  el.classList.toggle('hidden', !on);
}

function actualizarAuthChip() {
  const chip = document.getElementById('auth-chip-text');
  if (!chip) return;
  if (usuario && perfilUsuario) {
    const st = syncStatus === 'syncing' ? ' · guardando…'
      : syncStatus === 'synced' ? ' · nube'
      : syncStatus === 'error' ? ' · error sync'
      : '';
    chip.textContent = '@' + (perfilUsuario.username || 'usuario') + st;
  } else if (usuario) {
    chip.textContent = usuario.email || 'Cuenta';
  } else {
    chip.textContent = 'Sin sesión';
  }
}

function exigirSesion() {
  if (usuario) return true;
  mostrarVista('gate', { replace: true });
  return false;
}

function normalizarUsername(u) {
  return String(u || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9._-]/g, '');
}

function withTimeout(promise, ms, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg || 'Tiempo agotado')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

async function usernameDisponible(username, exceptUid) {
  const key = normalizarUsername(username);
  if (key.length < 3) return { ok: false, msg: 'Mínimo 3 caracteres (letras, números, . _ -)' };
  if (key.length > 24) return { ok: false, msg: 'Máximo 24 caracteres' };
  if (!fbDb) return { ok: false, msg: 'Base de datos no disponible' };
  try {
    // Forzar red; evita error "client is offline" con caché stale
    try { await fbDb.enableNetwork(); } catch (e) { /* ignore */ }
    const ref = fbDb.collection('usernames').doc(key);
    let snap;
    try {
      snap = await withTimeout(ref.get({ source: 'server' }), 10000, 'Sin conexión al servidor');
    } catch (e1) {
      // Fallback caché / default
      try {
        snap = await withTimeout(ref.get(), 8000, 'Sin conexión');
      } catch (e2) {
        return {
          ok: false,
          msg: 'No hay conexión con Firebase. Revisa internet y las reglas de Firestore (usernames allow get).',
        };
      }
    }
    if (!snap.exists) return { ok: true, key };
    const data = snap.data() || {};
    if (exceptUid && data.uid === exceptUid) return { ok: true, key };
    return { ok: false, msg: 'Ese nombre de usuario ya está en uso' };
  } catch (err) {
    console.error('usernameDisponible', err);
    const m = (err && err.message) || '';
    if (/offline/i.test(m)) {
      return { ok: false, msg: 'Sin conexión. Activa internet e inténtalo de nuevo.' };
    }
    if (/permission|insufficient/i.test(m)) {
      return { ok: false, msg: 'Permiso denegado. Publica las reglas de usernames en Firestore.' };
    }
    return { ok: false, msg: m || 'No se pudo comprobar el usuario' };
  }
}

async function reservarUsername(username, uid) {
  const check = await usernameDisponible(username, uid);
  if (!check.ok) throw new Error(check.msg);
  const ref = fbDb.collection('usernames').doc(check.key);
  const snap = await ref.get();
  if (snap.exists && (snap.data() || {}).uid === uid) return check.key;
  await ref.set({
    uid,
    username: check.key,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return check.key;
}

async function liberarUsername(usernameKey) {
  if (!usernameKey) return;
  try {
    await fbDb.collection('usernames').doc(usernameKey).delete();
  } catch (e) { console.warn(e); }
}

async function cargarPerfil(uid) {
  const snap = await withTimeout(
    fbDb.collection('users').doc(uid).get(),
    12000,
    'Tiempo agotado al leer tu perfil'
  );
  if (snap.exists) {
    const d = snap.data() || {};
    perfilUsuario = {
      username: d.username || '',
      email: d.email || (usuario && usuario.email) || '',
    };
    let cargoEstado = false;
    if (d.estado && typeof d.estado === 'object') {
      try { cargoEstado = !!normalizarEstado(d.estado); } catch (e) { console.warn('estado inválido', e); }
    }
    return { doc: d, cargoEstado };
  }
  perfilUsuario = { username: '', email: (usuario && usuario.email) || '' };
  return { doc: null, cargoEstado: false };
}


function asegurarEstadoMinimo() {
  if (!estado || !Array.isArray(estado.escenarios) || !estado.escenarios.length) {
    const e = nuevoEscenario('Escenario A');
    estado = { activoId: e.id, escenarios: [e] };
  }
  if (!estado.activoId) estado.activoId = estado.escenarios[0].id;
}

async function guardarNube() {
  if (!usuario || !fbDb) return;
  try {
    syncStatus = 'syncing';
    actualizarAuthChip();
    asegurarEstadoMinimo();
    const payload = {
      estado,
      email: usuario.email || null,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (perfilUsuario && perfilUsuario.username) payload.username = perfilUsuario.username;
    await withTimeout(
      fbDb.collection('users').doc(usuario.uid).set(payload, { merge: true }),
      12000,
      'Tiempo agotado al guardar'
    );
    syncStatus = 'synced';
    actualizarAuthChip();
  } catch (err) {
    console.error('guardarNube', err);
    syncStatus = 'error';
    actualizarAuthChip();
  }
}

async function cargarDesdeNube() {
  if (!usuario || !fbDb) return false;
  try {
    const data = await cargarPerfil(usuario.uid);
    if (data && data.cargoEstado) {
      asegurarEstadoMinimo();
      guardarLocal();
      syncStatus = 'synced';
      return true;
    }
    // Sin documento en la nube: conservar lo que haya en este dispositivo
    cargarLocalONuevo();
    try { await guardarNube(); } catch (e) { console.warn(e); }
    return false;
  } catch (err) {
    console.error('cargarDesdeNube', err);
    syncStatus = 'error';
    try { cargarLocalONuevo(); } catch (e) { asegurarEstadoMinimo(); }
    return false;
  }
}

function necesitaVerificarEmail(user) {
  if (!user) return false;
  const providers = (user.providerData || []).map((p) => p.providerId);
  if (providers.indexOf('password') < 0) return false;
  return user.emailVerified === false;
}

function renderVerify() {
  const el = document.getElementById('verify-email-show');
  if (el && usuario) el.textContent = usuario.email || '';
  const err = document.getElementById('verify-error');
  if (err) err.classList.add('hidden');
  if (typeof applyI18n === 'function') applyI18n();
}

/** Entrar a la app tras auth; siempre quita el loading */
async function entrarAppTrasAuth() {
  setAuthLoading(true, (typeof t === 'function' ? t('loading_account') : 'Cargando tu cuenta…'));
  try {
    // Refrescar flags de verificación
    try { await usuario.reload(); } catch (e) { /* ignore */ }
    if (necesitaVerificarEmail(usuario)) {
      setAuthLoading(false);
      renderVerify();
      mostrarVista('verify', { replace: true });
      return;
    }
    await cargarDesdeNube();
  } catch (e) {
    console.error('entrarAppTrasAuth', e);
    asegurarEstadoMinimo();
  } finally {
    if (usuario && !necesitaVerificarEmail(usuario)) {
      try {
        invalidarSimCache();
        actualizarAuthChip();
        mostrarVista('home', { replace: true });
        renderHome();
      } catch (e2) {
        console.error(e2);
      }
    }
    setAuthLoading(false);
  }
}

async function resendVerification() {
  const err = document.getElementById('verify-error');
  if (err) err.classList.add('hidden');
  if (!usuario) return;
  setAuthLoading(true, typeof t === 'function' ? t('loading_mail') : 'Enviando…');
  try {
    await usuario.sendEmailVerification();
    if (err) {
      err.textContent = (currentLang === 'en')
        ? 'Email sent. Check inbox and spam.'
        : 'Correo enviado. Revisa bandeja y spam.';
      err.classList.remove('hidden');
      err.style.color = 'var(--gold)';
    }
  } catch (e) {
    if (err) {
      err.style.color = '';
      err.textContent = e.message || 'Error';
      err.classList.remove('hidden');
    }
  }
  setAuthLoading(false);
}

async function continueAfterVerify() {
  if (!usuario) return;
  setAuthLoading(true, typeof t === 'function' ? t('loading_account') : '…');
  try {
    await usuario.reload();
    if (necesitaVerificarEmail(usuario)) {
      const err = document.getElementById('verify-error');
      if (err) {
        err.style.color = '';
        err.textContent = (currentLang === 'en')
          ? 'Email not verified yet. Open the link we sent you.'
          : 'Aún no está verificado. Abre el enlace que te enviamos.';
        err.classList.remove('hidden');
      }
      setAuthLoading(false);
      return;
    }
    await cargarDesdeNube();
    invalidarSimCache();
    mostrarVista('home', { replace: true });
    renderHome();
    actualizarAuthChip();
  } catch (e) {
    console.error(e);
  }
  setAuthLoading(false);
}

let registroEnCurso = false;

function tr(es, en) {
  return window.currentLang === 'en' ? en : es;
}

function showFormError(id, text, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!text) {
    el.textContent = '';
    el.style.color = '';
    el.classList.add('hidden');
    return;
  }
  el.style.color = ok ? 'var(--gold)' : '';
  el.textContent = text;
  el.classList.remove('hidden');
}

function msgAuth(err) {
  const code = (err && err.code) || '';
  const map = {
    'auth/invalid-email': tr('Correo no válido.', 'Invalid email.'),
    'auth/missing-email': tr('Escribe tu correo.', 'Enter your email.'),
    'auth/user-not-found': tr('No hay una cuenta con ese correo.', 'No account for that email.'),
    'auth/wrong-password': tr('Correo o contraseña incorrectos.', 'Wrong email or password.'),
    'auth/invalid-credential': tr('Correo o contraseña incorrectos.', 'Wrong email or password.'),
    'auth/invalid-login-credentials': tr('Correo o contraseña incorrectos.', 'Wrong email or password.'),
    'auth/email-already-in-use': tr('Ese correo ya está registrado.', 'That email is already registered.'),
    'auth/weak-password': tr('La contraseña debe tener al menos 6 caracteres.', 'Password must be at least 6 characters.'),
    'auth/too-many-requests': tr('Demasiados intentos. Espera un momento.', 'Too many attempts. Wait a moment.'),
    'auth/network-request-failed': tr('Sin conexión. Revisa internet.', 'You are offline. Check your connection.'),
    'auth/popup-closed-by-user': tr('Cerraste la ventana de Google.', 'The Google window was closed.'),
    'auth/popup-blocked': tr('El navegador bloqueó la ventana de Google.', 'The browser blocked the Google window.'),
    'auth/account-exists-with-different-credential': tr('Ese correo ya entra con otro método.', 'That email already uses another sign-in method.'),
  };
  return map[code] || (err && err.message) || tr('No se pudo completar.', 'Something went wrong.');
}

function toggleEye(btn) {
  const input = document.getElementById(btn && btn.getAttribute('data-target'));
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.setAttribute('aria-label', show ? tr('Ocultar contraseña', 'Hide password') : tr('Ver contraseña', 'Show password'));
}

function renderCuenta() {
  if (!usuario) return;
  const name = (perfilUsuario && perfilUsuario.username) || '';
  const userEl = document.getElementById('cuenta-username');
  const input = document.getElementById('perfil-username');
  const email = document.getElementById('cuenta-email');
  const sync = document.getElementById('cuenta-sync-info');
  if (userEl) userEl.textContent = name ? '@' + name : '—';
  if (input && document.activeElement !== input) input.value = name;
  if (email) email.value = usuario.email || '';
  const syncTxt = syncStatus === 'synced' ? tr('Guardado en la nube', 'Saved in the cloud')
    : syncStatus === 'syncing' ? tr('Guardando…', 'Saving…')
    : syncStatus === 'error' ? tr('No se pudo guardar en la nube. Los datos siguen en este dispositivo.', 'Cloud save failed. Data is still on this device.')
    : tr('Solo en este dispositivo', 'On this device only');
  if (sync) {
    sync.innerHTML = '<div class="result-item"><span class="r-label">Sync</span><span class="r-value">' + syncTxt + '</span></div>';
  }
  showFormError('perfil-user-error', '');
  showFormError('perfil-pass-msg', '');
  if (typeof applyI18n === 'function') applyI18n();
  actualizarAuthChip();
}

async function doLogin() {
  showFormError('login-error', '');
  if (!fbAuth) { showFormError('login-error', tr('Firebase no está listo.', 'Firebase is not ready.')); return; }
  const email = (document.getElementById('login-email').value || '').trim();
  const pass = document.getElementById('login-password').value || '';
  if (!email || !pass) {
    showFormError('login-error', tr('Escribe correo y contraseña.', 'Enter email and password.'));
    return;
  }
  setAuthLoading(true, typeof t === 'function' ? t('loading_enter') : 'Entrando…');
  try {
    await fbAuth.signInWithEmailAndPassword(email, pass);
  } catch (err) {
    setAuthLoading(false);
    showFormError('login-error', msgAuth(err));
  }
}

async function doRegistro() {
  if (registroEnCurso) return;
  showFormError('reg-error', '');
  if (!fbAuth) { showFormError('reg-error', tr('Firebase no está listo.', 'Firebase is not ready.')); return; }
  const username = document.getElementById('reg-username').value;
  const email = (document.getElementById('reg-email').value || '').trim();
  const p1 = document.getElementById('reg-password').value || '';
  const p2 = document.getElementById('reg-password2').value || '';
  if (!email) { showFormError('reg-error', tr('Escribe un correo.', 'Enter an email.')); return; }
  if (p1.length < 6) { showFormError('reg-error', tr('La contraseña debe tener al menos 6 caracteres.', 'Password must be at least 6 characters.')); return; }
  if (p1 !== p2) { showFormError('reg-error', tr('Las contraseñas no coinciden.', 'Passwords do not match.')); return; }
  const check = await usernameDisponible(username);
  if (!check.ok) { showFormError('reg-error', check.msg); return; }

  registroEnCurso = true;
  setAuthLoading(true, typeof t === 'function' ? t('loading_create') : 'Creando cuenta…');
  try {
    const cred = await fbAuth.createUserWithEmailAndPassword(email, p1);
    usuario = cred.user;
    try {
      const key = await reservarUsername(check.key, cred.user.uid);
      perfilUsuario = { username: key, email: cred.user.email || email };
      await guardarNube();
    } catch (e) {
      console.warn(e);
      perfilUsuario = { username: '', email: cred.user.email || email };
    }
    try { await cred.user.sendEmailVerification(); } catch (e) { console.warn(e); }
    await entrarAppTrasAuth();
  } catch (err) {
    showFormError('reg-error', msgAuth(err));
  } finally {
    registroEnCurso = false;
    setAuthLoading(false);
  }
}

async function doGoogle() {
  showFormError('login-error', '');
  if (!fbAuth) { showFormError('login-error', tr('Firebase no está listo.', 'Firebase is not ready.')); return; }
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  setAuthLoading(true, typeof t === 'function' ? t('loading_google') : 'Conectando con Google…');
  try {
    await fbAuth.signInWithPopup(provider);
  } catch (err) {
    const code = err && err.code;
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      try {
        await fbAuth.signInWithRedirect(provider);
        return;
      } catch (e2) {
        setAuthLoading(false);
        showFormError('login-error', msgAuth(e2));
        return;
      }
    }
    setAuthLoading(false);
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
    showFormError('login-error', msgAuth(err));
  }
}

async function doLogout() {
  if (!fbAuth) return;
  setAuthLoading(true, typeof t === 'function' ? t('loading_logout') : 'Cerrando sesión…');
  try {
    await fbAuth.signOut();
  } catch (err) {
    setAuthLoading(false);
    showFormError('perfil-pass-msg', msgAuth(err));
  }
}

async function forgotFromGate() {
  showFormError('login-error', '');
  if (!fbAuth) return;
  const email = (document.getElementById('login-email').value || '').trim();
  if (!email) {
    showFormError('login-error', tr('Escribe tu correo para enviarte el enlace.', 'Enter your email to get the reset link.'));
    return;
  }
  setAuthLoading(true, typeof t === 'function' ? t('loading_mail') : 'Enviando correo…');
  try {
    await fbAuth.sendPasswordResetEmail(email);
    showFormError('login-error', tr('Te enviamos un enlace para restablecer la contraseña.', 'We sent a link to reset your password.'), true);
  } catch (err) {
    showFormError('login-error', msgAuth(err));
  }
  setAuthLoading(false);
}

async function enviarResetPassword() {
  showFormError('perfil-pass-msg', '');
  if (!fbAuth || !usuario || !usuario.email) {
    showFormError('perfil-pass-msg', tr('Esta cuenta no tiene correo para restablecer la contraseña.', 'This account has no email to reset the password.'));
    return;
  }
  setAuthLoading(true, typeof t === 'function' ? t('loading_mail') : 'Enviando correo…');
  try {
    await fbAuth.sendPasswordResetEmail(usuario.email);
    showFormError('perfil-pass-msg', tr('Enlace enviado. Revisa tu correo.', 'Link sent. Check your inbox.'), true);
  } catch (err) {
    showFormError('perfil-pass-msg', msgAuth(err));
  }
  setAuthLoading(false);
}

async function guardarUsernamePerfil() {
  showFormError('perfil-user-error', '');
  if (!usuario || !fbDb) return;
  const prev = (perfilUsuario && perfilUsuario.username) || '';
  const check = await usernameDisponible(document.getElementById('perfil-username').value, usuario.uid);
  if (!check.ok) { showFormError('perfil-user-error', check.msg); return; }
  if (prev === check.key) {
    showFormError('perfil-user-error', tr('Ese ya es tu nombre de usuario.', 'That is already your username.'), true);
    return;
  }
  setAuthLoading(true, typeof t === 'function' ? t('loading_save') : 'Guardando…');
  try {
    await reservarUsername(check.key, usuario.uid);
    if (prev && prev !== check.key) await liberarUsername(prev);
    perfilUsuario = { username: check.key, email: usuario.email || (perfilUsuario && perfilUsuario.email) || '' };
    await guardarNube();
    renderCuenta();
    showFormError('perfil-user-error', tr('Nombre de usuario guardado.', 'Username saved.'), true);
  } catch (err) {
    showFormError('perfil-user-error', msgAuth(err));
  }
  setAuthLoading(false);
}

function escucharAuth() {
  if (!fbAuth) return;
  // Evitar condiciones de carrera si onAuthStateChanged dispara dos veces
  let gen = 0;
  fbAuth.onAuthStateChanged(async (user) => {
    const my = ++gen;
    usuario = user;
    if (registroEnCurso) return;
    if (user) {
      try {
        await entrarAppTrasAuth();
      } catch (e) {
        console.error(e);
        setAuthLoading(false);
        asegurarEstadoMinimo();
        mostrarVista('home', { replace: true });
        try { renderHome(); } catch (e2) {}
      }
      // Si llegó otro evento más nuevo, no pisar
      if (my !== gen) return;
    } else {
      perfilUsuario = null;
      syncStatus = 'local';
      estado = { activoId: null, escenarios: [] };
      setAuthLoading(false);
      mostrarVista('gate', { replace: true });
      actualizarAuthChip();
    }
  });
}

function on(id, ev, fn) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn('Elemento no encontrado:', id);
    return;
  }
  el.addEventListener(ev, fn);
}

function init() {
  try {
  initFirebase();
  initHistorial();
  // Sin sesión no se muestra la app: solo el gate
  mostrarVista('gate', { skipHistory: true });
  if (firebaseListo) {
    escucharAuth();
    fbAuth.getRedirectResult().catch((err) => {
      setAuthLoading(false);
      if (err && err.code && err.code !== 'auth/no-auth-event') showFormError('login-error', msgAuth(err));
    });
    // Red de seguridad: nunca dejar la pantalla colgada
    setTimeout(() => {
      const el = document.getElementById('auth-loading');
      if (el && !el.classList.contains('hidden')) {
        console.warn('Auth loading timeout — forzando UI');
        setAuthLoading(false);
        if (usuario && necesitaVerificarEmail(usuario)) {
          renderVerify();
          mostrarVista('verify', { replace: true });
        } else if (usuario) {
          asegurarEstadoMinimo();
          mostrarVista('home', { replace: true });
          try { renderHome(); } catch (e) {}
        } else {
          mostrarVista('gate', { replace: true });
        }
      }
    }, 15000);
  } else {
    const hint = document.getElementById('firebase-config-hint');
    if (hint) hint.textContent = 'No se pudo iniciar Firebase.';
    setAuthLoading(false);
  }
  actualizarAuthChip();
  if (typeof applyI18n === 'function') applyI18n();
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (typeof setLang === 'function') setLang(btn.getAttribute('data-lang'));
    });
  });

  document.getElementById('btn-nuevo-cdt').addEventListener('click', () => abrirNuevoCDT());
  document.getElementById('btn-ir-aportes').addEventListener('click', () => {
    renderAportesLista();
    mostrarVista('aportes');
  });
  document.getElementById('btn-volver-aportes').addEventListener('click', volverAtras);
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
  const aporteMontoInput = document.getElementById('aporte-monto');
  if (aporteMontoInput) {
    aporteMontoInput.addEventListener('input', () => {
      const el = document.getElementById('aporte-status-monto');
      if (el) el.textContent = fmt(num(aporteMontoInput.value));
    });
  }
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
  if (inputF) {
    inputF.addEventListener('change', () => {
      const e = esc();
      if (!e) return;
      e.fechaSim = inputF.value || hoyISO();
      guardar();
      renderHome();
    });
    inputF.addEventListener('input', () => {
      const e = esc();
      if (!e || !inputF.value) return;
      e.fechaSim = inputF.value;
      actualizarTotales();
    });
  }

  // Metas (lista + detalle)
  document.getElementById('btn-ir-metas').addEventListener('click', () => {
    renderMetasLista();
    mostrarVista('metas');
  });
  document.getElementById('btn-volver-metas').addEventListener('click', volverAtras);
  document.getElementById('btn-nueva-meta').addEventListener('click', () => abrirMeta(null));
  document.getElementById('btn-volver-meta').addEventListener('click', volverAtras);
  document.getElementById('btn-guardar-meta').addEventListener('click', guardarMeta);
  document.getElementById('btn-eliminar-meta').addEventListener('click', () => {
    const m = (esc().metas || []).find((x) => x.id === metaEditId);
    if (m) pedirEliminar('meta', m.id, m.nombre || 'Meta');
  });
  ['meta-fecha', 'meta-monto'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', actualizarInfoMeta);
    if (el) el.addEventListener('change', actualizarInfoMeta);
  });
  const metaMonto = document.getElementById('meta-monto');
  if (metaMonto) {
    metaMonto.addEventListener('input', () => {
      const el = document.getElementById('meta-status-monto');
      if (el) el.textContent = fmt(num(metaMonto.value));
    });
  }

  // Inversiones lista
  document.getElementById('btn-ir-inversiones').addEventListener('click', () => {
    renderInversionesLista();
    mostrarVista('inversiones');
  });
  document.getElementById('btn-volver-inversiones').addEventListener('click', volverAtras);

  document.getElementById('btn-toggle-caja').addEventListener('click', () => {
    const form = document.getElementById('caja-form');
    const e = esc();
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) {
      const cfg = cajaCfg(e);
      document.getElementById('caja-tasa').value = cfg.tasa;
      document.getElementById('caja-retencion').value = cfg.retencion;
      document.getElementById('caja-umbral').value = cfg.umbral;
    }
  });
  on('btn-guardar-caja', 'click', () => {
    const e = esc();
    if (!e) return;
    e.caja = {
      tasa: num(document.getElementById('caja-tasa').value, 4),
      retencion: num(document.getElementById('caja-retencion').value, 7),
      umbral: num(document.getElementById('caja-umbral').value, 2881),
    };
    guardar();
    document.getElementById('caja-form').classList.add('hidden');
    renderHome();
  });

  // Atajos de navegación del inicio
  on('btn-nav-aportes', 'click', () => { renderAportesLista(); mostrarVista('aportes'); });
  on('btn-nav-inversiones', 'click', () => { renderInversionesLista(); mostrarVista('inversiones'); });
  on('btn-nav-metas', 'click', () => { renderMetasLista(); mostrarVista('metas'); });

  // Cuenta / Auth
  on('btn-cuenta', 'click', () => {
    if (!exigirSesion()) return;
    renderCuenta();
    mostrarVista('cuenta');
  });
  on('btn-volver-cuenta', 'click', () => {
    if (usuario) { mostrarVista('home'); renderHome(); }
    else mostrarVista('gate', { replace: true });
  });
  on('btn-do-login', 'click', doLogin);
  on('btn-do-registro', 'click', doRegistro);
  on('btn-google-login', 'click', doGoogle);
  on('btn-cerrar-sesion', 'click', doLogout);
  on('btn-guardar-username', 'click', guardarUsernamePerfil);
  on('btn-reset-password', 'click', enviarResetPassword);
  on('btn-forgot-password', 'click', forgotFromGate);
  on('btn-verify-resend', 'click', resendVerification);
  on('btn-verify-continue', 'click', continueAfterVerify);
  on('btn-verify-logout', 'click', doLogout);
  ['login-email', 'login-password'].forEach((id) => {
    on(id, 'keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); doLogin(); } });
  });
  ['reg-username', 'reg-email', 'reg-password', 'reg-password2'].forEach((id) => {
    on(id, 'keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); doRegistro(); } });
  });
  document.querySelectorAll('.btn-eye').forEach((btn) => {
    btn.addEventListener('click', () => toggleEye(btn));
  });
  document.querySelectorAll('#auth-tabs .auth-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#auth-tabs .auth-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.getElementById('auth-panel-login').classList.toggle('hidden', tab !== 'login');
      document.getElementById('auth-panel-registro').classList.toggle('hidden', tab !== 'registro');
    });
  });

  } catch (err) {
    console.error('Error al iniciar Monsallve Financiero:', err);
    alert('Error al cargar la app: ' + (err && err.message ? err.message : err));
  }
}

document.addEventListener('DOMContentLoaded', init);
