<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-SERVER banner" width="100%">
</p>
# 🛰️ HYDRA-UMC SERVER

<p align="center">
  <a href="README.md">🇺🇸 English</a> |
  🇪🇸 <b>Español</b> |
  <a href="README_fra.md">🇫🇷 Français</a> |
  <a href="README_ita.md">🇮🇹 Italiano</a> |
  <a href="README_deu.md">🇩🇪 Deutsch</a> |
  <a href="README_zho.md">🇨🇳 简体中文</a> |
  <a href="README_jpn.md">🇯🇵 日本語</a>
</p>


### 🤖 Backend headless API/WebSocket para la Micro-Fábrica Multi-Robot HYDRA-UMC

<p align="left">
  <img src="https://img.shields.io/badge/Licencia-GPL%203.0-blue.svg" alt="GPL 3.0">
  <img src="https://img.shields.io/badge/Entorno-Node.js-339933.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/Framework-Express-000000.svg" alt="Express">
  <img src="https://img.shields.io/badge/Lenguaje-TypeScript-3178C6.svg" alt="TypeScript">
</p>


---

## 🎯 Visión General

HYDRA-UMC SERVER es el backend independiente que gobierna una célula de
micro-fábrica multi-robot HYDRA-UMC: un motor Node.js/Express + WebSocket
que posee el estado de los robots, lo persiste en disco, autentica cada
escritura y difunde actualizaciones en vivo a cada cliente conectado. Se
distribuye sin interfaz de usuario ni paso de build de frontend propios -
es un servicio puro de API + WebSocket, pensado para ejecutarse headless
(sin navegador, sin pantalla) en la máquina que está físicamente junto a
los robots (típicamente una Raspberry Pi CM5).

Opcionalmente PUEDE servir también el propio frontend ya compilado de
**[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** como
archivos estáticos, para el despliegue habitual "todo en una máquina, un
solo origen" - ejecuta **`build-frontend.sh`/`.bat`** una vez (compila
STUDIO desde un checkout hermano y copia el resultado en el propio
`public/` de este repo, ignorado por git) y este servidor empieza a
servirlo en `/` en su siguiente arranque. Esto es lo que permite que
HYDRA-UMC-ANDROID-CONTROL, HYDRA-UMC-IOS-CONTROL y HYDRA-UMC-DSI incrusten
el visor 3D real de STUDIO en su propio WebView interno, apuntando al
mismo ip:puerto de este servidor. Totalmente opcional: si no se ejecuta
ese script, este servidor sigue siendo tan headless como se describe
arriba - `public/` simplemente no existirá, y todas las rutas siguen
funcionando igual.

El mismo `build-frontend.sh`/`.bat` también compila el propio
**[`admin-ui/`](admin-ui/README.md)** de este repositorio - un panel
pequeño y separado para administrar este SERVIDOR en sí (dispositivos
conectados, su propio archivo de log, su propio puerto/nombre, sus
propias cuentas de usuario), servido en `/admin`. Esto NO es control de
robots (eso sigue siendo exclusivo de STUDIO) - una excepción puntual y
explícita al diseño headless de arriba, no una marcha atrás.

Este proyecto formaba parte de **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)**,
que se distribuía como un "monolito híbrido": un único proceso Node.js
que a la vez ejecutaba el motor de control de robots *y* servía el panel
web Vite/React (con el propio middleware de desarrollo de Vite conectado
directamente a la misma app Express). Ese proceso se ha dividido en dos:

- **HYDRA-UMC SERVER** *(este repositorio)* - el motor: estado de
  robots/controladores, la API REST + WebSocket, autenticación,
  descubrimiento mDNS, envío de modelos. Sin UI, sin bundler, sin paso de
  build de frontend.
- **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** - ahora
  un cliente Vite/React puro que habla con este servidor por red,
  exactamente igual que cualquier otro cliente de esta API.

## 🧩 Por Qué Existe

Separar el motor del panel web fue un cambio deliberado, no una
refactorización porque sí:

