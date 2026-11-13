const assert = require('assert');
const D = require('../dashboard.js');
let ok = 0; const t = (n, f) => { try { f(); ok++; console.log('  ✓', n); } catch (e) { console.log('  ✗', n, '\n     ', e.message); process.exitCode = 1; } };

t('semáforo: límites', () => {
  assert.equal(D.clasificarTemp(39.9), 'ok');
  assert.equal(D.clasificarTemp(40), 'warn');
  assert.equal(D.clasificarTemp(60), 'warn');
  assert.equal(D.clasificarTemp(60.1), 'hot');
  assert.equal(D.clasificarTemp(NaN), 'sin-dato');
  assert.equal(D.clasificarTemp(null), 'sin-dato');
  assert.equal(D.clasificarTemp('50'), 'sin-dato');
});
t('RingBuffer descarta lo más viejo al llenarse', () => {
  const r = new D.RingBuffer(3); [1,2,3,4,5].forEach(x => r.push(x));
  assert.deepEqual(r.toArray(), [3,4,5]); assert.equal(r.length, 3);
});
t('RingBuffer de 300 no pasa de 300', () => {
  const r = new D.RingBuffer(D.CONFIG.HIST_SIZE); for (let i = 0; i < 1000; i++) r.push(i);
  assert.equal(r.length, 300); assert.equal(r.toArray()[0], 700);
});
const dato = (modelo='go2', n=12) => ({ modelo, ts: 5.5,
  motores: Array.from({length:n}, (_, i) => ({ id:i, nombre:'M'+i, angulo:1.5, velocidad:0.1, torque:2, temperatura:30+i })),
  imu:{roll:1,pitch:2,yaw:3,ax:.1,ay:.2,az:9.8}, bms:{soc:90,corriente:1200,temperatura:31.5,celdas:[3.7,3.71]}, fuerzas:{FR:1,FL:0,RR:1,RL:1} });
t('validarTelemetria', () => {
  assert.ok(D.validarTelemetria(dato()));
  assert.ok(!D.validarTelemetria(null)); assert.ok(!D.validarTelemetria({})); assert.ok(!D.validarTelemetria({...dato(), motores:'x'}));
});
t('normalizarBase / wsUrl', () => {
  assert.equal(D.normalizarBase('192.168.0.5:8001'), 'http://192.168.0.5:8001');
  assert.equal(D.normalizarBase(' http://localhost:8001/ '), 'http://localhost:8001');
  assert.equal(D.normalizarBase('https://x.com/abc'), 'https://x.com');
  assert.throws(() => D.normalizarBase('')); assert.throws(() => D.normalizarBase('ftp://x')); assert.throws(() => D.normalizarBase('javascript://x'));
  assert.equal(D.wsUrl('http://h:8001'), 'ws://h:8001/ws'); assert.equal(D.wsUrl('https://h'), 'wss://h/ws');
});
t('aplanarMuestra: columnas esperadas (Go2)', () => {
  const f = D.aplanarMuestra(dato(), 'manual', new Date('2026-11-13T12:00:00Z'));
  assert.equal(f.fecha_hora, '2026-11-13T12:00:00.000Z'); assert.equal(f.ts_servidor_s, 5.5); assert.equal(f.modelo, 'go2');
  assert.equal(f.imu_roll, 1); assert.equal(f.bms_soc_pct, 90); assert.equal(f.bms_celda_2_v, 3.71); assert.equal(f.pata_FR, 1);
  assert.equal(f.m00_M0_temp_c, 30); assert.equal(f.m11_M11_torque_nm, 2);
  assert.equal(Object.keys(f).length, 5 + 6 + 3 + 2 + 4 + 12*4);
});
t('CSV: encabezado, filas, escape y unión de columnas', () => {
  const a = D.aplanarMuestra(dato(), 'manual'); const b = D.aplanarMuestra({...dato(), bms:{soc:1,corriente:1,temperatura:1,celdas:[3.7,3.7,3.7]}}, 'alerta_temp_FR_hip');
  const csv = D.construirCSV([a, b]); const l = csv.trim().split('\r\n');
  assert.equal(l.length, 3);
  const cab = l[0].split(','); assert.ok(cab.includes('bms_celda_3_v'));
  assert.equal(l[1].split(',').length, cab.length); assert.equal(l[2].split(',').length, cab.length);
  assert.equal(D.escaparCSV('a,b'), '"a,b"'); assert.equal(D.escaparCSV('di"ce'), '"di""ce"');
  assert.equal(D.escaparCSV('=1+1'), "'=1+1"); assert.equal(D.escaparCSV(-5), '-5'); assert.equal(D.escaparCSV(NaN), ''); assert.equal(D.escaparCSV(undefined), '');
});
t('CSV con 10 muestras', () => {
  const m = Array.from({length:10}, (_, i) => D.aplanarMuestra({...dato(), ts:i}, 'manual'));
  assert.equal(D.construirCSV(m).trim().split('\r\n').length, 11);
});
t('estadisticaCeldas', () => {
  assert.equal(D.estadisticaCeldas([]), null);
  const e = D.estadisticaCeldas([3.7, 3.72, 3.69]); assert.equal(e.min, 3.69); assert.equal(e.max, 3.72); assert.ok(Math.abs(e.delta - 0.03) < 1e-9);
});
t('alertas: una vez por cruce, con histéresis', () => {
  const s = new Set(); const mot = (t) => [{id:1,nombre:'a',temperatura:t}];
  assert.equal(D.motoresNuevosEnAlerta(mot(61), s).length, 1);
  assert.equal(D.motoresNuevosEnAlerta(mot(62), s).length, 0);   // sigue en alerta: no repite
  assert.equal(D.motoresNuevosEnAlerta(mot(59), s).length, 0);   // aún dentro de la histéresis
  assert.equal(D.motoresNuevosEnAlerta(mot(57), s).length, 0);   // rearmada
  assert.equal(D.motoresNuevosEnAlerta(mot(61), s).length, 1);   // vuelve a avisar
});
t('fmt', () => { assert.equal(D.fmt(1.234, 2), '1.23'); assert.equal(D.fmt(NaN), '—'); assert.equal(D.fmt(undefined), '—'); });

