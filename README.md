# TP05 · Dashboard web de telemetría (Unitree)

Frontend del monitor de motores Unitree (versión web de electroSim). Consume el backend FastAPI de la cátedra y muestra los cuatro paneles: motores con semáforo de temperatura, IMU con gráfico histórico, batería (BMS) y fuerzas por pata, más captura de muestras y exportación a CSV.

Archivos: `dashboard.html`, `dashboard.css` y `dashboard.js`. No necesita instalar nada: Chart.js se carga por CDN (hace falta internet para los gráficos).

## Cómo correrlo

1. **Backend** (provisto por la cátedra, repo `tsamaan/UadeRobotLab`, carpeta `05LaboratoriosTPs/TP05_Desarrollo_de_Aplicaciones_II/entorno`). Sin simulador, en modo demo:

   ```bash
   pip install fastapi uvicorn websockets
   python3 arrancar_api.py --demo --robot go2      # o --robot g1
   ```

   Usar **Python 3.11 o superior**. Con 3.10 el WebSocket se corta después del primer mensaje (el servidor captura `TimeoutError` y en 3.10 `asyncio.wait_for` lanza otra clase). El dashboard lo tolera y sigue por polling, pero no recibe push.

2. **Dashboard:** abrir `dashboard.html` en el navegador (doble clic) o servirlo con `python3 -m http.server 8090` y entrar a `http://localhost:8090/dashboard.html`.

3. **Servidor:** si no se indica ninguno, el dashboard prueba `http://localhost:8001` (laboratorio) y `http://localhost:8000` (servidor de ejemplo del enunciado) y usa el que responda. También se puede escribir en el campo «Servidor» de la barra superior o pasar `?api=http://IP:8001` en la dirección.
4. **Robot:** el selector «Robot» permite pedir `go2` o `g1` (`/telemetria?modelo=`), como en el enunciado. Con el servidor del laboratorio, que atiende un solo robot, pedir otro muestra el motivo del servidor. Con un robot elegido se usa polling, porque el WebSocket no recibe parámetros.

## Parámetros de la dirección (opcionales)

| Parámetro | Efecto |
|---|---|
| `?api=http://IP:8001` | servidor de telemetría |
| `?fuente=auto\|ws\|polling` | fuente de datos |
| `?modelo=go2\|g1` | robot a pedir |
| `?forzarTemp=25` | suma 25 °C a las temperaturas mostradas, solo para verificar el semáforo en rojo (el dashboard lo avisa en pantalla) |

## Qué hace

- **Resumen de un vistazo:** tarjetas fijas arriba con la temperatura máxima (y en qué motor), motores en riesgo, batería, patas apoyadas y muestras capturadas. Cambian de color con el semáforo.
- **Motores:** tabla ordenable por temperatura (clic en el encabezado) y un **mapa de calor** agrupado por pata o articulación.
- **IMU:** horizonte artificial (roll y pitch) y brújula (yaw), además de los valores y el gráfico histórico.
- **Tema claro y oscuro** (botón de la barra superior, se recuerda) y **pantalla completa**, pensados para proyectar en el laboratorio.

- **Fuente de datos:** WebSocket con reconexión automática; si falla, pasa a polling a `/telemetria` cada 250 ms (la consigna pide 500 ms como máximo) y reintenta el WebSocket. También se puede forzar solo WebSocket o solo polling.
- **Pérdida de conexión:** aviso rojo, paneles atenuados con los últimos valores y reintento automático; nunca se rompe la página.
- **Modelo del robot:** se deduce del mensaje (12 motores en el Go2, 29 en el G1). Si el servidor no trae voltajes de celda o patas, el panel lo dice.
- **Captura y CSV:** «Capturar muestra» guarda hora real, hora del servidor, IMU, BMS (con celdas), patas y los cuatro valores de cada motor. «Exportar CSV» descarga el archivo desde el navegador con la API Blob, sin pasar por el servidor.
- **Alertas automáticas:** si un motor supera 60 °C se avisa y se registra una muestra sola.

## Pruebas de la lógica

Las funciones puras (semáforo, buffer circular, CSV, validación) se exportan con `module.exports` y se pueden probar con Node.

## Entregables

- **Código:** `dashboard.html`, `dashboard.css`, `dashboard.js`.
- **Capturas de pantalla** (`entregables/capturas/`): dashboard completo en modo demo con los cuatro paneles y el semáforo, en tema oscuro y claro; mapa de calor; captura y exportación; semáforo en rojo (con `?forzarTemp=25`, temperaturas simuladas, avisado en la propia captura); G1 con 29 motores; y la pérdida de conexión.
- **CSV exportado** (`entregables/csv/`): sesión de prueba con 12 muestras capturadas manualmente con el botón.
- **Documento técnico:** pendiente (2 páginas como máximo).

## Seguridad

El dashboard es de solo lectura: solo hace `GET /telemetria`, `GET /info` y abre el WebSocket `/ws`; no envía comandos al robot. El servidor de la cátedra escucha en todas las interfaces y tiene CORS abierto, así que conviene usarlo solo en la red cerrada del laboratorio y no exponerlo a internet.