- **Aislamiento de recursos.** Una vista 3D pesada que ahoga la propia
  pestaña del navegador ya no comparte proceso (y por tanto contención de
  CPU/E-S) con el código realmente responsable de mover los robots. Si la
  UI web se cuelga, este servidor sigue respondiendo a comandos de parada
  de emergencia de cualquier otro cliente conectado.
- **Un controlador headless real.** Este proceso puede ejecutarse sin
  ninguna UI cargada jamás en el host - el "cerebro" de una célula
  industrial no necesita una pestaña de navegador abierta para funcionar.
  Libera RAM/CPU en hardware limitado (una Raspberry Pi CM5) para la parte
  del trabajo que realmente importa: cinemática y control.
- **Ciclos de vida independientes.** La UI web puede redesplegarse,
  reiniciarse o sustituirse por una build más nueva sin tocar nunca este
  proceso - sin tiempo de inactividad del control de robots solo por
  publicar un arreglo de UI.
- **Alojamiento flexible.** Este servidor está pensado para ejecutarse en
  (o junto a) el hardware que controla; el cliente que lo renderiza puede
  alojarse en cualquier otro sitio, alcanzable por red exactamente igual
  que los demás clientes remotos de esta misma API.

## 🔌 Superficie de API y WebSocket

Cada ruta, el contrato de mensajes WebSocket, la autenticación y el
modelo de acceso remoto por cliente están documentados en
**[`docs/REMOTE_API.md`](docs/REMOTE_API.md)** - la única fuente de
verdad para cualquier cosa que hable con este servidor, incluido el
propio código cliente de HYDRA-UMC STUDIO. En resumen:

- API REST bajo `/api/*` - lectura/escritura de settings, comandos
  atómicos de robot (jog/play/pause/stop/tool/valve/pump/speed/vision),
  gestión de cuentas, subida/descarga de archivos de trabajo, envío de
  modelos, métricas de sistema, descubrimiento.
- Un único endpoint WebSocket `/ws` (token bearer en la query string) que
  difunde snapshots completos `settings` y actualizaciones más ligeras
  `delta` a cada cliente conectado cuando cambia el estado.
- Autenticación JWT por bearer token en cada escritura; dos roles de
  cuenta (`admin`, `operator`) filtran las escrituras de settings/gestión
  de usuarios frente a la operación diaria de robots.
- Anuncio mDNS/Bonjour `_hydra._tcp` para descubrimiento sin
  configuración en la red local, más un `GET /api/hydra-info` plano para
  un escaneo de subred.
- `GET /metrics` - formato de exposición Prometheus (`prom-client`), para
  el dashboard opcional de Grafana descrito en "📊 Monitorización" más
  abajo.

CORS está habilitado mediante una allowlist configurable
(`CORS_ALLOWED_ORIGINS`, ver "Variables de Entorno" más abajo) ya que los
clientes de este servidor ya no comparten necesariamente su propio origen.
Sin configurar, se mantiene abierto fuera de `NODE_ENV=production`
(comportamiento actual sin configuración para desarrollo local); en
producción deniega cualquier petición de navegador de origen cruzado
hasta que se configure la allowlist - ver el comentario sobre
`app.use(cors(corsOptions))` en `src/server.ts` para el razonamiento
completo.

## 💾 Datos y Persistencia

Todo lo que posee este servidor vive bajo `data/`, creada automáticamente
en el primer arranque:

- `data/settings.json` - el árbol de estado completo: controladores,
  robots, configuración de sistema. Nunca servido como archivo estático
  (404 explícito) - solo alcanzable a través de la ruta autenticada
  `/api/settings`.
- `data/users.json` - credenciales de cuenta (hash scrypt, con sal, nunca
  en texto plano). Tampoco servido nunca de forma estática.
- `data/logs/server.log` - log industrial de solo-anexado de cada
  comando.
- `data/WORKS/` - trayectorias de robot guardadas, una carpeta por robot
  por defecto, servidas como archivos estáticos planos (índice + archivos
  de trabajo individuales).
