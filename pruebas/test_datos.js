// Pruebas de la capa de datos (Telemetria) contra un servidor HTTP falso, y de las funciones nuevas.
const assert = require('assert'); const http = require('http');
const D = require('../dashboard.js');
let ok = 0; const fallos = [];
const t = async (n, f) => { try { await f(); ok++; console.log('  ✓', n); } catch (e) { fallos.push(n); console.log('  ✗', n, '\n     ', e.message); process.exitCode = 1; } };
const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const dato = (modelo, n, conNombre = true) => ({ modelo, ts: 1.5,
  motores: Array.from({length:n}, (_, i) => ({ id:i, ...(conNombre ? {nombre:'X'+i} : {}), angulo:1, velocidad:2, torque:3, temperatura:30 })),
  imu:{roll:1,pitch:2,yaw:3,ax:0,ay:0,az:9.8}, bms:{soc:90,corriente:1,temperatura:30,celdas:[3.7]}, fuerzas:{FR:1,FL:0,RR:1,RL:1} });

(async () => {
  await t('nombreDeMotor: del servidor, estándar o genérico', () => {
    assert.equal(D.nombreDeMotor({id:0, nombre:'abc'}, 12), 'abc');
    assert.equal(D.nombreDeMotor({id:4}, 12), 'FL_thigh');
    assert.equal(D.nombreDeMotor({id:28}, 29), 'R_wrist_yaw');
    assert.equal(D.nombreDeMotor({id:3}, 7), 'Motor 3');
  });
  await t('aplanarMuestra usa nombres estándar si el servidor no manda nombre', () => {
    const f = D.aplanarMuestra(dato('go2', 12, false));
    assert.equal(f.m00_FR_hip_temp_c, 30); assert.equal(f.m11_RL_calf_torque_nm, 3);
  });
  await t('limitarPorcentaje y colorBateria', () => {
    assert.equal(D.limitarPorcentaje(150), 100); assert.equal(D.limitarPorcentaje(-3), 0); assert.equal(D.limitarPorcentaje('x'), 0); assert.equal(D.limitarPorcentaje(55), 55);
    assert.equal(D.colorBateria(10), 'var(--hot)'); assert.equal(D.colorBateria(30), 'var(--warn)'); assert.equal(D.colorBateria(80), 'var(--ok)');
  });

  // ----- servidor falso: robot activo "go2"; ?modelo=g1 da 409 como el servidor del laboratorio; ?modelo=go2 o sin parámetro responde
  const pedidos = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); pedidos.push(req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (u.pathname !== '/telemetria') { res.statusCode = 404; return res.end('{}'); }
    const m = u.searchParams.get('modelo');
    if (m && m !== 'go2') { res.statusCode = 409; res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({detail:'El servidor esta conectado a go2, no a ' + m})); }
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(dato('go2', 12)));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port;

  await t('polling: recibe datos, respeta el intervalo y no se solapa', async () => {
    const tel = new D.Telemetria(); const recibidos = []; const estados = [];
    tel.en('dato', d => recibidos.push(d)); tel.en('estado', e => estados.push(e.estado));
    pedidos.length = 0; tel.iniciar(base, 'polling'); await dormir(1300); tel.detener();
    assert.ok(recibidos.length >= 3 && recibidos.length <= 6, 'mensajes: ' + recibidos.length);   // 250 ms => ~5 en 1,3 s
    assert.ok(estados.includes('polling')); assert.equal(tel.estado, 'polling');
    assert.ok(pedidos.every(p => p === '/telemetria'));
    const est = tel.estadisticas(); assert.ok(est.msgsPorSeg > 2 && est.msgsPorSeg < 6, 'msgs/s ' + est.msgsPorSeg); assert.ok(est.rttMs !== null);
  });
  await t('polling con robot elegido manda ?modelo= y recibe datos', async () => {
    const tel = new D.Telemetria(); let n = 0; tel.en('dato', () => n++);
    pedidos.length = 0; tel.iniciar(base, 'auto', 'go2'); await dormir(700); tel.detener();
    assert.equal(tel.modo, 'polling'); assert.ok(n >= 1); assert.ok(pedidos.every(p => p === '/telemetria?modelo=go2'));
  });
  await t('robot distinto del servidor: 409 con el motivo del servidor en el aviso', async () => {
    const tel = new D.Telemetria(); const estados = [];
    tel.en('estado', e => estados.push(e));
    tel.iniciar(base, 'polling', 'g1'); await dormir(3600); tel.detener();
    const caido = estados.find(e => e.estado === 'caido'); assert.ok(caido, 'tenía que avisar la caída');
    assert.ok(caido.detalle.includes('conectado a go2, no a g1'), caido.detalle);
  });
  await t('servidor apagado: avisa la caída sin lanzar errores y reconecta al volver', async () => {
    const tel = new D.Telemetria(); const estados = []; let n = 0;
    tel.en('estado', e => estados.push(e.estado)); tel.en('dato', () => n++);
    tel.iniciar(base, 'polling'); await dormir(600);
    const puerto = srv.address().port; await new Promise(r => srv.close(r));
    await dormir(4500); assert.equal(tel.estado, 'caido'); const antes = n;
    await new Promise(r => srv.listen(puerto, '127.0.0.1', r)); await dormir(2200);
    tel.detener(); assert.ok(n > antes, 'tenía que recuperarse'); assert.ok(estados.includes('caido') && estados.at(-1) === 'polling');
  });
  await t('mensajes inválidos se descartan y se cuentan', () => {
    const tel = new D.Telemetria(); let n = 0; tel.en('dato', () => n++);
    tel._recibir('no es json', null); tel._recibir('{"motores":1}', null); tel._recibir(JSON.stringify(dato('go2', 12)), 5);
    assert.equal(n, 1); assert.equal(tel.invalidos, 2);
  });
  await t('detener() corta todo: no llegan más datos', async () => {
    const tel = new D.Telemetria(); let n = 0; tel.en('dato', () => n++);
    tel.iniciar(base, 'polling'); await dormir(500); tel.detener(); const x = n; await dormir(800); assert.equal(n, x);
  });
  srv.close();
  console.log(`\n${ok} pruebas OK` + (fallos.length ? `, ${fallos.length} FALLARON` : ''));
  process.exit(process.exitCode || 0);
})();
