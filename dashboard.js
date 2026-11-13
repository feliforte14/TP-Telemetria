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
  29: ['L_hip_yaw', 'L_hip_roll', 'L_hip_pitch', 'L_knee', 'L_ankle_pitch', 'L_ankle_roll',
       'R_hip_yaw', 'R_hip_roll', 'R_hip_pitch', 'R_knee', 'R_ankle_pitch', 'R_ankle_roll',
       'torso_yaw', 'torso_roll', 'torso_pitch',
       'L_shoulder_pitch', 'L_shoulder_roll', 'L_shoulder_yaw', 'L_elbow', 'L_wrist_roll', 'L_wrist_pitch', 'L_wrist_yaw',
       'R_shoulder_pitch', 'R_shoulder_roll', 'R_shoulder_yaw', 'R_elbow', 'R_wrist_roll', 'R_wrist_pitch', 'R_wrist_yaw'],
});

/** Nombre de un motor: el que manda el servidor; si no, el estándar del modelo (12 = Go2, 29 = G1); si no, "Motor N". */
function nombreDeMotor(motor, total) {
  if (motor && typeof motor.nombre === 'string' && motor.nombre) return motor.nombre;
  const porDefecto = NOMBRES_POR_DEFECTO[total];
  const id = motor ? motor.id : undefined;
  return (porDefecto && porDefecto[id]) || ('Motor ' + id);
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

  iniciar(base, modo = 'auto') {
    this.detener();
    this.base = base;
    this.modo = modo;
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
      const resp = await fetch(this.base + '/telemetria', { signal: ctrl.signal, cache: 'no-store' });
      if (!resp.ok) throw new Error('El servidor respondió HTTP ' + resp.status);
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
    CONFIG, clasificarTemp, fmt, RingBuffer, validarTelemetria, normalizarBase, wsUrl, aplanarMuestra, escaparCSV, construirCSV, estadisticaCeldas, motoresNuevosEnAlerta, Telemetria, nombreDeMotor, limitarPorcentaje, colorBateria,
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

function configurarChartJs() {
  if (typeof Chart === 'undefined') return false;
  Chart.defaults.color = '#94a3b8';
  Chart.defaults.borderColor = 'rgba(148, 163, 184, .18)';
  Chart.defaults.font.family = 'system-ui, sans-serif';
  Chart.defaults.animation = false;
  return true;
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

/* ---------- Panel de motores ---------- */
const PanelMotores = {
  filas: [],
  construir(motores) {
    const tbody = document.querySelector('#tablaMotores tbody');
    tbody.replaceChildren();
    this.filas = motores.map((m) => {
      const tr = crear('tr');
      const pastilla = crear('span', 'pill-temp', '—');
      const temp = crear('td', 'temp sin-dato');
      temp.appendChild(pastilla);
      const celdas = {
        nombre: crear('td', '', nombreDeMotor(m, motores.length)),
        temp,
        tempTexto: pastilla,
        estado: crear('td', 'estado', '—'),
        angulo: crear('td', '', '—'),
        velocidad: crear('td', '', '—'),
        torque: crear('td', '', '—'),
      };
      for (const k of ['nombre', 'temp', 'estado', 'angulo', 'velocidad', 'torque']) tr.appendChild(celdas[k]);
      tbody.appendChild(tr);
      return celdas;
    });
  },
  actualizar(motores) {
    const cuenta = { 'ok': 0, 'warn': 0, 'hot': 0 };
    let maxT = -Infinity;
    motores.forEach((m, i) => {
      const f = this.filas[i];
      if (!f) return;
      const nivel = clasificarTemp(m.temperatura);
      f.temp.className = 'temp ' + nivel;
      f.tempTexto.textContent = fmt(m.temperatura, 1) + ' °C';
      f.estado.textContent = ETIQUETAS_TEMP[nivel];
      f.angulo.textContent = fmt(m.angulo, 2);
      f.velocidad.textContent = fmt(m.velocidad, 3);
      f.torque.textContent = fmt(m.torque, 2);
      if (nivel in cuenta) cuenta[nivel]++;
      if (typeof m.temperatura === 'number' && m.temperatura > maxT) maxT = m.temperatura;
    });
    $('chipOk').textContent = cuenta.ok;
    $('chipWarn').textContent = cuenta.warn;
    $('chipHot').textContent = cuenta.hot;
    $('chipMax').textContent = Number.isFinite(maxT) ? fmt(maxT, 1) + ' °C' : '—';
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
  actualizar(imu, ts) {
    $('roll').textContent = fmt(imu.roll, 2) + ' °';
    $('pitch').textContent = fmt(imu.pitch, 2) + ' °';
    $('yaw').textContent = fmt(imu.yaw, 2) + ' °';
    $('ax').textContent = fmt(imu.ax, 3);
    $('ay').textContent = fmt(imu.ay, 3);
    $('az').textContent = fmt(imu.az, 3);

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
    PanelMotores.actualizar(data.motores);
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

  /* ---------- selector de motores del gráfico ---------- */
  $('btnTodos').addEventListener('click', () => PanelTemp.marcarTodos(true));
  $('btnNinguno').addEventListener('click', () => PanelTemp.marcarTodos(false));

  /* ---------- conexión: servidor y fuente ---------- */
  let baseActual = null;
  function conectar(base, modo) {
    baseActual = base;
    modeloActual = null;
    $('inpApi').value = base;
    guardarAlmacenado('tp05.api', base);
    guardarAlmacenado('tp05.fuente', modo);
    telemetria.iniciar(base, modo);
  }
  $('formApi').addEventListener('submit', (e) => {
    e.preventDefault();
    try { conectar(normalizarBase($('inpApi').value), $('selFuente').value); }
    catch (err) { toast(err.message, 'aviso'); }
  });
  $('selFuente').addEventListener('change', () => {
    if (baseActual) conectar(baseActual, $('selFuente').value);
  });

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
  let base;
  try { base = normalizarBase(params.get('api') || leerAlmacenado('tp05.api') || CONFIG.API_POR_DEFECTO); }
  catch { base = CONFIG.API_POR_DEFECTO; }
  const fuenteGuardada = params.get('fuente') || leerAlmacenado('tp05.fuente');
  const fuente = ['auto', 'ws', 'polling'].includes(fuenteGuardada) ? fuenteGuardada : 'auto';
  $('selFuente').value = fuente;
  conectar(base, fuente);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciarApp);
  else iniciarApp();
}
