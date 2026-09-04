<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-SERVER banner" width="100%">
</p>
# 🛰️ HYDRA-UMC SERVER

<p align="center">
  <a href="README.md">🇺🇸 English</a> |
  <a href="README_spa.md">🇪🇸 Español</a> |
  <a href="README_fra.md">🇫🇷 Français</a> |
  🇮🇹 <b>Italiano</b> |
  <a href="README_deu.md">🇩🇪 Deutsch</a> |
  <a href="README_zho.md">🇨🇳 简体中文</a> |
  <a href="README_jpn.md">🇯🇵 日本語</a>
</p>


### 🤖 Backend headless API/WebSocket per la Micro-Fabbrica Multi-Robot HYDRA-UMC

<p align="left">
  <img src="https://img.shields.io/badge/Licenza-GPL%203.0-blue.svg" alt="GPL 3.0">
  <img src="https://img.shields.io/badge/Runtime-Node.js-339933.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/Framework-Express-000000.svg" alt="Express">
</p>


---

## 🎯 Panoramica

HYDRA-UMC SERVER è il backend indipendente che governa una cella di
micro-fabbrica multi-robot HYDRA-UMC: un motore Node.js/Express +
WebSocket che possiede lo stato dei robot, lo persiste su disco, autentica
ogni scrittura e trasmette aggiornamenti in tempo reale a ogni client
connesso. Viene distribuito senza interfaccia utente né passo di build del
frontend propri - è un servizio puro di API + WebSocket, pensato per
funzionare headless (senza browser, senza schermo) sulla macchina
fisicamente accanto ai robot (tipicamente un Raspberry Pi CM5).

Può anche, opzionalmente, servire il frontend già compilato di
**[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** come
file statici, per il tipico deployment "tutto su una macchina, un'unica
origine" - esegui **`build-frontend.sh`/`.bat`** una volta (compila
STUDIO da un checkout gemello e copia il risultato nel proprio `public/`
di questo repo, ignorato da git) e questo server inizierà a servirlo su
`/` al successivo avvio. Questo è ciò che permette a
HYDRA-UMC-ANDROID-CONTROL, HYDRA-UMC-IOS-CONTROL e HYDRA-UMC-DSI di
incorporare il vero visualizzatore 3D di STUDIO nella propria WebView
interna, puntando allo stesso ip:porta di questo server. Del tutto
opzionale: senza eseguire quello script, questo server resta headless
esattamente come descritto sopra - `public/` semplicemente non esisterà,
e tutte le rotte continuano a funzionare allo stesso modo.

Lo stesso `build-frontend.sh`/`.bat` compila anche il proprio
**[`admin-ui/`](admin-ui/README.md)** di questo repository - un piccolo
pannello separato per amministrare questo SERVER stesso (dispositivi
connessi, il proprio file di log, la propria porta/nome, i propri account
utente), servito su `/admin`. Questo NON è il controllo dei robot (che
resta esclusivo di STUDIO) - un'eccezione puntuale ed esplicita al design
headless di sopra, non un passo indietro.

Questo progetto faceva parte di **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)**,
distribuito come un "monolite ibrido": un unico processo Node.js che
eseguiva sia il motore di controllo robot *sia* il pannello web
Vite/React (con il middleware di sviluppo di Vite collegato direttamente
alla stessa app Express). Quel processo è stato diviso in due:

- **HYDRA-UMC SERVER** *(questo repository)* - il motore: stato di
  robot/controller, API REST + WebSocket, autenticazione, discovery mDNS,
  invio modelli. Nessuna UI, nessun bundler, nessun passaggio di build
  frontend.
- **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** - ora
  un client Vite/React puro che comunica con questo server via rete,
  esattamente come ogni altro client di questa API.

## 🧩 Perché Esiste

Separare il motore dal pannello web è stato un cambiamento deliberato,
non un refactoring fine a se stesso:

