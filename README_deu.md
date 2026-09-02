<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-SERVER banner" width="100%">
</p>
# 🛰️ HYDRA-UMC SERVER

<p align="center">
  <a href="README.md">🇺🇸 English</a> |
  <a href="README_spa.md">🇪🇸 Español</a> |
  <a href="README_fra.md">🇫🇷 Français</a> |
  <a href="README_ita.md">🇮🇹 Italiano</a> |
  🇩🇪 <b>Deutsch</b> |
  <a href="README_zho.md">🇨🇳 简体中文</a> |
  <a href="README_jpn.md">🇯🇵 日本語</a>
</p>


### 🤖 Headless API/WebSocket-Backend für die HYDRA-UMC Multi-Roboter-Mikrofabrik

<p align="left">
  <img src="https://img.shields.io/badge/Lizenz-GPL%203.0-blue.svg" alt="GPL 3.0">
  <img src="https://img.shields.io/badge/Runtime-Node.js-339933.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/Framework-Express-000000.svg" alt="Express">
</p>


---

## 🎯 Überblick

HYDRA-UMC SERVER ist das eigenständige Backend, das eine
Multi-Roboter-Mikrofabrikzelle von HYDRA-UMC steuert: eine
Node.js/Express + WebSocket-Engine, die den Roboterzustand besitzt, ihn
auf der Festplatte persistiert, jeden Schreibvorgang authentifiziert und
Live-Updates an jeden verbundenen Client sendet. Sie wird ohne eigene Benutzeroberfläche oder Frontend-Build-Schritt
ausgeliefert - sie ist ein reiner API + WebSocket-Dienst, gedacht für den
headless-Betrieb (ohne Browser, ohne Bildschirm) auf der Maschine, die
tatsächlich neben den Robotern steht (typischerweise ein Raspberry Pi
CM5).

Sie KANN optional auch das bereits gebaute Frontend von
**[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** als
statische Dateien ausliefern, für das übliche "alles auf einer Maschine,
ein Ursprung"-Deployment - führe einmal **`build-frontend.sh`/`.bat`**
aus (baut STUDIO aus einem Geschwister-Checkout und kopiert das Ergebnis
in das eigene, von Git ignorierte `public/` dieses Repos) und dieser
Server liefert es ab dem nächsten Start unter `/` aus. Das ermöglicht es
HYDRA-UMC-ANDROID-CONTROL, HYDRA-UMC-IOS-CONTROL und HYDRA-UMC-DSI, den
echten 3D-Viewport von STUDIO in ihrer eigenen In-App-WebView einzubetten,
die auf dieselbe ip:Port dieses Servers zeigt. Vollständig optional: ohne
dieses Skript bleibt dieser Server genauso headless wie oben beschrieben
- `public/` existiert dann einfach nicht, und alle Routen funktionieren
weiterhin identisch.

Dasselbe `build-frontend.sh`/`.bat` baut auch das eigene
**[`admin-ui/`](admin-ui/README.md)** dieses Repos - ein kleines,
separates Panel zur Verwaltung dieses SERVERS selbst (verbundene Geräte,
seine eigene Log-Datei, sein eigener Port/Name, seine eigenen
Benutzerkonten), ausgeliefert unter `/admin`. Das ist bewusst KEINE
Robotersteuerung (die bleibt STUDIO-exklusiv) - eine gezielte,
ausdrückliche Ausnahme vom headless-Design oben, keine Abkehr davon.

Dieses Projekt war früher Teil von **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)**,
das als "hybrides Monolith" ausgeliefert wurde: ein einziger
Node.js-Prozess, der sowohl die Roboter-Steuerungs-Engine ausführte *als
auch* das Vite/React-Web-Dashboard bediente (mit Vites eigenem
Entwicklungs-Middleware direkt in dieselbe Express-App eingebunden).
Dieser Prozess wurde in zwei Teile aufgespalten:

- **HYDRA-UMC SERVER** *(dieses Repository)* - die Engine:
  Roboter-/Controller-Zustand, die REST + WebSocket-API,
  Authentifizierung, mDNS-Erkennung, Modell-Einreichungen. Keine UI, kein
  Bundler, kein Frontend-Build-Schritt.
- **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** - jetzt
  ein reiner Vite/React-Client, der über das Netzwerk mit diesem Server
  spricht, genau wie jeder andere Client dieser API bereits.

## 🧩 Warum Dieses Projekt Existiert

Die Trennung der Engine vom Web-Dashboard war eine bewusste Entscheidung,
kein Refactoring um seiner selbst willen:

- **Ressourcenisolierung.** Eine schwere 3D-Ansicht, die den eigenen
  Browser-Tab erstickt, teilt sich keinen Prozess (und damit keine
  CPU/I-O-Konkurrenz) mehr mit dem Code, der tatsächlich für die
  Bewegung der Roboter verantwortlich ist. Wenn die Web-UI hängt,
  beantwortet dieser Server weiterhin Not-Aus-Befehle von jedem anderen
  verbundenen Client.
- **Ein echter headless-Controller.** Dieser Prozess kann laufen, ohne
  dass jemals eine UI auf dem Host geladen wird - das "Gehirn" einer
  industriellen Zelle braucht keinen geöffneten Browser-Tab, um zu
  funktionieren. Gibt RAM/CPU auf eingeschränkter Hardware (einem
  Raspberry Pi CM5) für den Teil der Arbeit frei, der wirklich zählt:
  Kinematik und Steuerung.
- **Unabhängige Lebenszyklen.** Die Web-UI kann neu bereitgestellt,
  neugestartet oder gegen einen neueren Build ausgetauscht werden, ohne
  jemals diesen Prozess zu berühren - keine Ausfallzeit der
  Robotersteuerung nur um einen UI-Fix auszuliefern.
- **Flexibles Hosting.** Dieser Server ist dafür gedacht, auf (oder
  direkt neben) der Hardware zu laufen, die er steuert; der Client, der
  ihn darstellt, kann komplett woanders gehostet werden, erreichbar über
  das Netzwerk genau wie die anderen entfernten Clients dieser selben
  API.

## 🔌 API- und WebSocket-Oberfläche

Jede Route, der WebSocket-Nachrichtenvertrag, die Authentifizierung und
das Modell für clientweisen Fernzugriff sind in
**[`docs/REMOTE_API.md`](docs/REMOTE_API.md)** dokumentiert - die einzige
verlässliche Quelle für alles, was mit diesem Server spricht,
einschließlich des eigenen Client-Codes von HYDRA-UMC STUDIO. Kurz
zusammengefasst:

- REST-API unter `/api/*` - Lesen/Schreiben von Settings, atomare
  Roboterbefehle (jog/play/pause/stop/tool/valve/pump/speed/vision),
  Kontoverwaltung, Upload/Download von Arbeitsdateien, Modell-Einreichung,
  Systemmetriken, Erkennung.
- Ein einziger `/ws` WebSocket-Endpunkt (Bearer-Token im Query-String),
  der bei jeder Zustandsänderung vollständige `settings`-Snapshots und
  leichtere `delta`-Updates an jeden verbundenen Client sendet.
- JWT-Bearer-Token-Authentifizierung bei jedem Schreibvorgang; zwei
  Kontorollen (`admin`, `operator`) trennen Settings-/Benutzerverwaltungs-
  Schreibvorgänge vom täglichen Roboterbetrieb.
- `_hydra._tcp` mDNS/Bonjour-Ankündigung für zero-config-Erkennung im
  lokalen Netzwerk, plus ein einfaches `GET /api/hydra-info` für einen
  Subnetz-Scan.
- `GET /metrics` - Prometheus-Expositionsformat (`prom-client`), für das
  optionale Grafana-Dashboard, beschrieben unter "📊 Monitoring" weiter
  unten.