- `data/model_submissions.json` + las propias carpetas de modelos
  enviados - el lado servidor del flujo de
  [HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)
  para "enviar un modelo de robot terminado directamente al catálogo de
  este servidor".

## 📂 Estructura del Repositorio

```
HYDRA-UMC-SERVER/
├── src/
│   ├── server.ts       # App Express + WebSocketServer + todas las rutas /api
│   ├── kinematics.ts   # Ayudante de cinemática inversa para el endpoint atómico de jog
│   └── users.ts        # Almacén de cuentas (hash de contraseña scrypt)
├── data/                # Estado en ejecución - settings, users, logs, archivos de trabajo
│   ├── settings.json
│   ├── users.json
│   ├── logs/
│   └── WORKS/
├── docs/
│   ├── REMOTE_API.md              # Contrato completo: cada ruta, protocolo WS, auth
│   └── PRODUCTION_BOOTSTRAP.md    # JWT y administrador inicial obligatorios
├── tools/
│   └── verify_production_bootstrap_contract.mjs # Comprueba el cierre seguro en producción
├── monitoring/           # Stack opcional Prometheus + Grafana - ver monitoring/README.md
├── scripts/
│   └── bump-version.mjs # Ayudante nativo heredado; los builds estándar usan bump_manifest_version.py
├── build.bat / build.sh # Instala dependencias + build de producción
├── dev.bat / dev.sh      # Instala dependencias + arranca el servidor de desarrollo
├── package.json
├── tsconfig.json
├── CHANGELOG.md
└── LICENSE
```

## 🛠️ Entorno de Desarrollo