- **Isolamento delle risorse.** Una vista 3D pesante che blocca la scheda
  del browser non condivide più il processo (e quindi la contesa di
  CPU/I-O) con il codice realmente responsabile del movimento dei robot.
  Se la UI web si blocca, questo server continua a rispondere ai comandi
  di arresto di emergenza da qualsiasi altro client connesso.
- **Un vero controller headless.** Questo processo può funzionare senza
  alcuna UI mai caricata sull'host - il "cervello" di una cella
  industriale non ha bisogno di una scheda del browser aperta per
  funzionare. Libera RAM/CPU su hardware limitato (un Raspberry Pi CM5)
  per la parte del lavoro che conta davvero: cinematica e controllo.
- **Cicli di vita indipendenti.** La UI web può essere ridistribuita,
  riavviata o sostituita con una build più recente senza mai toccare
  questo processo - nessun fermo del controllo robot solo per rilasciare
  una correzione UI.
- **Hosting flessibile.** Questo server è pensato per funzionare sull'(o
  accanto all')hardware che controlla; il client che lo visualizza può
  essere ospitato altrove, raggiungibile via rete esattamente come gli
  altri client remoti di questa stessa API.

## 🔌 Superficie API e WebSocket

Ogni rotta, il contratto dei messaggi WebSocket, l'autenticazione e il
modello di accesso remoto per client sono documentati in
**[`docs/REMOTE_API.md`](docs/REMOTE_API.md)** - l'unica fonte di verità
per qualsiasi cosa comunichi con questo server, incluso il codice client
di HYDRA-UMC STUDIO stesso. In breve:

- API REST sotto `/api/*` - lettura/scrittura settings, comandi atomici
  robot (jog/play/pause/stop/tool/valve/pump/speed/vision), gestione
  account, upload/download file di lavoro, invio modelli, metriche di
  sistema, discovery.
- Un singolo endpoint WebSocket `/ws` (token bearer nella query string)
  che trasmette snapshot completi `settings` e aggiornamenti più leggeri
  `delta` a ogni client connesso quando lo stato cambia.
- Autenticazione JWT a bearer token su ogni scrittura; due ruoli account
  (`admin`, `operator`) filtrano le scritture di settings/gestione utenti
  rispetto all'operatività quotidiana dei robot.
- Annuncio mDNS/Bonjour `_hydra._tcp` per la discovery zero-config sulla
  rete locale, più un semplice `GET /api/hydra-info` per una scansione di
  sottorete.
- `GET /metrics` - formato di esposizione Prometheus (`prom-client`), per
  la dashboard Grafana opzionale descritta in "📊 Monitoraggio" più sotto.

CORS è abilitato tramite una allowlist configurabile
(`CORS_ALLOWED_ORIGINS`, vedi "Variabili d'Ambiente" più sotto) poiché i
client di questo server non condividono più necessariamente la sua stessa
origine. Se non configurata, resta completamente aperto fuori da
`NODE_ENV=production` (comportamento attuale senza configurazione per lo
sviluppo locale); in produzione nega ogni richiesta cross-origin del
browser finché l'allowlist non viene impostata - vedere il commento sopra
`app.use(cors(corsOptions))` in `src/server.ts` per il ragionamento
completo.

## 💾 Dati e Persistenza

Tutto ciò che questo server possiede vive sotto `data/`, creata
automaticamente al primo avvio:

- `data/settings.json` - l'intero albero di stato: controller, robot,
  configurazione di sistema. Mai servito come file statico (404
  esplicito) - raggiungibile solo tramite la rotta autenticata
  `/api/settings`.
- `data/users.json` - credenziali account (hash scrypt, con salt, mai in
  chiaro). Anch'esso mai servito staticamente.
- `data/logs/server.log` - log industriale append-only di ogni comando.
- `data/WORKS/` - traiettorie robot salvate, una cartella per robot per
  default, servite come semplici file statici (indice + singoli file di
  lavoro).
- `data/model_submissions.json` + le cartelle dei modelli inviati stesse
  - il lato server del flusso di
  [HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)
  per "inviare un modello robot finito direttamente nel catalogo di
  questo server".

## 📂 Struttura del Repository

