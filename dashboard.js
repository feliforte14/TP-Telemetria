'use strict';

/* ============================================================================
 * Dashboard web de telemetría — TP05 Desarrollo de Aplicaciones II (UADE)
 *
 * Versión web del monitor de motores Unitree (electroSim). Consume el backend
 * FastAPI de la cátedra: GET /telemetria (polling) y WS /ws (tiempo real).
 *
 * Organización del archivo (cada parte solo depende de las anteriores):
 *   1. Configuración y lógica pura (semáforo, buffer circular, CSV, validación).
 *   2. Telemetria: acceso a datos. WebSocket + polling, reconexión, estadísticas.
 *      Es un Observer: la interfaz se suscribe y no sabe de dónde llegan los datos.
 *   3. Paneles: un objeto por panel (Motores, IMU, BMS, Patas, TempHistorial).
 *   4. Captura y exportación CSV.
 *   5. Aplicación: conecta todo y maneja la pantalla.
 *
 * Las funciones puras se exportan con module.exports para poder probarlas con Node.
 * ========================================================================== */

/* ============================================================================
 * 1. CONFIGURACIÓN Y LÓGICA PURA
 * ========================================================================== */

const CONFIG = Object.freeze({
  API_POR_DEFECTO: 'http://localhost:8001',
  API_CANDIDATAS: ['http://localhost:8001', 'http://localhost:8000'],   // 8001: laboratorio; 8000: servidor de ejemplo del enunciado
  POLL_MS: 250,                 // la consigna pide como máximo 500 ms
  TIMEOUT_MS: 2000,             // tiempo máximo de espera de cada pedido HTTP
  HIST_SIZE: 300,               // buffer circular (30 s a 10 Hz, como electroSim)
  MIN_GRAFICO: 60,              // la consigna pide al menos 60 muestras en el gráfico
  UMBRAL_VERDE: 40,             // < 40 °C verde
  UMBRAL_ROJO: 60,              // 40 a 60 °C amarillo, > 60 °C rojo
  HISTERESIS_ALERTA: 2,         // una alerta se rearma al bajar 2 °C del umbral
  SIN_DATOS_MS: 2000,           // sin mensajes por este tiempo = conexión caída
  WS_REINTENTO_INICIAL_MS: 1000,
  WS_REINTENTO_MAX_MS: 10000,
  FALLOS_PARA_CAIDA: 3,         // pedidos HTTP seguidos que fallan antes de avisar
  MAX_MUESTRAS: 5000,           // tope de capturas en memoria
  VENTANA_STATS_MS: 5000,       // ventana para mensajes por segundo y tráfico
});

const ETIQUETAS_TEMP = Object.freeze({
  'ok': 'Normal',
  'warn': 'Precaución',
  'hot': 'Sobrecalentado',
  'sin-dato': 'Sin dato',
});

/** Semáforo de temperatura. Mismos umbrales que electroSim. */
function clasificarTemp(t) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return 'sin-dato';
  if (t < CONFIG.UMBRAL_VERDE) return 'ok';
  if (t <= CONFIG.UMBRAL_ROJO) return 'warn';
  return 'hot';
}

/* Nombres de los motores por modelo. Los usa solo si el servidor no manda `nombre`. */
const NOMBRES_POR_DEFECTO = Object.freeze({
  12: ['FR_hip', 'FR_thigh', 'FR_calf', 'FL_hip', 'FL_thigh', 'FL_calf', 'RR_hip', 'RR_thigh', 'RR_calf', 'RL_hip', 'RL_thigh', 'RL_calf'],
});

/** Nombre de un motor: el que manda el servidor; si no, el estándar del Go2 (12 motores); si no, "Motor N". */
function nombreDeMotor(motor, total) {
  if (motor && typeof motor.nombre === 'string' && motor.nombre) return motor.nombre;
  const porDefecto = NOMBRES_POR_DEFECTO[total];
  const id = motor ? motor.id : undefined;
  return (porDefecto && porDefecto[id]) || ('Motor ' + id);
}

/** Escala del mapa de calor: de 20 a 70 °C. Los cortes del semáforo (40 y 60 °C) caen al 40 % y al 80 %. */
const ESCALA_CALOR = Object.freeze({ MIN: 20, MAX: 70 });

/** Posición (0 a 1) de una temperatura en la escala del mapa de calor; `null` si no hay dato. */
function fraccionCalor(t) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  return Math.min(1, Math.max(0, (t - ESCALA_CALOR.MIN) / (ESCALA_CALOR.MAX - ESCALA_CALOR.MIN)));
}

/**
 * Color continuo de una temperatura: verdes por debajo de 40 °C, de amarillo a naranja entre 40 y 60 °C y rojo por encima.
 * Respeta los cortes del semáforo (el color salta al cruzarlos) y cambia de tono dentro de cada tramo.
 */
function colorCalor(t) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  let tono;
  if (t < CONFIG.UMBRAL_VERDE) tono = 140 - ((Math.max(t, ESCALA_CALOR.MIN) - ESCALA_CALOR.MIN) / (CONFIG.UMBRAL_VERDE - ESCALA_CALOR.MIN)) * 30;
  else if (t <= CONFIG.UMBRAL_ROJO) tono = 48 - ((t - CONFIG.UMBRAL_VERDE) / (CONFIG.UMBRAL_ROJO - CONFIG.UMBRAL_VERDE)) * 30;
  else tono = 2;
  return 'hsl(' + Math.round(tono) + ' 78% 48%)';
}

/** Tendencia de una serie: 'sube', 'baja' o 'estable' según cuánto cambió entre el primer y el último valor (umbral en °C). */
function tendenciaDe(valores, umbral = 1) {
  const v = (valores || []).filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (v.length < 2) return 'estable';
  const d = v[v.length - 1] - v[0];
  return d >= umbral ? 'sube' : d <= -umbral ? 'baja' : 'estable';
}

/** Descripción de cada pata del cuadrúpedo, tal como la define el enunciado. */
const DESCRIPCION_PATAS = Object.freeze({ FR: 'delantera derecha', FL: 'delantera izquierda', RR: 'trasera derecha', RL: 'trasera izquierda' });

/** Porcentaje de batería acotado a 0-100 (o 0 si no es un número). */
function limitarPorcentaje(soc) {
  return (typeof soc === 'number' && Number.isFinite(soc)) ? Math.max(0, Math.min(100, soc)) : 0;
}

/** Color de la barra de batería según el nivel. */
function colorBateria(pct) {
  return pct < 20 ? 'var(--hot)' : pct < 40 ? 'var(--warn)' : 'var(--ok)';
}

/** Formatea un número para mostrarlo; '—' si no es un número válido. */
function fmt(n, decimales = 1) {
  return (typeof n === 'number' && Number.isFinite(n)) ? n.toFixed(decimales) : '—';
}

/** Buffer circular de tamaño fijo: al llenarse descarta la muestra más antigua. */
class RingBuffer {
  constructor(capacidad) {
    this.capacidad = capacidad;
    this.items = [];
  }
  push(valor) {
    this.items.push(valor);
    if (this.items.length > this.capacidad) this.items.shift();
  }
  get length() { return this.items.length; }
  toArray() { return this.items.slice(); }
  clear() { this.items.length = 0; }
}

/** Revisa que un mensaje tenga la forma del contrato (API.md). */
function validarTelemetria(d) {
  return !!d && typeof d === 'object'
    && Array.isArray(d.motores)
    && !!d.imu && typeof d.imu === 'object'
    && !!d.bms && typeof d.bms === 'object'
    && !!d.fuerzas && typeof d.fuerzas === 'object';
}

/** Acepta "192.168.0.5:8001" o "http://host:8001/" y devuelve "http://host:8001". */
function normalizarBase(texto) {
  let t = String(texto || '').trim();
  if (!t) throw new Error('Escribí la dirección del servidor.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = 'http://' + t;
  let url;
  try { url = new URL(t); } catch { throw new Error('La dirección no es válida.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Solo se admiten direcciones http:// o https://.');
  }
  return url.origin;
}

/** http://host:8001 -> ws://host:8001/ws */
function wsUrl(base) {
  return base.replace(/^http/i, 'ws') + '/ws';
}

/**
 * Geometría del gemelo digital: dónde va cada articulación en la silueta (coordenadas del SVG).
 * 12 motores = cuadrúpedo (Go2, visto desde arriba); otra cantidad = sin silueta.
 */
function disposicionGemelo(total) {
  if (total === 12) {
    // Se define la pata delantera derecha (FR), que apunta hacia adelante, y las otras tres salen por simetría.
    const FR = { hip: [205, 110], thigh: [240, 98], calf: [266, 74], pie: [280, 44] };
    const articulaciones = {};
    const huesos = [];
    const pies = {};
    const patas = {};
    const etiquetas = [{ texto: '▲ FRENTE', x: 160, y: 60 }];
    for (const [pata, [h, v]] of Object.entries({ FR: [false, false], FL: [true, false], RR: [false, true], RL: [true, true] })) {
      const p = (xy) => [h ? 320 - xy[0] : xy[0], v ? 360 - xy[1] : xy[1]];
      articulaciones[pata + '_hip'] = p(FR.hip);
      articulaciones[pata + '_thigh'] = p(FR.thigh);
      articulaciones[pata + '_calf'] = p(FR.calf);
      pies[pata] = p(FR.pie);
      huesos.push([p(FR.hip), p(FR.thigh), p(FR.calf), p(FR.pie)]);
      // Reposo de la pata y su signo: al espejar una pata, los giros cambian de sentido.
      patas[pata] = { reposo: { hip: p(FR.hip), thigh: p(FR.thigh), calf: p(FR.calf), pie: p(FR.pie) }, signo: (h ? -1 : 1) * (v ? -1 : 1), hueso: huesos.length - 1 };
      const e = p([303, 12]);  // la etiqueta queda en la esquina, lejos del pie aunque la pata se mueva
      etiquetas.push({ texto: pata, x: e[0], y: e[1] });
    }
    return {
      tipo: 'cuadrupedo', titulo: 'Cuadrúpedo · vista superior', ancho: 320, alto: 360, radioArt: 9,
      decoracion: [{ tipo: 'rect', x: 120, y: 78, ancho: 80, alto: 204, radio: 26 }],
      huesos, articulaciones, pies, etiquetas, patas,
    };
  }
  return null;
}

/**
 * Pose de una pata a partir de los ángulos de sus tres motores (grados). Es una aproximación visual de la vista
 * superior: la cadera abre o cierra la pata, y el muslo y la pantorrilla la adelantan o la atrasan. Los giros
 * se acumulan a lo largo de la cadena y la longitud de cada hueso se conserva.
 * `reposo` = {hip, thigh, calf, pie}; `signo` = ±1 según el lado de la pata.
 */
/** ¿El sistema pidió reducir las animaciones? */
function movimientoReducido() { return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

const GANANCIA_POSE = Object.freeze({ hip: 0.3, thigh: 0.55, calf: 0.3 });
function posePata(reposo, signo, ang) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const rad = (g) => (g * Math.PI) / 180;
  const giro = (v, g) => { const c = Math.cos(g), s = Math.sin(g); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c]; };
  const resta = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const suma = (a, b) => [a[0] + b[0], a[1] + b[1]];
  let acum = rad(signo * GANANCIA_POSE.hip * num(ang.hip));
  const thigh = suma(reposo.hip, giro(resta(reposo.thigh, reposo.hip), acum));
  acum += rad(signo * GANANCIA_POSE.thigh * num(ang.thigh));
  const calf = suma(thigh, giro(resta(reposo.calf, reposo.thigh), acum));
  acum += rad(signo * GANANCIA_POSE.calf * num(ang.calf));
  const pie = suma(calf, giro(resta(reposo.pie, reposo.calf), acum));
  return { hip: reposo.hip, thigh, calf, pie };
}

