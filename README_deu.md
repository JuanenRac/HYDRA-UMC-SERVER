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
│   └── users.ts        # Konto-Speicher (scrypt-Passwort-Hashing)
├── data/                # Laufzeitzustand - Settings, Users, Logs, Arbeitsdateien
│   ├── settings.json
│   ├── users.json
│   ├── logs/
│   └── WORKS/
├── docs/
│   ├── REMOTE_API.md              # Vollständiger Vertrag: Routen, WS-Protokoll, Auth
│   └── PRODUCTION_BOOTSTRAP.md    # Erforderliches JWT und erster Administrator
├── tools/
│   └── verify_production_bootstrap_contract.mjs # Prüft sicheres Scheitern in Produktion
├── monitoring/           # Optionaler Prometheus + Grafana Stack - siehe monitoring/README.md
├── scripts/
│   └── bump-version.mjs # Legacy-Hilfe nur für die native Version; Standard-Builds nutzen bump_manifest_version.py
├── build.bat / build.sh # Installiert Abhängigkeiten + Produktions-Build
├── dev.bat / dev.sh      # Installiert Abhängigkeiten + startet den Entwicklungsserver
├── package.json
├── tsconfig.json
├── CHANGELOG.md
└── LICENSE
```

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

Dieses Projekt ist Teil eines größeren Robotik-Ökosystems desselben Autors (JuanenRac / Electro Hobby 3D), das aus vielen Projekten besteht - von Firmware über Steuerungssoftware bis hin zu KI-Nodes und Fleet-Tooling. Gut zu wissen, da eine Anfrage sich eigentlich auf eines davon statt auf dieses Repository beziehen könnte.

### Direkt mit Diesem Server Verwandt

- **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** — stellt den Zustand dieses Servers über OPC-UA/MQTT bereit.
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** — nimmt die von diesem Server erzeugten Logs auf.
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** — nimmt die von diesem Server erzeugten Logs auf.
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — koordiniert mehrere Instanzen dieses Servers.
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — koordiniert mehrere Instanzen dieses Servers und verwaltet deren Failover.
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — bildet die Brücke zwischen diesem Server und dem digitalen Zwilling.
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** — führt flottenweites DevOps gegen die API dieses Servers aus.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — stellt nur authentifizierte, übergeordnete Koordination zwischen diesem Server und ROS 2 bereit.
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — koordiniert nachverfolgbare PCB-Übergaben über den autorisierten Serverpfad.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — koordiniert Druckerhilfen über den Server; die native Firmware bleibt autoritativ.
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — fordert begrenzte CNC-Zellenhilfen an, ohne die Controller-Sicherheit zu ersetzen.
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — fordert Laserzellenhilfen an, ohne einen Weg zum Scharfschalten oder Auslösen eines Lasers bereitzustellen.

### Rest des Ökosystems

**HYDRA-UMC-Plattform** — die Multi-Roboter-Mikrofabrikzelle
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — das Mainboard selbst: Raspberry-Pi-CM5-Host + Dual-Core-STM32H745-Echtzeit-Coprozessor, der bis zu 8 verteilte Roboterarme über CAN-OTA/SPI-OTA orchestriert. Eigene Hardware + Firmware, GPL-3.0/CERN-OHL-S v2/CC BY-SA 4.0.
- **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — webbasiertes Steuerungs-Dashboard für HYDRA-UMC: Multi-Roboter-3D-Visualisierung, Kinematik-/Trajektorienaufzeichnung, CAN-OTA-Flashing und -Tests für die gesamte Plattform. React + Vite + Three.js - jetzt ein reiner Frontend-Client, der über das Netzwerk mit genau diesem Server spricht, exakt wie jeder andere Client der Liste unten.
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — Android-Steuerungs-App für HYDRA-UMC über Wi-Fi/Bluetooth. Echte, funktionierende App - vollständiger Funktionsumfang zur Fernsteuerung, JWT-Authentifizierung, verschlüsselte Anmeldedatenspeicherung.
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — iOS/iPadOS-Steuerungs-App für HYDRA-UMC über Wi-Fi, in Flutter erstellt (plattformübergreifend, unter Windows ohne Mac verifizierbar; das endgültige `.ipa`-Packaging benötigt weiterhin Xcode). Echte, funktionierende App - derselbe Funktionsumfang wie die Android-App.
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — Desktop-Kommandozentrale (Python/PySide6) für den Schwarm: Multi-Controller-Netzwerkerkennung, bidirektionale Live-Synchronisation, echter 3D-Roboter-Viewport, andockbarer Arbeitsbereich im Photoshop-Stil. Echt und funktionsfähig, kein Platzhalter.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — grafischer Desktop-URDF-Ersteller/-Editor (Python/PySide6) für den Modellkatalog dieses Projekts: bezieht Quelldateien von GitHub oder einem lokalen Ordner, validiert die Machbarkeit der Freiheitsgrade, bearbeitet Farbe/Skalierung/Kinematik mit Live-3D-Vorschau und überträgt das fertige Ergebnis direkt in den Katalog dieses Servers. Echt und funktionsfähig, kein Platzhalter.
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — native Flutter-Touch-UI für HYDRA-UMCs eigenen 5"/7"-DSI-Touchscreen (1280×720, gleiche Auflösung bei beiden Größen) am Compute Module 5, das denselben Server direkt von der Platine aus steuert. Echtes, funktionierendes Grundgerüst mit allen 6 Katalogbildschirmen, angebunden an den Live-Server; echter Linux-Ziel-Build noch nicht auf echter Hardware ausgeführt.

**URTC-Plattform** — der Werkzeugkopf-Controller, den jeder HYDRA-UMC-Roboterarm trägt
- **[URTC](https://github.com/JuanenRac/URTC)** — Universal Robot Tool Controller: STM32F303-basierter CAN-Bus-Werkzeugkopf-Controller, 25 vollständig implementierte Werkzeugprofile, CAN-OTA-Firmware-Update.
- **[URTC Flasher](https://github.com/JuanenRac/URTC-FLASHER)** — Desktop-Tool für CAN-OTA- + Full-Chip-SWD/JTAG-Flashing für URTC-Platinen (Windows/Linux).
- **[URTC Tester](https://github.com/JuanenRac/URTC-TESTER)** — Desktop-Tool für Live-CAN-Bus-Diagnose für URTC-Platinen, ein Panel pro Werkzeugprofil (Windows/Linux).
- **[URTC Web Studio](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — browserbasierte Alternative zu den 2 oben genannten Desktop-Tools (Web Serial API + SLCAN), keine lokale Installation nötig.

**👁️ Vision-KI-Node (Hailo-8)**
- [HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)
- [HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)
- [HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)
- [HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)
- [HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)

**🧠 Kognitiver KI-Node (Hailo-10)**
- [HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)
- [HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)
- [HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)
- [HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)
- [HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)

**🐝 Orchestrierung & Schwarm**
- [HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)
- [HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)
- [HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)

**🎮 Digitaler Zwilling & Simulation**
- [HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)
- [HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)
- [HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)

**📊 Daten & Analytik**
- [HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)
- [HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)

**🏭 Industrielles Gateway**
- [HYDRA-UMC-OPCUA-SERVER](https://github.com/JuanenRac/HYDRA-UMC-OPCUA-SERVER)
- [HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)
- [HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)

**🛠️ Ergänzende Werkzeuge**
- [URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)
- [URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)
- [HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)
- [HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)

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