CORS ist über eine konfigurierbare Allowlist aktiviert
(`CORS_ALLOWED_ORIGINS`, siehe "Umgebungsvariablen" weiter unten), da die
Clients dieses Servers nicht mehr garantiert seinen eigenen Ursprung
teilen. Unkonfiguriert bleibt es außerhalb von `NODE_ENV=production`
weit offen (heutiges Zero-Config-Verhalten für die lokale Entwicklung);
in Produktion werden alle Cross-Origin-Browseranfragen abgelehnt, bis die
Allowlist gesetzt ist - siehe den Kommentar über
`app.use(cors(corsOptions))` in `src/server.ts` für die vollständige
Begründung.

## 💾 Daten und Persistenz

Alles, was dieser Server besitzt, lebt unter `data/`, das beim ersten
Start automatisch erstellt wird:

- `data/settings.json` - der vollständige Zustandsbaum: Controller,
  Roboter, Systemkonfiguration. Wird nie als statische Datei
  ausgeliefert (explizites 404) - nur über die authentifizierte Route
  `/api/settings` erreichbar.
- `data/users.json` - Kontozugangsdaten (scrypt-gehasht, gesalzen, nie
  Klartext). Ebenfalls nie statisch ausgeliefert.
- `data/logs/server.log` - nur anhängendes Industrieprotokoll jedes
  Befehls.
- `data/WORKS/` - gespeicherte Roboter-Trajektorien, standardmäßig ein
  Ordner pro Roboter, als einfache statische Dateien ausgeliefert (Index
  + einzelne Arbeitsdateien).
- `data/model_submissions.json` + die eingereichten Modellordner selbst -
  die Serverseite des Ablaufs von
  [HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF),
  um "ein fertiges Robotermodell direkt in den Katalog dieses Servers zu
  übertragen".

## 📂 Repository-Struktur

```
HYDRA-UMC-SERVER/
├── src/
│   ├── server.ts       # Express-App + WebSocketServer + alle /api-Routen
│   ├── kinematics.ts   # Inverse-Kinematik-Hilfsfunktion für den atomaren Jog-Endpunkt
│   ├── metrics.ts      # Bedient GET /metrics - Prometheus-Textexposition (prom-client)
│   └── users.ts        # Konto-Speicher (scrypt-Passwort-Hashing)
├── admin-ui/            # Eigenständiges Vite/React-Admin-Panel für DIESEN Server selbst
│   │                      (verbundene Geräte, eigene Logdatei, eigene Konfiguration, eigene
│   │                      Benutzer - bewusst keine Robotersteuerung, das bleibt STUDIO-exklusiv)
│   ├── src/
│   │   ├── App.tsx, main.tsx, index.css, api.ts, LoginScreen.tsx
│   │   └── tabs/AboutTab.tsx, ConfigTab.tsx, DevicesTab.tsx, LogsTab.tsx, UsersTab.tsx
│   ├── package.json / tsconfig.json / vite.config.ts
│   └── README.md
├── data/                # Laufzeitzustand - Settings, Users, Logs, Arbeitsdateien, gespeicherte Punkte
│   ├── settings.json
│   ├── users.json
│   ├── logs/
│   ├── points/
│   └── WORKS/
├── docs/
│   ├── REMOTE_API.md              # Vollständiger Vertrag: Routen, WS-Protokoll, Auth
│   ├── PRODUCTION_BOOTSTRAP.md    # Erforderliches JWT und erster Administrator
│   └── REMOTE_ACCESS_VPN.md       # Echter Leitfaden für Remote-Zugriff/VPN-Deployment
├── images/               # Medien und Diagramme
├── systemd/
│   └── hydra-umc-server.service # Lokale systemd-Unit auf der CM5
├── tools/
│   ├── ci_validate.py                                   # Manifest-/CHANGELOG-/Doku-Validierung, von der CI genutzt
│   └── verify_*_contract.mjs, verify_auth_negative.mjs  # 11 echte Vertrags-/Negativ-Auth-Prüfungen gegen
│                                                           einen laufenden Server (CAN-OTA-Relay, Discovery,
│                                                           Ecosystem-Service-Steuerung/-Status, Integrations-
│                                                           Test-Connection, Produktions-Bootstrap, Roboter-
│                                                           befehle, Playback, Telemetrie-Relay, Sprach-Relay)
├── monitoring/           # Optionaler Prometheus + Grafana Stack - siehe monitoring/README.md
├── scripts/
│   └── bump-version.mjs # Legacy-Hilfe nur für die native Version; Standard-Builds nutzen bump_manifest_version.py
├── bump_manifest_version.py # Synchronisiert die Version von hydra-umc.project.json mit der nativen (--sync)
├── build.bat / build.sh # Installiert Abhängigkeiten + Produktions-Build
├── dev.bat / dev.sh      # Installiert Abhängigkeiten + startet den Entwicklungsserver
├── package.json
├── tsconfig.json
├── CHANGELOG.md
└── LICENSE
```