/**
 * Puntos ("x,y x,y ...") de una línea de tendencia. Los valores se ubican a la derecha si hay menos que
 * `capacidad`, así la línea "crece" desde el borde. Si casi no varían se usa un rango mínimo de 2 unidades,
 * para no agrandar el ruido.
 */
function puntosTendencia(valores, ancho = 84, alto = 22, capacidad = valores.length) {
  const v = valores.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (v.length < 2) return '';
  const min = Math.min(...v);
  const max = Math.max(...v);
  const rango = Math.max(max - min, 2);
  const base = min - (rango - (max - min)) / 2;
  const margen = 2;
  const paso = ancho / Math.max(capacidad - 1, 1);
  const inicio = Math.max(capacidad - v.length, 0);
  return v.map((x, i) => {
    const px = (inicio + i) * paso;
    const py = alto - margen - ((x - base) / rango) * (alto - 2 * margen);
    return px.toFixed(1) + ',' + py.toFixed(1);
  }).join(' ');
}

/** Pasa un mensaje de la API a una fila plana (una columna por valor) para el CSV. */
function aplanarMuestra(data, evento = 'manual', ahora = new Date()) {
  const fila = {
    fecha_hora: ahora.toISOString(),                                   // UTC, sin ambigüedad
    hora_local: ahora.toLocaleTimeString('es-AR', { hour12: false }),   // la hora que ve el usuario
    ts_servidor_s: data.ts,
    modelo: data.modelo,
    evento,
  };
  const imu = data.imu || {};
  for (const k of ['roll', 'pitch', 'yaw', 'ax', 'ay', 'az']) fila['imu_' + k] = imu[k];

  const bms = data.bms || {};
  fila.bms_soc_pct = bms.soc;
  fila.bms_corriente_ma = bms.corriente;
  fila.bms_temperatura_c = bms.temperatura;
  (bms.celdas || []).forEach((v, i) => { fila['bms_celda_' + (i + 1) + '_v'] = v; });

  for (const [pata, valor] of Object.entries(data.fuerzas || {})) fila['pata_' + pata] = valor;

  for (const m of data.motores || []) {
    const base = 'm' + String(m.id).padStart(2, '0') + '_' + nombreDeMotor(m, (data.motores || []).length);
    fila[base + '_temp_c'] = m.temperatura;
    fila[base + '_angulo_deg'] = m.angulo;
    fila[base + '_vel_rad_s'] = m.velocidad;
    fila[base + '_torque_nm'] = m.torque;
  }
  return fila;
}

/** Escapa un valor para CSV. Evita además que Excel interprete texto como fórmula. */
function escaparCSV(valor) {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'number') return Number.isFinite(valor) ? String(valor) : '';
  let s = String(valor);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Arma el texto CSV. Las columnas son la unión de las de todas las muestras (en orden de aparición). */
function construirCSV(muestras) {
  const columnas = [];
  const vistas = new Set();
  for (const m of muestras) {
    for (const k of Object.keys(m)) {
      if (!vistas.has(k)) { vistas.add(k); columnas.push(k); }
    }
  }
  const lineas = [columnas.map(escaparCSV).join(',')];
  for (const m of muestras) lineas.push(columnas.map(c => escaparCSV(m[c])).join(','));
  return lineas.join('\r\n') + '\r\n';
}

/** Mínimo, máximo y diferencia de un conjunto de valores. */
function estadisticaCeldas(celdas) {
  const v = celdas.filter(x => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return null;
  const min = Math.min(...v);
  const max = Math.max(...v);
  return { min, max, delta: max - min };
}

/** Motores que pasaron a estar por encima del umbral rojo y todavía no estaban en alerta. */
function motoresNuevosEnAlerta(motores, enAlerta) {
  const nuevos = [];
  for (const m of motores) {
    const t = m.temperatura;
    if (typeof t !== 'number') continue;
    if (t > CONFIG.UMBRAL_ROJO) {
      if (!enAlerta.has(m.id)) { enAlerta.add(m.id); nuevos.push(m); }
    } else if (t < CONFIG.UMBRAL_ROJO - CONFIG.HISTERESIS_ALERTA) {
      enAlerta.delete(m.id);
    }
  }
  return nuevos;
}

/* ============================================================================
 * 2. TELEMETRIA — acceso a datos (patrón Observer)
 *
 * Quien quiera datos se suscribe con en('dato', fn) y en('estado', fn).
 * Modos: 'auto'    WebSocket; si falla, polling mientras reintenta el WebSocket.
 *        'ws'      solo WebSocket (reconecta con espera creciente).
 *        'polling' solo GET /telemetria cada POLL_MS.
 * Estados: 'conectando' | 'ws' | 'polling' | 'caido'.
 * ========================================================================== */

class Telemetria {
  constructor() {
    this.oyentes = { dato: [], estado: [] };
    this.base = null;
    this.modelo = '';
    this.modo = 'auto';
    this.estado = 'conectando';
    this.detalle = '';
    this.intentos = 0;
    this.ultimoDato = null;
    this.ultimoDatoEn = 0;
    this.invalidos = 0;
    this.rttMs = null;
    this._llegadas = [];
    this._gen = 0;            // se incrementa en cada iniciar(); descarta callbacks viejos
    this._ws = null;
    this._wsAbierto = false;
    this._wsReintentoMs = CONFIG.WS_REINTENTO_INICIAL_MS;
    this._wsTimer = null;
    this._pollActivo = false;
    this._pollTimer = null;
    this._fallosPoll = 0;
    this._vigilante = null;
  }

  en(evento, fn) { this.oyentes[evento].push(fn); }

  _emitir(evento, arg) {
    for (const fn of this.oyentes[evento]) {
      try { fn(arg); } catch (e) { console.error('Error en un suscriptor de ' + evento, e); }
    }
  }

  _setEstado(estado, detalle = '') {
    if (estado === this.estado && detalle === this.detalle) return;
    this.estado = estado;
    this.detalle = detalle;
    this._emitir('estado', { estado, detalle, intentos: this.intentos });
  }

  /** `modelo` ('go2') es opcional: se manda como ?modelo= en el polling. El WebSocket no permite elegir robot. */
  iniciar(base, modo = 'auto', modelo = '') {
    this.detener();
    this.base = base;
    this.modelo = modelo || '';
    this.modo = this.modelo ? 'polling' : modo;
    modo = this.modo;
    this.intentos = 0;
    this.ultimoDato = null;
    this.ultimoDatoEn = 0;
    this.rttMs = null;
    this._llegadas = [];
    this._wsReintentoMs = CONFIG.WS_REINTENTO_INICIAL_MS;
    this._fallosPoll = 0;
    const gen = this._gen;
    this._setEstado('conectando', 'Conectando con ' + base);
    if (modo === 'polling') this._iniciarPolling(gen); else this._abrirWS(gen);
    this._vigilante = setInterval(() => this._vigilar(gen), 1000);
  }

  detener() {
    this._gen++;
    clearTimeout(this._wsTimer);
    clearTimeout(this._pollTimer);
    clearInterval(this._vigilante);
    this._pollActivo = false;
    this._wsAbierto = false;
    if (this._ws) {
      this._ws.onopen = this._ws.onmessage = this._ws.onerror = this._ws.onclose = null;
      try { this._ws.close(); } catch { /* ya estaba cerrado */ }
      this._ws = null;
    }
  }

  /** Se llama cuando llega un mensaje bueno, venga de donde venga. */
  _recibir(texto, rtt) {
    let d;
    try { d = JSON.parse(texto); } catch { this.invalidos++; return; }
    if (!validarTelemetria(d)) { this.invalidos++; return; }
    const ahora = Date.now();
    this.ultimoDato = d;
    this.ultimoDatoEn = ahora;
    if (rtt !== null && rtt !== undefined) this.rttMs = rtt;
    this._llegadas.push({ t: ahora, bytes: texto.length });
    const limite = ahora - CONFIG.VENTANA_STATS_MS;
    while (this._llegadas.length && this._llegadas[0].t < limite) this._llegadas.shift();
    this._emitir('dato', d);
  }

  /** Mensajes por segundo, intervalo medio y tráfico en la ventana reciente. */
  estadisticas() {
    const n = this._llegadas.length;
    if (n < 2) return { msgsPorSeg: 0, intervaloMs: null, kbPorSeg: 0, rttMs: this.rttMs };
    const span = (this._llegadas[n - 1].t - this._llegadas[0].t) / 1000;
    const bytes = this._llegadas.slice(1).reduce((a, x) => a + x.bytes, 0);
    return {
      msgsPorSeg: span > 0 ? (n - 1) / span : 0,
      intervaloMs: span > 0 ? (span * 1000) / (n - 1) : null,
      kbPorSeg: span > 0 ? bytes / 1024 / span : 0,
      rttMs: this.rttMs,
    };
  }

  /** Cada segundo: si el flujo se cortó sin que el navegador lo avise, lo detecta. */
  _vigilar(gen) {
    if (gen !== this._gen) return;
    if (!this.ultimoDatoEn) return;
    const edad = Date.now() - this.ultimoDatoEn;
    if (edad > CONFIG.SIN_DATOS_MS && (this.estado === 'ws' || this.estado === 'polling')) {
      this._setEstado('caido', 'No llegan datos hace ' + Math.round(edad / 1000) + ' s');
      if (this._ws) { try { this._ws.close(); } catch { /* sigue */ } }
    }
  }

  /* ---------- WebSocket ---------- */

  _abrirWS(gen) {
    if (gen !== this._gen) return;
    let ws;
    try {
      ws = new WebSocket(wsUrl(this.base));
    } catch (e) {
      this._wsFallo(gen, 'Dirección de WebSocket inválida');
      return;
    }
    this._ws = ws;
    ws.onopen = () => {
      if (gen !== this._gen) return;
      this._wsAbierto = true;
      this._wsReintentoMs = CONFIG.WS_REINTENTO_INICIAL_MS;
      this.intentos = 0;
      this._detenerPolling();          // si estaba el respaldo por polling, ya no hace falta
      this._setEstado('ws', 'WebSocket');
    };
    ws.onmessage = (ev) => {
      if (gen !== this._gen) return;
      if (typeof ev.data !== 'string') return;
      this._recibir(ev.data, null);
      if (this.estado !== 'ws') this._setEstado('ws', 'WebSocket');
    };
    ws.onerror = () => { /* siempre viene seguido de onclose */ };
    ws.onclose = () => {
      if (gen !== this._gen) return;
      this._ws = null;
      this._wsAbierto = false;
      this._wsFallo(gen, 'Se cerró el WebSocket');
    };
  }

  _wsFallo(gen, motivo) {
    if (gen !== this._gen) return;
    this.intentos++;
    if (this.modo === 'auto') {
      this._iniciarPolling(gen);        // respaldo: seguir recibiendo datos mientras se reintenta
      if (this.estado !== 'polling') this._setEstado('conectando', motivo + '. Probando con polling…');
    } else {
      this._setEstado('caido', motivo + '. Reintentando en ' + Math.round(this._wsReintentoMs / 1000) + ' s…');
    }
    clearTimeout(this._wsTimer);
    this._wsTimer = setTimeout(() => this._abrirWS(gen), this._wsReintentoMs);
    this._wsReintentoMs = Math.min(this._wsReintentoMs * 2, CONFIG.WS_REINTENTO_MAX_MS);
  }

  /* ---------- Polling ---------- */

  _iniciarPolling(gen) {
    if (this._pollActivo || gen !== this._gen) return;
    this._pollActivo = true;
    this._fallosPoll = 0;
    this._cicloPolling(gen);
  }

  _detenerPolling() {
    this._pollActivo = false;
    clearTimeout(this._pollTimer);
  }

  /** Un pedido por vez: el siguiente se agenda recién cuando termina el anterior. */
  async _cicloPolling(gen) {
    if (!this._pollActivo || gen !== this._gen) return;
    const inicio = performance.now();
    const ctrl = new AbortController();
    const corte = setTimeout(() => ctrl.abort(), CONFIG.TIMEOUT_MS);
    try {
      const url = this.base + '/telemetria' + (this.modelo ? '?modelo=' + encodeURIComponent(this.modelo) : '');
      const resp = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!resp.ok) {
        let detalle = '';
        try { const j = await resp.json(); if (j && typeof j.detail === 'string') detalle = j.detail; } catch { /* sin cuerpo JSON */ }
        throw new Error(detalle || 'El servidor respondió HTTP ' + resp.status);
      }
      const texto = await resp.text();
      if (gen !== this._gen || !this._pollActivo) return;
      this._fallosPoll = 0;
      this._recibir(texto, performance.now() - inicio);
      if (!this._wsAbierto) this._setEstado('polling', 'Polling cada ' + CONFIG.POLL_MS + ' ms');
    } catch (e) {
      if (gen !== this._gen || !this._pollActivo) return;
      this._fallosPoll++;
      if (this._fallosPoll >= CONFIG.FALLOS_PARA_CAIDA) {
        const motivo = !e ? 'error de red'
          : e.name === 'AbortError' ? 'el servidor no responde'
          : e.name === 'TypeError' ? 'no se pudo contactar al servidor'
          : e.message || 'error de red';
        this._setEstado('caido', 'Falló la conexión (' + motivo + '). Reintentando…');
      }
    } finally {
      clearTimeout(corte);
    }
    if (!this._pollActivo || gen !== this._gen) return;
    const gastado = performance.now() - inicio;
    const espera = this._fallosPoll > 0 ? 1000 : Math.max(0, CONFIG.POLL_MS - gastado);
    this._pollTimer = setTimeout(() => this._cicloPolling(gen), espera);
  }
}