### Requisitos
- [Node.js](https://nodejs.org/) (v18 o superior recomendado)
- npm

### Instalación

```bash
npm install
```

### Variables de Entorno

Opcional - el servidor funciona sin ninguna configuración adicional,
usando valores de desarrollo integrados para cada variable de abajo.
Define valores reales antes de exponer este servidor más allá de una LAN
totalmente de confianza - por ejemplo a través de internet vía el
NAT/redirección de puertos del router, lo que cambia el modelo de amenaza
de "solo LAN de confianza" a "alcanzable por cualquiera" (ver
`.env.example`):

- `JWT_SECRET` - firma cada token de inicio de sesión. Si no está
  definida, se usa un valor de desarrollo fijo incluido en
  `src/server.ts` (válido para desarrollo local, no para un despliegue
  alcanzable fuera de una red de confianza). Expórtala desde tu shell, o
  mediante tu gestor de procesos/contenedor preferido (`Environment=` de
  systemd, la configuración de entorno de `pm2`, `-e` de Docker...).
- `NODE_ENV` - define `production` para cualquier despliegue real.
  Controla las dos rutas de respaldo de abajo (CORS abierto, valores por
  defecto silenciosos) y activa avisos de arranque bien visibles si
  `JWT_SECRET` o la cuenta seedeada `admin`/`admin` siguen en su valor por
  defecto. Sin definir (o con cualquier otro valor) mantiene el
  comportamiento permisivo de desarrollo actual.
- `CORS_ALLOWED_ORIGINS` - lista separada por comas de orígenes
  autorizados a hacer peticiones de navegador de origen cruzado a esta
  API - el caso real que importa aquí es HYDRA-UMC STUDIO sirviéndose
  desde otro host/puerto que este servidor (p.ej.
  `https://studio.example.com`, o `http://192.168.1.20:5173` en
  desarrollo). Ejemplo:
  `CORS_ALLOWED_ORIGINS=https://studio.example.com,http://192.168.1.20:5173`.
  Si no está definida: `NODE_ENV != production` permite cualquier origen
  (sin configuración necesaria para desarrollo local, igual al
  comportamiento histórico de este proyecto); `NODE_ENV = production` en
  cambio **deniega** cualquier petición de navegador de origen cruzado
  hasta que esto se configure, con un aviso de arranque bien visible. Los
  clientes que no son navegador (curl, HYDRA-UMC SUITE, las apps móviles)
  nunca se ven afectados en ningún caso - CORS es un mecanismo exclusivo
  del navegador.
- `JWT_EXPIRES_IN` - cuánto tiempo permanece válido un token de sesión.
  Cualquier cadena que acepte la opción `expiresIn` propia de
  `jsonwebtoken` (`"24h"`, `"7d"`, un número de segundos a secas...). Por
  defecto `30d` si no está definida (la suposición original de este
  proyecto de LAN de confianza). **Un servidor alcanzable más allá de una
  LAN de confianza debería definir esto mucho más corto - `24h` es un
  punto de partida razonable** - un token de larga duración filtrado no
  tiene forma de revocarse individualmente salvo cambiando la contraseña
  de esa cuenta.
- `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` - limita
  únicamente `POST /api/login` (el resto de rutas no se ven afectadas).
  Por defecto 5 intentos por 15 minutos por IP si alguna no está definida;
  al activarse responde `429` con un error JSON claro, no un `500`
  genérico.
- `TLS_CERT_PATH` / `TLS_KEY_PATH` - define **ambas** para cambiar el
  servidor (API REST + el WebSocket `/ws`, que comparte el mismo
  listener) de HTTP/WS plano a HTTPS/WSS. Ver "TLS / HTTPS" más abajo.
  Dejar cualquiera sin definir mantiene el comportamiento HTTP plano
  actual sin cambios.

### TLS / HTTPS

Desactivado por defecto - este servidor siempre ha funcionado como
HTTP/WS plano, y sigue así salvo que se active explícitamente. Define
tanto `TLS_CERT_PATH` como `TLS_KEY_PATH` (ver arriba) apuntando a un
certificado PEM y su clave privada correspondiente, y el listener
compartido REST + WebSocket cambia a `https.createServer()` - `/ws` pasa
automáticamente a WSS junto con él, sin configuración adicional. Una ruta
de certificado/clave definida pero ilegible o inválida hace fallar el
arranque de forma visible (un error real de `fs`) en vez de volver
silenciosamente a HTTP plano.

Esto importa sobre todo una vez que este servidor es alcanzable más allá
de una LAN totalmente de confianza (p.ej. expuesto vía NAT/redirección de
puertos del router para pruebas remotas) - HTTP plano significa que cada
token bearer, cada comando de robot y el propio login de admin/operador
cruzan la red en texto claro.

Cómo conseguir un certificado:

- **Tienes un dominio propio apuntando a este servidor** - usa
  [Let's Encrypt](https://letsencrypt.org/) (p.ej. vía
  [Certbot](https://certbot.eff.org/)) para un certificado real, de
  confianza para los navegadores, gratuito y renovable automáticamente.
  Apunta `TLS_CERT_PATH` / `TLS_KEY_PATH` al `fullchain.pem` /
  `privkey.pem` resultante.
- **Pruebas locales, sin dominio** - un certificado autofirmado basta
  para ejercitar la ruta de código HTTPS/WSS (los navegadores y la
  mayoría de clientes HTTP avisarán/exigirán confiar en él manualmente,
  lo cual es esperado y está bien para pruebas):
  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"
  ```
  Luego define `TLS_CERT_PATH=./cert.pem` y `TLS_KEY_PATH=./key.pem`.

### Modo Desarrollo

Ejecuta el servidor API/WebSocket directamente con `tsx` (sin bundler, sin
frontend involucrado):
- **Windows:** doble clic en `dev.bat` o `npm run dev`
- **Linux/Mac:** ejecuta `./dev.sh` o `npm run dev`

### Build de Producción

Empaqueta el servidor en un único archivo desplegable con esbuild:
- **Windows:** usa `build.bat` para un build de publicación versionado; usa `npm run build` solo para compilar.
- **Linux/Mac:** usa `./build.sh` para un build de publicación versionado; usa `npm run build` solo para compilar.

Luego arranca el servidor de producción con:
```bash
npm start
```

El servidor escucha en `0.0.0.0:3000` - accesible en
`http://localhost:3000` o `http://<tu-ip-local>:3000` en la red local.
Todo el estado persiste en `data/`.

### Versionado

Solo los scripts raíz `build*.bat` y `build*.sh` crean un incremento de
versión de publicación. Llaman una única vez a `bump_manifest_version.py`,
manteniendo sincronizados `package.json`, `hydra-umc.project.json` y
[`CHANGELOG.md`](CHANGELOG.md) con la regla de cuentakilómetros en base 10
(`0.0.9` -> `0.1.0`, nunca `0.0.10`). `npm run build` compila deliberadamente
sin versionar, por lo que los builds directos y la validación `build-test` no
pueden cambiar solo la versión de `package.json`. La versión en ejecución se
lee en vivo desde `GET /api/hydra-info` (`appVersion`).

## 📊 Monitorización (Opcional)

`GET /metrics` expone el uptime del proceso, los clientes WebSocket
conectados, la latencia de escritura de `settings.json`, los comandos
atómicos de robot por tipo, los fallos de autenticación, y las mismas
cifras de CPU/memoria/temperatura que `GET /api/system/metrics` - todo en
formato Prometheus. Un stack Prometheus + Grafana listo para usar (con un
dashboard inicial) vive en **[`monitoring/`](monitoring/README.md)**:
`docker compose up -d` desde esa carpeta y ya está en marcha. Totalmente
opcional - nada aquí es necesario para que el servidor en sí funcione.

## 🔗 Proyectos Relacionados

Este proyecto forma parte de un ecosistema de robótica más amplio del mismo autor (JuanenRac / Electro Hobby 3D), compuesto por muchos proyectos que abarcan firmware, software de control, nodos de IA y herramientas de flota. Vale la pena conocerlos, ya que una petición podría en realidad referirse a uno de ellos en vez de a este repositorio.

### Directamente Relacionados con Este Servidor

- **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** — expone el estado de este servidor vía OPC-UA/MQTT.
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** — ingiere los logs que genera este servidor.
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** — ingiere los logs que genera este servidor.
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — coordina múltiples instancias de este servidor.
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — coordina múltiples instancias de este servidor y gestiona su failover.
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — actúa de puente entre este servidor y el gemelo digital.
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** — realiza DevOps de flota contra la API de este servidor.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — expone solo coordinación autenticada de alto nivel entre este servidor y ROS 2.
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — coordina entregas de PCB trazables mediante la ruta autorizada del servidor.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — coordina auxiliares de impresora mediante el servidor; el firmware nativo conserva la autoridad.
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — solicita auxiliares acotados de celda CNC; nunca sustituye la seguridad del controlador.
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — solicita auxiliares de celda láser sin ruta para armar ni disparar un láser.

### Resto del Ecosistema

**Plataforma HYDRA-UMC** — la célula de microfábrica multi-robot
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — la placa base en sí: host Raspberry Pi CM5 + coprocesador de tiempo real STM32H745 de doble núcleo, orquestando hasta 8 brazos robóticos distribuidos por CAN-OTA/SPI-OTA. Hardware y firmware propios, GPL-3.0/CERN-OHL-S v2/CC BY-SA 4.0.
- **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — panel de control web para HYDRA-UMC: visualización 3D multi-robot, grabación de cinemática/trayectorias, flasheo y pruebas CAN-OTA para toda la plataforma. React + Vite + Three.js - ahora un cliente frontend puro que habla con este mismo servidor por red, exactamente igual que cualquier otro cliente de la lista de abajo.
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — app de control Android para HYDRA-UMC por Wi-Fi/Bluetooth. App real y funcional - conjunto completo de funciones de control remoto, autenticación JWT, almacenamiento cifrado de credenciales.
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — app de control iOS/iPadOS para HYDRA-UMC por Wi-Fi, hecha en Flutter (multiplataforma, verificable en Windows sin necesitar un Mac; el empaquetado final del `.ipa` sigue necesitando Xcode). App real y funcional - mismo conjunto de funciones que la app Android.
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — centro de mando de escritorio (Python/PySide6) para el enjambre: descubrimiento de red multi-controlador, sincronización bidireccional en vivo, visor 3D real de robots, espacio de trabajo acoplable estilo Photoshop. Real y funcional, no un placeholder.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — creador/editor gráfico de URDF de escritorio (Python/PySide6) para el catálogo de modelos de este proyecto: obtiene archivos fuente desde GitHub o una carpeta local, valida la viabilidad de los grados de libertad, edita color/escala/cinemática con vista previa 3D en vivo, y envía el resultado final directamente al catálogo de este servidor. Real y funcional, no un placeholder.
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — interfaz táctil nativa en Flutter para la pantalla táctil DSI de 5"/7" del propio HYDRA-UMC (1280×720, misma resolución en ambos tamaños) en la Compute Module 5, controlando este mismo servidor directamente desde la placa. Scaffold real y funcional con las 6 pantallas del catálogo conectadas al servidor en vivo; compilación real del target Linux aún no ejecutada en hardware real.

**Plataforma URTC** — el controlador de cabezal de herramienta que lleva cada brazo robótico HYDRA-UMC
- **[URTC](https://github.com/JuanenRac/URTC)** — Universal Robot Tool Controller: controlador de cabezal de herramienta por bus CAN basado en STM32F303, 25 perfiles de herramienta totalmente implementados, actualización de firmware CAN-OTA.
- **[URTC Flasher](https://github.com/JuanenRac/URTC-FLASHER)** — herramienta de escritorio de flasheo CAN-OTA + chip completo SWD/JTAG para placas URTC (Windows/Linux).
- **[URTC Tester](https://github.com/JuanenRac/URTC-TESTER)** — herramienta de escritorio de diagnóstico en vivo por bus CAN para placas URTC, un panel por perfil de herramienta (Windows/Linux).
- **[URTC Web Studio](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — alternativa basada en navegador a las 2 herramientas de escritorio anteriores (Web Serial API + SLCAN), sin instalación local necesaria.

**👁️ Nodo de IA de Visión (Hailo-8)**
- [HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)
- [HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)
- [HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)
- [HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)
- [HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)

**🧠 Nodo de IA Cognitiva (Hailo-10)**
- [HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)
- [HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)
- [HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)
- [HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)
- [HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)

**🐝 Orquestación y Enjambre**
- [HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)
- [HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)
- [HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)

**🎮 Gemelo Digital y Simulación**
- [HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)
- [HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)
- [HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)

**📊 Datos y Analítica**
- [HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)
- [HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)

**🏭 Pasarela Industrial**
- [HYDRA-UMC-OPCUA-SERVER](https://github.com/JuanenRac/HYDRA-UMC-OPCUA-SERVER)
- [HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)
- [HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)

**🛠️ Herramientas Complementarias**
- [URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)
- [URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)
- [HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)
- [HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)

---

## 👤 Autor

**JuanenRac** (Electro Hobby 3D)
📧 electrohobby3d@gmail.com
📺 youtube.com/@electrohobby3d

---

## 📜 Licencia y Avisos de Copyright

HYDRA-UMC SERVER es (c) 2026 JuanenRac (Electro Hobby 3D). Este aviso debe
incluirse en cualquier distribución de este proyecto o trabajos derivados.

El código fuente de esta aplicación está disponible bajo la **GNU General
Public License v3.0 (GPL-3.0)**. Texto completo en
https://www.gnu.org/licenses/gpl-3.0.html.

La documentación (este README y sus propias traducciones - `README_spa.md`,
`README_ita.md`, `README_fra.md`, `README_deu.md`, `README_zho.md`,
`README_jpn.md`) está disponible bajo
**Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA
4.0)**. Texto completo en https://creativecommons.org/licenses/by-sa/4.0/.
