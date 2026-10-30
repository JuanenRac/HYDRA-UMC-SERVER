<!-- =============================================================================
HYDRA-UMC-SERVER - Headless REST and WebSocket backend of the HYDRA-UMC micro-factory
Copyright (C) JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
GPL-3.0-or-later - see LICENSE
============================================================================= -->

<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-SERVER banner" width="100%">
</p>

# 🤖 HYDRA-UMC-SERVER

<p align="center"><a href="README.md">🇺🇸 English</a> | <a href="README_spa.md">🇪🇸 Español</a> | <a href="README_fra.md">🇫🇷 Français</a> | 🇮🇹 <b>Italiano</b> | <a href="README_deu.md">🇩🇪 Deutsch</a> | <a href="README_zho.md">🇨🇳 简体中文</a> | <a href="README_jpn.md">🇯🇵 日本語</a> | <a href="README_por.md">🇵🇹 Português</a></p>

### 🤖 Backend headless API/WebSocket per la Micro-Fabbrica Multi-Robot HYDRA-UMC

<p align="center">
  <img src="https://img.shields.io/badge/License-GPL%203.0--or--later-blue.svg" alt="GPL 3.0 or later">
  <img src="https://img.shields.io/badge/Runtime-Node.js-339933.svg" alt="Runtime">
  <img src="https://img.shields.io/badge/Framework-Express-000000.svg" alt="Framework">
  <img src="https://img.shields.io/badge/Language-TypeScript-3178C6.svg" alt="Language">
  <img src="https://img.shields.io/badge/Protocol-WebSocket-lightgrey.svg" alt="Protocol">
  <img src="https://img.shields.io/badge/Tests-377%20passing-2ea44f.svg" alt="Tests">
  <img src="https://img.shields.io/badge/Version-0.8.1.3-0f6cbd.svg" alt="Version">
  <img src="https://img.shields.io/badge/Maturity-functional-0F6CBD.svg" alt="Maturity">
</p>

---

> **Verifica di onestà - cosa funziona davvero oggi:** il motore Express + WebSocket, la sua superficie REST e WebSocket (63 operazioni in 58 percorsi), l'accesso JWT con rotazione del token di refresh e scrypt, la scoperta mDNS, prenotazioni e revisioni dei robot, la riproduzione e i relay verso CAN-OTA, telemetria, voce, i servizi di IA locali e il connector hub sono reali e provati contro un'istanza reale di questo stesso server avviata dai test stessi: 377 test unitari più 28 script di contratto end-to-end, tutti superati. Ciò che sfiora l'hardware e non è verificato qui: il collegamento a una vera CM5 HYDRA-UMC con una scheda STM32H745, codice reale esercitato solo tramite lo strato API e contratti. TLS, Bluetooth LE, il bridge MQTT e lo stack Prometheus e Grafana sono reali, facoltativi e spenti per impostazione predefinita.

---

> **Stato di sicurezza (safety e security):** questo ecosistema non è un sistema di sicurezza certificato. Non esiste ancora un percorso E-STOP hardware, né limiti o interblocchi imposti dal firmware, né un comando di movimento verificato; le immagini firmware sono controllate con CRC-32 e una firma Ed25519, e una compilazione di rilascio rifiuta le chiavi di sviluppo pubblicate (le teste utensile e le schede di espansione dietro il relè usano ancora i bootloader di URTC, che accettano un HMAC-SHA256 a chiave condivisa invece di una firma); TLS e TLS reciproco sono opzionali e disattivati per impostazione predefinita; nessuna scheda propria è stata ancora assemblata o provata. Leggi la [base di sicurezza](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md) e il [modello delle minacce](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md) prima di fidarti di qualsiasi affermazione qui per la sicurezza di una persona.

---

## 📋 In breve

| | |
|---|---|
| Versione | `0.8.1.3` |
| Maturità | Funzionale |
| Test | 377 (`npm run test:unit`) |
| Tecnologia | Node.js 20+ / Express / WebSocket (ws) / REST/OpenAPI |
| Destinazione | Il Raspberry Pi CM5 di una cella HYDRA-UMC |
| Su hardware reale | Non ancora: per questa versione non risulta alcuna esecuzione su hardware reale |