/* Exportación para las pruebas con Node (en el navegador no existe `module`). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG, clasificarTemp, fmt, RingBuffer, validarTelemetria, normalizarBase, wsUrl,
    aplanarMuestra, escaparCSV, construirCSV, estadisticaCeldas, motoresNuevosEnAlerta, Telemetria,
    nombreDeMotor, limitarPorcentaje, colorBateria, disposicionGemelo, posePata, puntosTendencia, fraccionCalor, colorCalor, tendenciaDe, ESCALA_CALOR,
  };
}

/* ============================================================================
 * 3. PANELES
 * Cada panel tiene construir() (cuando se conoce el modelo de robot) y
 * actualizar(datos). Todo el texto se escribe con textContent: ningún dato del
 * servidor se interpreta como HTML.
 * ========================================================================== */

const $ = (id) => document.getElementById(id);

function crear(tag, clase, texto) {
  const el = document.createElement(tag);
  if (clase) el.className = clase;
  if (texto !== undefined) el.textContent = texto;
  return el;
}

const COLORES_IMU = { roll: '#60a5fa', pitch: '#34d399', yaw: '#fbbf24' };

function colorMotor(indice, total) {
  return 'hsl(' + Math.round((indice * 360) / Math.max(total, 1)) + ', 70%, 60%)';
}

/** Lee los colores del tema activo (variables CSS) para que los gráficos combinen con la pantalla. */
function coloresChart() {
  const css = getComputedStyle(document.documentElement);
  return {
    texto: css.getPropertyValue('--texto-suave').trim() || '#94a3b8',
    grilla: css.getPropertyValue('--borde').trim() || '#334155',
  };
}

function configurarChartJs() {
  if (typeof Chart === 'undefined') return false;
  const c = coloresChart();
  Chart.defaults.color = c.texto;
  Chart.defaults.borderColor = c.grilla;
  Chart.defaults.font.family = 'system-ui, sans-serif';
  Chart.defaults.animation = false;
  return true;
}

/** Cambia el tema de un gráfico que ya existe, sin perder sus datos. */
function recolorearChart(chart) {
  if (!chart) return;
  const c = coloresChart();
  chart.options.color = c.texto;
  for (const eje of ['x', 'y']) {
    const e = chart.options.scales[eje];
    e.ticks.color = c.texto;
    e.grid = { ...(e.grid || {}), color: c.grilla };
    e.title.color = c.texto;
  }
  chart.options.plugins.legend.labels.color = c.texto;
  chart.update('none');
}

const opcionesLinea = (etiquetaY) => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  interaction: { mode: 'index', intersect: false },
  elements: { point: { radius: 0 }, line: { borderWidth: 1.6, tension: 0 } },
  scales: {
    x: { ticks: { maxTicksLimit: 6 }, title: { display: true, text: 'tiempo del servidor (s)' } },
    y: { title: { display: true, text: etiquetaY } },
  },
  plugins: { legend: { labels: { boxWidth: 12 } } },
});

