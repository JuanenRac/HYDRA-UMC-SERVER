<!-- =============================================================================
HYDRA-UMC-SERVER - Headless REST and WebSocket backend of the HYDRA-UMC micro-factory
Copyright (C) JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
GPL-3.0-or-later - see LICENSE
============================================================================= -->

<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-SERVER banner" width="100%">
</p>

# 🤖 HYDRA-UMC-SERVER

<p align="center"><a href="README.md">🇺🇸 English</a> | 🇪🇸 <b>Español</b> | <a href="README_fra.md">🇫🇷 Français</a> | <a href="README_ita.md">🇮🇹 Italiano</a> | <a href="README_deu.md">🇩🇪 Deutsch</a> | <a href="README_zho.md">🇨🇳 简体中文</a> | <a href="README_jpn.md">🇯🇵 日本語</a> | <a href="README_por.md">🇵🇹 Português</a></p>

### 🤖 Backend headless API/WebSocket para la Micro-Fábrica Multi-Robot HYDRA-UMC

<p align="center">
  <img src="https://img.shields.io/badge/License-GPL%203.0--or--later-blue.svg" alt="GPL 3.0 or later">
  <img src="https://img.shields.io/badge/Runtime-Node.js-339933.svg" alt="Runtime">
  <img src="https://img.shields.io/badge/Framework-Express-000000.svg" alt="Framework">
  <img src="https://img.shields.io/badge/Language-TypeScript-3178C6.svg" alt="Language">
  <img src="https://img.shields.io/badge/Protocol-WebSocket-lightgrey.svg" alt="Protocol">
  <img src="https://img.shields.io/badge/Tests-414%20passing-2ea44f.svg" alt="Tests">
  <img src="https://img.shields.io/badge/Version-0.8.1.4-0f6cbd.svg" alt="Version">
  <img src="https://img.shields.io/badge/Maturity-functional-0F6CBD.svg" alt="Maturity">
</p>

---

> **Comprobación de honestidad - qué funciona realmente hoy:** el motor Express + WebSocket, su superficie REST y WebSocket (63 operaciones en 58 rutas), el inicio de sesión JWT con rotación del token de refresco y scrypt, el descubrimiento mDNS, las reservas y revisiones de robots, la reproducción, y los relés hacia CAN-OTA, telemetría, voz, los servicios de IA locales y el connector hub son reales y se prueban contra una instancia real de este mismo servidor que arrancan las propias pruebas: 414 pruebas unitarias más 28 scripts de contrato de extremo a extremo, todos pasan. Lo que roza el hardware y no se verifica aquí: el enlace con una CM5 HYDRA-UMC real con una placa STM32H745, que es código real ejercitado solo por la capa de API y contratos. TLS, Bluetooth LE, el puente MQTT y la pila Prometheus y Grafana son reales, opcionales y están apagados por defecto.

---

> **Estado de seguridad física y de ciberseguridad:** este ecosistema no es un sistema de seguridad certificado. Todavía no existe una ruta de E-STOP por hardware, ni límites ni enclavamientos aplicados por el firmware, ni un comando de movimiento verificado; las imágenes de firmware se comprueban con CRC-32 y una firma Ed25519, y una compilación de versión rechaza las claves de desarrollo publicadas (los cabezales de herramienta y las placas de expansión detrás del relé siguen con cargadores de URTC, que usan un HMAC-SHA256 de clave compartida en lugar de una firma); TLS y TLS mutuo son opcionales y están desactivados por defecto; aún no se ha poblado ni probado ninguna placa propia. Lee la [línea base de seguridad](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md) y el [modelo de amenazas](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md) antes de fiarte de cualquier afirmación de aquí para la seguridad de una persona.

---

## 📋 De un vistazo

| | |
|---|---|
| Versión | `0.8.1.4` |
| Madurez | Funcional |
| Tests | 414 (`npm run test:unit`) |
| Tecnología | Node.js 20+ / Express / WebSocket (ws) / REST/OpenAPI |
| Destino | La Raspberry Pi CM5 de una celda HYDRA-UMC |
| En hardware real | Ejecutado en un banco de pruebas: la comprobación de honestidad de arriba dice qué partes funcionaron en hardware real |