// ---- Gemelo digital y minigráfico de tendencia ----
const puntosDe = (g) => [].concat(Object.values(g.articulaciones), Object.values(g.pies), ...g.huesos, g.etiquetas.map(e => [e.x, e.y]));
const dentro = (g) => puntosDe(g).every(([x, y]) => x >= 0 && x <= g.ancho && y >= 0 && y <= g.alto);
const sinSolapes = (g) => { const a = Object.values(g.articulaciones); for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (Math.hypot(a[i][0] - a[j][0], a[i][1] - a[j][1]) < 2 * g.radioArt) return false; return true; };
t('gemelo digital: cuadrúpedo (12 motores) con las 12 articulaciones y las 4 patas', () => {
  const g = D.disposicionGemelo(12); assert.equal(g.tipo, 'cuadrupedo');
  for (let i = 0; i < 12; i++) assert.ok(g.articulaciones[D.nombreDeMotor({ id: i }, 12)], 'falta la articulación ' + i);
  assert.deepEqual(Object.keys(g.pies).sort(), ['FL', 'FR', 'RL', 'RR']);
  assert.ok(dentro(g), 'hay puntos fuera del lienzo'); assert.ok(sinSolapes(g), 'hay articulaciones superpuestas');
});
t('gemelo digital: humanoide (29 motores) con las 29 articulaciones y los 2 pies', () => {
  const g = D.disposicionGemelo(29); assert.equal(g.tipo, 'humanoide');
  for (let i = 0; i < 29; i++) assert.ok(g.articulaciones[D.nombreDeMotor({ id: i }, 29)], 'falta la articulación ' + i);
  assert.deepEqual(Object.keys(g.pies).sort(), ['L_foot', 'R_foot']);
  assert.ok(dentro(g), 'hay puntos fuera del lienzo'); assert.ok(sinSolapes(g), 'hay articulaciones superpuestas');
});
t('gemelo digital: simetría izquierda y derecha del humanoide', () => {
  const g = D.disposicionGemelo(29);
  for (const n of ['hip_pitch', 'knee', 'shoulder_roll', 'elbow', 'wrist_yaw']) { const l = g.articulaciones['L_' + n], r = g.articulaciones['R_' + n]; assert.equal(l[0] + r[0], 320); assert.equal(l[1], r[1]); }
});
t('gemelo digital: un modelo desconocido no tiene silueta', () => { assert.equal(D.disposicionGemelo(7), null); assert.equal(D.disposicionGemelo(0), null); });
t('tendencia: pocos datos no dibujan nada', () => { assert.equal(D.puntosTendencia([]), ''); assert.equal(D.puntosTendencia([30]), ''); assert.equal(D.puntosTendencia([null, undefined, NaN]), ''); });
t('tendencia: una serie que sube dibuja una línea que sube', () => {
  const p = D.puntosTendencia([30, 32, 34, 36], 80, 20).split(' ').map(x => x.split(',').map(Number));
  assert.equal(p.length, 4); assert.equal(p[0][0], 0); assert.equal(p[3][0], 80);
  for (let i = 1; i < 4; i++) assert.ok(p[i][1] < p[i - 1][1], 'tiene que subir (el eje y crece hacia abajo)');
  assert.ok(p.every(([x, y]) => y >= 0 && y <= 20));
});
t('tendencia: sin variación queda plana y centrada (no agranda el ruido)', () => {
  const ys = D.puntosTendencia([40, 40, 40], 60, 20).split(' ').map(x => Number(x.split(',')[1])); assert.ok(ys.every(y => y === ys[0]) && Math.abs(ys[0] - 10) < 0.2);
  const ruido = D.puntosTendencia([40, 40.4, 40.1], 60, 20).split(' ').map(x => Number(x.split(',')[1])); assert.ok(Math.max(...ruido) - Math.min(...ruido) < 5, 'un ruido de 0,4 °C no tiene que ocupar todo el alto');
});
t('tendencia: con pocos valores se alinea a la derecha de la capacidad', () => {
  const p = D.puntosTendencia([30, 31, 32], 90, 20, 10).split(' ').map(x => Number(x.split(',')[0])); assert.ok(p[0] > 0 && p[2] === 90);
});

console.log(ok + ' pruebas OK');