/* ---------- Panel de motores (tabla ordenable + mapa de calor) ---------- */
const PanelMotores = {
  filas: [],
  mosaicos: [],
  orden: 'ninguno',          // 'ninguno' | 'desc' | 'asc' (por temperatura)
  ordenDOM: [],
  ultimos: [],
  historial: [],             // últimas 60 temperaturas de cada motor, para el minigráfico

  construir(motores) {
    const tbody = document.querySelector('#tablaMotores tbody');
    tbody.replaceChildren();
    this.filas = motores.map((m) => {
      const tr = crear('tr');
      const pastilla = crear('span', 'pill-temp', '—');
      const temp = crear('td', 'temp sin-dato');
      temp.appendChild(pastilla);
      const NS = 'http://www.w3.org/2000/svg';
      const spark = document.createElementNS(NS, 'svg');
      spark.setAttribute('viewBox', '0 0 84 22');
      spark.setAttribute('preserveAspectRatio', 'none');
      spark.setAttribute('class', 'spark sin-dato');
      spark.setAttribute('aria-hidden', 'true');
      const linea = document.createElementNS(NS, 'polyline');
      spark.appendChild(linea);
      const tdSpark = crear('td', 'tendencia');
      tdSpark.appendChild(spark);
      const celdas = {
        tr,
        nombre: crear('td', '', nombreDeMotor(m, motores.length)),
        temp,
        tempTexto: pastilla,
        estado: crear('td', 'estado', '—'),
        tendencia: tdSpark,
        spark,
        linea,
        angulo: crear('td', '', '—'),
        velocidad: crear('td', '', '—'),
        torque: crear('td', '', '—'),
      };
      for (const k of ['nombre', 'temp', 'estado', 'tendencia', 'angulo', 'velocidad', 'torque']) tr.appendChild(celdas[k]);
      tbody.appendChild(tr);
      return celdas;
    });
    this.filas.forEach((f, i) => {
      // Pasar el mouse por una fila resalta su articulación en el gemelo digital, y al revés.
      f.tr.addEventListener('mouseenter', () => Gemelo.resaltar(i, true));
      f.tr.addEventListener('mouseleave', () => Gemelo.resaltar(i, false));
    });
    this.historial = motores.map(() => new RingBuffer(60));
    this.ordenDOM = this.filas.map((_, i) => i);
    this.ultimos = [];
    this._construirMapa(motores);
  },

  /** Mapa de calor: una tarjeta por pata (o grupo de articulaciones), ubicadas como en el robot cuando son las cuatro patas. */
  _construirMapa(motores) {
    const cont = $('mapaMotores');
    cont.replaceChildren();
    this.mosaicos = [];
    this.grupos = {};
    const grupos = new Map();
    motores.forEach((m, i) => {
      const nombre = nombreDeMotor(m, motores.length);
      const corte = nombre.indexOf('_');
      const grupo = corte > 0 ? nombre.slice(0, corte) : 'Motores';
      const corto = corte > 0 ? nombre.slice(corte + 1) : nombre;
      if (!grupos.has(grupo)) grupos.set(grupo, []);
      grupos.get(grupo).push({ i, corto });
    });
    // Con las cuatro patas del cuadrúpedo, se ubican como se ve el robot desde arriba: delanteras arriba, traseras abajo.
    let orden = [...grupos.keys()];
    const vista = ['FL', 'FR', 'RL', 'RR'];
    if (vista.every((g) => grupos.has(g)) && orden.length === 4) orden = vista;
    const grilla = crear('div', 'mapa-grilla' + (orden === vista ? ' cuatro-patas' : ''));
    for (const grupo of orden) {
      const tarjeta = crear('section', 'mapa-grupo');
      const cab = crear('header', 'mapa-cab');
      cab.appendChild(crear('b', '', grupo));
      const maxEl = crear('span', 'mapa-max', '—');
      cab.appendChild(maxEl);
      tarjeta.appendChild(cab);
      const fila = crear('div', 'mapa-fila');
      for (const { i, corto } of grupos.get(grupo)) {
        const t = crear('div', 'mosaico');
        t.tabIndex = 0;
        t.appendChild(crear('small', '', corto));
        const val = crear('b', '', '—');
        t.appendChild(val);
        const barra = crear('i', 'mosaico-barra');
        const relleno = crear('i', '');
        barra.appendChild(relleno);
        t.appendChild(barra);
        const tend = crear('span', 'mosaico-tend', '');
        t.appendChild(tend);
        t.addEventListener('mouseenter', () => Gemelo.resaltar(i, true));
        t.addEventListener('mouseleave', () => Gemelo.resaltar(i, false));
        t.addEventListener('click', () => this.irAFila(i));
        t.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.irAFila(i); } });
        fila.appendChild(t);
        this.mosaicos[i] = { el: t, val, relleno, tend };
      }
      tarjeta.appendChild(fila);
      grilla.appendChild(tarjeta);
      this.grupos[grupo] = { max: maxEl, indices: grupos.get(grupo).map((x) => x.i), tarjeta };
    }
    cont.appendChild(grilla);
    // Escala de colores con los cortes del semáforo
    const escala = crear('div', 'escala-calor');
    const barraEsc = crear('i', 'escala-barra');
    const marca = crear('i', 'escala-marca');
    barraEsc.appendChild(marca);
    escala.appendChild(barraEsc);
    const etiquetas = crear('div', 'escala-etq');
    for (const [t, texto] of [[ESCALA_CALOR.MIN, '≤ 20 °C'], [CONFIG.UMBRAL_VERDE, '40 °C'], [CONFIG.UMBRAL_ROJO, '60 °C'], [ESCALA_CALOR.MAX, '≥ 70 °C']]) {
      const e = crear('span', '', texto);
      e.style.left = (fraccionCalor(t) * 100) + '%';
      etiquetas.appendChild(e);
    }
    escala.appendChild(etiquetas);
    const resumen = crear('p', 'escala-resumen', '');
    escala.appendChild(resumen);
    cont.appendChild(escala);
    this.escala = { marca, resumen };
  },

  /** Resalta (o no) la fila de un motor en la tabla. */
  resaltarFila(i, encendida) {
    if (this.filas[i]) this.filas[i].tr.classList.toggle('resaltada', encendida);
  },

  /** Lleva la tabla hasta la fila de un motor y la hace destellar (clic en el gemelo digital). */
  irAFila(i) {
    const f = this.filas[i];
    if (!f) return;
    this.mostrarVista('tabla');
    f.tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    f.tr.classList.remove('destello');
    void f.tr.offsetWidth;                  // reinicia la animación
    f.tr.classList.add('destello');
  },

  mostrarVista(vista) {
    const mapa = vista === 'mapa';
    $('tablaWrap').hidden = mapa;
    $('mapaMotores').hidden = !mapa;
    $('vistaTabla').setAttribute('aria-pressed', String(!mapa));
    $('vistaMapa').setAttribute('aria-pressed', String(mapa));
  },

  /** Alterna el orden de la tabla: original, de más caliente a más frío, de más frío a más caliente. */
  cambiarOrden() {
    this.orden = this.orden === 'ninguno' ? 'desc' : this.orden === 'desc' ? 'asc' : 'ninguno';
    $('thTemp').setAttribute('aria-sort', this.orden === 'desc' ? 'descending' : this.orden === 'asc' ? 'ascending' : 'none');
    this._ordenar();
  },

  _ordenar() {
    const t = (i) => (this.ultimos[i] && typeof this.ultimos[i].temperatura === 'number') ? this.ultimos[i].temperatura : -Infinity;
    let indices = this.filas.map((_, i) => i);
    if (this.orden === 'desc') indices.sort((a, b) => t(b) - t(a) || a - b);
    else if (this.orden === 'asc') indices.sort((a, b) => t(a) - t(b) || a - b);
    if (indices.join() === this.ordenDOM.join()) return;      // nada que mover
    this.ordenDOM = indices;
    document.querySelector('#tablaMotores tbody').append(...indices.map((i) => this.filas[i].tr));
  },

  /** Actualiza tabla y mapa. Devuelve un resumen para el panel de indicadores. */
  actualizar(motores) {
    const cuenta = { 'ok': 0, 'warn': 0, 'hot': 0 };
    let maxT = -Infinity;
    let maxNombre = '';
    this.ultimos = motores;
    motores.forEach((m, i) => {
      const f = this.filas[i];
      if (!f) return;
      const nivel = clasificarTemp(m.temperatura);
      const texto = fmt(m.temperatura, 1) + ' °C';
      f.temp.className = 'temp ' + nivel;
      f.tempTexto.textContent = texto;
      f.estado.textContent = ETIQUETAS_TEMP[nivel];
      f.angulo.textContent = fmt(m.angulo, 2);
      f.velocidad.textContent = fmt(m.velocidad, 3);
      f.torque.textContent = fmt(m.torque, 2);
      if (this.historial[i]) {
        this.historial[i].push(m.temperatura);
        f.linea.setAttribute('points', puntosTendencia(this.historial[i].items, 84, 22, 60));
        f.spark.setAttribute('class', 'spark ' + nivel);
      }
      const mosaico = this.mosaicos[i];
      if (mosaico) {
        const color = colorCalor(m.temperatura);
        mosaico.el.className = 'mosaico ' + nivel;
        mosaico.el.style.setProperty('--calor', color || 'var(--sin-dato)');
        mosaico.val.textContent = fmt(m.temperatura, 1) + '°';
        const fr = fraccionCalor(m.temperatura);
        mosaico.relleno.style.width = (fr === null ? 0 : Math.max(4, fr * 100)) + '%';
        const tend = tendenciaDe(this.historial[i] ? this.historial[i].items.slice(-20) : []);
        mosaico.tend.textContent = tend === 'sube' ? '▲' : tend === 'baja' ? '▼' : '';
        mosaico.tend.title = tend === 'sube' ? 'Subiendo' : tend === 'baja' ? 'Bajando' : '';
        mosaico.el.title = nombreDeMotor(m, motores.length) + ' · ' + texto + ' · ángulo ' + fmt(m.angulo, 1) + '° · torque ' + fmt(m.torque, 2) + ' N·m';
      }
      if (nivel in cuenta) cuenta[nivel]++;
      if (typeof m.temperatura === 'number' && m.temperatura > maxT) { maxT = m.temperatura; maxNombre = nombreDeMotor(m, motores.length); }
    });
    for (const g of Object.values(this.grupos || {})) {
      const t = g.indices.map((i) => motores[i] && motores[i].temperatura).filter((x) => typeof x === 'number' && Number.isFinite(x));
      const mx = t.length ? Math.max(...t) : null;
      g.max.textContent = mx === null ? '—' : 'máx ' + fmt(mx, 1) + ' °C';
      g.tarjeta.className = 'mapa-grupo ' + clasificarTemp(mx);
    }
    if (this.escala) {
      const todas = motores.map((m) => m.temperatura).filter((x) => typeof x === 'number' && Number.isFinite(x));
      if (todas.length) {
        const prom = todas.reduce((a, b) => a + b, 0) / todas.length;
        this.escala.marca.style.left = (fraccionCalor(prom) * 100) + '%';
        this.escala.resumen.textContent = 'Promedio ' + fmt(prom, 1) + ' °C · más frío ' + fmt(Math.min(...todas), 1) + ' °C · más caliente ' + fmt(Math.max(...todas), 1) + ' °C · diferencia ' + fmt(Math.max(...todas) - Math.min(...todas), 1) + ' °C';
      }
    }
    this._ordenar();
    $('chipOk').textContent = cuenta.ok;
    $('chipWarn').textContent = cuenta.warn;
    $('chipHot').textContent = cuenta.hot;
    $('chipMax').textContent = Number.isFinite(maxT) ? fmt(maxT, 1) + ' °C' : '—';
    return { cuenta, total: motores.length, maxT: Number.isFinite(maxT) ? maxT : null, maxNombre };
  },
};