```
HYDRA-UMC-SERVER/
├── src/
│   ├── server.ts       # App Express + WebSocketServer + tutte le rotte /api
│   ├── kinematics.ts   # Helper di cinematica inversa per l'endpoint atomico di jog
│   ├── metrics.ts      # Alimenta GET /metrics - esposizione testuale Prometheus (prom-client)
│   └── users.ts        # Archivio account (hash password scrypt)
├── admin-ui/            # Pannello di amministrazione Vite/React separato per QUESTO server
│   │                      (dispositivi connessi, il proprio file di log, la propria config, i
│   │                      propri utenti - deliberatamente non controllo robot, resta solo STUDIO)
│   ├── src/
│   │   ├── App.tsx, main.tsx, index.css, api.ts, LoginScreen.tsx
│   │   └── tabs/AboutTab.tsx, ConfigTab.tsx, DevicesTab.tsx, LogsTab.tsx, UsersTab.tsx
│   ├── package.json / tsconfig.json / vite.config.ts
│   └── README.md
├── data/                # Stato a runtime - settings, users, log, file di lavoro, punti salvati
│   ├── settings.json
│   ├── users.json
│   ├── logs/
│   ├── points/
│   └── WORKS/
├── docs/
│   ├── REMOTE_API.md              # Contratto completo: rotte, protocollo WS, auth
│   ├── PRODUCTION_BOOTSTRAP.md    # JWT e amministratore iniziale obbligatori
│   └── REMOTE_ACCESS_VPN.md       # Guida reale al deployment di accesso remoto/VPN
├── images/               # Media e diagrammi
├── systemd/
│   └── hydra-umc-server.service # Unità systemd locale sulla CM5
├── tools/
│   ├── ci_validate.py                                   # Validazione manifest/CHANGELOG/docs usata dalla CI
│   └── verify_*_contract.mjs, verify_auth_negative.mjs  # 11 verifiche reali di contratto/auth negativa
│                                                           contro un server reale (relay CAN-OTA, discovery,
│                                                           controllo/stato dei servizi dell'ecosistema,
│                                                           test-connection delle integrazioni, bootstrap di
│                                                           produzione, comandi robot, playback, relay di
│                                                           telemetria, relay vocale)
├── monitoring/           # Stack opzionale Prometheus + Grafana - vedi monitoring/README.md
├── scripts/
│   └── bump-version.mjs # Helper nativo legacy; le build standard usano bump_manifest_version.py
├── bump_manifest_version.py # Sincronizza la versione di hydra-umc.project.json con quella nativa (--sync)
├── build.bat / build.sh # Installa dipendenze + build di produzione
├── dev.bat / dev.sh      # Installa dipendenze + avvia il server di sviluppo
├── package.json
├── tsconfig.json
├── CHANGELOG.md
└── LICENSE
```

`public/` (il frontend statico compilato di STUDIO, distribuito insieme a
questo server su `/`) è in gitignore - viene popolato copiando l'output di
build di STUDIO, non fa parte di un clone appena effettuato.

## 🛠️ Ambiente di Sviluppo