`public/` (STUDIOs gebautes statisches Frontend, zusammen mit diesem
Server unter `/` bereitgestellt) ist per gitignore ausgeschlossen - wird
durch Kopieren von STUDIOs eigenem Build-Output befüllt, nicht Teil eines
frischen Clones.

## 🛠️ Entwicklungsumgebung

### Voraussetzungen
- [Node.js](https://nodejs.org/) (v18 oder höher empfohlen)
- npm

### Installation

```bash
npm install
```

### Umgebungsvariablen

Optional - der Server läuft ohne jede Konfiguration, mit
entwicklungsfreundlichen Standardwerten für jede Variable unten. Setzen
Sie echte Werte, bevor dieser Server über ein vollständig
vertrauenswürdiges LAN hinaus freigegeben wird - z. B. über das offene
Internet via NAT/Portweiterleitung des Routers, was das Bedrohungsmodell
von "nur vertrauenswürdiges LAN" zu "von jedem erreichbar" ändert (siehe
`.env.example`):

- `JWT_SECRET` - signiert jedes Login-Token. Falls nicht gesetzt, wird
  stattdessen ein fester Entwicklungswert aus `src/server.ts` verwendet
  (in Ordnung für die lokale Entwicklung, nicht für ein Deployment
  außerhalb eines vertrauenswürdigen Netzwerks). Exportieren Sie sie über
  Ihre Shell oder über Ihren bevorzugten Prozessmanager/Container
  (systemd `Environment=`, die Umgebungskonfiguration von `pm2`, Docker
  `-e`, ...).
- `NODE_ENV` - setzen Sie `production` für jedes reale Deployment.
  Steuert die beiden Fallbacks unten (offenes CORS, stille Standardwerte)
  und aktiviert deutlich sichtbare Start-Warnungen, falls `JWT_SECRET`
  oder das geseedete `admin`/`admin`-Konto noch auf ihren Standardwerten
  stehen. Nicht gesetzt (oder jeder andere Wert) behält das heutige
  permissive Entwicklungsverhalten bei.
- `CORS_ALLOWED_ORIGINS` - kommagetrennte Liste von Ursprüngen, die
  Cross-Origin-Browseranfragen an diese API stellen dürfen - der reale
  Fall, auf den es hier ankommt, ist HYDRA-UMC STUDIO, das von einem
  anderen Host/Port als diesem Server ausgeliefert wird (z. B.
  `https://studio.example.com`, oder `http://192.168.1.20:5173` in der
  Entwicklung). Beispiel:
  `CORS_ALLOWED_ORIGINS=https://studio.example.com,http://192.168.1.20:5173`.
  Falls nicht gesetzt: `NODE_ENV != production` erlaubt jeden Ursprung
  (keine Konfiguration für die lokale Entwicklung nötig, entspricht dem
  bisherigen Verhalten dieses Projekts); `NODE_ENV = production`
  **verweigert** stattdessen jede Cross-Origin-Browseranfrage, bis dies
  gesetzt ist, mit einer deutlich sichtbaren Start-Warnung. Nicht-Browser-
  Clients (curl, HYDRA-UMC SUITE, die mobilen Apps) sind in beiden
  Fällen nie betroffen - CORS ist ein reiner Browser-Mechanismus.
- `JWT_EXPIRES_IN` - wie lange ein Login-Token gültig bleibt. Jede
  Zeichenkette, die die `expiresIn`-Option von `jsonwebtoken` selbst
  akzeptiert (`"24h"`, `"7d"`, eine reine Sekundenzahl, ...). Standardmäßig
  `30d`, falls nicht gesetzt (die ursprüngliche Annahme dieses Projekts
  eines vertrauenswürdigen LANs). **Ein Server, der über ein
  vertrauenswürdiges LAN hinaus erreichbar ist, sollte dies deutlich
  kürzer setzen - `24h` ist ein vernünftiger Ausgangspunkt** - ein
  geleaktes langlebiges Token kann nicht einzeln widerrufen werden, außer
  durch Ändern des Passworts dieses Kontos.
- `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` - drosselt
  ausschließlich `POST /api/login` (alle anderen Routen sind nicht
  betroffen). Standardmäßig 5 Versuche pro 15 Minuten pro IP, falls eine
  der beiden nicht gesetzt ist; ein ausgelöstes Limit antwortet mit `429`
  und einer klaren JSON-Fehlermeldung, nicht mit einem generischen `500`.
- `TLS_CERT_PATH` / `TLS_KEY_PATH` - setzen Sie **beide**, um den Server
  (REST-API + den `/ws`-WebSocket, der denselben Listener teilt) von
  einfachem HTTP/WS auf HTTPS/WSS umzuschalten. Siehe "TLS / HTTPS"
  unten. Wird eine der beiden nicht gesetzt, bleibt das heutige
  Klartext-HTTP-Verhalten unverändert.

### TLS / HTTPS

Standardmäßig deaktiviert - dieser Server lief schon immer als einfaches
HTTP/WS und tut das weiterhin, sofern nicht explizit aktiviert. Setzen
Sie sowohl `TLS_CERT_PATH` als auch `TLS_KEY_PATH` (siehe oben) auf ein
PEM-Zertifikat und den passenden privaten Schlüssel, und der gemeinsame
REST-+-WebSocket-Listener wechselt zu `https.createServer()` - `/ws` wird
dabei automatisch zu WSS, ohne separate Konfiguration. Ein gesetzter,
aber unlesbarer oder ungültiger Zertifikat-/Schlüsselpfad lässt den Start
laut fehlschlagen (ein echter `fs`-Fehler), statt still auf einfaches
HTTP zurückzufallen.

Das ist vor allem relevant, sobald dieser Server über ein vollständig
vertrauenswürdiges LAN hinaus erreichbar ist (z. B. über
NAT/Portweiterleitung des Routers für Remote-Tests freigegeben) - einfaches
HTTP bedeutet, dass jedes Bearer-Token, jeder Roboterbefehl und der
Admin-/Operator-Login selbst im Klartext über das Netzwerk laufen.

Ein Zertifikat besorgen:

- **Sie besitzen eine Domain, die auf diesen Server zeigt** - verwenden
  Sie [Let's Encrypt](https://letsencrypt.org/) (z. B. über
  [Certbot](https://certbot.eff.org/)) für ein echtes, browser-
  vertrauenswürdiges Zertifikat, kostenlos und automatisch erneuerbar.
  Zeigen Sie `TLS_CERT_PATH` / `TLS_KEY_PATH` auf das resultierende
  `fullchain.pem` / `privkey.pem`.
- **Lokale Tests, ohne Domain** - ein selbstsigniertes Zertifikat genügt,
  um den HTTPS/WSS-Codepfad zu testen (Browser und die meisten
  HTTP-Clients werden warnen/ein explizites manuelles Vertrauen
  verlangen, was für Tests erwartet und in Ordnung ist):
  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"
  ```
  Setzen Sie dann `TLS_CERT_PATH=./cert.pem` und `TLS_KEY_PATH=./key.pem`.

### Entwicklungsmodus

Führt den API/WebSocket-Server direkt mit `tsx` aus (kein Bundler, kein
Frontend beteiligt):
- **Windows:** Doppelklick auf `dev.bat` oder `npm run dev` ausführen
- **Linux/Mac:** `./dev.sh` oder `npm run dev` ausführen

### Produktions-Build

Bündelt den Server mit esbuild in eine einzelne bereitstellbare Datei:
- **Windows:** `build.bat` für einen versionierten Release-Build nutzen; `npm run build` nur zum Kompilieren verwenden.
- **Linux/Mac:** `./build.sh` für einen versionierten Release-Build nutzen; `npm run build` nur zum Kompilieren verwenden.

Dann den Produktionsserver starten mit:
```bash
npm start
```

Der Server lauscht auf `0.0.0.0:3000` - erreichbar unter
`http://localhost:3000` oder `http://<deine-lokale-ip>:3000` im lokalen
Netzwerk. Der gesamte Zustand wird in `data/` persistiert.

### Versionierung

Nur die Root-Skripte `build*.bat` und `build*.sh` erzeugen eine
Release-Versionserhöhung. Sie rufen `bump_manifest_version.py` genau einmal
auf und halten damit `package.json`, `hydra-umc.project.json` und
[`CHANGELOG.md`](CHANGELOG.md) nach der Basis-10-Kilometerzählerregel
synchron (`0.0.9` -> `0.1.0`, niemals `0.0.10`). `npm run build` kompiliert
bewusst ohne Versionserhöhung; direkte Builds und die `build-test`-Validierung
können daher niemals nur `package.json` verändern. Die laufende Version ist
über `GET /api/hydra-info` (`appVersion`) lesbar.

## 📊 Monitoring (Optional)

`GET /metrics` stellt die Prozess-Uptime, verbundene WebSocket-Clients,
die Schreiblatenz von `settings.json`, atomare Roboterbefehle nach Typ,
Authentifizierungsfehler sowie dieselben CPU-/Speicher-/Temperaturwerte
wie `GET /api/system/metrics` bereit - alles im Prometheus-Format. Ein
einsatzbereiter Prometheus + Grafana Stack (mit einem Start-Dashboard)
liegt unter **[`monitoring/`](monitoring/README.md)**: `docker compose up
-d` aus diesem Ordner genügt, um ihn zu starten. Vollständig optional -
nichts davon wird benötigt, damit der Server selbst funktioniert.

## 🔗 Verwandte Projekte

Dieses Projekt ist Teil des HYDRA-UMC-Robotik-Ökosystems desselben Autors (JuanenRac / Electro Hobby 3D). Gut zu wissen, da eine Anfrage eigentlich eines dieser Projekte betreffen könnte statt dieses Repositorys.

**Untergeordnete Projekte** — jedes davon ist ein echter Client oder eine Koordinationsbrücke, die nur über die API dieses Servers mit der Roboterflotte spricht
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — Web-Steuerungs-Dashboard mit Echtzeit-3D-Visualisierung mehrerer Roboter.
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — Desktop-Schwarmleitstand (PySide6) für mehrere Server gleichzeitig, verpackt als eigenständige ausführbare Datei.
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — native Android-Steuerungs-App mit biometrischem Login und einer gekoppelten Wear-OS-Begleit-App.
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — iOS/iPadOS-Steuerungs-App (Flutter) mit Echtzeit-WebSocket-Synchronisierung.
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — native Touch-UI für das eingebaute 7"-DSI-Touchscreen, direkt auf dem CM5 eingebettet.
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — Koordinationsschranke für AGV-/AMR-Flotten über einen echten VDA-5050-MQTT-Publisher.
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — High-Level-Koordinator für CNC-Zellen mit echtem GRBL-Status-/Steuerbyte-Zugriff.
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — Koordinationsschranke für laufende/humanoide Droiden, mit einem echten Boston-Dynamics-Spot-Befehlssender.
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — Sicherheitskoordinator für Laserzellen, liest 3 echte Schlüssel-/Gehäuse-/Verriegelungs-GPIO-Sicherungen.
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — sicherer High-Level-Koordinator für den Leiterplattenfluss von OpenPnP Pick-and-Place.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — sichere Koordinationsschranke für Moonraker/Klipper-3D-Drucker, mit echten gesicherten Job-Befehlen.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — Sicherheitskoordinator mit einem echten, träge importierten rclpy-ROS-2-Transport.
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — Koordinationsschranke für kameraausgestattete UAVs, mit einem echten MAVLink-Befehlssender.

**Direkt verwandt**
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — dieser Server leitet begrenzte, authentifizierte Sprachrunden über eine Loopback-Verbindung an diesen weiter und behält das Gateway-Token serverseitig, sodass Sprache nie zu einem direkten Roboterbefehl wird.
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — das physische Motherboard des Roboterarms, mit dem der eigene `spi_bridge`-Dienst dieses Servers über die echte CM5↔STM32H745-SPI-OTA-Verbindung spricht.

**Ebenfalls Teil des Ökosystems**

*Kern-Hardware & Plattform*
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — reproduzierbare Raspberry-Pi-OS-Produktschicht für den CM5, auf dem dieser Server läuft: schreibgeschützter Agent, validierte Konfiguration/Profile, WiFi-Ersteinrichtung.
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — der gemeinsame JSON-Schema-Vertrag und die Sicherheitsschranke, gegen die jede Bridge oben ihre Befehle validiert.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — grafischer Desktop-URDF-Ersteller/-Editor, der fertige Modelle in den eigenen Katalog dieses Servers überträgt.

*URTC-Werkzeugplattform*
- **[URTC](https://github.com/JuanenRac/URTC)** — Firmware für die physische Universal-Robot-Tool-Controller-Platine, 25+ Werkzeugprofile über CAN-Bus.
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — Desktop-GUI-Flash-Tool für URTC-Platinen, CAN-OTA plus Full-Chip-SWD/JTAG.
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — Desktop-Live-CAN-Bus-Diagnosetool für URTC-Platinen, ein Panel pro Werkzeugprofil.
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — browserbasierte Alternative zu URTC-TESTER über die Web-Serial-API, ohne lokale Installation.

*Vision-KI-Knoten (Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — Integrationsknoten für die Hailo-8-Vision-Pipeline, mit einer echten stufenweisen Hardware-Bereitschaftsprüfung.
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — echte Registry für kompilierte Modelle mit Hailo-Architektur-/Prüfsummen-Safe-Load-Verifizierung.
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — echter GStreamer-Pipeline- + MediaMTX-Konfigurationsgenerator mit einer echten HailoRT-Integrationsschranke.
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — echtes Position-Based-Visual-Servoing-Korrekturgesetz, sicherheitsgesteuert nach vorgelagertem Zonenstatus.
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — echte Zonenverletzungsprüfung und E-STOP-Anforderung, mit erzwungener Kalibrierungsaktualität.

*Kognitiver KI-Knoten (Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** — Integrationsknoten für die Hailo-10-Cognitive-Pipeline (LLM-/VLA-/Sprach-Orchestrierung).
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** — echte Aktions-Token-Kodierung/-Dekodierung und Trajektoriengenerierung für ein Vision-Language-Action-Modell.
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** — echte regelbasierte Aufgabenzerlegung und semantische Fehlerbehebung über MCU-Fehlercodes.
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** — echte, nur auf der Standardbibliothek basierende TF-IDF-Dokumentensuche über die eigenen Markdown-Dokumente dieses Ökosystems.

*Orchestrierung & Schwarm*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — Integrationsknoten mit einem echten gRPC/Protobuf-Health-Report-Vertrag und einer Missions-Zustandsmaschine.
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** — echte prioritätsbasierte Job-Queue mit Deduplizierung, über eine echte HTTP-API.
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — echter gRPC-basierter Flotten-Health-Watchdog mit Retry/Backoff und Identitäts-Mismatch-Erkennung.
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** — echter RRT-basierter 3D-Pfadplaner mit echter Hindernis-/Arbeitsraum-Kollisionsvalidierung.
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** — echte CRDT-LWW-Element-Map-Zustandssynchronisation, eigenschaftsgetestet auf Multi-Zellen-Konvergenz.

*Digitaler Zwilling & Simulation*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** — Integrationsknoten für die Digital-Twin-Engine, mit einem echten Versionskompatibilitäts-Sync-Vertrag.
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — echte Hardware-in-the-Loop-Sicherheitsverriegelung, die Befehle zwischen Simulation und echter Hardware routet.
- **[HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)** — echte Vorwärtskinematik und Gelenkgrenzenvalidierung über eine echte URDF-Teilmenge.
- **[HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)** — echter prozeduraler 2D-Szenengenerator mit YOLO/COCO-Annotationsexport.

*Daten & Analytik*
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** — echter sqlite3-gestützter Zeitreihenspeicher mit einer echten Ingest-/Abfrage-HTTP-API.
- **[HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)** — echter FFT- + statistischer Basislinien-Anomaliedetektor mit Drift-Überwachung.
- **[HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)** — echte OEE-/Verfügbarkeitsberechnung über den DATALAKE-Verlauf, mit reproduzierbarem CSV-Export.
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** — echte CAN/WebSocket-Ingestion-Pipeline in DATALAKE, mit Sequenz-Deduplizierung.

*Industrie-Gateway*
- **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** — Integrationsknoten, der zu Industrieprotokollen weiterleitet, mit einer echten Befehls-Allowlist-/Backpressure-Schicht.
- **[HYDRA-UMC-OPCUA-SERVER](https://github.com/JuanenRac/HYDRA-UMC-OPCUA-SERVER)** — echter OPC-UA-Adressraum, verifiziert mit einer echten Binärprotokoll-Client-Session.
- **[HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)** — echter MQTT-Broker mit optionaler Pro-Client-Authentifizierung und Topic-ACLs.
- **[HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)** — echte MTConnect-`/probe`- und `/current`-XML-Endpunkte mit Degraded-Mode-Ausgabe.

*Ergänzende Tools & Ökosystembetrieb*
- **[HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)** — Smart-Summaries- und Anomaly-Highlighting-Panels über DATALAKE/ANOMALY-DETECTOR, mit einem ehrlichen statistischen Fallback.
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** — Flotten-CLI mit einem echten, stabilen Exit-Code-Vertrag, ein echter Live-Client der eigenen API dieses Servers.
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — WearOS-Begleit-App mit echten haptischen Alarmen und einem Sprach-Relay zum gekoppelten Telefon.
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** — Firmware für ein Platinenmontagegestell mit echter Werkzeug-ID-Dekodierung und Smart-Idle-Vorheizlogik.
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** — Firmware plus ein echter Python-Vision-Begleiter für einen Thermal-/RGB-Inspektionswerkzeugkopf.
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** — administratives Desktop-Tool, das jedes Repository in diesem Ökosystem entdeckt, klont und aktualisiert.

---

## 👤 AUTOR
**JuanenRac** (Electro Hobby 3D)
📧 electrohobby3d@gmail.com
📺 [youtube.com/@electrohobby3d](https://youtube.com/@electrohobby3d)

## 📜 LIZENZ

HYDRA-UMC SERVER ist (c) 2026 JuanenRac (Electro Hobby 3D). Dieser
Hinweis muss in jeder Verbreitung dieses Projekts oder abgeleiteter
Werke enthalten sein.

Der Quellcode dieser Anwendung ist unter der **GNU General Public
License v3.0 (GPL-3.0)** verfügbar. Vollständiger Text unter
https://www.gnu.org/licenses/gpl-3.0.html.

Die Dokumentation (dieses README und seine eigenen Übersetzungen -
`README_spa.md`, `README_ita.md`, `README_fra.md`, `README_deu.md`,
`README_zho.md`, `README_jpn.md`) ist
verfügbar unter **Creative Commons Attribution-ShareAlike 4.0
International (CC BY-SA 4.0)**. Vollständiger Text unter
https://creativecommons.org/licenses/by-sa/4.0/.