/* ---------- Gemelo digital: silueta del robot con cada articulación coloreada por su temperatura ---------- */
const Gemelo = {
  nodos: [],                 // un círculo por motor (en el mismo orden que la tabla)
  pies: {},                  // un círculo por pie, por nombre de pata
  nombres: [],
  geo: null,
  huesos: {},                // tres segmentos (hueso) por pata
  halos: [],                 // aro de aviso de cada articulación
  ondas: {},                 // onda de contacto de cada pie
  rol: [],                   // por motor: { pata, parte }
  actual: {},                // pose dibujada de cada pata (se acerca a la pose objetivo en cada cuadro)
  objetivo: {},              // pose pedida por el último dato
  animando: false,

  construir(motores) {
    const cont = $('gemelo');
    cont.replaceChildren();
    this.nodos = [];
    this.pies = {};
    this.huesos = {};
    this.halos = [];
    this.ondas = {};
    this.rol = [];
    this.actual = {};
    this.objetivo = {};
    this.geo = null;
    const total = motores.length;
    const geo = disposicionGemelo(total);
    const sinSilueta = (texto) => {
      cont.appendChild(crear('p', 'vacio', texto));
      $('gemeloEtiqueta').textContent = '';
    };
    if (!geo) { sinSilueta('No hay silueta para este modelo: se muestran la tabla y el mapa de calor.'); return; }

    const NS = 'http://www.w3.org/2000/svg';
    const el = (tag, atributos = {}, clase = '') => {
      const nodo = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(atributos)) nodo.setAttribute(k, String(v));
      if (clase) nodo.setAttribute('class', clase);
      return nodo;
    };
    const svg = el('svg', { viewBox: '0 0 ' + geo.ancho + ' ' + geo.alto, 'aria-hidden': 'true' });

    // Fondo tipo radar: anillos concéntricos y cruz central
    const cx = geo.ancho / 2, cy = geo.alto / 2;
    const defs = el('defs');
    const grad = el('radialGradient', { id: 'gradCuerpo', cx: '50%', cy: '35%', r: '75%' });
    grad.appendChild(el('stop', { offset: '0%', 'stop-color': 'var(--acento)', 'stop-opacity': '0.28' }));
    grad.appendChild(el('stop', { offset: '100%', 'stop-color': 'var(--acento)', 'stop-opacity': '0.04' }));
    defs.appendChild(grad);
    svg.appendChild(defs);
    for (const rad of [70, 125, 178]) svg.appendChild(el('circle', { cx, cy, r: rad }, 'rejilla-g'));
    svg.appendChild(el('line', { x1: cx, y1: 6, x2: cx, y2: geo.alto - 6 }, 'rejilla-g'));
    svg.appendChild(el('line', { x1: 6, y1: cy, x2: geo.ancho - 6, y2: cy }, 'rejilla-g'));
    for (let a = 0; a < 360; a += 30) {
      const t = (a * Math.PI) / 180;
      svg.appendChild(el('line', { x1: cx + Math.sin(t) * 172, y1: cy - Math.cos(t) * 172, x2: cx + Math.sin(t) * 184, y2: cy - Math.cos(t) * 184 }, 'marca-g'));
    }

    for (const d of geo.decoracion) {
      if (d.tipo === 'rect') {
        svg.appendChild(el('rect', { x: d.x, y: d.y, width: d.ancho, height: d.alto, rx: d.radio }, 'cuerpo-g'));
        // Detalles del chasis: sensor frontal, columna central y módulos
        const mx = d.x + d.ancho / 2;
        svg.appendChild(el('rect', { x: mx - 20, y: d.y + 12, width: 40, height: 12, rx: 6 }, 'sensor-g'));
        svg.appendChild(el('line', { x1: mx, y1: d.y + 34, x2: mx, y2: d.y + d.alto - 18 }, 'columna-g'));
        for (let k = 0; k < 4; k++) svg.appendChild(el('rect', { x: mx - 16, y: d.y + 46 + k * 36, width: 32, height: 22, rx: 4 }, 'modulo-g'));
      }
      else if (d.tipo === 'poligono') svg.appendChild(el('polygon', { points: d.puntos }, 'cuerpo-g'));
      else if (d.tipo === 'circulo') svg.appendChild(el('circle', { cx: d.cx, cy: d.cy, r: d.r }, 'cuerpo-g'));
      else if (d.tipo === 'linea') svg.appendChild(el('line', { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 }, 'hueso'));
    }
    const anchos = [10, 8, 6];
    geo.huesos.forEach((h, k) => {
      const segs = [];
      for (let q = 0; q < 3; q++) {
        const sombra = el('line', { x1: h[q][0], y1: h[q][1], x2: h[q + 1][0], y2: h[q + 1][1], 'stroke-width': anchos[q] + 5 }, 'hueso-sombra');
        svg.appendChild(sombra);
        segs.push(sombra);
      }
      const visibles = [];
      for (let q = 0; q < 3; q++) {
        const seg = el('line', { x1: h[q][0], y1: h[q][1], x2: h[q + 1][0], y2: h[q + 1][1], 'stroke-width': anchos[q] }, 'hueso');
        svg.appendChild(seg);
        visibles.push(seg);
      }
      for (const [pata, d] of Object.entries(geo.patas || {})) if (d.hueso === k) this.huesos[pata] = { sombras: segs, segs: visibles };
    });
    for (const [pata, p] of Object.entries(geo.pies)) {
      const onda = el('circle', { cx: p[0], cy: p[1], r: geo.radioArt + 4 }, 'onda-g');
      svg.appendChild(onda);
      this.ondas[pata] = onda;
      const c = el('circle', { cx: p[0], cy: p[1], r: geo.radioArt + 4 }, 'pie-g');
      svg.appendChild(c);
      this.pies[pata] = c;
    }
    for (const e of geo.etiquetas) {
      const t = el('text', { x: e.x, y: e.y }, 'etq-g');
      t.textContent = e.texto;
      svg.appendChild(t);
    }

    let colocados = 0;
    motores.forEach((m, i) => {
      const nombre = nombreDeMotor(m, total);
      const pos = geo.articulaciones[nombre];
      if (!pos) return;
      const halo = el('circle', { cx: pos[0], cy: pos[1], r: geo.radioArt + 4 }, 'halo sin-dato');
      svg.appendChild(halo);
      this.halos[i] = halo;
      const c = el('circle', { cx: pos[0], cy: pos[1], r: geo.radioArt, tabindex: 0, role: 'img' }, 'art sin-dato');
      const titulo = el('title');
      titulo.textContent = nombre;
      c.appendChild(titulo);
      c.addEventListener('mouseenter', () => { PanelMotores.resaltarFila(i, true); this.resaltar(i, true); });
      c.addEventListener('mouseleave', () => { PanelMotores.resaltarFila(i, false); this.resaltar(i, false); });
      c.addEventListener('focus', () => PanelMotores.resaltarFila(i, true));
      c.addEventListener('blur', () => PanelMotores.resaltarFila(i, false));
      c.addEventListener('click', () => PanelMotores.irAFila(i));
      c.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); PanelMotores.irAFila(i); } });
      svg.appendChild(c);
      this.nodos[i] = c;
      const partes = nombre.split('_');
      if (geo.patas && geo.patas[partes[0]] && ['hip', 'thigh', 'calf'].includes(partes[1])) this.rol[i] = { pata: partes[0], parte: partes[1] };
      colocados++;
    });
    if (colocados < total * 0.6) { this.nodos = []; this.pies = {}; this.huesos = {}; this.halos = []; this.ondas = {}; this.rol = []; cont.replaceChildren(); sinSilueta('Los nombres de los motores no coinciden con ninguna silueta conocida.'); return; }
    cont.appendChild(svg);
    this.geo = geo;
    for (const [pata, d] of Object.entries(geo.patas || {})) { this.actual[pata] = d.reposo; this.objetivo[pata] = d.reposo; }
    $('gemeloEtiqueta').textContent = geo.titulo;
  },

  /** Calcula la pose objetivo de cada pata con los ángulos del dato y arranca la animación. */
  mover(motores) {
    if (!this.geo || !this.geo.patas) return;
    const ang = {};
    motores.forEach((m, i) => { const r = this.rol[i]; if (r) (ang[r.pata] = ang[r.pata] || {})[r.parte] = m.angulo; });
    for (const [pata, d] of Object.entries(this.geo.patas)) this.objetivo[pata] = posePata(d.reposo, d.signo, ang[pata] || {});
    if (movimientoReducido()) { for (const pata of Object.keys(this.objetivo)) this.actual[pata] = this.objetivo[pata]; this.dibujar(); return; }
    if (!this.animando) { this.animando = true; requestAnimationFrame(() => this.cuadro()); }
  },

  /** Un cuadro de la animación: cada punto se acerca a su objetivo, así el movimiento se ve continuo entre dato y dato. */
  cuadro() {
    let resto = 0;
    const paso = (a, b) => { const d = [b[0] - a[0], b[1] - a[1]]; resto = Math.max(resto, Math.abs(d[0]), Math.abs(d[1])); return [a[0] + d[0] * 0.3, a[1] + d[1] * 0.3]; };
    for (const pata of Object.keys(this.objetivo)) {
      const a = this.actual[pata], o = this.objetivo[pata];
      this.actual[pata] = { hip: o.hip, thigh: paso(a.thigh, o.thigh), calf: paso(a.calf, o.calf), pie: paso(a.pie, o.pie) };
    }
    this.dibujar();
    if (resto > 0.05) requestAnimationFrame(() => this.cuadro()); else this.animando = false;
  },

  dibujar() {
    const fijar = (n, v) => n.toFixed(1);
    for (const [pata, pose] of Object.entries(this.actual)) {
      const h = this.huesos[pata];
      if (h) {
        const pts = [pose.hip, pose.thigh, pose.calf, pose.pie];
        for (let q = 0; q < 3; q++) for (const linea of [h.sombras[q], h.segs[q]]) {
          linea.setAttribute('x1', fijar(pts[q][0])); linea.setAttribute('y1', fijar(pts[q][1]));
          linea.setAttribute('x2', fijar(pts[q + 1][0])); linea.setAttribute('y2', fijar(pts[q + 1][1]));
        }
      }
      for (const c of [this.pies[pata], this.ondas[pata]]) if (c) { c.setAttribute('cx', fijar(pose.pie[0])); c.setAttribute('cy', fijar(pose.pie[1])); }
    }
    this.rol.forEach((r, i) => {
      const c = this.nodos[i];
      if (!r || !c) return;
      const p = this.actual[r.pata][r.parte];
      for (const n of [c, this.halos[i]]) if (n) { n.setAttribute('cx', fijar(p[0])); n.setAttribute('cy', fijar(p[1])); }
    });
  },

  /** Resalta (o no) una articulación; la llama la tabla al pasar el mouse por una fila. */
  resaltar(i, encendida) {
    if (this.nodos[i]) this.nodos[i].classList.toggle('resaltada', encendida);
  },

  actualizar(motores, fuerzas) {
    motores.forEach((m, i) => {
      const c = this.nodos[i];
      if (!c) return;
      const nivel = clasificarTemp(m.temperatura);
      c.classList.remove('ok', 'warn', 'hot', 'sin-dato');
      c.classList.add(nivel);
      const halo = this.halos[i];
      if (halo) { halo.classList.remove('ok', 'warn', 'hot', 'sin-dato'); halo.classList.add(nivel); }
      c.querySelector('title').textContent = nombreDeMotor(m, motores.length) + ' · ' + fmt(m.temperatura, 1) + ' °C · ángulo ' + fmt(m.angulo, 1) + '° · torque ' + fmt(m.torque, 2) + ' N·m';
    });
    for (const [pata, c] of Object.entries(this.pies)) {
      const apoyado = Number((fuerzas || {})[pata]) === 1;
      c.classList.toggle('apoyado', apoyado);
      if (this.ondas[pata]) this.ondas[pata].classList.toggle('activa', apoyado);
    }
    this.mover(motores);
  },
};