**Vai a:** [Panoramica](#-panoramica) · [Architettura](#-architettura) · [Funzionalità](#-funzionalità) · [Sicurezza e protezione](#-sicurezza-e-protezione) · [Interfacce](#-interfacce) · [Configurazione](#-configurazione) · [Avvio rapido](#-avvio-rapido) · [Test](#-test) · [Risoluzione dei problemi](#-risoluzione-dei-problemi) · [Struttura del repository](#-struttura-del-repository) · [Progetti correlati](#-progetti-correlati)

## 🚦 Stato del progetto

Ogni riga è una parte di questo repository e il semaforo dice a che punto è oggi. È scritta in base a ciò che il repository può mostrare (test, compilazioni, esecuzioni), non a ciò che è previsto.

🟢 Fatto e verificato · 🟡 Funziona, con limiti noti · 🟠 Fatto a metà o non ancora verificato · 🔴 Non fatto o non funzionante

| Area | Stato | Cosa significa qui |
|---|---|---|
| Software | 🟡 | Funziona per il suo scopo principale; la verifica di onestà qui sopra elenca ciò che manca ancora |
| Test | 🟢 | 377 test automatici, eseguiti a ogni modifica |
| Hardware reale | 🔴 | Non ancora: per questa versione non risulta alcuna esecuzione su hardware reale |
| Documentazione | 🟢 | README in otto lingue, verificato rispetto al manifesto a ogni modifica |

## 🎯 Panoramica

HYDRA-UMC SERVER è il backend indipendente che governa una cella di
micro-fabbrica multi-robot HYDRA-UMC: un motore Node.js/Express +
WebSocket che possiede lo stato dei robot, lo persiste su disco, autentica
ogni scrittura e trasmette aggiornamenti in tempo reale a ogni client
connesso. Viene distribuito senza interfaccia utente né passo di build del
frontend propri - è un servizio puro di API + WebSocket, pensato per
funzionare headless (senza browser, senza schermo) sulla macchina
fisicamente accanto ai robot (tipicamente un Raspberry Pi CM5).

Il secondo contratto è completo: scritture condizionali (`If-Match` su comandi e prenotazioni, `GET /api/robot/:id`), il comando atomico `table`, un registro di audit in sola aggiunta (`GET /api/audit`, concatenato con hash, disattivabile) e un messaggio WebSocket `claims`. Le password delle telecamere non compaiono più nell'elenco dei processi né nel registro. Vedi `docs/CONTRACT_V2.md`.

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

## 🧩 Ruolo in HYDRA-UMC

**HYDRA-UMC-SERVER** è il motore della cella: un backend Node.js ed Express senza interfaccia che possiede lo stato dei robot, lo salva su disco, richiede un ruolo per ogni scrittura e invia aggiornamenti in tempo reale a tutti i client con un unico WebSocket. Tutti i client (STUDIO, SUITE, le app per telefono, il touchscreen, l'orologio, lo strumento da riga di comando) passano da lui, ed esso solo decide chi può muovere quale robot e fin dove.

## 🏛️ Architettura

<p align="center">
  <img src="images/architecture.svg" alt="HYDRA-UMC-SERVER architecture" width="100%">
</p>

### Perché Esiste

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

## ✨ Funzionalità

### Dati e Persistenza

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
- `data/totp.json` - il secondo fattore degli account che lo hanno attivato (facoltativo, disattivato per ogni account finché il suo proprietario non lo attiva): ogni segreto è cifrato con AES-GCM sotto `HYDRA_UMC_TOTP_KEY` (o una chiave derivata da `JWT_SECRET`) e i dieci codici di recupero sono conservati solo come hash; il file non esiste finché un account non attiva il secondo passaggio.

## 🔒 Sicurezza e protezione

| Minaccia | Difesa | Dove |
|---|---|---|
| Token firmati con una chiave nota | Con `NODE_ENV=production` il server rifiuta di avviarsi con un `JWT_SECRET` vuoto, di esempio o corto e senza amministratore iniziale; in sviluppo si usa un valore integrato e si stampa un avviso `[SECURITY]` | `src/auth.ts`, `src/secretsPolicy.ts` |
| Forza bruta sull'accesso, o un'ondata di stop | 5 accessi falliti ogni 15 minuti per indirizzo (`429`), 120 refresh e 60 stop globali al minuto, regolabili con `LOGIN_RATE_LIMIT_MAX`, `REFRESH_RATE_LIMIT_MAX` e `STOP_ALL_RATE_LIMIT_MAX`; le password usano scrypt con sale casuale, al massimo 4 alla volta e 20 in coda, così un'ondata non può affamare il server | `src/auth.ts`, `src/users.ts` |
| Un token rubato, o un token letto dall'indirizzo | I token di accesso scadono (`JWT_EXPIRES_IN`, 30 giorni per impostazione predefinita, 24 h consigliate fuori da una LAN fidata) e si rinnovano con un token di refresh a rotazione; il WebSocket riceve il token come sottoprotocollo `hydra.bearer` e rifiuta `?token=` salvo che `HYDRA_UMC_WS_QUERY_TOKEN=allow` lo riammetta, con un avviso a ogni avvio | `src/refresh_tokens.ts`, `src/ws.ts` |
| Due client che muovono lo stesso robot, o un comando che il robot non dovrebbe ricevere | Un robot è prenotato per un account e una finestra, le scritture richiedono `If-Match` (una revisione scaduta riceve `412`), il ruolo osservatore non può scrivere, e la dimensione di un movimento e la temperatura massima del piano riscaldato vengono dai limiti di sicurezza che fissa un amministratore; lo stop globale funziona qualunque cosa dicano le prenotazioni | `src/claimPolicy.ts`, `src/safetyLimits.ts`, `src/routes/commandRoutes.ts` |
| Immagini delle telecamere aperte a chiunque in rete | Flussi in diretta, foto e registrazioni richiedono un ticket firmato di 5 minuti (o un token bearer); al massimo 8 telecamere; le password delle telecamere restano fuori dall'elenco dei processi e dal registro; `HYDRA_UMC_CAMERA_AUTH=open` è l'esclusione temporanea | `src/mediaTickets.ts`, `src/serverPolicy.ts` |
| Richieste enormi o ostili, e accesso cross-origin aperto | I corpi JSON sono limitati a 1 MB (50 MB solo sulla rotta di caricamento grande); `CORS_ALLOWED_ORIGINS` è una lista consentita e, in produzione, una lista non impostata nega ogni richiesta cross-origin del browser (lo sviluppo consente qualsiasi origine, con un avviso); `settings.json` e `users.json` non vengono mai serviti come file | `src/server.ts` |
| Opzioni di accesso deboli lasciate attive: testo vocale, confidenza del riconoscitore, firma MAVLink, Bluetooth, MQTT, TLS | Ognuna ha un interruttore che un amministratore modifica con `PUT /api/admin/server-config` (solo admin), con un valore predefinito prudente e l'ambiente che prevale su ciò che è salvato; la risposta elenca avvisi come `voice_heard_text_on`, `voice_confidence_off`, `mavlink_unsigned_allowed` e `mavlink_signing_off`; il relay vocale sostituisce qualsiasi `options` inviata da un client con quelle dell'amministratore, e un file di chiave MAVLink viene controllato (32 byte o 64 caratteri esadecimali) prima di salvarne il percorso | `src/securityConfig.ts`, `src/routes/adminRoutes.ts`, `src/routes/assistantRoutes.ts` |
| Un registro manomesso di chi ha fatto cosa | Un registro di audit in sola aggiunta le cui voci sono concatenate con hash (`GET /api/audit`, `?verify=1` verifica la catena), un registro del server che ruota per dimensione e un passaggio di oscuramento che rimuove i segreti prima di scrivere qualsiasi cosa | `src/auditLog.ts`, `src/logRotation.ts`, `src/redaction.ts` |

**Cosa non fa mai:** fare da funzione di sicurezza certificata. I limiti e lo stop sono software in questo processo; dietro non c'è ancora un percorso di arresto di emergenza in hardware, né un limite imposto dal firmware né una vera scheda controller.

## 🔌 Interfacce

### Superficie API e WebSocket

Ogni rotta, il contratto dei messaggi WebSocket, l'autenticazione e il
modello di accesso remoto per client sono documentati in
**[`docs/REMOTE_API.md`](docs/REMOTE_API.md)** - l'unica fonte di verità
per qualsiasi cosa comunichi con questo server, incluso il codice client
di HYDRA-UMC STUDIO stesso. In breve:

- API REST sotto `/api/*` - lettura/scrittura settings, comandi atomici
  robot (jog/play/pause/stop/tool/valve/pump/speed/vision), gestione
  account, upload/download file di lavoro, invio modelli, metriche di
  sistema, discovery.
- Un singolo endpoint WebSocket `/ws` (token bearer come sottoprotocollo `hydra.bearer`, un token nella query string viene rifiutato a meno che l'installazione lo riabiliti)
  che trasmette snapshot completi `settings` e aggiornamenti più leggeri
  `delta` a ogni client connesso quando lo stato cambia.
- `POST /api/stop-all` è lo stop globale: una chiamata, aperta a ogni account autenticato, ferma tutti i robot e spegne tutte le valvole e pompe,
  qualunque sia la prenotazione, e risponde un risultato per robot.
- Bluetooth LE (spento per impostazione predefinita): un telefono vicino alla CM5 può leggere lo stato dei robot e, se un amministratore lo consente, inviare comandi che il server conferma solo dopo che ha risposto la stessa route usata da un client di rete. Vedi [`docs/BLE_GATT.md`](docs/BLE_GATT.md).
- Autenticazione JWT a bearer token su ogni scrittura; tre ruoli account
  (`admin`, `operator`, `viewer` di sola lettura) filtrano le scritture di settings/gestione utenti
  rispetto all'operatività quotidiana dei robot e alla sola lettura.
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

### Monitoraggio (Opzionale)

`GET /metrics` espone l'uptime del processo, i client WebSocket connessi,
la latenza di scrittura di `settings.json`, i comandi atomici robot per
tipo, i fallimenti di autenticazione, e le stesse cifre di CPU/memoria/
temperatura di `GET /api/system/metrics` - tutto in formato Prometheus.
Uno stack Prometheus + Grafana pronto all'uso (con una dashboard iniziale)
si trova in **[`monitoring/`](monitoring/README.md)**: `docker compose up
-d` da quella cartella ed è già attivo. Del tutto opzionale - nulla qui è
necessario perché il server stesso funzioni.

| Topic o rotta | Cosa porta |
|---|---|
| `/api/login`, `/api/refresh`, `/api/logout` | accedere (con limite di frequenza), ruotare il token di refresh, uscire |
| `/api/users`, `/api/users/:username` | elencare, creare, modificare ed eliminare account (`admin`, `operator`, `viewer`); solo admin |
| `/api/settings`, `/api/robot/:id`, `/api/robot/:id/command` | l'albero di stato e i comandi atomici tipizzati (movimento, riproduzione, pausa, stop, utensile, valvola, pompa, velocità, visione, tavolo) con `If-Match` |
| `/api/robot/:id/claim`, `/release`, `/jog-arm`, `/api/claims`, `/api/stop-all`, `/api/safety-limits` | prenotazioni, armare il movimento, chi tiene cosa, lo stop globale e i limiti di sicurezza |
| `/api/admin/server-config`, `/clients`, `/logs`, `/restart`, `/safety-limits` | amministrazione: gli interruttori di accesso, le app connesse, il registro del server, un riavvio e i limiti di sicurezza; solo admin |
| `/api/camera/*`, `/api/cameras/status` | flussi delle telecamere, istantanee, registrazioni, PTZ e `POST /api/camera/ticket` |
| `/api/system/metrics`, `/api/system/supervisor`, `/api/ecosystem/status`, `/api/system/bluetooth/*` | informazioni sull'host, il supervisore dei processi, lo stato e il controllo dei servizi dell'ecosistema, abbinamento Bluetooth |
| `/api/voice/turn`, `/api/voice/confirm`, `/api/watch/system-status`, `/api/ai/*` | relay verso il servizio vocale, lo stato dell'orologio e i servizi di IA locali |
| `/ws` | un WebSocket: istantanee complete `settings`, aggiornamenti leggeri `delta` e un messaggio `claims`; il token viaggia come sottoprotocollo `hydra.bearer` |
| `GET /api/hydra-info`, `_hydra._tcp` | scoperta: la versione del contratto remoto (`remoteApiVersion` 2), la versione dell'app e il numero di controller e robot, annunciati via mDNS |
| `/admin`, `/dashboard-ai`, `/` | pagine statiche facoltative, servite solo quando `build-frontend` le ha compilate accanto a questo repository: il pannello di amministrazione, DASHBOARD-AI e STUDIO |
| `/metrics` | testo Prometheus: tempo di attività, client WebSocket, latenza di scrittura, comandi per tipo, errori di autenticazione, valori dell'host |

## ⚙️ Configurazione

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
- `REFRESH_RATE_LIMIT_MAX` - budget di richieste di `POST /api/refresh` per finestra e per IP (default 120). Solo gli accessi falliti contano per il limite di login qui sopra.
- `TLS_CERT_PATH` / `TLS_KEY_PATH` - imposta **entrambe** per far passare
  il server (API REST + il WebSocket `/ws`, che condivide lo stesso
  listener) da HTTP/WS in chiaro a HTTPS/WSS. Vedi "TLS / HTTPS" più
  sotto. Lasciarne una qualsiasi non impostata mantiene il comportamento
  HTTP in chiaro attuale invariato.
- `HYDRA_UMC_CAMERA_AUTH` - le immagini delle telecamere (stream in diretta, foto e registrazioni salvate) richiedono **di default** un `?ticket=` di breve durata (`POST /api/camera/ticket` ne consegna uno a un client autenticato) o un token Bearer; `HYDRA_UMC_CAMERA_AUTH=open` è la via d'uscita temporanea per i client che non chiedono ancora ticket.
- `HYDRA_UMC_WS_QUERY_TOKEN` - `/ws?token=` è **rifiutato di default** (il token viaggia come sottoprotocollo `hydra.bearer`); `HYDRA_UMC_WS_QUERY_TOKEN=allow` è la via d'uscita temporanea per i client che non sono ancora passati. Il server avvisa a ogni avvio finché una via d'uscita è attiva.
- `HYDRA_UMC_BLE_GATT` - il servizio Bluetooth LE: `off` (predefinito), `state` (i telefoni leggono lo stato) o `commands` (e inviano comandi, ciascuno con il token di accesso dell'account). `HYDRA_UMC_BLE_ENCRYPTION=off` smette di richiedere un collegamento cifrato (è richiesto per impostazione predefinita). Entrambi si possono impostare anche dalla schermata di amministrazione del server; una modifica si applica al prossimo avvio. Richiede BlueZ, `python3-dbus` e `python3-gi` sulla macchina.
- `HYDRA_UMC_MQTT_BRIDGE` - il ponte verso il broker MQTT della cella: `off` (predefinito), `state` (lo stato di ogni robot esce su topic retained) o `commands` (e un comando pubblicato sul topic di un robot viene eseguito dalla stessa route di un client di rete, con il token di un account dedicato indicato da `HYDRA_UMC_MQTT_COMMAND_USER`). L'indirizzo, il prefisso dei topic e i nomi utente si impostano anche dalla schermata Server Admin; le password solo dall'ambiente. Vedi [`docs/MQTT_BRIDGE.md`](docs/MQTT_BRIDGE.md).
- `HYDRA_UMC_INFO_AUTH=required` - richiede un client autenticato per le informazioni di sola lettura del dispositivo (`/metrics`, `/api/system/metrics`, `/api/system/supervisor`, `/api/ecosystem/status`, `/api/models`). Disattivato di default perché un client che non invia ancora il token su quelle rotte continui a funzionare; un avvio in produzione avvisa finché è disattivato.
- `HYDRA_UMC_VOICE_UI_INCLUDE_HEARD_TEXT`, `HYDRA_UMC_VOICE_UI_MIN_CONFIDENCE`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_KEY_FILE`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_ALLOW_UNSIGNED` - le opzioni di voce e UAV che un amministratore può impostare anche da Server Admin (`voice` e `mavlink` in `data/server-config.json`): se una risposta vocale ripete ciò che è stato detto (`1` lo attiva; spento per impostazione predefinita), la confidenza minima del riconoscimento vocale (da 0 a 1, predefinita 0,6) prima di accettare una richiesta che avvia un movimento, e il file della chiave della firma MAVLink 2 e se i messaggi non firmati vengono ancora accettati (per impostazione predefinita nessuna firma e i messaggi non firmati sono rifiutati). L'ambiente prevale su quanto salvato, e allora la schermata mostra il valore come fisso.
- `HYDRA_UMC_AI_ACCESS=admin` - limita agli amministratori il relay verso i servizi di IA locali (`/api/ai/*`). Disattivato per impostazione predefinita: qualunque utente autenticato può usarlo, come prima.
- `HYDRA_UMC_VISUAL_SERVOING_TOKEN`, `HYDRA_UMC_VLA_ENGINE_TOKEN`, `HYDRA_UMC_COGNITIVE_NODE_TOKEN`, `HYDRA_UMC_DETECTION_HEF_TOKEN`, `HYDRA_UMC_VISION_NODE_TOKEN` e `HYDRA_UMC_ANOMALY_TOKEN` (per il relay `/api/ai/*`), `HYDRA_UMC_VISION_STREAMER_TOKEN` (per i flussi delle telecamere) e `HYDRA_UMC_DATALAKE_READ_TOKEN`, altrimenti `HYDRA_UMC_DATALAKE_TOKEN` (per la telemetria) - il token Bearer che questo server presenta a un servizio che lo richiede; ognuna legge anche `..._FILE`, un file la cui prima riga è il token. Sono i nomi che leggono i servizi stessi, quindi un solo file di ambiente serve a entrambi, e nessun client li vede mai. Un servizio senza token configurato si raggiunge esattamente come prima. Il relay rifiuta inoltre una sessione che non sia di amministratore né di operatore, e solo un amministratore può modificare la linea di base del rilevatore di anomalie (qualsiasi `POST` diverso da `/detect`); `vision-node` e `anomaly-detector` entrano nel relay.
- `HYDRA_UMC_VOICE_UI_RESULT_KEY` (o `..._FILE`) - la chiave con cui HYDRA-UMC-VOICE-UI firma un risultato vocale confermato (16 caratteri o più, lo stesso valore che possiede). `POST /api/voice/confirm` inoltra una conferma con l'utente autenticato come soggetto e crede a una risposta `confirmed` solo se nomina quell'utente e la sua firma risulta valida; senza la chiave la risposta viene passata con `verified: false`, e `HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE=1` la rifiuta invece. Questa route non esegue nulla.
- `HYDRA_UMC_TELEMETRY_COLLECTOR_URL` (con `HYDRA_UMC_TELEMETRY_COLLECTOR_TOKEN` o `..._FILE`, e `HYDRA_UMC_TELEMETRY_INTERVAL_MS`, da 100 a 60000, 1000 per impostazione predefinita) - attiva il produttore di telemetria: i valori di ogni delta di robot che questo server trasmette (posizione, giunti, stato di riproduzione) vengono inviati a HYDRA-UMC-TELEMETRY-COLLECTOR come un campione `robot_state` per robot, al massimo uno per intervallo e fusi, così il data lake ha qualcosa di reale da conservare. Disattivato se manca l'indirizzo; non ritarda mai un comando, conserva una quantità limitata di dati e si ferma 30 secondi dopo un errore.
- `/dashboard-ai` - se HYDRA-UMC-DASHBOARD-AI è presente accanto a questo repository, `build-frontend` lo compila e questo server lo serve lì. La pagina legge il data lake (`/api/ai/datalake/*`, sola lettura: `GET` su `/query`, `/aggregate`, `/stats`, `/stats/range`, `/series` e `/health`, tutto il resto viene rifiutato) e il rilevatore di anomalie (`/api/ai/anomaly-detector/*`) tramite il relay, con la sessione di chi ha effettuato l'accesso a STUDIO nello stesso browser; si applicano quindi i ruoli e i token di servizio di questo server. Con questo il rilevatore di anomalie può essere avviato con `HYDRA_UMC_ANOMALY_PROTECT_READS=1`.
- `HYDRA_UMC_LOG_MAX_BYTES` e `HYDRA_UMC_LOG_KEEP` - la dimensione a cui ruota il log del server (10 MB predefiniti) e quanti file ruotati si conservano (1 predefinito).
- `HYDRA_UMC_SETTINGS_STORE`, `HYDRA_UMC_SETTINGS_BACKUPS` e `HYDRA_UMC_SETTINGS_BACKUP_INTERVAL_S` - per impostazione predefinita le impostazioni (`settings.json` e i file dei punti) si scrivono come un'unica unità tutto o niente con un journal: una scrittura interrotta viene completata o scartata al successivo avvio, una copia di `settings.json` viene conservata in `data/backups/` (10 copie, al massimo una ogni 600 s) e un `settings.json` danneggiato viene ripristinato dall'ultima copia buona. `HYDRA_UMC_SETTINGS_STORE=plain` torna alla scrittura file per file; `HYDRA_UMC_SETTINGS_BACKUPS=0` disattiva le copie.
- L'accesso al relay dell'IA, l'obbligo di accesso delle informazioni dell'host e TLS (percorsi di certificato e chiave, con l'impronta SHA-256 del certificato) possono essere modificati da un amministratore anche dalla schermata Amministrazione server dell'app di controllo. Un valore impostato nell'ambiente prevale e appare bloccato; l'obbligo di accesso chiede conferma prima di essere disattivato; TLS vale dal successivo avvio.
- `STOP_ALL_RATE_LIMIT_MAX` / `STOP_ALL_RATE_LIMIT_WINDOW_MS` - budget dello stop globale (`POST /api/stop-all`) per indirizzo, separato da quello del login (di default 60 al minuto). In produzione il server rifiuta inoltre di avviarsi con un `JWT_SECRET` o una password di avvio di esempio da un modello di distribuzione, un `JWT_SECRET` sotto i 32 caratteri o una password di avvio sotto i 12.

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

Gli interruttori di accesso qui sotto sono quelli che le schermate Server Admin di STUDIO e SUITE modificano. Ognuno si risolve nello stesso ordine: prima l'ambiente del deployment (la schermata lo mostra bloccato), poi ciò che l'amministratore ha salvato in `data/server-config.json`, poi il valore predefinito prudente. Le variabili elencate sopra coprono tutto il resto.

| Variabile | Predefinito | Cosa imposta |
|---|---|---|
| `aiAccess`, `HYDRA_UMC_AI_ACCESS` | `open` | chi può usare il relay di IA locale: `open` è qualsiasi account autenticato, `admin` solo gli amministratori |
| `infoAuth`, `HYDRA_UMC_INFO_AUTH` | disattivato | chiedere l'accesso per le informazioni di sola lettura dell'host (metriche, supervisore dei processi, stato dell'ecosistema) |
| `tls.enabled`, `TLS_CERT_PATH, TLS_KEY_PATH` | disattivato (HTTP semplice) | HTTPS e WSS con il certificato e la chiave indicati; la schermata mostra l'impronta del certificato in uso |
| `ble.mode`, `HYDRA_UMC_BLE_GATT` | `off` | Bluetooth LE per i telefoni vicini al server: `off`, `state` (pubblica solo lo stato) o `commands` (accetta anche comandi); una parola sconosciuta significa spento |
| `ble.requireEncryption`, `HYDRA_UMC_BLE_ENCRYPTION` | attivo | la caratteristica dei comandi si scrive, e lo stato si legge, solo su un collegamento cifrato; solo `off` nella variabile lo disattiva |
| `mqtt.mode`, `MQTT environment of the deployment` | `off` | il bridge MQTT verso il broker della cella: `off`, `state` o `commands`, con URL, prefisso e utenti |
| `voice.includeHeardText`, `HYDRA_UMC_VOICE_UI_INCLUDE_HEARD_TEXT` | disattivato | una risposta vocale ripete ciò che è stato detto; sono dati personali, quindi è spento, e nella variabile solo la parola esatta `1` lo attiva |
| `voice.minConfidence`, `HYDRA_UMC_VOICE_UI_MIN_CONFIDENCE` | `0.6` | la confidenza minima del riconoscitore vocale, da 0 a 1, per accettare una richiesta che avvia un movimento; 0 disattiva il controllo, uno stop non viene mai trattenuto, e un numero errato nella variabile è ignorato |
| `mavlink.signingKeyFile`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_KEY_FILE` | vuoto (nessuna firma) | firma MAVLink 2 del bridge UAV: il percorso di un file con la chiave da 32 byte (32 byte grezzi o 64 caratteri esadecimali); si salva solo il percorso, mai la chiave, e il bridge lo legge all'avvio |
| `mavlink.signingAllowUnsigned`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_ALLOW_UNSIGNED` | disattivato | continuare ad accettare messaggi non firmati (un veicolo che non firma ancora); la schermata avvisa finché è attivo |

## 🚀 Avvio rapido

Richiede Node.js 22 o successivo con npm. Il server funziona senza configurazione con valori predefiniti di sviluppo; imposta le variabili della sezione Configurazione prima che sia raggiungibile fuori da una LAN fidata.

```bash
npm install
./dev.sh                    # runs the server with tsx on port 3000, no frontend (dev.bat on Windows)
npm run test:unit           # the unit tests
npm test                    # unit tests, the OpenAPI check and the contract scripts against a live instance
npm run build && npm start  # one bundled file (build.sh and build.bat make a versioned release build)
```

Il server ascolta su `0.0.0.0:3000`; tutto il suo stato vive in `data/`. Questo repository non ha un Dockerfile di proposito: HYDRA-UMC-OS lo installa sulla CM5 (`provisioning/install_server.sh`). La versione in esecuzione si legge in `GET /api/hydra-info` (`appVersion`); solo gli script `build*.sh` e `build*.bat` della radice fanno una build di versione, `npm run build` si limita a compilare.

## 🧪 Test

377 test automatici si eseguono con `npm run test:unit`. In più, `npm test` esegue il controllo OpenAPI e 28 script di contratto end-to-end in `tools/` contro un'istanza reale di questo server (scoperta, accesso senza e con credenziali, avvio di produzione, comandi e proprietà dei robot, token di refresh, relay vocale e i suoi percorsi di errore, riproduzione, lo stop globale, bridge Bluetooth e MQTT, media delle telecamere, relay IA e connector-hub, ruolo osservatore e altro); tutti passano. Nessuno richiede hardware.

La CI esegue `HYDRA_UMC_CI=1 python tools/ci_validate.py`, che controlla il manifesto, i documenti, gli otto README e le immagini.

## 🏗️ Compilazione e rilascio

### Requisiti

- [Node.js](https://nodejs.org/) (v18 o superiore consigliato)
- npm

### Installazione

```bash
npm install
```

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

Questo repository non ha un Dockerfile di proposito: il server viene impacchettato e installato sulla CM5 da [HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS) (`provisioning/install_server.sh`).

## 🩺 Risoluzione dei problemi

| Vedi | Perché | Fai |
|---|---|---|
| Il server si ferma all'avvio in produzione | `NODE_ENV=production` richiede un vero `JWT_SECRET` (almeno 32 caratteri, non di esempio) e un amministratore iniziale al primo avvio | Imposta `JWT_SECRET`, `HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME` e `HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD` (vedi `docs/PRODUCTION_BOOTSTRAP.md`) |
| `429` all'accesso | Più di 5 accessi falliti da un indirizzo in 15 minuti | Attendi che la finestra passi; alza `LOGIN_RATE_LIMIT_MAX` solo su una rete fidata |
| L'app del browser è bloccata da CORS | In produzione un `CORS_ALLOWED_ORIGINS` non impostato nega ogni richiesta cross-origin del browser (curl, SUITE e le app per telefono non sono interessati) | Imposta `CORS_ALLOWED_ORIGINS=https://studio.example.com,...` con le origini della pagina |
| Il WebSocket si chiude subito, o un'immagine della telecamera non si carica | Il client invia il token nell'indirizzo (`/ws?token=`, rifiutato per impostazione predefinita) o apre l'immagine senza ticket (richiesto per impostazione predefinita) | Usa il sottoprotocollo `hydra.bearer` e `POST /api/camera/ticket`; le esclusioni `HYDRA_UMC_WS_QUERY_TOKEN=allow` e `HYDRA_UMC_CAMERA_AUTH=open` sono temporanee |
| Un interruttore di accesso viene rifiutato perché bloccato, o un file di chiave MAVLink viene rifiutato | Il valore è impostato da una variabile d'ambiente (prevale su quello salvato), oppure il file di chiave non è leggibile o non ha 32 byte né 64 caratteri esadecimali | Cambia o rimuovi la variabile e riavvia, o correggi il file; il bridge MAVLink legge le sue opzioni all'avvio |

## 📂 Struttura del repository

<p align="center">
  <img src="images/repository-structure.svg" alt="Repository structure of HYDRA-UMC-SERVER" width="100%">
</p>

<details>
<summary>Versione testuale dell'albero</summary>

```text
HYDRA-UMC-SERVER/
├── src/                       codice sorgente
│   ├── server.ts              Avvio leggero che collega i moduli qui sotto; le rotte /api stanno in src/routes/, le connessioni dal vivo in ws.ts, i file delle impostazioni in settingsStore.ts
│   ├── kinematics.ts          Helper di cinematica inversa per l'endpoint atomico di jog
│   ├── metrics.ts             Alimenta GET /metrics - esposizione testuale Prometheus (prom-client)
│   ├── ble/                   Servizio Bluetooth LE: frame, gateway (comandi, conferme, stato) e trasporto dell'helper
│   ├── users.ts               Archivio account (hash password scrypt)
│   ├── routes/                Le rotte /api per area: auth, impostazioni, prenotazioni dei robot, comandi, limiti di sicurezza, telecamere, Bluetooth, amministrazione, sistema, relay verso i servizi fratelli, IA locale, assistente, file di lavoro, alimentazione, info e file statici
│   ├── auth.ts                Verifica dei token, il cancello amministratore e i limitatori di frequenza; l'archivio dei token di refresh; ciò che la produzione accetta come segreto di firma e prima password; le opzioni di accesso; i token presentati ai servizi in relay
│   ├── claimPolicy.ts         Chi controlla quale robot; le modifiche che un operatore fa su un robot; i limiti a cui ogni client è vincolato; lo spostamento del tavolo XY in una richiesta; la riproduzione autorevole lato server
│   ├── settingsStore.ts       I file di impostazioni su disco, i loro backup, le scritture tutto-o-niente di più file, il registro di audit e la rotazione dei log
│   ├── ws.ts                  L'hub delle connessioni dal vivo (WebSocket), il ponte MQTT verso il broker della cella e il suo avvio, e il primo produttore di telemetria
│   ├── cameraHealth.ts        Se un flusso di telecamera consegna davvero fotogrammi, sondaggio delle telecamere IP e PTZ, il supervisore dei processi di flusso e ticket di breve durata per le immagini delle telecamere
│   └── ecosystemStatus.ts     Scoperta e vitalità dell'ecosistema, il registro delle porte dei servizi, metriche dell'host, l'ambiente di esecuzione del processo (mDNS, porta), funzioni di policy pure, redazione dei segreti, utilità di associazione Bluetooth, gli indirizzi dei servizi a monte e la conferma di una richiesta vocale
├── admin-ui/                  Pannello di amministrazione Vite/React separato per QUESTO server
├── data/                      Stato a runtime - settings, users, log, file di lavoro, punti salvati
├── docs/                      documenti del progetto
├── images/                    Media e diagrammi
├── systemd/                   unità di servizio
├── tools/                     strumenti del progetto e controlli della CI
├── tests/                     test automatici
├── monitoring/                Stack opzionale Prometheus + Grafana - vedi monitoring/README.md
├── scripts/                   l'helper Bluetooth LE (BlueZ) e un vecchio helper per le versioni
├── .github/                   workflow di CI e modelli di segnalazione
├── bump_manifest_version.py   Sincronizza la versione di hydra-umc.project.json con quella nativa (--sync)
├── build.bat / build.sh       Installa dipendenze + build di produzione
├── dev.bat / dev.sh           Installa dipendenze + avvia il server di sviluppo
├── package.json               metadati e script del pacchetto
├── tsconfig.json              configurazione TypeScript
├── CHANGELOG.md               cosa è cambiato in ogni versione
├── LICENSE
├── build-test.sh              controllo di build senza modifiche
├── hydra-umc.project.json     manifesto: versione, maturità, famiglia
└── test.sh                    esegue i test
```

</details>

## 🗺️ Roadmap e limiti noti

**Limiti noti oggi**

* Il collegamento a una vera CM5 con una scheda STM32H745 (`spi_bridge`) è codice reale esercitato solo tramite lo strato API e contratti; non c'è mai stata una scheda fisica per chiudere l'ultimo salto.
* Il server ascolta su tutte le interfacce (`0.0.0.0`); non c'è ancora un interruttore per l'indirizzo di ascolto, quindi un firewall o gli interruttori di accesso qui sopra limitano l'esposizione.
* In sviluppo (`NODE_ENV` diverso da `production`) si usano una chiave di firma integrata, l'account `admin`/`admin` e una policy CORS aperta, ciascuna con un avviso; la produzione le rifiuta.
* TLS, Bluetooth LE e il bridge MQTT sono facoltativi e spenti per impostazione predefinita.

**Prossimo passo:** ogni nuova rotta segue la stessa lista di controllo (documentata in `docs/REMOTE_API.md`, nominata in `docs/openapi.json`, tipizzata nei client dell'SDK).

## 🌍 Lingue

Questo README e i documenti del repository esistono in otto lingue: inglese, spagnolo, tedesco, francese, italiano, giapponese, cinese e portoghese (Portogallo). Sono scritti insieme e la CI verifica che gli otto file abbiano le stesse sezioni e gli stessi link. Questo repository non ha uno schermo né un catalogo di messaggi propri, quindi non ci sono stringhe di interfaccia da tradurre.

## 🔗 Progetti correlati

Questo progetto fa parte dell'ecosistema robotico HYDRA-UMC dello stesso autore (JuanenRac / Electro Hobby 3D). Vale la pena conoscerlo, poiché una richiesta potrebbe in realtà riguardare uno di questi invece di questo repository.

**Progetti Figli** — ognuno di questi è un vero client o un ponte di coordinamento che comunica con la flotta di robot solo tramite l'API di questo server
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — dashboard di controllo web con visualizzazione 3D multi-robot in tempo reale.
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — centro di comando sciame desktop (PySide6) per più server contemporaneamente, pacchettizzato come eseguibile standalone.
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — app di controllo nativa per Android con login biometrico e un companion Wear OS abbinato.
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — app di controllo per iOS/iPadOS (Flutter) con sincronizzazione WebSocket in tempo reale.
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — interfaccia touch nativa per il touchscreen DSI da 7" a bordo, incorporata direttamente nel CM5.
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — barriera di coordinamento per flotte AGV/AMR tramite un publisher MQTT VDA 5050 (testato solo contro una flotta emulata).
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — coordinatore ad alto livello per celle CNC con accesso a stato/byte di controllo GRBL (testato solo contro un emulatore).
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — barriera di coordinamento per droidi con zampe/umanoidi, con un mittente di comandi per Boston Dynamics Spot (testato solo contro un emulatore).
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — coordinatore per celle laser che legge 3 segnali GPIO di chiave/involucro/interblocco (testato solo contro un chip simulato; non può armare né far partire un laser).
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — coordinatore ad alto livello sicuro per il flusso schede del pick-and-place OpenPnP.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — barriera di coordinamento sicura per stampanti 3D Moonraker/Klipper, con comandi di lavoro reali e controllati.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — coordinatore con un trasporto ROS 2 rclpy importato in modo lazy (non ancora eseguito contro un'installazione ROS 2).
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — barriera di coordinamento per UAV dotati di fotocamera, con un mittente di comandi MAVLink (testato solo contro un emulatore).

**Direttamente Correlati**
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — questo server inoltra turni vocali autenticati e limitati verso di esso tramite una connessione loopback, mantenendo il token del gateway lato server così la voce non diventa mai un comando robot diretto.
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — il progetto della scheda madre del braccio robotico (nessuna scheda assemblata per ora); il servizio `spi_bridge` di questo server è pensato per comunicare con essa tramite il collegamento SPI-OTA CM5↔STM32H745 (provato solo con simulazioni).

**Fa Anche Parte dell'Ecosistema**

*Hardware e Piattaforma di Base*
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — livello prodotto riproducibile su Raspberry Pi OS per il CM5 su cui gira questo server: agente in sola lettura, config/profili validati, provisioning WiFi al primo contatto.
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — il contratto JSON-Schema condiviso e la barriera software di controllo dei job contro cui ogni bridge valida i propri comandi (non è una funzione di sicurezza certificata).
- **[HYDRA-UMC-CONNECTOR-HUB](https://github.com/JuanenRac/HYDRA-UMC-CONNECTOR-HUB)** — registro dichiarativo e validatore di manifesti adattatore per connettori di macchine esterne; estende la propria idea di contratto dell'SDK alle macchine esterne senza sostituire i progetti di gateway industriale.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — creatore/editor grafico desktop di URDF che invia i modelli finiti al catalogo di questo server.
- **[HYDRA-UMC-EDITOR-STL](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-STL)** — editor desktop di modelli STL, che trasforma/sostituisce/rimuove/aggiunge veri pezzi nello stesso catalogo di modelli modificato anche da HYDRA-UMC-EDITOR-URDF.

*Piattaforma Strumenti URTC*
- **[URTC](https://github.com/JuanenRac/URTC)** — firmware per la scheda fisica dell'Universal Robot Tool Controller, oltre 25 profili utensile su bus CAN.
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — strumento desktop con GUI per il flashing delle schede URTC, CAN-OTA più SWD/JTAG a chip intero.
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — strumento desktop di diagnostica CAN-bus dal vivo per schede URTC, un pannello per profilo utensile.
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — alternativa basata su browser a URTC-TESTER tramite la Web Serial API, senza installazione locale.
- **[URTC-GATEWAY](https://github.com/JuanenRac/URTC-GATEWAY)** — gateway davanti al bus CAN di URTC: elenco di identificatori consentiti, limite di frequenza e chiave di sessione; software provato su computer, non ancora su un bus reale.

*Nodo IA Visione (Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — hub di integrazione per la pipeline di visione Hailo-8, con un vero controllo di prontezza hardware per fase.
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — registro reale di modelli compilati con verifica di caricamento sicuro per architettura Hailo/checksum.
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — generatore reale di pipeline GStreamer + config MediaMTX, con una vera barriera di integrazione HailoRT.
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — legge di correzione Position-Based Visual Servoing con autorizzazione condizionata allo stato di zona; ancora nessuna stima di posa da telecamera.
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — logica v0 di violazione zona, freschezza di calibrazione e richiesta E-STOP che legge le posizioni degli oggetti da un file; nessun rilevatore la alimenta e nessun E-STOP fisico è ancora collegato.

*Nodo IA Cognitivo (Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** — hub di integrazione per la pipeline cognitiva Hailo-10 (orchestrazione LLM/VLA/voce).
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** — vera codifica/decodifica di token d'azione e generazione di traiettoria per un modello Vision-Language-Action.
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** — vera scomposizione dei task basata su regole e recupero semantico degli errori sui codici errore MCU.
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** — vera ricerca documentale TF-IDF (solo libreria standard) sui documenti Markdown di questo ecosistema.
- **[HYDRA-UMC-LOCAL-TECHNICIAN](https://github.com/JuanenRac/HYDRA-UMC-LOCAL-TECHNICIAN)** — tecnico di manutenzione IA locale e con cancelli di policy per l'ecosistema stesso - osserva, diagnostica e propone correzioni; i due livelli di rischio più alti non sono deliberatamente ancora implementati.

*Orchestrazione e Sciame*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — hub di integrazione con un vero contratto di health-report gRPC/Protobuf e una macchina a stati di missione.
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** — vera coda di lavori basata su priorità con deduplicazione, su una vera API HTTP.
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — vero watchdog di salute della flotta basato su gRPC, con retry/backoff e rilevamento di discrepanza d'identità.
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** — vero pianificatore di percorsi 3D basato su RRT, con vera validazione delle collisioni ostacolo/spazio di lavoro.
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** — vera sincronizzazione di stato CRDT LWW-Element-Map, con property test per la convergenza multi-cella.

*Gemello Digitale e Simulazione*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** — hub di integrazione per il motore di gemello digitale, con un vero contratto di sincronizzazione per compatibilità di versione.
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — router hardware-in-the-loop con un interblocco software di collisione tra simulazione e hardware reale (testato senza hardware reale).
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
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — app companion WearOS con schemi di avviso aptico e un relay vocale verso il telefono abbinato (non ancora eseguita su un orologio fisico).
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** — firmware per un rack di montaggio schede con decodifica reale dell'ID utensile e logica di preriscaldamento Smart Idle.
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** — firmware più un vero companion di visione Python per una testa utensile di ispezione termica/RGB.
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** — strumento amministrativo desktop che scopre, clona e aggiorna ogni repository di questo ecosistema.
- **[HYDRA-UMC-OS-REBUILDER](https://github.com/JuanenRac/HYDRA-UMC-OS-REBUILDER)** — strumento desktop Windows/Linux che costruisce un'immagine della CM5 pronta da scrivere, precaricata con le versioni più aggiornate dell'ecosistema, con configurazione di primo avvio Wi-Fi/utente/SSH in stile Raspberry Pi Imager.
- **[HYDRA-UMC-OPS-AGENT](https://github.com/JuanenRac/HYDRA-UMC-OPS-AGENT)** — coordinatore di incidenti di manutenzione: un ruolo edge a basso privilegio raccoglie uno snapshot di inventario/salute sanificato, un ruolo control-plane lo rende in sola lettura e chiede a un provider di IA di suggerire una diagnosi - non applica mai una patch né distribuisce nulla.
- **[HYDRA-UMC-DEV-SERVER](https://github.com/JuanenRac/HYDRA-UMC-DEV-SERVER)** — host di sviluppo riproducibile (Raspberry Pi 5 / CM5) che conserva il codice sorgente dell'ecosistema ed esegue attività delimitate di build/test tramite una coda durevole; un ruolo di sviluppo dedicato, esplicitamente distinto da un CM5 operativo.

## 📚 Documentazione

Dove leggere di più:

* [Base di sicurezza dell'ecosistema](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md)
* [Modello delle minacce dell'ecosistema](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md)
* [Registro delle modifiche di questo repository](CHANGELOG.md)
* [Licenza di questo repository](LICENSE.md)

## 🤝 Contribuire e comunità

* Prima di una pull request esegui `HYDRA_UMC_CI=1 py -3 tools/ci_validate.py` (oppure `HYDRA_UMC_CI=1 python3 tools/ci_validate.py`): deve stampare `CI_VALIDATION=PASS`. Non eseguire `build.sh` né `build.bat` per questa verifica; compilare non è verificare.
* I otto README sono scritti da un'unica fonte in HYDRA-UMC-DOCS; non modificarli a mano. Cambia la fonte e riscrivili con `tools/make_readmes.py`.
* Non affermare in un README ciò che non è stato eseguito: scrivi «simulato» o «non provato su hardware» quando è la verità.
* Vedi [CONTRIBUTING.md](CONTRIBUTING.md), il [codice di condotta](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md) e [SUPPORT.md](SUPPORT.md).

## 👤 AUTORE

**JuanenRac (Electro Hobby 3D)** · electrohobby3d@gmail.com

## 📜 LICENZA

GPL-3.0-or-later - [LICENSE](LICENSE).