**Ir a:** [Resumen](#-resumen) · [Arquitectura](#-arquitectura) · [Funciones](#-funciones) · [Seguridad y protección](#-seguridad-y-protección) · [Interfaces](#-interfaces) · [Configuración](#-configuración) · [Inicio rápido](#-inicio-rápido) · [Pruebas](#-pruebas) · [Resolución de problemas](#-resolución-de-problemas) · [Estructura del repositorio](#-estructura-del-repositorio) · [Proyectos relacionados](#-proyectos-relacionados)

## 🚦 Estado del proyecto

Cada línea es una parte de este repositorio y la luz dice hasta dónde llega hoy. Se escribe con lo que el repositorio puede demostrar (pruebas, compilaciones, ejecuciones), no con lo previsto.

🟢 Hecho y verificado · 🟡 Funciona, con límites conocidos · 🟠 Hecho a medias o sin verificar · 🔴 Sin hacer o sin funcionar

| Área | Estado | Qué significa aquí |
|---|---|---|
| Software | 🟡 | Funciona para su propósito principal; la comprobación de honestidad de arriba lista lo que aún falta |
| Pruebas | 🟢 | 414 pruebas automáticas, ejecutadas en cada cambio |
| Hardware real | 🟡 | Ejecutado en un banco de pruebas: la comprobación de honestidad de arriba dice qué partes funcionaron en hardware real |
| Documentación | 🟢 | README en ocho idiomas, comprobado contra el manifiesto en cada cambio |

## 🎯 Resumen

HYDRA-UMC SERVER es el backend independiente que gobierna una célula de
micro-fábrica multi-robot HYDRA-UMC: un motor Node.js/Express + WebSocket
que posee el estado de los robots, lo persiste en disco, autentica cada
escritura y difunde actualizaciones en vivo a cada cliente conectado. Se
distribuye sin interfaz de usuario ni paso de build de frontend propios -
es un servicio puro de API + WebSocket, pensado para ejecutarse headless
(sin navegador, sin pantalla) en la máquina que está físicamente junto a
los robots (típicamente una Raspberry Pi CM5).

El segundo contrato está completo: escrituras condicionales (`If-Match` en órdenes y reservas, `GET /api/robot/:id`), la orden atómica `table`, un registro de auditoría solo-añadir (`GET /api/audit`, encadenado por hash, desactivable) y un mensaje `claims` por WebSocket. Las contraseñas de las cámaras ya no salen en la lista de procesos ni en el registro. Ver `docs/CONTRACT_V2.md`.

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

## 🧩 Papel en HYDRA-UMC

**HYDRA-UMC-SERVER** es el motor de la celda: un backend Node.js y Express sin interfaz que guarda el estado de los robots, lo persiste en disco, exige un rol a cada escritura y envía actualizaciones en vivo a todos los clientes por un único WebSocket. Todos los clientes (STUDIO, SUITE, las aplicaciones de móvil, la pantalla táctil, el reloj, la herramienta de línea de órdenes) pasan por él, y solo él decide quién puede mover qué robot y hasta dónde.

## 🏛️ Arquitectura

<p align="center">
  <img src="images/architecture.svg" alt="HYDRA-UMC-SERVER architecture" width="100%">
</p>

### Por Qué Existe

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

## ✨ Funciones

### Datos y Persistencia

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
- `data/totp.json` - el segundo factor de las cuentas que lo activaron (opcional, desactivado en cada cuenta hasta que su dueño lo activa): cada secreto se cifra con AES-GCM bajo `HYDRA_UMC_TOTP_KEY` (o una clave derivada de `JWT_SECRET`) y los diez códigos de recuperación se guardan solo como hashes; el fichero no existe hasta que una cuenta activa el segundo paso.

## 🔒 Seguridad y protección

| Amenaza | Defensa | Dónde |
|---|---|---|
| Tokens firmados con una clave conocida | Con `NODE_ENV=production` el servidor se niega a arrancar con un `JWT_SECRET` vacío, de ejemplo o corto y sin administrador inicial; en desarrollo se usa un valor integrado y se imprime un aviso `[SECURITY]` | `src/auth.ts`, `src/secretsPolicy.ts` |
| Fuerza bruta en el inicio de sesión, o una avalancha de paradas | 5 inicios fallidos cada 15 minutos por dirección (`429`), 120 refrescos y 60 paradas globales por minuto, todo ajustable con `LOGIN_RATE_LIMIT_MAX`, `REFRESH_RATE_LIMIT_MAX` y `STOP_ALL_RATE_LIMIT_MAX`; las contraseñas usan scrypt con sal aleatoria, como mucho 4 a la vez y 20 en cola, así que una avalancha no puede ahogar el servidor | `src/auth.ts`, `src/users.ts` |
| Un token robado, o un token leído de la dirección | Los tokens de acceso caducan (`JWT_EXPIRES_IN`, 30 días por defecto, 24 h aconsejado fuera de una LAN de confianza) y se renuevan con un token de refresco rotatorio; el WebSocket recibe el token como subprotocolo `hydra.bearer` y rechaza `?token=` salvo que `HYDRA_UMC_WS_QUERY_TOKEN=allow` lo permita, con un aviso en cada arranque | `src/refresh_tokens.ts`, `src/ws.ts` |
| Dos clientes moviendo el mismo robot, o una orden que el robot no debería recibir | Un robot se reserva para una cuenta y ventana, las escrituras exigen `If-Match` (una revisión caducada recibe `412`), el rol de espectador no puede escribir, y el tamaño de un movimiento y la temperatura máxima de la cama caliente vienen de los límites de seguridad que fija un administrador; la parada global funciona digan lo que digan las reservas | `src/claimPolicy.ts`, `src/safetyLimits.ts`, `src/routes/commandRoutes.ts` |
| Imágenes de cámara abiertas a cualquiera en la red | Las emisiones en vivo, fotos y grabaciones necesitan un ticket firmado de 5 minutos (o un token de acceso); como mucho 8 cámaras; las contraseñas de cámara no aparecen en la lista de procesos ni en el registro; `HYDRA_UMC_CAMERA_AUTH=open` es la exclusión temporal | `src/mediaTickets.ts`, `src/serverPolicy.ts` |
| Peticiones enormes u hostiles, y acceso entre orígenes abierto | Los cuerpos JSON se limitan a 1 MB (50 MB solo en la ruta de subida grande); `CORS_ALLOWED_ORIGINS` es una lista permitida y, en producción, una lista sin definir deniega toda petición de navegador entre orígenes (desarrollo permite cualquier origen, con un aviso); `settings.json` y `users.json` nunca se sirven como ficheros | `src/server.ts` |
| Opciones de acceso débiles activadas: texto de voz, confianza del reconocedor, firma MAVLink, Bluetooth, MQTT, TLS | Cada una tiene un interruptor que un administrador edita con `PUT /api/admin/server-config` (solo admin), con un valor por defecto conservador y con el entorno por encima de lo guardado; la respuesta lista avisos como `voice_heard_text_on`, `voice_confidence_off`, `mavlink_unsigned_allowed` y `mavlink_signing_off`; el relé de voz sustituye cualquier `options` que envíe un cliente por las del administrador, y un fichero de clave MAVLink se comprueba (32 bytes o 64 caracteres hexadecimales) antes de guardar su ruta | `src/securityConfig.ts`, `src/routes/adminRoutes.ts`, `src/routes/assistantRoutes.ts` |
| Un registro manipulado de quién hizo qué | Un registro de auditoría de solo añadir cuyas entradas están encadenadas por hash (`GET /api/audit`, `?verify=1` comprueba la cadena), un registro del servidor que rota por tamaño y un paso de redacción que elimina secretos antes de escribir nada | `src/auditLog.ts`, `src/logRotation.ts`, `src/redaction.ts` |

**Lo que nunca hace:** actuar como función de seguridad certificada. Los límites y la parada son software en este proceso; todavía no hay detrás una vía de parada de emergencia en hardware, ni límites impuestos por firmware ni una placa controladora real.

## 🔌 Interfaces

### Superficie de API y WebSocket

Cada ruta, el contrato de mensajes WebSocket, la autenticación y el
modelo de acceso remoto por cliente están documentados en
**[`docs/REMOTE_API.md`](docs/REMOTE_API.md)** - la única fuente de
verdad para cualquier cosa que hable con este servidor, incluido el
propio código cliente de HYDRA-UMC STUDIO. En resumen:

- API REST bajo `/api/*` - lectura/escritura de settings, comandos
  atómicos de robot (jog/play/pause/stop/tool/valve/pump/speed/vision),
  gestión de cuentas, subida/descarga de archivos de trabajo, envío de
  modelos, métricas de sistema, descubrimiento.
- Un único endpoint WebSocket `/ws` (token bearer como subprotocolo `hydra.bearer`, un token en la query string se rechaza salvo que la instalación lo vuelva a permitir) que
  difunde snapshots completos `settings` y actualizaciones más ligeras
  `delta` a cada cliente conectado cuando cambia el estado.
- `POST /api/stop-all` es la parada global: una llamada, abierta a toda cuenta con sesión, detiene todos los robots y apaga todas las válvulas y bombas
  diga lo que diga cualquier reserva, y responde un resultado por robot.
- Bluetooth LE (apagado por defecto): un teléfono cerca de la CM5 puede leer el estado de los robots y, cuando un administrador lo permite, enviar órdenes que el servidor acusa solo después de que la misma ruta que usa un cliente de red haya respondido. Véase [`docs/BLE_GATT.md`](docs/BLE_GATT.md).
- Autenticación JWT por bearer token en cada escritura; tres roles de
  cuenta (`admin`, `operator`, `viewer` de solo lectura) filtran las escrituras de settings/gestión
  de usuarios frente a la operación diaria de robots y a la mera lectura.
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

### Monitorización (Opcional)

`GET /metrics` expone el uptime del proceso, los clientes WebSocket
conectados, la latencia de escritura de `settings.json`, los comandos
atómicos de robot por tipo, los fallos de autenticación, y las mismas
cifras de CPU/memoria/temperatura que `GET /api/system/metrics` - todo en
formato Prometheus. Un stack Prometheus + Grafana listo para usar (con un
dashboard inicial) vive en **[`monitoring/`](monitoring/README.md)**:
`docker compose up -d` desde esa carpeta y ya está en marcha. Totalmente
opcional - nada aquí es necesario para que el servidor en sí funcione.

| Topic o ruta | Qué lleva |
|---|---|
| `/api/login`, `/api/refresh`, `/api/logout` | iniciar sesión (con límite de ritmo), rotar el token de refresco, cerrar sesión |
| `/api/users`, `/api/users/:username` | listar, crear, cambiar y borrar cuentas (`admin`, `operator`, `viewer`); solo administradores |
| `/api/settings`, `/api/robot/:id`, `/api/robot/:id/command` | el árbol de estado y las órdenes atómicas tipadas (mover, reproducir, pausa, parada, herramienta, válvula, bomba, velocidad, visión, mesa), con `If-Match` |
| `/api/robot/:id/claim`, `/release`, `/jog-arm`, `/api/claims`, `/api/stop-all`, `/api/safety-limits` | reservas, armar el movimiento, quién tiene qué, la parada global y los límites de seguridad |
| `/api/admin/server-config`, `/clients`, `/logs`, `/restart`, `/safety-limits` | administración: los interruptores de acceso, las aplicaciones conectadas, el registro del servidor, un reinicio y los límites de seguridad; solo administradores |
| `/api/camera/*`, `/api/cameras/status` | flujos de cámara, instantáneas, grabaciones, PTZ y `POST /api/camera/ticket` |
| `/api/system/metrics`, `/api/system/supervisor`, `/api/ecosystem/status`, `/api/system/bluetooth/*` | información del equipo, el supervisor de procesos, el estado y control de los servicios del ecosistema, emparejamiento Bluetooth |
| `/api/voice/turn`, `/api/voice/confirm`, `/api/watch/system-status`, `/api/ai/*` | relés hacia el servicio de voz, el estado del reloj y los servicios de IA locales |
| `/ws` | un WebSocket: instantáneas completas de `settings`, actualizaciones ligeras `delta` y un mensaje `claims`; el token viaja como subprotocolo `hydra.bearer` |
| `GET /api/hydra-info`, `_hydra._tcp` | descubrimiento: la versión del contrato remoto (`remoteApiVersion` 2), la versión de la aplicación y el número de controladores y robots, anunciado por mDNS |
| `/admin`, `/dashboard-ai`, `/` | páginas estáticas opcionales, servidas solo cuando `build-frontend` las ha compilado junto a este repositorio: el panel de administración, DASHBOARD-AI y STUDIO |
| `/metrics` | texto Prometheus: tiempo activo, clientes WebSocket, latencia de escritura, órdenes por tipo, fallos de autenticación, cifras del equipo |

## ⚙️ Configuración

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
- `REFRESH_RATE_LIMIT_MAX` - presupuesto de peticiones de `POST /api/refresh` por ventana e IP (por defecto 120). Solo los inicios de sesión fallidos cuentan para el límite de login anterior.
- `TLS_CERT_PATH` / `TLS_KEY_PATH` - define **ambas** para cambiar el
  servidor (API REST + el WebSocket `/ws`, que comparte el mismo
  listener) de HTTP/WS plano a HTTPS/WSS. Ver "TLS / HTTPS" más abajo.
  Dejar cualquiera sin definir mantiene el comportamiento HTTP plano
  actual sin cambios.
- `HYDRA_UMC_CAMERA_AUTH` - las imágenes de las cámaras (streams en vivo, fotos y grabaciones guardadas) exigen **por defecto** un `?ticket=` de vida corta (`POST /api/camera/ticket` lo entrega a un cliente con sesión) o un token Bearer; `HYDRA_UMC_CAMERA_AUTH=open` es la salida temporal para clientes que aún no piden tickets.
- `HYDRA_UMC_WS_QUERY_TOKEN` - `/ws?token=` se **rechaza por defecto** (el token viaja como subprotocolo `hydra.bearer`); `HYDRA_UMC_WS_QUERY_TOKEN=allow` es la salida temporal para clientes que aún no migraron. El servidor avisa en cada arranque mientras haya una salida activa.
- `HYDRA_UMC_BLE_GATT` - el servicio Bluetooth LE: `off` (por defecto), `state` (los teléfonos leen el estado) o `commands` (y envían órdenes, cada una con el token de acceso de la cuenta). `HYDRA_UMC_BLE_ENCRYPTION=off` deja de exigir un enlace cifrado (se exige por defecto). Ambos se pueden fijar también desde la pantalla de administración del servidor; un cambio se aplica en el siguiente arranque. Necesita BlueZ, `python3-dbus` y `python3-gi` en el equipo.
- `HYDRA_UMC_MQTT_BRIDGE` - el puente al broker MQTT de la celda: `off` (por defecto), `state` (el estado de cada robot sale por topics retenidos) o `commands` (y un comando publicado en el topic de un robot se ejecuta por la misma ruta que usa un cliente de red, con el token de una cuenta dedicada que nombra `HYDRA_UMC_MQTT_COMMAND_USER`). La dirección, el prefijo de los topics y los nombres de usuario también se fijan desde la pantalla Server Admin; las contraseñas solo desde el entorno. Véase [`docs/MQTT_BRIDGE.md`](docs/MQTT_BRIDGE.md).
- `HYDRA_UMC_INFO_AUTH=required` - hace que la información de solo lectura del equipo (`/metrics`, `/api/system/metrics`, `/api/system/supervisor`, `/api/ecosystem/status`, `/api/models`) exija un cliente con sesión. Desactivado por defecto para que un cliente que aún no envía su token en esas rutas siga funcionando; un arranque en producción avisa mientras esté desactivado.
- `HYDRA_UMC_VOICE_UI_INCLUDE_HEARD_TEXT`, `HYDRA_UMC_VOICE_UI_MIN_CONFIDENCE`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_KEY_FILE`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_ALLOW_UNSIGNED` - las opciones de voz y de UAV que un administrador también puede fijar desde Server Admin (`voice` y `mavlink` en `data/server-config.json`): si una respuesta de voz repite lo dicho (`1` lo activa; apagado por defecto), la confianza mínima del reconocedor de voz (de 0 a 1, por defecto 0,6) para aceptar una petición que inicia un movimiento, y el fichero de clave de la firma MAVLink 2 y si se siguen aceptando mensajes sin firmar (por defecto sin firma y se rechazan los no firmados). El entorno gana sobre lo guardado, y entonces la pantalla muestra el valor como fijo.
- `HYDRA_UMC_AI_ACCESS=admin` - limita a los administradores el relé hacia los servicios de IA locales (`/api/ai/*`). Desactivado por defecto: cualquier usuario con sesión puede usarlo, como antes.
- `HYDRA_UMC_VISUAL_SERVOING_TOKEN`, `HYDRA_UMC_VLA_ENGINE_TOKEN`, `HYDRA_UMC_COGNITIVE_NODE_TOKEN`, `HYDRA_UMC_DETECTION_HEF_TOKEN`, `HYDRA_UMC_VISION_NODE_TOKEN` y `HYDRA_UMC_ANOMALY_TOKEN` (para el relay `/api/ai/*`), `HYDRA_UMC_VISION_STREAMER_TOKEN` (para las transmisiones de cámara) y `HYDRA_UMC_DATALAKE_READ_TOKEN`, o si no `HYDRA_UMC_DATALAKE_TOKEN` (para la telemetría) - el token Bearer que este servidor presenta a un servicio que lo pide; cada una lee también `..._FILE`, un fichero cuya primera línea es el token. Son los nombres que leen los propios servicios, así que un único fichero de entorno sirve a ambos, y ningún cliente los ve nunca. Un servicio sin token configurado se alcanza exactamente como antes. El relay rechaza además una sesión que no sea de administrador ni de operador, y solo un administrador puede cambiar la línea base del detector de anomalías (cualquier `POST` que no sea `/detect`); `vision-node` y `anomaly-detector` se suman al relay.
- `HYDRA_UMC_VOICE_UI_RESULT_KEY` (o `..._FILE`) - la clave con la que HYDRA-UMC-VOICE-UI firma un resultado de voz confirmado (16 caracteres o más, el mismo valor que tiene). `POST /api/voice/confirm` retransmite una confirmación con el usuario con sesión como sujeto y solo cree una respuesta `confirmed` si nombra a ese usuario y su firma se verifica; sin la clave la respuesta se pasa con `verified: false`, y `HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE=1` la rechaza en su lugar. Esta ruta no ejecuta nada.
- `HYDRA_UMC_TELEMETRY_COLLECTOR_URL` (con `HYDRA_UMC_TELEMETRY_COLLECTOR_TOKEN` o `..._FILE`, y `HYDRA_UMC_TELEMETRY_INTERVAL_MS`, de 100 a 60000, 1000 por defecto) - activa el productor de telemetría: los números de cada delta de robot que emite este servidor (posición, articulaciones, estado de reproducción) se envían a HYDRA-UMC-TELEMETRY-COLLECTOR como una muestra `robot_state` por robot, como máximo una por intervalo y fusionadas, de modo que el data lake tenga algo real que guardar. Desactivado si falta la dirección; nunca retrasa una orden, guarda una cantidad acotada de datos y se detiene 30 segundos tras un fallo.
- `/dashboard-ai` - si HYDRA-UMC-DASHBOARD-AI está descargado junto a este repositorio, `build-frontend` lo compila y este servidor lo sirve ahí. La página lee el data lake (`/api/ai/datalake/*`, solo lectura: `GET` de `/query`, `/aggregate`, `/stats`, `/stats/range`, `/series` y `/health`; cualquier otra cosa se rechaza) y el detector de anomalías (`/api/ai/anomaly-detector/*`) a través del relé, con la sesión de quien inició sesión en STUDIO en el mismo navegador, de modo que se aplican los roles y los tokens de servicio de este servidor. Con eso, el detector de anomalías puede arrancarse con `HYDRA_UMC_ANOMALY_PROTECT_READS=1`.
- `HYDRA_UMC_LOG_MAX_BYTES` y `HYDRA_UMC_LOG_KEEP` - el tamaño al que rota el registro del servidor (10 MB por defecto) y cuántos ficheros rotados se conservan (1 por defecto).
- `HYDRA_UMC_SETTINGS_STORE`, `HYDRA_UMC_SETTINGS_BACKUPS` y `HYDRA_UMC_SETTINGS_BACKUP_INTERVAL_S` - por defecto los ajustes (`settings.json` y los ficheros de puntos) se escriben como una unidad de todo o nada con un diario: una escritura interrumpida se termina o se descarta en el siguiente arranque, se guarda una copia de `settings.json` en `data/backups/` (10 copias, como máximo una cada 600 s) y un `settings.json` dañado se restaura desde la última copia buena. `HYDRA_UMC_SETTINGS_STORE=plain` vuelve a escribir los ficheros uno a uno; `HYDRA_UMC_SETTINGS_BACKUPS=0` desactiva las copias.
- El acceso al relé de IA, la exigencia de sesión de la información del equipo y TLS (rutas del certificado y de la clave, con la huella SHA-256 del certificado) también los puede cambiar un administrador desde la pantalla Administración del servidor de la app de control. Un valor definido en el entorno manda y se muestra bloqueado; la exigencia de sesión pide confirmación antes de desactivarse; TLS se aplica en el siguiente arranque.
- `STOP_ALL_RATE_LIMIT_MAX` / `STOP_ALL_RATE_LIMIT_WINDOW_MS` - presupuesto de la parada global (`POST /api/stop-all`) por dirección, separado del del inicio de sesión (por defecto 60 por minuto). En producción el servidor además se niega a arrancar con un `JWT_SECRET` o una contraseña de arranque de ejemplo de una plantilla de despliegue, un `JWT_SECRET` de menos de 32 caracteres o una contraseña de arranque de menos de 12.

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

Los interruptores de acceso de abajo son los que editan las pantallas Server Admin de STUDIO y SUITE. Cada uno se resuelve en el mismo orden: primero el entorno del despliegue (la pantalla lo muestra bloqueado), luego lo que el administrador guardó en `data/server-config.json` y por último el valor por defecto conservador. Las variables de arriba cubren todo lo demás.

| Variable | Por defecto | Qué fija |
|---|---|---|
| `aiAccess`, `HYDRA_UMC_AI_ACCESS` | `open` | quién puede usar el relé de IA local: `open` es cualquier cuenta con sesión, `admin` solo administradores |
| `infoAuth`, `HYDRA_UMC_INFO_AUTH` | desactivado | pedir inicio de sesión para la información de solo lectura del equipo (métricas, supervisor de procesos, estado del ecosistema) |
| `tls.enabled`, `TLS_CERT_PATH, TLS_KEY_PATH` | desactivado (HTTP sin cifrar) | HTTPS y WSS con el certificado y la clave que indiques; la pantalla muestra la huella del certificado en uso |
| `ble.mode`, `HYDRA_UMC_BLE_GATT` | `off` | Bluetooth LE para teléfonos cerca del servidor: `off`, `state` (solo publica el estado) o `commands` (también acepta órdenes); una palabra desconocida significa apagado |
| `ble.requireEncryption`, `HYDRA_UMC_BLE_ENCRYPTION` | activado | la característica de órdenes se escribe, y el estado se lee, solo por un enlace cifrado; solo `off` en la variable lo desactiva |
| `mqtt.mode`, `MQTT environment of the deployment` | `off` | el puente MQTT al broker de la celda: `off`, `state` o `commands`, con su URL, prefijo y usuarios |
| `voice.includeHeardText`, `HYDRA_UMC_VOICE_UI_INCLUDE_HEARD_TEXT` | desactivado | una respuesta de voz repite lo que se dijo; son datos personales, así que está apagado, y en la variable solo la palabra exacta `1` lo activa |
| `voice.minConfidence`, `HYDRA_UMC_VOICE_UI_MIN_CONFIDENCE` | `0.6` | la confianza mínima del reconocedor de voz, de 0 a 1, para aceptar una petición que inicia un movimiento; 0 desactiva la comprobación, una parada nunca se retiene, y un número erróneo en la variable se ignora |
| `mavlink.signingKeyFile`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_KEY_FILE` | vacío (sin firma) | firma MAVLink 2 del puente UAV: la ruta de un fichero con la clave de 32 bytes (32 bytes en bruto o 64 caracteres hexadecimales); solo se guarda la ruta, nunca la clave, y el puente la lee al arrancar |
| `mavlink.signingAllowUnsigned`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_ALLOW_UNSIGNED` | desactivado | seguir aceptando mensajes sin firmar (un vehículo que aún no firma); la pantalla avisa mientras está activo |

## 🚀 Inicio rápido

Requiere Node.js 22 o superior con npm. El servidor funciona sin configuración y con valores por defecto de desarrollo; fija las variables de la sección Configuración antes de que sea accesible fuera de una LAN de confianza.

```bash
npm install
./dev.sh                    # runs the server with tsx on port 3000, no frontend (dev.bat on Windows)
npm run test:unit           # the unit tests
npm test                    # unit tests, the OpenAPI check and the contract scripts against a live instance
npm run build && npm start  # one bundled file (build.sh and build.bat make a versioned release build)
```

El servidor escucha en `0.0.0.0:3000`; todo su estado vive en `data/`. Este repositorio no tiene Dockerfile a propósito: HYDRA-UMC-OS lo instala en la CM5 (`provisioning/install_server.sh`). La versión en ejecución se lee en `GET /api/hydra-info` (`appVersion`); solo los scripts `build*.sh` y `build*.bat` de la raíz hacen una compilación de versión, mientras que `npm run build` solo compila.

## 🧪 Pruebas

414 pruebas automáticas se ejecutan con `npm run test:unit`. Además, `npm test` ejecuta la comprobación de OpenAPI y 28 scripts de contrato de extremo a extremo en `tools/` contra una instancia real de este servidor (descubrimiento, inicio de sesión sin y con credenciales, arranque de producción, órdenes y propiedad de robots, tokens de refresco, relé de voz y sus rutas de error, reproducción, la parada global, puentes Bluetooth y MQTT, medios de cámara, los relés de IA y de connector-hub, rol de espectador y más); todos pasan. Ninguno necesita hardware.

El CI ejecuta `HYDRA_UMC_CI=1 python tools/ci_validate.py`, que comprueba el manifiesto, los documentos, los ocho README y las imágenes.

## 🏗️ Compilación y publicación

### Requisitos

- [Node.js](https://nodejs.org/) (v18 o superior recomendado)
- npm

### Instalación

```bash
npm install
```

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

Este repositorio no tiene Dockerfile a propósito: el servidor lo empaqueta e instala en la CM5 [HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS) (`provisioning/install_server.sh`).

## 🩺 Resolución de problemas

| Ves | Porque | Haz |
|---|---|---|
| El servidor se detiene al arrancar en producción | `NODE_ENV=production` exige un `JWT_SECRET` real (al menos 32 caracteres, no de ejemplo) y un administrador inicial en el primer arranque | Define `JWT_SECRET`, `HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME` y `HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD` (véase `docs/PRODUCTION_BOOTSTRAP.md`) |
| `429` al iniciar sesión | Más de 5 inicios fallidos desde una dirección en 15 minutos | Espera a que pase la ventana; sube `LOGIN_RATE_LIMIT_MAX` solo en una red de confianza |
| La aplicación del navegador se bloquea por CORS | En producción, un `CORS_ALLOWED_ORIGINS` sin definir deniega toda petición de navegador entre orígenes (curl, SUITE y las aplicaciones de móvil no se ven afectados) | Define `CORS_ALLOWED_ORIGINS=https://studio.example.com,...` con los orígenes de la página |
| El WebSocket se cierra enseguida, o una imagen de cámara no carga | El cliente envía el token en la dirección (`/ws?token=`, rechazado por defecto) o abre la imagen sin ticket (obligatorio por defecto) | Usa el subprotocolo `hydra.bearer` y `POST /api/camera/ticket`; las exclusiones `HYDRA_UMC_WS_QUERY_TOKEN=allow` y `HYDRA_UMC_CAMERA_AUTH=open` son temporales |
| Un interruptor de acceso se rechaza porque está bloqueado, o se rechaza un fichero de clave MAVLink | El valor lo fija una variable de entorno (gana sobre el guardado), o el fichero de clave no se puede leer o no tiene 32 bytes ni 64 caracteres hexadecimales | Cambia o quita la variable y reinicia, o corrige el fichero; el puente MAVLink lee sus opciones al arrancar |

## 📂 Estructura del repositorio

<p align="center">
  <img src="images/repository-structure.svg" alt="Repository structure of HYDRA-UMC-SERVER" width="100%">
</p>

<details>
<summary>Versión en texto del árbol</summary>

```text
HYDRA-UMC-SERVER/
├── src/                       código fuente
│   ├── server.ts              Arranque delgado que une los módulos de abajo; las rutas /api están en src/routes/, las conexiones en vivo en ws.ts, los archivos de ajustes en settingsStore.ts
│   ├── kinematics.ts          Ayudante de cinemática inversa para el endpoint atómico de jog
│   ├── metrics.ts             Respalda GET /metrics - exposición Prometheus en texto (prom-client)
│   ├── ble/                   Servicio Bluetooth LE: tramas, pasarela (órdenes, acuses, estado) y transporte del ayudante
│   ├── users.ts               Almacén de cuentas (hash de contraseña scrypt)
│   ├── routes/                Las rutas /api por áreas: auth, ajustes, reservas de robot, órdenes, límites de seguridad, cámaras, Bluetooth, administración, sistema, relés a los servicios hermanos, IA local, asistente, ficheros de trabajo, energía, información y ficheros estáticos
│   ├── auth.ts                Verificación de tokens, la puerta de administrador y los limitadores de tasa; el almacén de tokens de refresco; lo que acepta producción como secreto de firma y primera contraseña; las opciones de acceso; los tokens que se presentan a los servicios retransmitidos
│   ├── claimPolicy.ts         Quién controla qué robot; las ediciones que un operador hace sobre un robot; los límites a los que se sujeta todo cliente; el movimiento de la mesa XY en una petición; la reproducción autoritativa del servidor
│   ├── settingsStore.ts       Los ficheros de ajustes en disco, sus copias de seguridad, escrituras de todo o nada de varios ficheros, el registro de auditoría y la rotación de logs
│   ├── ws.ts                  El centro de conexiones en vivo (WebSocket), el puente MQTT al broker de la celda y su arranque, y el primer productor de telemetría
│   ├── cameraHealth.ts        Si un flujo de cámara entrega fotogramas de verdad, sondeo de cámaras IP y PTZ, el supervisor de procesos de flujo y tickets de vida corta para las imágenes de cámara
│   └── ecosystemStatus.ts     Descubrimiento y vida del ecosistema, el registro de puertos de servicios, métricas del equipo, el entorno de ejecución del proceso (mDNS, puerto), utilidades de política puras, ocultación de secretos, utilidades de emparejamiento Bluetooth, las direcciones de los servicios relayados y la confirmación de una petición hablada
├── admin-ui/                  Panel de administración Vite/React independiente para ESTE servidor
├── data/                      Estado en ejecución - settings, users, logs, archivos de trabajo, puntos guardados
├── docs/                      documentos del proyecto
├── images/                    Medios y diagramas
├── systemd/                   unidad de servicio
├── tools/                     herramientas del proyecto y comprobaciones del CI
├── tests/                     pruebas automáticas
├── monitoring/                Stack opcional Prometheus + Grafana - ver monitoring/README.md
├── scripts/                   el ayudante Bluetooth LE (BlueZ) y un ayudante de versiones heredado
├── .github/                   flujo de CI y plantillas de incidencias
├── bump_manifest_version.py   Sincroniza la versión de hydra-umc.project.json con la nativa (--sync)
├── build.bat / build.sh       Instala dependencias + build de producción
├── dev.bat / dev.sh           Instala dependencias + arranca el servidor de desarrollo
├── package.json               metadatos y scripts del paquete
├── tsconfig.json              configuración de TypeScript
├── CHANGELOG.md               qué cambió en cada versión
├── LICENSE
├── build-test.sh              comprobación de compilación sin cambios
├── hydra-umc.project.json     manifiesto: versión, madurez, familia
└── test.sh                    ejecuta las pruebas
```

</details>

## 🗺️ Hoja de ruta y límites conocidos

**Límites conocidos hoy**

* El enlace con una CM5 real con una placa STM32H745 (`spi_bridge`) es código real que solo se ha ejercitado por la capa de API y de contratos; nunca hubo una placa física para cerrar el último salto.
* El servidor escucha en todas las interfaces (`0.0.0.0`); todavía no hay interruptor para la dirección de escucha, así que un cortafuegos o los interruptores de acceso de arriba son lo que limita la exposición.
* En desarrollo (`NODE_ENV` distinto de `production`) se usan una clave de firma integrada, la cuenta `admin`/`admin` y una política CORS abierta, cada una con aviso; producción las rechaza.
* TLS, Bluetooth LE y el puente MQTT son opcionales y están apagados por defecto.

**Siguiente:** cada ruta nueva sigue la misma lista de comprobación (documentada en `docs/REMOTE_API.md`, nombrada en `docs/openapi.json`, tipada en los clientes del SDK).

## 🌍 Idiomas

Este README y los documentos del repositorio existen en ocho idiomas: inglés, español, alemán, francés, italiano, japonés, chino y portugués (Portugal). Se escriben a la vez y el CI comprueba que los ocho ficheros tengan las mismas secciones y los mismos enlaces. Este repositorio no tiene pantalla ni catálogo de mensajes propios, así que no hay cadenas de interfaz que traducir.

## 🔗 Proyectos relacionados

Este proyecto es parte del ecosistema de robótica HYDRA-UMC del mismo autor (JuanenRac / Electro Hobby 3D). Vale la pena conocerlo, ya que una petición podría en realidad ser sobre alguno de estos en vez de sobre este repositorio.

**Proyectos Hijos** — cada uno de estos es un cliente real o un puente de coordinación que solo habla con la flota de robots a través de la API de este servidor
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — panel de control web con visualización 3D multi-robot en tiempo real.
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — centro de mando de enjambre de escritorio (PySide6) para varios servidores a la vez, empaquetado como ejecutable independiente.
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — app nativa de control para Android con inicio de sesión biométrico y un compañero Wear OS emparejado.
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — app de control para iOS/iPadOS (Flutter) con sincronización en tiempo real por WebSocket.
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — interfaz táctil nativa para la pantalla táctil DSI de 7" a bordo, embebida en el propio CM5.
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — barrera de coordinación para flotas AGV/AMR mediante un publicador MQTT VDA 5050 (probado solo contra una flota emulada).
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — coordinador de alto nivel para celdas CNC con acceso a estado/bytes de control GRBL (probado solo contra un emulador).
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — barrera de coordinación para droides con patas/humanoides, con un emisor de comandos para Boston Dynamics Spot (probado solo contra un emulador).
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — coordinador de celdas láser que lee 3 señales GPIO de llave/carcasa/enclavamiento (probado solo contra un chip simulado; no puede armar ni disparar un láser).
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — coordinador de alto nivel seguro para el flujo de placas de pick-and-place OpenPnP.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — barrera de coordinación segura para impresoras 3D Moonraker/Klipper, con comandos de trabajo reales y controlados.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — coordinador con un transporte ROS 2 rclpy importado de forma perezosa (todavía no ejecutado contra una instalación de ROS 2).
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — barrera de coordinación para UAV equipados con cámara, con un emisor de comandos MAVLink (probado solo contra un emulador).

**Directamente Relacionados**
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — este servidor retransmite turnos de voz autenticados y acotados hacia él por conexión loopback, conservando el token de la puerta de enlace en el servidor para que la voz nunca se convierta en un comando de robot directo.
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — el diseño de la placa madre del brazo robótico (todavía sin placa poblada); el propio servicio `spi_bridge` de este servidor está pensado para hablar con ella por el enlace SPI-OTA CM5↔STM32H745 (probado solo con dobles de prueba).

**También Forma Parte del Ecosistema**

*Hardware y Plataforma Base*
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — capa de producto reproducible sobre Raspberry Pi OS para el CM5 en el que corre este servidor: agente de solo lectura, config/perfiles validados, aprovisionamiento WiFi de primer contacto.
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — el contrato JSON-Schema compartido y la barrera de software de puerta de trabajos contra la que cada bridge valida sus comandos (no es una función de seguridad certificada).
- **[HYDRA-UMC-CONNECTOR-HUB](https://github.com/JuanenRac/HYDRA-UMC-CONNECTOR-HUB)** — registro declarativo y validador de manifiestos de adaptador para conectores de máquinas externas; extiende la propia idea de contrato del SDK a máquinas externas sin sustituir a los proyectos de pasarela industrial.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — creador/editor gráfico de URDF de escritorio que envía los modelos terminados al propio catálogo de este servidor.
- **[HYDRA-UMC-EDITOR-STL](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-STL)** — editor de escritorio de modelos STL, que transforma/reemplaza/quita/añade piezas reales en el mismo catálogo de modelos que también edita HYDRA-UMC-EDITOR-URDF.

*Plataforma de Herramientas URTC*
- **[URTC](https://github.com/JuanenRac/URTC)** — firmware para la placa física del Universal Robot Tool Controller, más de 25 perfiles de herramienta por bus CAN.
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — herramienta de escritorio con GUI para flashear placas URTC, CAN-OTA más SWD/JTAG de chip completo.
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — herramienta de escritorio de diagnóstico CAN-bus en vivo para placas URTC, un panel por perfil de herramienta.
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — alternativa basada en navegador a URTC-TESTER mediante la Web Serial API, sin instalación local.
- **[URTC-GATEWAY](https://github.com/JuanenRac/URTC-GATEWAY)** — pasarela delante del bus CAN de URTC: lista de identificadores permitidos, límite de tasa y clave de sesión; software probado en ordenador, aún no en un bus real.

*Nodo IA de Visión (Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — nodo de integración para el pipeline de visión Hailo-8, con una comprobación real de disponibilidad de hardware por etapa.
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — registro real de modelos compilados con verificación de carga segura por arquitectura Hailo/checksum.
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — generador real de pipeline GStreamer + config MediaMTX, con una frontera de integración HailoRT real.
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — ley de corrección Position-Based Visual Servoing con autorización condicionada al estado de zona; todavía sin estimación de pose por cámara.
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — lógica v0 de invasión de zona, vigencia de calibración y solicitud de E-STOP que toma las posiciones de los objetos de un fichero; ningún detector la alimenta y todavía no hay un E-STOP físico conectado.

*Nodo IA Cognitivo (Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** — nodo de integración para el pipeline cognitivo Hailo-10 (orquestación de LLM/VLA/voz).
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** — codificación/decodificación real de tokens de acción y generación de trayectoria para un modelo Vision-Language-Action.
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** — descomposición real de tareas basada en reglas y recuperación semántica de errores sobre códigos de error del MCU.
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** — búsqueda real de documentos TF-IDF (solo librería estándar) sobre los propios documentos Markdown de este ecosistema.
- **[HYDRA-UMC-LOCAL-TECHNICIAN](https://github.com/JuanenRac/HYDRA-UMC-LOCAL-TECHNICIAN)** — técnico de mantenimiento con IA local y con puertas de política para el propio ecosistema - observa, diagnostica y propone arreglos; los dos niveles de riesgo más altos están deliberadamente sin implementar todavía.

*Orquestación y Enjambre*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — nodo de integración con un contrato real de informe de salud gRPC/Protobuf y una máquina de estados de misión.
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** — cola de trabajos real basada en prioridad con deduplicación, sobre una API HTTP real.
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — watchdog de salud de flota real basado en gRPC, con reintento/backoff y detección de discrepancia de identidad.
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** — planificador de rutas 3D real basado en RRT, con validación real de colisión de obstáculos/espacio de trabajo.
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** — sincronización de estado real mediante CRDT LWW-Element-Map, con pruebas de propiedades para convergencia multi-celda.

*Gemelo Digital y Simulación*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** — nodo de integración para el motor de gemelo digital, con un contrato real de sincronización por compatibilidad de versión.
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — enrutador hardware-in-the-loop con un enclavamiento de software por colisión entre simulación y hardware real (probado sin hardware real).
- **[HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)** — cinemática directa real y validación de límites articulares sobre un subconjunto real de URDF.
- **[HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)** — generador real de escenas 2D procedurales con exportación de anotaciones YOLO/COCO.

*Datos y Analítica*
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** — almacén de series temporales real respaldado por sqlite3, con una API HTTP real de ingesta/consulta.
- **[HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)** — detector de anomalías real basado en FFT + línea base estadística, con monitorización de deriva.
- **[HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)** — cálculo real de OEE/disponibilidad sobre el histórico de DATALAKE, con exportación CSV reproducible.
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** — pipeline real de ingesta CAN/WebSocket hacia DATALAKE, con deduplicación por secuencia.

*Pasarela Industrial*
- **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** — nodo de integración que retransmite a protocolos industriales, con una capa real de lista blanca de comandos/contrapresión.
- **[HYDRA-UMC-OPCUA-SERVER](https://github.com/JuanenRac/HYDRA-UMC-OPCUA-SERVER)** — espacio de direcciones OPC-UA real, verificado con una sesión de cliente real del protocolo binario.
- **[HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)** — broker MQTT real con autenticación por cliente opcional y ACL de tópicos.
- **[HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)** — endpoints XML reales `/probe` y `/current` de MTConnect, con salida en modo degradado.

*Herramientas Complementarias y Operaciones del Ecosistema*
- **[HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)** — paneles de Resúmenes Inteligentes y Resaltado de Anomalías sobre DATALAKE/ANOMALY-DETECTOR, con un respaldo estadístico honesto.
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** — CLI de flota con un contrato real y estable de códigos de salida, cliente real y en vivo de la propia API de este servidor.
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — app compañera de WearOS con patrones de alerta háptica y un relé de voz al teléfono emparejado (todavía no ejecutada en un reloj físico).
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** — firmware para un rack de montaje de placas con decodificación real de ID de herramienta y lógica de precalentamiento Smart Idle.
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** — firmware más un compañero de visión real en Python para un cabezal de inspección térmica/RGB.
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** — herramienta administrativa de escritorio que descubre, clona y actualiza cada repositorio de este ecosistema.
- **[HYDRA-UMC-OS-REBUILDER](https://github.com/JuanenRac/HYDRA-UMC-OS-REBUILDER)** — herramienta de escritorio Windows/Linux que construye una imagen de la CM5 lista para grabar, precargada con las versiones más actuales del ecosistema, con configuración de primer arranque de Wi-Fi/usuario/SSH al estilo de Raspberry Pi Imager.
- **[HYDRA-UMC-OPS-AGENT](https://github.com/JuanenRac/HYDRA-UMC-OPS-AGENT)** — coordinador de incidencias de mantenimiento: un rol edge de bajo privilegio recopila un snapshot de inventario/salud saneado, un rol control-plane lo renderiza de solo lectura y pide a un proveedor de IA que sugiera un diagnóstico - nunca aplica un parche ni despliega nada.
- **[HYDRA-UMC-DEV-SERVER](https://github.com/JuanenRac/HYDRA-UMC-DEV-SERVER)** — host de desarrollo reproducible (Raspberry Pi 5 / CM5) que almacena el código del ecosistema y ejecuta tareas acotadas de compilación/pruebas bajo una cola duradera; un rol de desarrollo dedicado, explícitamente distinto de un CM5 operativo.

## 📚 Documentación

Dónde leer más:

* [Base de seguridad del ecosistema](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md)
* [Modelo de amenazas del ecosistema](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md)
* [Historial de cambios de este repositorio](CHANGELOG.md)
* [Licencia de este repositorio](LICENSE.md)

## 🤝 Contribuir y comunidad

* Antes de un pull request ejecuta `HYDRA_UMC_CI=1 py -3 tools/ci_validate.py` (o `HYDRA_UMC_CI=1 python3 tools/ci_validate.py`): debe imprimir `CI_VALIDATION=PASS`. No ejecutes `build.sh` ni `build.bat` para esta comprobación; compilar no es comprobar.
* Los ocho README se escriben desde una sola fuente en HYDRA-UMC-DOCS; no los edites a mano. Cambia la fuente y vuelve a escribirlos con `tools/make_readmes.py`.
* No afirmes en un README lo que no se ha ejecutado: di «simulado» o «sin probar en hardware» cuando esa sea la verdad.
* Mira [CONTRIBUTING.md](CONTRIBUTING.md), el [código de conducta](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md) y [SUPPORT.md](SUPPORT.md).

## 👤 AUTOR

**JuanenRac (Electro Hobby 3D)** · electrohobby3d@gmail.com

## 📜 LICENCIA

GPL-3.0-or-later - [LICENSE](LICENSE).