### Requisiti
- [Node.js](https://nodejs.org/) (v18 o superiore consigliato)
- npm

### Installazione

```bash
npm install
```

### Variabili d'Ambiente

Opzionale - il server funziona senza alcuna configurazione, usando valori
di sviluppo integrati per ogni variabile qui sotto. Imposta valori reali
prima di esporre questo server oltre una LAN completamente affidabile -
per esempio su internet aperto tramite il NAT/port-forward del router,
il che cambia il modello di minaccia da "solo LAN affidabile" a
"raggiungibile da chiunque" (vedi `.env.example`):

- `JWT_SECRET` - firma ogni token di login. Se non impostata, viene usato
  un valore di sviluppo fisso incluso in `src/server.ts` (va bene per lo
  sviluppo locale, non per un deployment raggiungibile fuori da una rete
  affidabile). Esportala dalla tua shell, oppure tramite il tuo process
  manager/container preferito (`Environment=` di systemd, la
  configurazione d'ambiente di `pm2`, `-e` di Docker...).
- `NODE_ENV` - imposta `production` per qualsiasi deployment reale.
  Controlla i due fallback qui sotto (CORS aperto, valori di default
  silenziosi) e attiva avvisi di avvio ben visibili se `JWT_SECRET` o
  l'account seedato `admin`/`admin` sono ancora ai loro valori di
  default. Non impostata (o qualsiasi altro valore) mantiene il
  comportamento permissivo di sviluppo attuale.
- `CORS_ALLOWED_ORIGINS` - lista separata da virgole di origini
  autorizzate a fare richieste cross-origin del browser verso questa API
  - il caso reale che conta qui è HYDRA-UMC STUDIO servito da un
  host/porta diversi da questo server (es. `https://studio.example.com`,
  o `http://192.168.1.20:5173` in sviluppo). Esempio:
  `CORS_ALLOWED_ORIGINS=https://studio.example.com,http://192.168.1.20:5173`.
  Se non impostata: `NODE_ENV != production` permette qualsiasi origine
  (nessuna configurazione necessaria per lo sviluppo locale, corrisponde
  al comportamento storico di questo progetto); `NODE_ENV = production`
  invece **nega** ogni richiesta cross-origin del browser finché questa
  non viene impostata, con un avviso di avvio ben visibile. I client
  non-browser (curl, HYDRA-UMC SUITE, le app mobili) non sono mai
  interessati in nessuno dei due casi - CORS è un meccanismo esclusivo
  del browser.
- `JWT_EXPIRES_IN` - per quanto tempo resta valido un token di login.
  Qualsiasi stringa accettata dall'opzione `expiresIn` propria di
  `jsonwebtoken` (`"24h"`, `"7d"`, un numero di secondi secco...). Default
  `30d` se non impostata (l'assunzione originale di questo progetto di
  LAN affidabile). **Un server raggiungibile oltre una LAN affidabile
  dovrebbe impostare questo valore molto più corto - `24h` è un buon
  punto di partenza** - un token di lunga durata trapelato non ha modo di
  essere revocato individualmente se non cambiando la password di
  quell'account.
- `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` - limita
  esclusivamente `POST /api/login` (le altre rotte non sono interessate).
  Default 5 tentativi ogni 15 minuti per IP se una delle due non è
  impostata; un limite raggiunto risponde `429` con un errore JSON
  chiaro, non un `500` generico.
- `TLS_CERT_PATH` / `TLS_KEY_PATH` - imposta **entrambe** per far passare
  il server (API REST + il WebSocket `/ws`, che condivide lo stesso
  listener) da HTTP/WS in chiaro a HTTPS/WSS. Vedi "TLS / HTTPS" più
  sotto. Lasciarne una qualsiasi non impostata mantiene il comportamento
  HTTP in chiaro attuale invariato.

### TLS / HTTPS

Disattivato per default - questo server ha sempre funzionato come HTTP/WS
in chiaro, e continua così a meno di attivazione esplicita. Imposta sia
`TLS_CERT_PATH` che `TLS_KEY_PATH` (vedi sopra) su un certificato PEM e la
sua chiave privata corrispondente, e il listener condiviso REST +
WebSocket passa a `https.createServer()` - `/ws` diventa automaticamente
WSS insieme ad esso, senza configurazione separata necessaria. Un percorso
di certificato/chiave impostato ma illeggibile o non valido fa fallire
l'avvio in modo visibile (un vero errore `fs`) invece di tornare
silenziosamente a HTTP in chiaro.

Questo conta soprattutto una volta che questo server è raggiungibile oltre
una LAN completamente affidabile (es. esposto tramite NAT/port-forward del
router per test da remoto) - HTTP in chiaro significa che ogni token
bearer, ogni comando robot, e il login stesso di admin/operatore
attraversano la rete in chiaro.

Ottenere un certificato:

- **Possiedi un dominio che punta a questo server** - usa
  [Let's Encrypt](https://letsencrypt.org/) (es. tramite
  [Certbot](https://certbot.eff.org/)) per un certificato reale, fidato
  dai browser, gratuito e rinnovabile automaticamente. Punta
  `TLS_CERT_PATH` / `TLS_KEY_PATH` al `fullchain.pem` / `privkey.pem`
  risultante.
- **Test locali, senza dominio** - un certificato autofirmato è
  sufficiente per esercitare il percorso di codice HTTPS/WSS (i browser e
  la maggior parte dei client HTTP avviseranno/richiederanno una fiducia
  manuale esplicita, il che è previsto e va bene per i test):
  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"
  ```
  Poi imposta `TLS_CERT_PATH=./cert.pem` e `TLS_KEY_PATH=./key.pem`.

### Modalità Sviluppo

Esegue il server API/WebSocket direttamente con `tsx` (nessun bundler,
nessun frontend coinvolto):
- **Windows:** doppio clic su `dev.bat` o `npm run dev`
- **Linux/Mac:** esegui `./dev.sh` o `npm run dev`

### Build di Produzione

Impacchetta il server in un unico file distribuibile con esbuild:
- **Windows:** usa `build.bat` per una build di rilascio versionata; usa `npm run build` solo per compilare.
- **Linux/Mac:** usa `./build.sh` per una build di rilascio versionata; usa `npm run build` solo per compilare.

Poi avvia il server di produzione con:
```bash
npm start
```

Il server ascolta su `0.0.0.0:3000` - raggiungibile su
`http://localhost:3000` o `http://<tuo-ip-locale>:3000` sulla rete
locale. Tutto lo stato persiste in `data/`.

### Versionamento

Solo gli script radice `build*.bat` e `build*.sh` creano un incremento di
versione di rilascio. Richiamano `bump_manifest_version.py` una sola volta,
tenendo sincronizzati `package.json`, `hydra-umc.project.json` e
[`CHANGELOG.md`](CHANGELOG.md) secondo la regola del contachilometri in base
10 (`0.0.9` -> `0.1.0`, mai `0.0.10`). `npm run build` compila
deliberatamente senza incrementare versioni; build dirette e validazione
`build-test` non possono quindi modificare solo `package.json`. La versione
in esecuzione è leggibile da `GET /api/hydra-info` (`appVersion`).

## 📊 Monitoraggio (Opzionale)

`GET /metrics` espone l'uptime del processo, i client WebSocket connessi,
la latenza di scrittura di `settings.json`, i comandi atomici robot per
tipo, i fallimenti di autenticazione, e le stesse cifre di CPU/memoria/
temperatura di `GET /api/system/metrics` - tutto in formato Prometheus.
Uno stack Prometheus + Grafana pronto all'uso (con una dashboard iniziale)
si trova in **[`monitoring/`](monitoring/README.md)**: `docker compose up
-d` da quella cartella ed è già attivo. Del tutto opzionale - nulla qui è
necessario perché il server stesso funzioni.

## 🔗 Progetti Correlati

Questo progetto fa parte dell'ecosistema robotico HYDRA-UMC dello stesso autore (JuanenRac / Electro Hobby 3D). Vale la pena conoscerlo, poiché una richiesta potrebbe in realtà riguardare uno di questi invece di questo repository.

**Progetti Figli** — ognuno di questi è un vero client o un ponte di coordinamento che comunica con la flotta di robot solo tramite l'API di questo server
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — dashboard di controllo web con visualizzazione 3D multi-robot in tempo reale.
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — centro di comando sciame desktop (PySide6) per più server contemporaneamente, pacchettizzato come eseguibile standalone.
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — app di controllo nativa per Android con login biometrico e un companion Wear OS abbinato.
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — app di controllo per iOS/iPadOS (Flutter) con sincronizzazione WebSocket in tempo reale.
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — interfaccia touch nativa per il touchscreen DSI da 7" a bordo, incorporata direttamente nel CM5.
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — barriera di coordinamento per flotte AGV/AMR tramite un publisher MQTT VDA 5050 reale.
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — coordinatore ad alto livello per celle CNC con accesso reale a stato/byte di controllo GRBL.
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — barriera di coordinamento per droidi con zampe/umanoidi, con un vero mittente di comandi per Boston Dynamics Spot.
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — coordinatore di sicurezza per celle laser che legge 3 salvaguardie GPIO reali di chiave/involucro/interblocco.
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — coordinatore ad alto livello sicuro per il flusso schede del pick-and-place OpenPnP.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — barriera di coordinamento sicura per stampanti 3D Moonraker/Klipper, con comandi di lavoro reali e controllati.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — coordinatore di sicurezza con un vero trasporto ROS 2 rclpy, importato in modo lazy.
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — barriera di coordinamento per UAV dotati di fotocamera, con un vero mittente di comandi MAVLink.

**Direttamente Correlati**
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — questo server inoltra turni vocali autenticati e limitati verso di esso tramite una connessione loopback, mantenendo il token del gateway lato server così la voce non diventa mai un comando robot diretto.
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — la scheda madre fisica del braccio robotico con cui parla il proprio servizio `spi_bridge` di questo server tramite il vero collegamento SPI-OTA CM5↔STM32H745.

**Fa Anche Parte dell'Ecosistema**

*Hardware e Piattaforma di Base*
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — livello prodotto riproducibile su Raspberry Pi OS per il CM5 su cui gira questo server: agente in sola lettura, config/profili validati, provisioning WiFi al primo contatto.
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — il contratto JSON-Schema condiviso e la barriera di sicurezza contro cui ogni bridge sopra valida i propri comandi.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — creatore/editor grafico desktop di URDF che invia i modelli finiti al catalogo di questo server.

*Piattaforma Strumenti URTC*
- **[URTC](https://github.com/JuanenRac/URTC)** — firmware per la scheda fisica dell'Universal Robot Tool Controller, oltre 25 profili utensile su bus CAN.
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — strumento desktop con GUI per il flashing delle schede URTC, CAN-OTA più SWD/JTAG a chip intero.
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — strumento desktop di diagnostica CAN-bus dal vivo per schede URTC, un pannello per profilo utensile.
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — alternativa basata su browser a URTC-TESTER tramite la Web Serial API, senza installazione locale.

*Nodo IA Visione (Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — hub di integrazione per la pipeline di visione Hailo-8, con un vero controllo di prontezza hardware per fase.
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — registro reale di modelli compilati con verifica di caricamento sicuro per architettura Hailo/checksum.
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — generatore reale di pipeline GStreamer + config MediaMTX, con una vera barriera di integrazione HailoRT.
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — vera legge di correzione Position-Based Visual Servoing, con cancello di sicurezza sullo stato di zona a monte.
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — vero controllo di violazione zona e richiesta E-STOP, con imposizione della freschezza di calibrazione.

*Nodo IA Cognitivo (Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** — hub di integrazione per la pipeline cognitiva Hailo-10 (orchestrazione LLM/VLA/voce).
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** — vera codifica/decodifica di token d'azione e generazione di traiettoria per un modello Vision-Language-Action.
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** — vera scomposizione dei task basata su regole e recupero semantico degli errori sui codici errore MCU.
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** — vera ricerca documentale TF-IDF (solo libreria standard) sui documenti Markdown di questo ecosistema.

*Orchestrazione e Sciame*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — hub di integrazione con un vero contratto di health-report gRPC/Protobuf e una macchina a stati di missione.
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** — vera coda di lavori basata su priorità con deduplicazione, su una vera API HTTP.
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — vero watchdog di salute della flotta basato su gRPC, con retry/backoff e rilevamento di discrepanza d'identità.
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** — vero pianificatore di percorsi 3D basato su RRT, con vera validazione delle collisioni ostacolo/spazio di lavoro.
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** — vera sincronizzazione di stato CRDT LWW-Element-Map, con property test per la convergenza multi-cella.

*Gemello Digitale e Simulazione*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** — hub di integrazione per il motore di gemello digitale, con un vero contratto di sincronizzazione per compatibilità di versione.
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — vero interblocco di sicurezza hardware-in-the-loop che instrada i comandi tra simulazione e hardware reale.
- **[HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)** — vera cinematica diretta e validazione dei limiti articolari su un vero sottoinsieme URDF.
- **[HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)** — vero generatore procedurale di scene 2D con esportazione di annotazioni YOLO/COCO.

*Dati e Analisi*
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** — vero archivio di serie temporali basato su sqlite3, con una vera API HTTP di ingestione/query.
- **[HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)** — vero rilevatore di anomalie FFT + baseline statistica, con monitoraggio della deriva.
- **[HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)** — vero calcolo OEE/disponibilità sullo storico di DATALAKE, con esportazione CSV riproducibile.
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** — vera pipeline di ingestione CAN/WebSocket verso DATALAKE, con deduplicazione per sequenza.

*Gateway Industriale*
- **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** — hub di integrazione che inoltra ai protocolli industriali, con un vero livello di allowlist dei comandi/backpressure.
- **[HYDRA-UMC-OPCUA-SERVER](https://github.com/JuanenRac/HYDRA-UMC-OPCUA-SERVER)** — vero spazio di indirizzi OPC-UA, verificato con una vera sessione client del protocollo binario.
- **[HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)** — vero broker MQTT con autenticazione opzionale per client e ACL sui topic.
- **[HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)** — veri endpoint XML `/probe` e `/current` di MTConnect, con output in modalità degradata.

*Strumenti Complementari e Operazioni dell'Ecosistema*
- **[HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)** — pannelli Smart Summaries e Anomaly Highlighting su DATALAKE/ANOMALY-DETECTOR, con un fallback statistico onesto.
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** — CLI di flotta con un vero e stabile contratto di exit-code, un client live reale della stessa API di questo server.
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — app companion WearOS con avvisi aptici reali e un relay vocale verso il telefono abbinato.
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** — firmware per un rack di montaggio schede con decodifica reale dell'ID utensile e logica di preriscaldamento Smart Idle.
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** — firmware più un vero companion di visione Python per una testa utensile di ispezione termica/RGB.
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** — strumento amministrativo desktop che scopre, clona e aggiorna ogni repository di questo ecosistema.
- **[HYDRA-UMC-OS-REBUILDER](https://github.com/JuanenRac/HYDRA-UMC-OS-REBUILDER)** — strumento desktop Windows/Linux che costruisce un'immagine della CM5 pronta da scrivere, precaricata con le versioni più aggiornate dell'ecosistema, con configurazione di primo avvio Wi-Fi/utente/SSH in stile Raspberry Pi Imager.

---

## 📚 Documentazione e Comunità

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — stack tecnologico e linee guida di codifica per una pull request.
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — gli standard di comportamento attesi in questa comunità.
- **[SECURITY.md](SECURITY.md)** — come segnalare una vulnerabilità, e le reali aree di attenzione sulla sicurezza di questo progetto.
- **[SUPPORT.md](SUPPORT.md)** — dove porre domande e segnalare bug.
- **[LICENSE.md](LICENSE.md)** — la licenza propria di questo progetto.

## 👤 AUTORE
**JuanenRac** (Electro Hobby 3D)
📧 electrohobby3d@gmail.com
📺 [youtube.com/@electrohobby3d](https://youtube.com/@electrohobby3d)

## 📜 LICENZA

HYDRA-UMC SERVER è (c) 2026 JuanenRac (Electro Hobby 3D). Questo avviso
deve essere incluso in qualsiasi distribuzione di questo progetto o
lavori derivati.

Il codice sorgente di questa applicazione è disponibile sotto la **GNU
General Public License v3.0 (GPL-3.0)**. Testo completo su
https://www.gnu.org/licenses/gpl-3.0.html.

La documentazione (questo README e le sue traduzioni - `README_spa.md`,
`README_ita.md`, `README_fra.md`, `README_deu.md`, `README_zho.md`,
`README_jpn.md`) è disponibile sotto
**Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA
4.0)**. Testo completo su https://creativecommons.org/licenses/by-sa/4.0/.