/* ---------- Indicadores de un vistazo (tarjetas de arriba) ---------- */
const Resumen = {
  actualizar(data, motores) {
    const nivel = clasificarTemp(motores.maxT);
    $('kpiTemp').textContent = motores.maxT === null ? '—' : fmt(motores.maxT, 1) + ' °C';
    $('kpiTempSub').textContent = motores.maxNombre ? 'en ' + motores.maxNombre : ' ';
    $('kpiTempCard').className = 'kpi ' + (nivel === 'sin-dato' ? '' : nivel);

    const enRiesgo = motores.cuenta.warn + motores.cuenta.hot;
    $('kpiRiesgo').textContent = enRiesgo + ' de ' + motores.total;
    $('kpiRiesgoSub').textContent = motores.cuenta.hot + ' rojos · ' + motores.cuenta.warn + ' amarillos';
    $('kpiRiesgoCard').className = 'kpi ' + (motores.cuenta.hot ? 'hot' : motores.cuenta.warn ? 'warn' : 'ok');

    const soc = data.bms && data.bms.soc;
    const pct = limitarPorcentaje(soc);
    $('kpiBat').textContent = typeof soc === 'number' ? fmt(soc, 0) + ' %' : '—';
    const barra = $('kpiBatBarra');
    barra.style.width = pct + '%';
    barra.style.background = colorBateria(pct);

    const patas = Object.keys(data.fuerzas || {});
    const apoyadas = patas.filter((p) => Number(data.fuerzas[p]) === 1);
    $('kpiPatas').textContent = patas.length ? apoyadas.length + ' de ' + patas.length : '—';
    $('kpiPatasSub').textContent = patas.length ? (apoyadas.join(' · ') || 'ninguna apoyada') : 'este modelo no las reporta';
  },
};

/* ---------- Panel IMU (números + gráfico con buffer circular) ---------- */
const PanelIMU = {
  chart: null,
  etiquetas: new RingBuffer(CONFIG.HIST_SIZE),
  series: { roll: new RingBuffer(CONFIG.HIST_SIZE), pitch: new RingBuffer(CONFIG.HIST_SIZE), yaw: new RingBuffer(CONFIG.HIST_SIZE) },
  construir() {
    if (this.chart || !configurarChartJs()) return;
    this.chart = new Chart($('chartImu'), {
      type: 'line',
      data: {
        labels: [],
        datasets: ['roll', 'pitch', 'yaw'].map((k) => ({
          label: k[0].toUpperCase() + k.slice(1) + ' (°)', data: [], borderColor: COLORES_IMU[k], backgroundColor: COLORES_IMU[k],
        })),
      },
      options: opcionesLinea('grados'),
    });
  },
  recolorear() { recolorearChart(this.chart); },
  actualizar(imu, ts) {
    $('roll').textContent = fmt(imu.roll, 2) + ' °';
    $('pitch').textContent = fmt(imu.pitch, 2) + ' °';
    $('yaw').textContent = fmt(imu.yaw, 2) + ' °';
    $('ax').textContent = fmt(imu.ax, 3);
    $('ay').textContent = fmt(imu.ay, 3);
    $('az').textContent = fmt(imu.az, 3);

    // Instrumentos: el horizonte gira con el roll y se desplaza con el pitch; la flecha sigue al yaw.
    if (Number.isFinite(imu.roll) && Number.isFinite(imu.pitch)) {
      const pitch = Math.max(-35, Math.min(35, imu.pitch));
      $('horizonteGrupo').style.transform = 'rotate(' + (-imu.roll) + 'deg) translateY(' + (pitch * 2.2) + 'px)';
    }
    if (Number.isFinite(imu.yaw)) $('brujulaFlecha').style.transform = 'rotate(' + imu.yaw + 'deg)';

    this.etiquetas.push(typeof ts === 'number' ? ts.toFixed(1) : '');
    for (const k of Object.keys(this.series)) this.series[k].push(typeof imu[k] === 'number' ? imu[k] : null);
    const n = this.etiquetas.length;
    $('imuBuffer').textContent = n + ' / ' + CONFIG.HIST_SIZE + ' muestras' + (n < CONFIG.MIN_GRAFICO ? ' (juntando…)' : '');
    if (this.chart) {
      this.chart.data.labels = this.etiquetas.toArray();
      ['roll', 'pitch', 'yaw'].forEach((k, i) => { this.chart.data.datasets[i].data = this.series[k].toArray(); });
      this.chart.update('none');
    }
  },
};

/* ---------- Panel BMS ---------- */
const PanelBMS = {
  actualizar(bms) {
    const soc = bms.soc;
    $('soc').textContent = typeof soc === 'number' ? fmt(soc, 0) + ' %' : '—';
    const barra = $('socBarra');
    const pct = limitarPorcentaje(soc);
    barra.style.width = pct + '%';
    barra.style.background = colorBateria(pct);
    $('bmsCorriente').textContent = typeof bms.corriente === 'number' ? fmt(bms.corriente, 0) + ' mA' : '—';
    $('bmsTemp').textContent = typeof bms.temperatura === 'number' ? fmt(bms.temperatura, 1) + ' °C' : '—';

    const celdas = Array.isArray(bms.celdas) ? bms.celdas : [];
    const cont = $('celdas');
    const est = estadisticaCeldas(celdas);
    if (!est) {
      if (!cont.classList.contains('sin-celdas')) {
        cont.replaceChildren(crear('p', 'vacio', 'Este servidor no reporta voltajes de celda.'));
        cont.classList.add('sin-celdas');
      }
      $('celdasResumen').textContent = '';
      return;
    }
    if (cont.classList.contains('sin-celdas') || cont.children.length !== celdas.length) {
      cont.classList.remove('sin-celdas');
      cont.replaceChildren(...celdas.map((_, i) => {
        const div = crear('div', 'celda');
        div.appendChild(crear('span', '', 'C' + (i + 1)));
        div.appendChild(crear('b', '', '—'));
        const mini = crear('div', 'mini');
        mini.appendChild(crear('i'));
        div.appendChild(mini);
        return div;
      }));
    }
    celdas.forEach((v, i) => {
      const div = cont.children[i];
      div.classList.toggle('min', est.delta > 0 && v === est.min);
      div.classList.toggle('max', est.delta > 0 && v === est.max);
      div.querySelector('b').textContent = fmt(v, 3) + ' V';
      // barra relativa a un rango típico de celda de litio (3,0 a 4,2 V)
      const rel = Math.max(0, Math.min(1, (v - 3.0) / 1.2));
      div.querySelector('i').style.width = (rel * 100) + '%';
    });
    $('celdasResumen').textContent = 'mín ' + fmt(est.min, 3) + ' V · máx ' + fmt(est.max, 3) + ' V · diferencia ' + fmt(est.delta * 1000, 0) + ' mV';
  },
};

/* ---------- Historial de voltajes por celda (gráfico de línea, buffer circular) ---------- */
const PanelCeldas = {
  chart: null,
  etiquetas: new RingBuffer(CONFIG.HIST_SIZE),
  series: [],
  _construir(n) {
    this.series = Array.from({ length: n }, () => new RingBuffer(CONFIG.HIST_SIZE));
    this.etiquetas.clear();
    if (this.chart) { this.chart.destroy(); this.chart = null; }
    if (!n || !configurarChartJs()) return;
    const opciones = opcionesLinea('voltios');
    opciones.plugins.legend.display = false;          // con 8 o 10 celdas la leyenda no aporta; el detalle sale al pasar el mouse
    this.chart = new Chart($('chartCeldas'), {
      type: 'line',
      data: { labels: [], datasets: this.series.map((_, i) => ({
        label: 'C' + (i + 1) + ' (V)', data: [], borderColor: colorMotor(i, n), backgroundColor: colorMotor(i, n),
      })) },
      options: opciones,
    });
  },
  recolorear() { recolorearChart(this.chart); },
  actualizar(celdas, ts) {
    const validas = Array.isArray(celdas) ? celdas : [];
    $('panelCeldasHist').hidden = validas.length === 0;
    if (validas.length !== this.series.length) this._construir(validas.length);
    if (!validas.length) return;
    this.etiquetas.push(typeof ts === 'number' ? ts.toFixed(1) : '');
    validas.forEach((v, i) => this.series[i].push(typeof v === 'number' ? v : null));
    if (!this.chart) return;
    this.chart.data.labels = this.etiquetas.toArray();
    this.series.forEach((r, i) => { this.chart.data.datasets[i].data = r.toArray(); });
    this.chart.update('none');
  },
};

