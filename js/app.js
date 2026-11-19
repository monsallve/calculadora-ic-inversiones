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
let txEditId = null;
let txDraftTipo = 'ingreso';
let rend30Mode = null; // 'prev' | 'next' | null
let nuevoDraft = null;

/* Firebase */
let fbClient = null;
let fbAuth = null;
let fbDb = null;
let usuario = null;       // firebase.User | null
let syncStatus = 'local'; // local | syncing | synced | error
let lastSyncError = '';
let lastSyncAt = null;
let pendingSync = false;
let needsInitialCloudPull = false;
let syncInFlight = false;
let syncQueued = false;
let firebaseListo = false;
let perfilUsuario = null; // { username, email }

function storageKeyForUser(uidVal) {
  return uidVal ? (STORAGE_KEY + '_' + uidVal) : STORAGE_KEY;
}
function pendingUsernameKey(uidVal) {
  return 'monsallve_pending_user_' + uidVal;
}
function savePendingUsername(uidVal, uname) {
  if (!uidVal || !uname) return;
  try { localStorage.setItem(pendingUsernameKey(uidVal), uname); } catch (_e) {}
}
function readPendingUsername(uidVal) {
  if (!uidVal) return '';
  try { return localStorage.getItem(pendingUsernameKey(uidVal)) || ''; } catch (_e) { return ''; }
}
function clearPendingUsername(uidVal) {
  if (!uidVal) return;
  try { localStorage.removeItem(pendingUsernameKey(uidVal)); } catch (_e) {}
}



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
    transacciones: [],
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
  const transacciones = (e.transacciones || []).filter((tx) => tx.fecha && !(excludeId && tx.id === excludeId));
  const bolsillos = (e.bolsillos || []).filter((b) => b.fechaInicio && !(excludeId && b.id === excludeId));

  let minF = fechaInclusive;
  aportes.forEach((a) => { if (a.fecha < minF) minF = a.fecha; });
  transacciones.forEach((tx) => { if (tx.fecha < minF) minF = tx.fecha; });
  bolsillos.forEach((b) => {
    if (b.fechaInicio && b.fechaInicio < minF) minF = b.fechaInicio;
    if (b.fechaFin && b.fechaFin < minF) minF = b.fechaFin;
  });

  // Mapas por fecha
  const porFecha = {};
  const ensure = (f) => {
    if (!porFecha[f]) porFecha[f] = { aportes: [], ingresos: [], gastos: [], inicios: [], fines: [] };
  };

  aportes.forEach((a) => {
    if (a.fecha > fechaInclusive) return;
    ensure(a.fecha);
    porFecha[a.fecha].aportes.push(a);
  });
  transacciones.forEach((tx) => {
    if (tx.fecha > fechaInclusive) return;
    const m = num(tx.monto);
    if (m <= 0) return;
    ensure(tx.fecha);
    if (tx.tipo === 'gasto') porFecha[tx.fecha].gastos.push(tx);
    else porFecha[tx.fecha].ingresos.push(tx);
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
      day.ingresos.forEach((tx) => {
        const m = num(tx.monto);
        balance += m;
        movs.push({ tipo: 'ingreso', id: tx.id, monto: m, nombre: tx.descripcion || 'Ingreso' });
      });
      day.fines.forEach((b) => {
        const fin = snapshotCDT(b, b.fechaFin);
        balance += fin.totalFinal;
        movs.push({ tipo: 'liberacion', monto: fin.totalFinal, nombre: (b.nombre || 'Inversión') + ' (vencimiento)', extra: fin.neto });
      });
      day.gastos.forEach((tx) => {
        const m = num(tx.monto);
        balance -= m;
        movs.push({ tipo: 'gasto', id: tx.id, monto: m, nombre: tx.descripcion || 'Gasto' });
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

function calcularRendimientoPeriodo(desdeFecha, hastaFecha) {
  const simD = simularCaja(desdeFecha);
  const simH = simularCaja(hastaFecha);
  const cajaNeto = Math.max(0, simH.interesNetoAcum - simD.interesNetoAcum);
  let invD = 0;
  let invH = 0;
  (esc()?.bolsillos || []).forEach((b) => {
    const sD = snapshotCDT(b, desdeFecha);
    if (sD.estado === 'activo' || sD.estado === 'vencido') invD += sD.neto;
    const sH = snapshotCDT(b, hastaFecha);
    if (sH.estado === 'activo' || sH.estado === 'vencido') invH += sH.neto;
  });
  const invNeto = Math.max(0, invH - invD);
  return {
    desde: desdeFecha,
    hasta: hastaFecha,
    cajaNeto,
    invNeto,
    totalNeto: cajaNeto + invNeto,
  };
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
  (e.transacciones || []).forEach((tx) => { if (tx.fecha && tx.fecha > maxF) maxF = tx.fecha; });
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
      } else if (m.tipo === 'ingreso') {
        events.push({
          fecha: d.fecha, tipo: 'ingreso', signo: '+', monto: m.monto,
          nombre: m.nombre, extra: tr('Ingreso diario', 'Daily income'),
          txId: m.id, orden: 0, saldo: null,
        });
      } else if (m.tipo === 'liberacion') {
        events.push({
          fecha: d.fecha, tipo: 'liberacion', signo: '+', monto: m.monto,
          nombre: m.nombre, orden: 0,
          extra: m.extra != null ? `neto ${fmt(m.extra)}` : '',
          saldo: null,
        });
      } else if (m.tipo === 'gasto') {
        events.push({
          fecha: d.fecha, tipo: 'gasto', signo: '−', monto: m.monto,
          nombre: m.nombre, extra: tr('Gasto diario', 'Daily expense'),
          txId: m.id, orden: 1, saldo: null,
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
    if (!Array.isArray(e.transacciones)) e.transacciones = [];
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
    e.transacciones.forEach((tx) => {
      if (!tx.id) tx.id = uid();
      tx.tipo = tx.tipo === 'gasto' ? 'gasto' : 'ingreso';
      tx.monto = Math.max(0, num(tx.monto));
      tx.descripcion = String(tx.descripcion || '').slice(0, 60);
      if (!tx.fecha) tx.fecha = e.fechaSim || hoyISO();
    });
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
  try {
    const key = storageKeyForUser(usuario && usuario.uid);
    localStorage.setItem(key, JSON.stringify(estado));
  } catch (err) { console.warn(err); }
}

function dispararGuardadoNubeInmediato() {
  if (!usuario || !fbClient || !fbDb) return;
  if (syncInFlight) {
    syncQueued = true;
    return;
  }
  syncInFlight = true;
  guardarNube({ silent: true })
    .catch((e) => console.warn(e))
    .finally(() => {
      syncInFlight = false;
      if (syncQueued && usuario && fbDb) {
        syncQueued = false;
        dispararGuardadoNubeInmediato();
      }
    });
}

function guardar() {
  invalidarSimCache();
  if (!usuario) return; // sin sesión no se persiste uso de la app
  guardarLocal();
  pendingSync = true;
  if (fbDb) {
    dispararGuardadoNubeInmediato();
  }
}

function estadoDesdeLocal() {
  const keysToTry = [];
  if (usuario && usuario.uid) keysToTry.push(storageKeyForUser(usuario.uid));
  keysToTry.push(STORAGE_KEY);
  for (const k of keysToTry) {
    try {
      const raw = localStorage.getItem(k);
      if (raw && normalizarEstado(JSON.parse(raw))) return true;
    } catch { /* migrar */ }
  }

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
const VISTAS = ['gate', 'verify', 'home', 'nuevo', 'detalle', 'aporte', 'aportes', 'inversiones', 'metas', 'meta', 'transaccion', 'movimientos', 'escenarios', 'cuenta'];
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
  else if (nombre === 'transaccion') actualizarInfoTx();
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
  renderRendimientos30();
}

function renderRendimientos30() {
  const f = fechaSim();
  const prev = calcularRendimientoPeriodo(addDays(f, -30), f);
  const next = calcularRendimientoPeriodo(f, addDays(f, 30));

  const prevEl = document.getElementById('rend-prev30-val');
  const nextEl = document.getElementById('rend-next30-val');
  if (prevEl) prevEl.textContent = (prev.totalNeto > 0 ? '+' : '') + fmt(prev.totalNeto);
  if (nextEl) nextEl.textContent = (next.totalNeto > 0 ? '+' : '') + fmt(next.totalNeto);

  const btnPrev = document.getElementById('btn-rend-prev30');
  const btnNext = document.getElementById('btn-rend-next30');
  if (btnPrev) {
    btnPrev.classList.toggle('active', rend30Mode === 'prev');
    btnPrev.setAttribute('aria-expanded', rend30Mode === 'prev' ? 'true' : 'false');
  }
  if (btnNext) {
    btnNext.classList.toggle('active', rend30Mode === 'next');
    btnNext.setAttribute('aria-expanded', rend30Mode === 'next' ? 'true' : 'false');
  }

  const panel = document.getElementById('rend-30d-panel');
  if (!panel) return;
  if (!rend30Mode) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  const info = rend30Mode === 'prev' ? prev : next;
  const title = rend30Mode === 'prev'
    ? tr('Rendimiento últimos 30 días', 'Yield in the past 30 days')
    : tr('Rendimiento próximos 30 días', 'Projected yield next 30 days');
  panel.innerHTML = `
    <div class="rend-30d-head">
      <span class="rend-30d-title">${escapeHtml(title)}</span>
      <span class="rend-30d-range">${info.desde} → ${info.hasta}</span>
    </div>
    <div class="meta-line"><span>${tr('Total rendimiento neto', 'Total net yield')}</span><strong class="gold">${(info.totalNeto > 0 ? '+' : '') + fmt(info.totalNeto)}</strong></div>
    <div class="meta-line"><span>${tr('Disponible (caja)', 'Available (cash)')}</span><strong>${fmt(info.cajaNeto)}</strong></div>
    <div class="meta-line"><span>${tr('Inversiones', 'Investments')}</span><strong>${fmt(info.invNeto)}</strong></div>
  `;
  panel.classList.remove('hidden');
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
    box.innerHTML = `<span class="meta-empty">${tr('Sin metas aún', 'No goals yet')}</span>`;
    return;
  }
  const lines = metas.slice(0, 2).map((m) => {
    if (!m.fecha) {
      return `<div class="meta-line"><span>${escapeHtml(m.nombre || 'Meta')}</span><strong>—</strong></div>`;
    }
    const pat = patrimonioEn(m.fecha);
    const obj = num(m.monto);
    let right = fmtShort(pat);
    if (obj > 0) {
      const gap = pat - obj;
      right = gap >= 0 ? 'ok' : '−' + fmtShort(-gap);
    }
    return `<div class="meta-line"><span>${escapeHtml(m.nombre || 'Meta')}</span><strong class="gold">${right}</strong></div>`;
  }).join('');
  const more = metas.length > 2 ? `<span class="meta-empty">+${metas.length - 2} ${tr('más', 'more')}</span>` : '';
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
          <span class="item-meta">${e.bolsillos.length} inversiones · ${e.aportes.length} aportes · ${(e.transacciones || []).length} mov. diarios${activo ? ' · activo' : ''}</span>
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
    const nameEl = row.querySelector('.item-name');
    rename.addEventListener('input', () => {
      const nextName = rename.value.trim() || e.nombre;
      if (nextName !== e.nombre) {
        e.nombre = nextName;
        if (nameEl) nameEl.textContent = e.nombre;
        guardar();
      }
    });
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
    `Línea de tiempo de «${e?.nombre || ''}». Toca un ingreso o gasto para editarlo.`;
  const lista = document.getElementById('lista-movimientos');
  const movs = generarMovimientos();
  const f = fechaSim();
  const futuros = (e?.transacciones || [])
    .filter((tx) => tx.fecha && tx.fecha > f)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  if (!movs.length && !futuros.length) {
    lista.innerHTML = '<p class="empty-msg">Sin movimientos todavía.</p>';
    return;
  }

  let html = movs.map((m) => {
    const clickable = !!m.txId;
    const montoClass = m.signo === '+' ? 'plus' : (m.tipo === 'gasto' ? 'minus-gasto' : 'minus');
    return `
      <div class="mov-row tipo-${m.tipo}${clickable ? ' mov-clickable' : ''}"${clickable ? ` data-tx-id="${escapeHtml(m.txId)}" role="button" tabindex="0"` : ''}>
        <div class="mov-left">
          <span class="mov-fecha">${m.fecha}</span>
          <span class="mov-nombre">${escapeHtml(m.nombre)}</span>
          ${m.extra ? `<span class="mov-extra">${escapeHtml(m.extra)}${clickable ? ' · ' + tr('tocar para editar', 'tap to edit') : ''}</span>` : ''}
        </div>
        <div class="mov-right">
          <span class="mov-monto ${montoClass}">${m.signo}${fmt(m.monto)}</span>
          <span class="mov-saldo">Disp. ${fmt(m.saldo)}</span>
        </div>
      </div>
    `;
  }).join('');

  if (futuros.length) {
    html += `<p class="mov-section-label">${tr('Programados después del', 'Scheduled after')} ${f}</p>`;
    html += futuros.map((tx) => {
      const esGasto = tx.tipo === 'gasto';
      return `
        <div class="mov-row tipo-${tx.tipo} mov-clickable" data-tx-id="${escapeHtml(tx.id)}" role="button" tabindex="0">
          <div class="mov-left">
            <span class="mov-fecha">${tx.fecha}</span>
            <span class="mov-nombre">${escapeHtml(tx.descripcion || (esGasto ? 'Gasto' : 'Ingreso'))}</span>
            <span class="mov-extra">${esGasto ? tr('Gasto futuro', 'Future expense') : tr('Ingreso futuro', 'Future income')} · ${tr('tocar para editar', 'tap to edit')}</span>
          </div>
          <div class="mov-right">
            <span class="mov-monto ${esGasto ? 'minus-gasto' : 'plus'}">${esGasto ? '−' : '+'}${fmt(num(tx.monto))}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  lista.innerHTML = html;
  lista.querySelectorAll('.mov-clickable[data-tx-id]').forEach((row) => {
    const go = () => {
      const id = row.getAttribute('data-tx-id');
      const tx = (esc()?.transacciones || []).find((x) => x.id === id);
      if (tx) abrirTransaccion(tx.tipo, tx.id);
    };
    row.addEventListener('click', go);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); }
    });
  });
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
    const aplicarCambioDetalle = () => {
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
      if (b[field] === val) return;
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
    };
    if (input.tagName === 'SELECT') {
      input.addEventListener('change', aplicarCambioDetalle);
    } else {
      input.addEventListener('input', aplicarCambioDetalle);
      input.addEventListener('change', aplicarCambioDetalle);
    }
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

/* ---------- INGRESO / GASTO DIARIO ---------- */
function syncTxTipoUI() {
  document.querySelectorAll('#tx-tipo-switch button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.txTipo === txDraftTipo);
  });
  const pill = document.getElementById('tx-status-pill');
  if (pill) {
    pill.textContent = txDraftTipo === 'gasto'
      ? tr('Gasto', 'Expense')
      : tr('Ingreso', 'Income');
  }
  const tit = document.getElementById('tx-titulo');
  if (tit) {
    if (txEditId) {
      tit.textContent = txDraftTipo === 'gasto'
        ? tr('Editar gasto', 'Edit expense')
        : tr('Editar ingreso', 'Edit income');
    } else {
      tit.textContent = txDraftTipo === 'gasto'
        ? tr('Nuevo gasto', 'New expense')
        : tr('Nuevo ingreso', 'New income');
    }
  }
}

function abrirTransaccion(tipo = 'ingreso', id = null) {
  const e = esc();
  const tx = id && e ? (e.transacciones || []).find((x) => x.id === id) : null;
  txEditId = tx ? tx.id : null;
  txDraftTipo = tx ? tx.tipo : (tipo === 'gasto' ? 'gasto' : 'ingreso');

  const descEl = document.getElementById('tx-descripcion');
  const montoEl = document.getElementById('tx-monto');
  const fechaEl = document.getElementById('tx-fecha');
  const delBtn = document.getElementById('btn-eliminar-tx');

  if (descEl) descEl.value = tx ? (tx.descripcion || '') : '';
  if (montoEl) montoEl.value = tx ? tx.monto : '';
  if (fechaEl) fechaEl.value = tx ? tx.fecha : fechaSim();
  if (delBtn) delBtn.classList.toggle('hidden', !tx);

  showFormError('tx-error', '');
  syncTxTipoUI();
  actualizarInfoTx();
  mostrarVista('transaccion');
  if (descEl && !tx) {
    setTimeout(() => { try { descEl.focus(); } catch (_e) {} }, 60);
  }
}

function actualizarInfoTx() {
  const montoEl = document.getElementById('tx-monto');
  const fechaEl = document.getElementById('tx-fecha');
  const statusMonto = document.getElementById('tx-status-monto');
  const box = document.getElementById('tx-disp-box');
  const saveBtn = document.getElementById('btn-guardar-tx');
  if (!montoEl || !fechaEl || !box) return;

  const fecha = fechaEl.value || fechaSim();
  const monto = Math.max(0, num(montoEl.value));
  const disp = disponibleEn(fecha, txEditId);
  const despues = txDraftTipo === 'gasto' ? disp - monto : disp + monto;

  if (statusMonto) {
    statusMonto.textContent = (txDraftTipo === 'gasto' ? '−' : '+') + fmt(monto);
  }
  box.innerHTML = `
    <div class="result-item"><span class="r-label">${tr('Disponible en esa fecha', 'Available on date')}</span>
      <span class="r-value">${fmt(disp)}</span></div>
    <div class="result-item"><span class="r-label">${tr('Disponible después', 'Available after')}</span>
      <span class="r-value">${fmt(despues)}</span></div>
  `;

  if (txDraftTipo === 'gasto' && monto > disp + 0.005) {
    showFormError('tx-error', tr(
      `No te alcanza el Disponible (${fmt(disp)}) en esa fecha para un gasto de ${fmt(monto)}.`,
      `Insufficient Available balance (${fmt(disp)}) on that date for a ${fmt(monto)} expense.`
    ));
    if (saveBtn) saveBtn.disabled = true;
  } else {
    showFormError('tx-error', '');
    if (saveBtn) saveBtn.disabled = false;
  }
}

function guardarTransaccion() {
  const e = esc();
  if (!e) return;
  const descEl = document.getElementById('tx-descripcion');
  const montoEl = document.getElementById('tx-monto');
  const fechaEl = document.getElementById('tx-fecha');

  const fecha = (fechaEl && fechaEl.value) || fechaSim();
  const monto = num(montoEl ? montoEl.value : 0);
  const descripcion = (descEl ? descEl.value.trim() : '')
    || (txDraftTipo === 'gasto' ? tr('Gasto', 'Expense') : tr('Ingreso', 'Income'));

  if (!(monto > 0)) {
    showFormError('tx-error', tr('Escribe un monto mayor a 0.', 'Enter an amount greater than 0.'));
    return;
  }

  if (txDraftTipo === 'gasto') {
    const disp = disponibleEn(fecha, txEditId);
    if (monto > disp + 0.005) {
      showFormError('tx-error', tr(
        `No te alcanza el Disponible (${fmt(disp)}) en esa fecha para registrar este gasto de ${fmt(monto)}.`,
        `Insufficient Available balance (${fmt(disp)}) on that date to record this ${fmt(monto)} expense.`
      ));
      return;
    }
  }

  if (!Array.isArray(e.transacciones)) e.transacciones = [];
  if (txEditId) {
    const tx = e.transacciones.find((x) => x.id === txEditId);
    if (tx) {
      tx.tipo = txDraftTipo;
      tx.fecha = fecha;
      tx.monto = monto;
      tx.descripcion = descripcion;
    }
  } else {
    e.transacciones.push({
      id: uid(),
      tipo: txDraftTipo,
      fecha,
      monto,
      descripcion,
    });
  }

  txEditId = null;
  guardar();
  volverAtras();
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
  } else if (tipo === 'transaccion') {
    if (!e) return;
    e.transacciones = (e.transacciones || []).filter((tx) => tx.id !== deleteTarget.id);
    txEditId = null;
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
  } else if (tipo === 'transaccion') {
    renderMovimientos();
    mostrarVista('movimientos', { replace: true });
  } else {
    mostrarVista('home');
    renderHome();
  }
}

/* ---------- init ---------- */

/* ---------- Firebase Auth + Firestore ---------- */
async function initFirebase() {
  const hint = document.getElementById('firebase-config-hint');
  try {
    if (!window.__firebaseClientPromise) {
      if (hint) hint.textContent = tr('No se cargó el cliente de Firebase. Revisa internet o bloqueadores.', 'Firebase client failed to load. Check network or blockers.');
      return false;
    }
    fbClient = await withTimeout(window.__firebaseClientPromise, 12000, 'Tiempo agotado cargando Firebase');
    fbAuth = fbClient.auth;
    fbDb = fbClient.db;
    firebaseListo = true;
    if (hint) hint.textContent = '';

    // Validación de conexión inicial con Firestore
    try {
      const conn = await fbClient.connectionPromise;
      if (conn && !conn.ok && conn.reason === 'offline') {
        lastSyncError = tr(
          'Sin conexión con Firestore en este momento. Los cambios se guardarán localmente hasta reconectar.',
          'Firestore is currently unreachable. Changes are saved locally until reconnected.'
        );
      }
    } catch (_e) { /* ignore */ }

    return true;
  } catch (err) {
    console.error('initFirebase', err);
    if (hint) hint.textContent = tr('Error Firebase: ', 'Firebase error: ') + (err && err.message ? err.message : String(err));
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
    const uname = '@' + (perfilUsuario.username || 'usuario');
    const st = syncStatus === 'syncing' ? tr('Guardando en la nube…', 'Saving to the cloud…')
      : syncStatus === 'synced' ? tr('Sincronizado en la nube', 'Synced to the cloud')
      : syncStatus === 'error' ? tr('Error de sincronización', 'Sync error')
      : '';
    chip.textContent = uname;
    chip.title = st ? `${uname} · ${st}` : uname;
  } else if (usuario) {
    chip.textContent = usuario.email || 'Cuenta';
    chip.title = chip.textContent;
  } else {
    chip.textContent = typeof t === 'function' ? t('chip_no_session') : 'Sin sesión';
    chip.title = '';
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

function extraerDetalleFirebase(err) {
  if (!err) return { code: '', message: '' };
  let code = err.code ? String(err.code) : '';
  let message = err.message ? String(err.message) : String(err);
  if (err.firestoreInfo && typeof err.firestoreInfo === 'object') {
    if (!code && err.firestoreInfo.code) code = String(err.firestoreInfo.code);
    if (err.firestoreInfo.error) message = String(err.firestoreInfo.error);
  } else if (message.startsWith('{')) {
    try {
      const parsed = JSON.parse(message);
      if (!code && parsed.code) code = String(parsed.code);
      if (parsed.error) message = String(parsed.error);
    } catch (_e) { /* ignore */ }
  }
  return { code, message };
}

function esErrorDeRedFirestore(err) {
  const { code, message } = extraerDetalleFirebase(err);
  const c = code.toLowerCase();
  const m = message.toLowerCase();
  return c === 'unavailable'
    || c === 'deadline-exceeded'
    || m.includes('client is offline')
    || m.includes('network')
    || m.includes('tiempo agotado')
    || m.includes('sin conexión');
}

function msgFirebaseError(err) {
  const { code, message } = extraerDetalleFirebase(err);
  if (code.startsWith('auth/')) return msgAuth({ code, message });
  const c = code.toLowerCase();
  const m = message.toLowerCase();

  if (c === 'permission-denied' || m.includes('missing or insufficient permissions') || m.includes('permission_denied')) {
    if (usuario && usuario.emailVerified === false) {
      return tr(
        'Debes verificar tu correo electrónico antes de guardar cambios en la nube.',
        'Please verify your email address before saving changes to the cloud.'
      );
    }
    return tr(
      'Permiso denegado en Firestore (permission-denied). Verifica las reglas de seguridad o vuelve a iniciar sesión.',
      'Firestore permission denied. Verify security rules or sign in again.'
    );
  }
  if (c === 'unavailable' || m.includes('client is offline') || m.includes('failed to get document because the client is offline')) {
    return tr(
      'Sin conexión con Firestore (offline). Revisa tu internet y pulsa Reintentar.',
      'Unable to reach Firestore (offline). Check your internet and tap Retry.'
    );
  }
  if (c === 'not-found' || m.includes('database') && m.includes('not found')) {
    return tr(
      'Base de datos Firestore no encontrada. Verifica la configuración del proyecto.',
      'Firestore database not found. Check your project configuration.'
    );
  }
  if (c === 'resource-exhausted' || m.includes('quota exceeded')) {
    return tr(
      'Se alcanzó la cuota diaria gratuita de Firestore. Intenta de nuevo mañana.',
      'Firestore daily free quota exceeded. Please try again tomorrow.'
    );
  }
  if (c === 'failed-precondition') {
    return tr(
      'Precondición fallida en Firestore: ' + message,
      'Firestore failed precondition: ' + message
    );
  }
  if (c === 'aborted') {
    return tr(
      'Conflicto al guardar en la nube. Intenta de nuevo.',
      'Sync conflict occurred. Please try again.'
    );
  }
  if (c === 'deadline-exceeded' || m.includes('tiempo agotado')) {
    return tr(
      'Tiempo de espera agotado al conectar con Firestore. Revisa tu conexión e intenta de nuevo.',
      'Timed out connecting to Firestore. Check your connection and retry.'
    );
  }
  return message || tr('Error de sincronización con Firebase.', 'Firebase synchronization error.');
}

function sanitizarEstadoParaNube(rawEstado) {
  const base = rawEstado && typeof rawEstado === 'object' ? rawEstado : estado;
  const list = Array.isArray(base && base.escenarios) ? base.escenarios.slice(0, 30) : [];
  if (!list.length) {
    const e = nuevoEscenario('Escenario A');
    list.push(e);
  }
  const activoId = (base && typeof base.activoId === 'string' && base.activoId.trim())
    ? base.activoId.trim().slice(0, 128)
    : String(list[0].id || uid()).slice(0, 128);
  return JSON.parse(JSON.stringify({
    activoId,
    escenarios: list,
  }));
}

async function usernameDisponible(username, exceptUid) {
  const key = normalizarUsername(username);
  if (key.length < 3) return { ok: false, msg: tr('Mínimo 3 caracteres (letras, números, . _ -)', 'Minimum 3 characters (letters, numbers, . _ -)') };
  if (key.length > 24) return { ok: false, msg: tr('Máximo 24 caracteres', 'Maximum 24 characters') };
  if (!fbClient || !fbDb) return { ok: false, msg: tr('Base de datos no disponible', 'Database not available') };

  const path = 'usernames/' + key;
  try {
    const ref = fbClient.docRef('usernames', key);
    let snap;
    try {
      snap = await withTimeout(fbClient.getDocFromServer(ref), 10000, 'Tiempo agotado al verificar usuario en Firestore');
    } catch (e1) {
      if (esErrorDeRedFirestore(e1)) {
        try {
          snap = await withTimeout(fbClient.getDoc(ref), 6000, 'Tiempo agotado al verificar usuario');
        } catch (e2) {
          return { ok: false, msg: msgFirebaseError(e2) };
        }
      } else {
        try { fbClient.handleFirestoreError(e1, fbClient.OperationType.GET, path); } catch (wrapped) {
          return { ok: false, msg: msgFirebaseError(wrapped) };
        }
        return { ok: false, msg: msgFirebaseError(e1) };
      }
    }
    if (!snap.exists()) return { ok: true, key, alreadyOwned: false };
    const data = snap.data() || {};
    if (exceptUid && data.uid === exceptUid) return { ok: true, key, alreadyOwned: true };
    return { ok: false, msg: tr('Ese nombre de usuario ya está en uso', 'That username is already taken') };
  } catch (err) {
    console.error('usernameDisponible', err);
    return { ok: false, msg: msgFirebaseError(err) };
  }
}

async function reservarUsername(username, uidVal, prevUsername) {
  const check = await usernameDisponible(username, uidVal);
  if (!check.ok) throw new Error(check.msg);
  const key = check.key;
  const prev = prevUsername ? normalizarUsername(prevUsername) : '';
  const path = 'usernames/' + key;

  if (check.alreadyOwned && (!prev || prev === key)) {
    return key;
  }

  try {
    const batch = fbClient.writeBatch();
    if (!check.alreadyOwned) {
      const newRef = fbClient.docRef('usernames', key);
      batch.set(newRef, {
        uid: uidVal,
        username: key,
        createdAt: fbClient.serverTimestamp(),
      });
    }
    if (prev && prev !== key) {
      const oldRef = fbClient.docRef('usernames', prev);
      try {
        const oldSnap = await withTimeout(fbClient.getDoc(oldRef), 6000, 'Tiempo agotado al revisar usuario anterior');
        if (oldSnap.exists() && (oldSnap.data() || {}).uid === uidVal) {
          batch.delete(oldRef);
        }
      } catch (_e) { /* Si no se pudo leer el anterior, igual reservamos el nuevo */ }
    }
    await withTimeout(batch.commit(), 12000, 'Tiempo agotado al registrar el nombre de usuario');
    return key;
  } catch (err) {
    const { code } = extraerDetalleFirebase(err);
    if (code) {
      fbClient.handleFirestoreError(err, fbClient.OperationType.WRITE, path);
    }
    throw err;
  }
}

async function cargarPerfil(uidVal) {
  const path = 'users/' + uidVal;
  const ref = fbClient.docRef('users', uidVal);
  let snap;
  try {
    try {
      snap = await withTimeout(fbClient.getDocFromServer(ref), 12000, 'Tiempo agotado al leer tu perfil');
    } catch (e1) {
      if (esErrorDeRedFirestore(e1)) {
        snap = await withTimeout(fbClient.getDoc(ref), 8000, 'Tiempo agotado al leer tu perfil');
      } else {
        throw e1;
      }
    }
  } catch (err) {
    fbClient.handleFirestoreError(err, fbClient.OperationType.GET, path);
  }

  if (snap.exists()) {
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

async function reclamarUsernamePendienteSiExiste() {
  if (!usuario || !fbClient || usuario.emailVerified === false) return;
  const pending = readPendingUsername(usuario.uid);
  if (!pending) return;
  if (perfilUsuario && perfilUsuario.username) {
    clearPendingUsername(usuario.uid);
    return;
  }
  try {
    const key = await reservarUsername(pending, usuario.uid, '');
    perfilUsuario = {
      username: key,
      email: usuario.email || (perfilUsuario && perfilUsuario.email) || '',
    };
    clearPendingUsername(usuario.uid);
    await guardarNube({ manual: true });
  } catch (err) {
    console.warn('No se pudo reclamar el username pendiente:', err);
    const { message } = extraerDetalleFirebase(err);
    if (/ya está en uso|already taken/i.test(message)) {
      clearPendingUsername(usuario.uid);
    }
  }
}

async function guardarNube(opts) {
  if (!usuario || !fbClient || !fbDb) return false;
  if (usuario.emailVerified === false) {
    syncStatus = 'error';
    lastSyncError = tr(
      'Verifica tu correo electrónico para habilitar el guardado en la nube.',
      'Verify your email address to enable cloud saving.'
    );
    actualizarAuthChip();
    if (vistaActual === 'cuenta') actualizarSyncUIEnCuenta();
    return false;
  }

  const path = 'users/' + usuario.uid;
  try {
    syncStatus = 'syncing';
    lastSyncError = '';
    actualizarAuthChip();
    if (vistaActual === 'cuenta' && opts && opts.manual) actualizarSyncUIEnCuenta();

    asegurarEstadoMinimo();
    const estadoLimpio = sanitizarEstadoParaNube(estado);
    const payload = {
      estado: estadoLimpio,
      updatedAt: fbClient.serverTimestamp(),
    };
    if (usuario.email) payload.email = String(usuario.email).slice(0, 320);
    if (perfilUsuario && perfilUsuario.username) {
      const cleanU = normalizarUsername(perfilUsuario.username);
      if (cleanU.length >= 3 && cleanU.length <= 24) payload.username = cleanU;
    }

    await withTimeout(
      fbClient.setDoc(fbClient.docRef('users', usuario.uid), payload, { merge: true }),
      12000,
      'Tiempo agotado al guardar en la nube'
    );

    syncStatus = 'synced';
    lastSyncError = '';
    lastSyncAt = new Date();
    pendingSync = false;
    needsInitialCloudPull = false;
    actualizarAuthChip();
    if (vistaActual === 'cuenta') actualizarSyncUIEnCuenta();
    return true;
  } catch (err) {
    console.error('guardarNube', err);
    try { fbClient.handleFirestoreError(err, fbClient.OperationType.WRITE, path); } catch (_wrapped) { /* logged */ }
    syncStatus = 'error';
    lastSyncError = msgFirebaseError(err);
    actualizarAuthChip();
    if (vistaActual === 'cuenta') actualizarSyncUIEnCuenta();
    return false;
  }
}

async function cargarDesdeNube() {
  if (!usuario || !fbClient || !fbDb) return false;
  try {
    const data = await cargarPerfil(usuario.uid);
    needsInitialCloudPull = false;

    if (data && data.cargoEstado) {
      asegurarEstadoMinimo();
      guardarLocal();
      pendingSync = false;
      syncStatus = 'synced';
      lastSyncError = '';
      lastSyncAt = new Date();
      await reclamarUsernamePendienteSiExiste();
      return true;
    }

    // Sin documento o sin estado en la nube: subir datos locales del dispositivo si existen o crear inicial
    cargarLocalONuevo();
    await reclamarUsernamePendienteSiExiste();
    const ok = await guardarNube({ manual: true });
    return ok;
  } catch (err) {
    console.error('cargarDesdeNube', err);
    needsInitialCloudPull = true;
    syncStatus = 'error';
    lastSyncError = msgFirebaseError(err);
    try { cargarLocalONuevo(); } catch (_e) { asegurarEstadoMinimo(); }
    return false;
  }
}

async function reintentarSyncManual() {
  if (!usuario || !fbClient || !fbDb) return;
  const btn = document.getElementById('btn-retry-sync');
  if (btn) btn.disabled = true;
  syncStatus = 'syncing';
  lastSyncError = '';
  renderCuenta();

  try {
    try { await fbClient.enableNetwork(); } catch (_e) { /* ignore */ }
    try { await fbClient.reloadUser(usuario); } catch (_e) { /* ignore */ }

    if (usuario.emailVerified === false) {
      syncStatus = 'error';
      lastSyncError = tr(
        'Tu correo aún no está verificado. Verifica tu correo antes de sincronizar.',
        'Your email is not verified yet. Please verify it before syncing.'
      );
      renderCuenta();
      return;
    }

    await reclamarUsernamePendienteSiExiste();

    if (needsInitialCloudPull && !pendingSync) {
      await cargarDesdeNube();
      invalidarSimCache();
      if (vistaActual === 'home') renderHome();
    } else {
      await guardarNube({ manual: true });
    }
  } finally {
    if (btn) btn.disabled = false;
    renderCuenta();
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
    if (fbClient && usuario) {
      try { await fbClient.reloadUser(usuario); } catch (_e) { /* ignore */ }
    }
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
  if (!usuario || !fbClient) return;
  setAuthLoading(true, typeof t === 'function' ? t('loading_mail') : 'Enviando…');
  try {
    await fbClient.sendVerificationEmail(usuario);
    if (err) {
      err.textContent = (window.currentLang === 'en')
        ? 'Email sent. Check inbox and spam.'
        : 'Correo enviado. Revisa bandeja y spam.';
      err.classList.remove('hidden');
      err.style.color = 'var(--gold)';
    }
  } catch (e) {
    if (err) {
      err.style.color = '';
      err.textContent = msgAuth(e);
      err.classList.remove('hidden');
    }
  }
  setAuthLoading(false);
}

async function continueAfterVerify() {
  if (!usuario || !fbClient) return;
  setAuthLoading(true, typeof t === 'function' ? t('loading_account') : '…');
  try {
    await fbClient.reloadUser(usuario);
    if (necesitaVerificarEmail(usuario)) {
      const err = document.getElementById('verify-error');
      if (err) {
        err.style.color = '';
        err.textContent = (window.currentLang === 'en')
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
    'auth/unauthorized-domain': tr('Este dominio no está autorizado en Firebase Authentication (Authorized domains).', 'This domain is not authorized in Firebase Authentication.'),
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

function actualizarSyncUIEnCuenta() {
  if (!usuario) return;
  const userEl = document.getElementById('cuenta-username');
  const sync = document.getElementById('cuenta-sync-info');
  const syncErrEl = document.getElementById('cuenta-sync-error');
  const retryBtn = document.getElementById('btn-retry-sync');
  const name = (perfilUsuario && perfilUsuario.username) || '';
  if (userEl) userEl.textContent = name ? '@' + name : '—';

  const syncTxt = syncStatus === 'synced' ? tr('Guardado en la nube', 'Saved in the cloud')
    : syncStatus === 'syncing' ? tr('Guardando en la nube…', 'Saving to the cloud…')
    : syncStatus === 'error' ? tr('No se pudo guardar en la nube. Tus datos siguen en este dispositivo.', 'Cloud save failed. Your data is still on this device.')
    : tr('Solo en este dispositivo', 'On this device only');

  const timeStr = lastSyncAt
    ? lastSyncAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';

  if (sync) {
    sync.innerHTML = '<div class="result-item"><span class="r-label">Sync</span><span class="r-value">'
      + escapeHtml(syncTxt) + (timeStr ? ' · ' + escapeHtml(timeStr) : '')
      + '</span></div>';
  }
  if (syncErrEl) {
    if (syncStatus === 'error' && lastSyncError) {
      syncErrEl.textContent = lastSyncError;
      syncErrEl.classList.remove('hidden');
    } else {
      syncErrEl.textContent = '';
      syncErrEl.classList.add('hidden');
    }
  }
  if (retryBtn) {
    retryBtn.disabled = syncStatus === 'syncing';
  }
  actualizarAuthChip();
}

function renderCuenta() {
  if (!usuario) return;
  const name = (perfilUsuario && perfilUsuario.username) || '';
  const input = document.getElementById('perfil-username');
  const email = document.getElementById('cuenta-email');

  if (input && document.activeElement !== input) input.value = name;
  if (email) email.value = usuario.email || '';

  actualizarSyncUIEnCuenta();
  showFormError('perfil-user-error', '');
  showFormError('perfil-pass-msg', '');
  if (typeof applyI18n === 'function') applyI18n();
}

async function doLogin() {
  showFormError('login-error', '');
  if (!fbClient || !fbAuth) { showFormError('login-error', tr('Firebase no está listo.', 'Firebase is not ready.')); return; }
  const email = (document.getElementById('login-email').value || '').trim();
  const pass = document.getElementById('login-password').value || '';
  if (!email || !pass) {
    showFormError('login-error', tr('Escribe correo y contraseña.', 'Enter email and password.'));
    return;
  }
  setAuthLoading(true, typeof t === 'function' ? t('loading_enter') : 'Entrando…');
  try {
    await fbClient.signInWithEmail(email, pass);
  } catch (err) {
    setAuthLoading(false);
    showFormError('login-error', msgAuth(err));
  }
}

async function doRegistro() {
  if (registroEnCurso) return;
  showFormError('reg-error', '');
  if (!fbClient || !fbAuth) { showFormError('reg-error', tr('Firebase no está listo.', 'Firebase is not ready.')); return; }
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
    const cred = await fbClient.registerWithEmail(email, p1);
    usuario = cred.user;
    // Guardar username pendiente para reclamarlo apenas se verifique el correo (o de inmediato si ya está verificado)
    savePendingUsername(cred.user.uid, check.key);
    perfilUsuario = { username: check.key, email: cred.user.email || email };
    if (cred.user.emailVerified) {
      try {
        const key = await reservarUsername(check.key, cred.user.uid, '');
        perfilUsuario = { username: key, email: cred.user.email || email };
        clearPendingUsername(cred.user.uid);
        await guardarNube({ manual: true });
      } catch (e) {
        console.warn(e);
      }
    } else {
      try { await fbClient.sendVerificationEmail(cred.user); } catch (e) { console.warn(e); }
    }
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
  if (!fbClient || !fbAuth) { showFormError('login-error', tr('Firebase no está listo.', 'Firebase is not ready.')); return; }
  setAuthLoading(true, typeof t === 'function' ? t('loading_google') : 'Conectando con Google…');
  try {
    await fbClient.signInWithGooglePopup();
  } catch (err) {
    const code = err && err.code;
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      try {
        await fbClient.signInWithGoogleRedirect();
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
  if (!fbClient || !fbAuth) return;
  setAuthLoading(true, typeof t === 'function' ? t('loading_logout') : 'Cerrando sesión…');
  try {
    syncQueued = false;
    if (pendingSync && !syncInFlight) {
      try { await guardarNube(); } catch (_e) { /* ignore */ }
    }
    await fbClient.signOut();
  } catch (err) {
    setAuthLoading(false);
    showFormError('perfil-pass-msg', msgAuth(err));
  }
}

async function forgotFromGate() {
  showFormError('login-error', '');
  if (!fbClient || !fbAuth) return;
  const email = (document.getElementById('login-email').value || '').trim();
  if (!email) {
    showFormError('login-error', tr('Escribe tu correo para enviarte el enlace.', 'Enter your email to get the reset link.'));
    return;
  }
  setAuthLoading(true, typeof t === 'function' ? t('loading_mail') : 'Enviando correo…');
  try {
    await fbClient.sendPasswordResetEmail(email);
    showFormError('login-error', tr('Te enviamos un enlace para restablecer la contraseña.', 'We sent a link to reset your password.'), true);
  } catch (err) {
    showFormError('login-error', msgAuth(err));
  }
  setAuthLoading(false);
}

async function enviarResetPassword() {
  showFormError('perfil-pass-msg', '');
  if (!fbClient || !fbAuth || !usuario || !usuario.email) {
    showFormError('perfil-pass-msg', tr('Esta cuenta no tiene correo para restablecer la contraseña.', 'This account has no email to reset the password.'));
    return;
  }
  setAuthLoading(true, typeof t === 'function' ? t('loading_mail') : 'Enviando correo…');
  try {
    await fbClient.sendPasswordResetEmail(usuario.email);
    showFormError('perfil-pass-msg', tr('Enlace enviado. Revisa tu correo.', 'Link sent. Check your inbox.'), true);
  } catch (err) {
    showFormError('perfil-pass-msg', msgAuth(err));
  }
  setAuthLoading(false);
}

async function guardarUsernamePerfil() {
  showFormError('perfil-user-error', '');
  if (!usuario || !fbClient || !fbDb) return;
  if (usuario.emailVerified === false) {
    showFormError('perfil-user-error', tr('Verifica tu correo antes de registrar tu nombre de usuario.', 'Verify your email before claiming a username.'));
    return;
  }
  const btn = document.getElementById('btn-guardar-username');
  const prev = (perfilUsuario && perfilUsuario.username) || '';
  if (btn) btn.disabled = true;
  try {
    const check = await usernameDisponible(document.getElementById('perfil-username').value, usuario.uid);
    if (!check.ok) { showFormError('perfil-user-error', check.msg); return; }
    if (prev === check.key) {
      showFormError('perfil-user-error', tr('Ese ya es tu nombre de usuario.', 'That is already your username.'), true);
      return;
    }
    await reservarUsername(check.key, usuario.uid, prev);
    clearPendingUsername(usuario.uid);
    perfilUsuario = { username: check.key, email: usuario.email || (perfilUsuario && perfilUsuario.email) || '' };
    const saved = await guardarNube({ manual: true });
    actualizarSyncUIEnCuenta();
    if (saved) {
      showFormError('perfil-user-error', tr('Nombre de usuario guardado en la nube.', 'Username saved to the cloud.'), true);
    } else {
      showFormError('perfil-user-error', lastSyncError || tr('Nombre reservado, pero falló el guardado del perfil.', 'Username claimed, but profile sync failed.'));
    }
  } catch (err) {
    showFormError('perfil-user-error', msgFirebaseError(err));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function escucharAuth() {
  if (!fbClient || !fbAuth) return;
  // Evitar condiciones de carrera si onAuthStateChanged dispara dos veces
  let gen = 0;
  fbClient.onAuthStateChanged(async (user) => {
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
        try { renderHome(); } catch (_e2) {}
      }
      if (my !== gen) return;
    } else {
      perfilUsuario = null;
      syncStatus = 'local';
      lastSyncError = '';
      lastSyncAt = null;
      pendingSync = false;
      needsInitialCloudPull = false;
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

async function init() {
  try {
  await initFirebase();
  initHistorial();
  // Sin sesión no se muestra la app: solo el gate
  mostrarVista('gate', { skipHistory: true });
  if (firebaseListo && fbClient) {
    escucharAuth();
    fbClient.getRedirectResult().catch((err) => {
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
          try { renderHome(); } catch (_e) {}
        } else {
          mostrarVista('gate', { replace: true });
        }
      }
    }, 15000);
  } else {
    const hint = document.getElementById('firebase-config-hint');
    if (hint && !hint.textContent) hint.textContent = tr('No se pudo iniciar Firebase.', 'Could not start Firebase.');
    setAuthLoading(false);
  }
  actualizarAuthChip();
  if (typeof applyI18n === 'function') applyI18n();
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (typeof setLang === 'function') setLang(btn.getAttribute('data-lang'));
      actualizarAuthChip();
      if (usuario && !necesitaVerificarEmail(usuario)) {
        refrescarVista(vistaActual);
      }
    });
  });

  const bindCardAction = (id, fn) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', fn);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        fn();
      }
    });
  };

  document.getElementById('btn-nuevo-cdt').addEventListener('click', () => abrirNuevoCDT());
  bindCardAction('card-ir-aportes', () => {
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
  const aporteFechaInput = document.getElementById('aporte-fecha');
  const aporteMontoInput = document.getElementById('aporte-monto');
  const aporteNotaInput = document.getElementById('aporte-nota');
  const syncAporteEnVivo = () => {
    if (aporteMontoInput) {
      const el = document.getElementById('aporte-status-monto');
      if (el) el.textContent = fmt(num(aporteMontoInput.value));
    }
    if (!aporteEditId) return;
    const e = esc();
    const a = e && (e.aportes || []).find((x) => x.id === aporteEditId);
    if (!a) return;
    const fecha = (aporteFechaInput && aporteFechaInput.value) || fechaSim();
    const monto = num(aporteMontoInput ? aporteMontoInput.value : a.monto);
    const nota = (aporteNotaInput ? aporteNotaInput.value.trim() : a.nota) || 'Aporte';
    if (a.fecha === fecha && a.monto === monto && a.nota === nota) return;
    a.fecha = fecha;
    a.monto = monto;
    a.nota = nota;
    const tit = document.getElementById('aporte-titulo');
    if (tit) tit.textContent = nota;
    guardar();
  };
  [aporteFechaInput, aporteMontoInput, aporteNotaInput].forEach((el) => {
    if (!el) return;
    el.addEventListener('input', syncAporteEnVivo);
    el.addEventListener('change', syncAporteEnVivo);
  });
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
      const nextFecha = inputF.value || hoyISO();
      if (e.fechaSim !== nextFecha) {
        e.fechaSim = nextFecha;
        guardar();
      }
      renderHome();
    });
    inputF.addEventListener('input', () => {
      const e = esc();
      if (!e || !inputF.value) return;
      if (e.fechaSim !== inputF.value) {
        e.fechaSim = inputF.value;
        guardar();
      }
      actualizarTotales();
    });
  }

  // Metas (lista + detalle)
  bindCardAction('meta-card-home', () => {
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
  const metaNombreInput = document.getElementById('meta-nombre');
  const metaFechaInput = document.getElementById('meta-fecha');
  const metaMonto = document.getElementById('meta-monto');
  const syncMetaEnVivo = () => {
    if (metaMonto) {
      const el = document.getElementById('meta-status-monto');
      if (el) el.textContent = fmt(num(metaMonto.value));
    }
    actualizarInfoMeta();
    if (!metaEditId) return;
    const e = esc();
    const m = e && (e.metas || []).find((x) => x.id === metaEditId);
    if (!m) return;
    const nombre = (metaNombreInput ? metaNombreInput.value.trim() : m.nombre) || 'Meta';
    const fecha = (metaFechaInput ? metaFechaInput.value : m.fecha) || '';
    const monto = num(metaMonto ? metaMonto.value : m.monto);
    if (m.nombre === nombre && m.fecha === fecha && m.monto === monto) return;
    m.nombre = nombre;
    m.fecha = fecha;
    m.monto = monto;
    const tit = document.getElementById('meta-titulo');
    if (tit) tit.textContent = nombre;
    guardar();
  };
  [metaNombreInput, metaFechaInput, metaMonto].forEach((el) => {
    if (!el) return;
    el.addEventListener('input', syncMetaEnVivo);
    el.addEventListener('change', syncMetaEnVivo);
  });

  // Inversiones lista (recuadro completo)
  bindCardAction('card-ir-inversiones', () => {
    renderInversionesLista();
    mostrarVista('inversiones');
  });
  document.getElementById('btn-volver-inversiones').addEventListener('click', volverAtras);

  // Ingresos / Gastos diarios y rendimientos a 30 días
  on('btn-add-ingreso', 'click', () => abrirTransaccion('ingreso', null));
  on('btn-add-gasto', 'click', () => abrirTransaccion('gasto', null));
  on('btn-rend-prev30', 'click', () => {
    rend30Mode = rend30Mode === 'prev' ? null : 'prev';
    renderRendimientos30();
  });
  on('btn-rend-next30', 'click', () => {
    rend30Mode = rend30Mode === 'next' ? null : 'next';
    renderRendimientos30();
  });

  on('btn-volver-tx', 'click', volverAtras);
  on('btn-guardar-tx', 'click', guardarTransaccion);
  on('btn-eliminar-tx', 'click', () => {
    const tx = (esc()?.transacciones || []).find((x) => x.id === txEditId);
    if (tx) pedirEliminar('transaccion', tx.id, tx.descripcion || (tx.tipo === 'gasto' ? 'Gasto' : 'Ingreso'));
  });
  document.querySelectorAll('#tx-tipo-switch button').forEach((btn) => {
    btn.addEventListener('click', () => {
      txDraftTipo = btn.dataset.txTipo === 'gasto' ? 'gasto' : 'ingreso';
      syncTxTipoUI();
      actualizarInfoTx();
    });
  });
  ['tx-descripcion', 'tx-monto', 'tx-fecha'].forEach((id) => {
    on(id, 'input', actualizarInfoTx);
    on(id, 'change', actualizarInfoTx);
  });

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
  const syncCajaEnVivo = () => {
    const e = esc();
    if (!e) return;
    const tasa = num(document.getElementById('caja-tasa').value, 4);
    const retencion = num(document.getElementById('caja-retencion').value, 7);
    const umbral = num(document.getElementById('caja-umbral').value, 2881);
    const prev = cajaCfg(e);
    if (prev.tasa === tasa && prev.retencion === retencion && prev.umbral === umbral) return;
    e.caja = { tasa, retencion, umbral };
    guardar();
    actualizarTotales();
  };
  ['caja-tasa', 'caja-retencion', 'caja-umbral'].forEach((id) => {
    on(id, 'input', syncCajaEnVivo);
    on(id, 'change', syncCajaEnVivo);
  });
  on('btn-guardar-caja', 'click', () => {
    syncCajaEnVivo();
    document.getElementById('caja-form').classList.add('hidden');
    renderHome();
  });

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
  on('btn-retry-sync', 'click', reintentarSyncManual);
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

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pendingSync && usuario && fbDb) {
      guardarNube().catch(() => {});
    }
  });
  window.addEventListener('pagehide', () => {
    if (pendingSync && usuario && fbDb) {
      guardarNube().catch(() => {});
    }
  });

  } catch (err) {
    console.error('Error al iniciar Monsallve Financiero:', err);
    alert('Error al cargar la app: ' + (err && err.message ? err.message : err));
  }
}

document.addEventListener('DOMContentLoaded', () => { init(); });