/* ---------- Panel de fuerzas por pata ---------- */
const PanelPatas = {
  nombres: [],
  nodos: {},
  construir(patas) {
    this.nombres = patas;
    this.nodos = {};
    const cont = $('patas');
    cont.replaceChildren();
    const cuadrupedo = ['FR', 'FL', 'RR', 'RL'].every((p) => patas.includes(p));
    if (!patas.length) {
      cont.appendChild(crear('p', 'vacio', 'Este modelo de robot no reporta fuerzas de pata.'));
      $('patasResumen').textContent = '';
      $('patasDescr').textContent = '';
      return;
    }
    if (cuadrupedo) {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 220 280');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'Robot visto desde arriba con las cuatro patas');
      const cuerpo = document.createElementNS(NS, 'rect');
      cuerpo.setAttribute('class', 'cuerpo');
      cuerpo.setAttribute('x', '70'); cuerpo.setAttribute('y', '40');
      cuerpo.setAttribute('width', '80'); cuerpo.setAttribute('height', '200'); cuerpo.setAttribute('rx', '22');
      svg.appendChild(cuerpo);
      const frente = document.createElementNS(NS, 'text');
      frente.setAttribute('class', 'frente'); frente.setAttribute('x', '110'); frente.setAttribute('y', '20');
      frente.textContent = '▲ frente';
      svg.appendChild(frente);
      const pos = { FL: [38, 70], FR: [182, 70], RL: [38, 210], RR: [182, 210] };
      for (const p of ['FL', 'FR', 'RL', 'RR']) {
        const g = document.createElementNS(NS, 'g');
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('class', 'pata-circulo');
        c.setAttribute('cx', pos[p][0]); c.setAttribute('cy', pos[p][1]); c.setAttribute('r', '28');
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('class', 'pata-txt');
        t.setAttribute('x', pos[p][0]); t.setAttribute('y', pos[p][1] + 5);
        t.textContent = p;
        g.appendChild(c); g.appendChild(t); svg.appendChild(g);
        this.nodos[p] = c;
      }
      cont.appendChild(svg);
      $('patasDescr').textContent = patas.map((p) => p + ' ' + DESCRIPCION_PATAS[p]).join(' · ');
    } else {
      $('patasDescr').textContent = '';
      const lista = crear('div', 'patas-lista');
      for (const p of patas) {
        const item = crear('span', 'item', p);
        lista.appendChild(item);
        this.nodos[p] = item;
      }
      cont.appendChild(lista);
    }
  },
  actualizar(fuerzas) {
    let apoyadas = 0;
    for (const p of this.nombres) {
      const nodo = this.nodos[p];
      if (!nodo) continue;
      const apoya = Number(fuerzas[p]) === 1;
      nodo.classList.toggle('apoyada', apoya);
      if (apoya) apoyadas++;
    }
    if (this.nombres.length) $('patasResumen').textContent = apoyadas + ' de ' + this.nombres.length + ' apoyadas';
  },
};

/* ---------- Historial de temperatura por motor ---------- */
const PanelTemp = {
  chart: null,
  etiquetas: new RingBuffer(CONFIG.HIST_SIZE),
  series: [],
  construir(motores) {
    this.series = motores.map(() => new RingBuffer(CONFIG.HIST_SIZE));
    this.etiquetas.clear();
    if (this.chart) { this.chart.destroy(); this.chart = null; }

    const selector = $('selectorMotores');
    selector.replaceChildren();
    motores.forEach((m, i) => {
      const label = crear('label');
      const chk = crear('input');
      chk.type = 'checkbox';
      chk.checked = i < 3;                       // por defecto, los tres primeros
      chk.dataset.indice = String(i);
      chk.addEventListener('change', () => this._visibilidad());
      const sw = crear('i');
      sw.style.background = colorMotor(i, motores.length);
      label.append(chk, sw, document.createTextNode(nombreDeMotor(m, motores.length)));
      selector.appendChild(label);
    });

    if (!configurarChartJs()) return;
    const datasets = motores.map((m, i) => ({
      label: nombreDeMotor(m, motores.length), data: [],
      borderColor: colorMotor(i, motores.length), backgroundColor: colorMotor(i, motores.length), hidden: i >= 3,
    }));
    // Líneas de referencia con los umbrales del semáforo
    datasets.push({ label: 'Umbral amarillo (40 °C)', data: [], borderColor: '#ffc107', borderDash: [6, 4], borderWidth: 1, pointRadius: 0 });
    datasets.push({ label: 'Umbral rojo (60 °C)', data: [], borderColor: '#f44336', borderDash: [6, 4], borderWidth: 1, pointRadius: 0 });
    const opciones = opcionesLinea('°C');
    opciones.plugins.legend.labels.filter = (item) => !item.hidden;     // la leyenda solo muestra los motores visibles
    this.chart = new Chart($('chartTemp'), { type: 'line', data: { labels: [], datasets }, options: opciones });
  },
  recolorear() { recolorearChart(this.chart); },
  _visibilidad() {
    if (!this.chart) return;
    document.querySelectorAll('#selectorMotores input').forEach((chk) => {
      this.chart.setDatasetVisibility(Number(chk.dataset.indice), chk.checked);
    });
    this.chart.update('none');
  },
  marcarTodos(valor) {
    document.querySelectorAll('#selectorMotores input').forEach((chk) => { chk.checked = valor; });
    this._visibilidad();
  },
  actualizar(motores, ts) {
    this.etiquetas.push(typeof ts === 'number' ? ts.toFixed(1) : '');
    motores.forEach((m, i) => { if (this.series[i]) this.series[i].push(typeof m.temperatura === 'number' ? m.temperatura : null); });
    if (!this.chart) return;
    const n = this.etiquetas.length;
    this.chart.data.labels = this.etiquetas.toArray();
    this.series.forEach((s, i) => { this.chart.data.datasets[i].data = s.toArray(); });
    const k = this.series.length;
    this.chart.data.datasets[k].data = new Array(n).fill(CONFIG.UMBRAL_VERDE);
    this.chart.data.datasets[k + 1].data = new Array(n).fill(CONFIG.UMBRAL_ROJO);
    this.chart.update('none');
  },
};

/* ============================================================================
 * 4. CAPTURA Y EXPORTACIÓN CSV (todo en el navegador, sin pasar por el servidor)
 * ========================================================================== */

const Captura = {
  muestras: [],
  agregar(data, evento) {
    if (this.muestras.length >= CONFIG.MAX_MUESTRAS) this.muestras.shift();
    const fila = aplanarMuestra(data, evento);
    this.muestras.push(fila);
    return fila;
  },
  vaciar() { this.muestras = []; },
  exportar() {
    if (!this.muestras.length) return false;
    const csv = '﻿' + construirCSV(this.muestras);   // BOM: Excel reconoce las tildes
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const modelo = this.muestras[this.muestras.length - 1].modelo || 'robot';
    const ahora = new Date();
    const dos = (n) => String(n).padStart(2, '0');
    const sello = ahora.getFullYear() + dos(ahora.getMonth() + 1) + dos(ahora.getDate()) + '-' + dos(ahora.getHours()) + dos(ahora.getMinutes()) + dos(ahora.getSeconds());   // hora local
    const a = document.createElement('a');
    a.href = url;
    a.download = 'telemetria_' + modelo + '_' + sello + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  },
};

/* ============================================================================
 * 5. APLICACIÓN
 * ========================================================================== */

function iniciarApp() {
  const telemetria = new Telemetria();
  const enAlerta = new Set();
  let modeloActual = null;
  let cantMotores = 0;
  let ultimo = null;                 // último mensaje recibido (ya con el ajuste de prueba, si hay)
  const params = new URLSearchParams(location.search);
  const forzarTemp = Number(params.get('forzarTemp')) || 0;   // solo para probar el semáforo

  /* ---------- avisos en pantalla ---------- */
  function toast(texto, tipo = '') {
    const t = crear('div', 'toast ' + tipo, texto);
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  function leerAlmacenado(clave) {
    try { return localStorage.getItem(clave); } catch { return null; }
  }
  function guardarAlmacenado(clave, valor) {
    try { localStorage.setItem(clave, valor); } catch { /* modo privado: no pasa nada */ }
  }

  /* ---------- latido: una onda en el indicador de conexión con cada mensaje que llega ---------- */
  const ondaLatido = $('latido');
  const sinMovimiento = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function latido() {
    if (sinMovimiento || !ondaLatido || !ondaLatido.animate) return;
    ondaLatido.animate([{ opacity: .9, transform: 'scale(.6)' }, { opacity: 0, transform: 'scale(2)' }], { duration: 450, easing: 'ease-out' });
  }

  /* ---------- estado de la conexión ---------- */
  const TEXTOS_ESTADO = { ws: 'En vivo · WebSocket', polling: 'En vivo · polling', conectando: 'Conectando…', caido: 'Sin conexión' };
  function mostrarEstado({ estado, detalle, intentos }) {
    document.body.dataset.conexion = (estado === 'ws' || estado === 'polling') ? 'ok' : estado;
    $('pillTexto').textContent = TEXTOS_ESTADO[estado] || estado;
    const banner = $('banner');
    banner.hidden = estado !== 'caido';
    if (estado === 'caido') {
      $('bannerTexto').textContent = ' ' + detalle + (intentos ? ' (intento ' + intentos + ')' : '') + ' Se muestran los últimos valores recibidos.';
    }
    $('statFuente').textContent = estado === 'ws' ? 'WebSocket (push)' : estado === 'polling' ? 'Polling HTTP cada ' + CONFIG.POLL_MS + ' ms' : TEXTOS_ESTADO[estado];
  }

  /* ---------- modelo de robot ---------- */
  function prepararModelo(data) {
    modeloActual = data.modelo;
    cantMotores = data.motores.length;
    PanelMotores.construir(data.motores);
    Gemelo.construir(data.motores);
    PanelTemp.construir(data.motores);
    PanelPatas.construir(Object.keys(data.fuerzas || {}));
    enAlerta.clear();
    $('nombreRobot').textContent = 'Unitree ' + String(data.modelo || '').toUpperCase() + ' · ' + cantMotores + ' motores';
    fetch(telemetria.base + '/info', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        if (info && info.nombre && modeloActual === data.modelo) {
          $('nombreRobot').textContent = info.nombre + ' · ' + info.n_motores + ' motores · modo ' + (info.modo || '?');
        }
      })
      .catch(() => { /* el nombre ya está puesto con los datos del mensaje */ });
  }

  function aplicarAjusteDePrueba(data) {
    if (!forzarTemp) return data;
    return { ...data, motores: data.motores.map((m) => ({ ...m, temperatura: typeof m.temperatura === 'number' ? m.temperatura + forzarTemp : m.temperatura })) };
  }

  /* ---------- llegada de datos ---------- */
  telemetria.en('estado', mostrarEstado);
  telemetria.en('dato', (crudo) => {
    const data = aplicarAjusteDePrueba(crudo);
    if (data.modelo !== modeloActual || data.motores.length !== cantMotores) prepararModelo(data);
    ultimo = data;
    document.body.classList.add('con-datos');
    const resumenMotores = PanelMotores.actualizar(data.motores);
    Gemelo.actualizar(data.motores, data.fuerzas);
    latido();
    Resumen.actualizar(data, resumenMotores);
    PanelIMU.actualizar(data.imu, data.ts);
    PanelBMS.actualizar(data.bms);
    PanelCeldas.actualizar(data.bms.celdas, data.ts);
    PanelPatas.actualizar(data.fuerzas);
    PanelTemp.actualizar(data.motores, data.ts);
    $('btnCapturar').disabled = false;

    if ($('chkAlertas').checked) {
      // Si varios motores cruzan el umbral en el mismo mensaje, se avisa y se registra una sola vez.
      const nuevos = motoresNuevosEnAlerta(data.motores, enAlerta);
      if (nuevos.length) {
        const nombres = nuevos.map((m) => nombreDeMotor(m, data.motores.length));
        const maxT = Math.max(...nuevos.map((m) => m.temperatura));
        toast('Más de ' + CONFIG.UMBRAL_ROJO + ' °C: ' + nombres.join(', ') + ' (máx. ' + fmt(maxT, 1) + ' °C)', 'alerta');
        registrarCaptura('alerta_temp_' + nombres.join('+'));
      }
    }
  });

  /* ---------- captura y CSV ---------- */
  function refrescarCaptura() {
    const n = Captura.muestras.length;
    $('contMuestras').textContent = n;
    $('kpiMuestras').textContent = n;
    $('btnExportar').disabled = n === 0;
    $('btnVaciar').disabled = n === 0;
    const lista = $('ultimasMuestras');
    lista.replaceChildren(...Captura.muestras.slice(-5).reverse().map((f) => {
      const hora = new Date(f.fecha_hora).toLocaleTimeString('es-AR');
      return crear('li', '', hora + ' · ' + f.evento + ' · roll ' + fmt(f.imu_roll, 1) + '° · batería ' + fmt(f.bms_soc_pct, 0) + ' %');
    }));
  }
  function registrarCaptura(evento) {
    if (!ultimo) { toast('Todavía no llegaron datos para capturar.', 'aviso'); return; }
    Captura.agregar(ultimo, evento);
    refrescarCaptura();
  }
  $('btnCapturar').addEventListener('click', () => {
    registrarCaptura('manual');
    toast('Muestra capturada (' + Captura.muestras.length + ').');
  });
  $('btnExportar').addEventListener('click', () => {
    if (Captura.exportar()) toast('CSV generado con ' + Captura.muestras.length + ' muestras.');
  });
  $('btnVaciar').addEventListener('click', () => {
    if (!Captura.muestras.length) return;
    if (confirm('¿Borrar las ' + Captura.muestras.length + ' muestras capturadas?')) { Captura.vaciar(); refrescarCaptura(); }
  });
  window.addEventListener('beforeunload', (e) => {
    if (Captura.muestras.length) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------- vista y orden de la tabla de motores ---------- */
  $('vistaTabla').addEventListener('click', () => PanelMotores.mostrarVista('tabla'));
  $('vistaMapa').addEventListener('click', () => PanelMotores.mostrarVista('mapa'));
  $('thTemp').addEventListener('click', () => PanelMotores.cambiarOrden());
  $('thTemp').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); PanelMotores.cambiarOrden(); }
  });

  /* ---------- tema claro / oscuro y pantalla completa ---------- */
  function aplicarTema(tema) {
    document.documentElement.dataset.tema = tema;
    guardarAlmacenado('tp05.tema', tema);
    PanelIMU.recolorear();
    PanelTemp.recolorear();
    PanelCeldas.recolorear();
  }
  $('btnTema').addEventListener('click', () => {
    aplicarTema(document.documentElement.dataset.tema === 'claro' ? 'oscuro' : 'claro');
  });
  $('btnPantalla').addEventListener('click', () => {
    if (!document.fullscreenElement) { if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); }
    else if (document.exitFullscreen) document.exitFullscreen();
  });
  const temaGuardado = leerAlmacenado('tp05.tema');
  document.documentElement.dataset.tema = (temaGuardado === 'claro' || temaGuardado === 'oscuro') ? temaGuardado : 'oscuro';

  /* ---------- selector de motores del gráfico ---------- */
  $('btnTodos').addEventListener('click', () => PanelTemp.marcarTodos(true));
  $('btnNinguno').addEventListener('click', () => PanelTemp.marcarTodos(false));

  /* ---------- conexión: servidor y fuente ---------- */
  let baseActual = null;
  function conectar(base, modo, modelo = '') {
    baseActual = base;
    modeloActual = null;
    if (modelo && modo !== 'polling') {
      // El WebSocket no permite elegir robot (ws://host/ws no recibe parámetros): con robot elegido se usa polling.
      modo = 'polling';
      toast('Con un robot elegido se usa polling: el WebSocket transmite el robot al que está conectado el servidor.', 'aviso');
    }
    $('inpApi').value = base;
    $('selFuente').value = modo;
    $('selModelo').value = modelo;
    guardarAlmacenado('tp05.api', base);
    guardarAlmacenado('tp05.fuente', modo);
    guardarAlmacenado('tp05.modelo', modelo);
    telemetria.iniciar(base, modo, modelo);
  }
  $('formApi').addEventListener('submit', (e) => {
    e.preventDefault();
    try { conectar(normalizarBase($('inpApi').value), $('selFuente').value, $('selModelo').value); }
    catch (err) { toast(err.message, 'aviso'); }
  });
  $('selFuente').addEventListener('change', () => {
    if (baseActual) conectar(baseActual, $('selFuente').value, $('selModelo').value);
  });
  $('selModelo').addEventListener('change', () => {
    if (baseActual) conectar(baseActual, $('selFuente').value, $('selModelo').value);
  });

  /** Si no se indicó servidor, prueba las direcciones habituales y usa la primera que responde. */
  async function detectarServidor(candidatas) {
    const probar = async (dir) => {
      const ctrl = new AbortController();
      const corte = setTimeout(() => ctrl.abort(), 1200);
      try {
        const r = await fetch(dir + '/telemetria', { signal: ctrl.signal, cache: 'no-store' });
        return (r.ok || r.status === 409) ? dir : null;
      } catch { return null; } finally { clearTimeout(corte); }
    };
    const respuestas = await Promise.all(candidatas.map(probar));
    return respuestas.find(Boolean) || null;
  }

  /* ---------- estadísticas y "datos desactualizados" ---------- */
  setInterval(() => {
    const s = telemetria.estadisticas();
    $('statMsgs').textContent = s.msgsPorSeg ? fmt(s.msgsPorSeg, 1) + ' /s' : '—';
    $('statIntervalo').textContent = s.intervaloMs ? Math.round(s.intervaloMs) + ' ms' : '—';
    $('statKb').textContent = s.kbPorSeg ? fmt(s.kbPorSeg, 1) + ' KB/s' : '—';
    $('statRtt').textContent = s.rttMs !== null && s.rttMs !== undefined ? Math.round(s.rttMs) + ' ms' : (telemetria.estado === 'ws' ? 'no aplica (push)' : '—');
    $('statInvalidos').textContent = telemetria.invalidos;
    const edad = telemetria.ultimoDatoEn ? (Date.now() - telemetria.ultimoDatoEn) : null;
    $('statUltimo').textContent = edad === null ? 'todavía no llegó nada' : (edad < 1500 ? 'hace menos de 2 s' : 'hace ' + Math.round(edad / 1000) + ' s');
    document.body.classList.toggle('desactualizado', edad !== null && edad > CONFIG.SIN_DATOS_MS);
  }, 500);

  /* ---------- arranque ---------- */
  PanelIMU.construir();
  if (typeof Chart === 'undefined') toast('No se pudo cargar Chart.js (¿sin internet?). Los gráficos están desactivados; el resto funciona.', 'aviso');
  if (forzarTemp) {
    const av = $('avisoPrueba');
    av.hidden = false;
    av.textContent = 'Modo de prueba: temperaturas simuladas con ' + (forzarTemp > 0 ? '+' : '') + forzarTemp + ' °C sobre el valor del servidor (parámetro forzarTemp), solo para verificar el semáforo.';
  }
  const fuenteGuardada = params.get('fuente') || leerAlmacenado('tp05.fuente');
  const fuente = ['auto', 'ws', 'polling'].includes(fuenteGuardada) ? fuenteGuardada : 'auto';
  const modeloGuardado = (params.get('modelo') || leerAlmacenado('tp05.modelo') || '').toLowerCase();
  const modelo = modeloGuardado === 'go2' ? modeloGuardado : '';
  const indicada = params.get('api') || leerAlmacenado('tp05.api');
  if (indicada) {
    let base;
    try { base = normalizarBase(indicada); } catch { base = CONFIG.API_POR_DEFECTO; }
    conectar(base, fuente, modelo);
  } else {
    // Primera vez y sin ?api=: se busca el servidor en las direcciones habituales (8001 del laboratorio y 8000 del enunciado).
    $('selFuente').value = fuente;
    $('selModelo').value = modelo;
    detectarServidor(CONFIG.API_CANDIDATAS).then((hallada) => conectar(hallada || CONFIG.API_POR_DEFECTO, fuente, modelo));
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciarApp);
  else iniciarApp();
}
