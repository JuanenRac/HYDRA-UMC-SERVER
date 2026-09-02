<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-SERVER banner" width="100%">
</p>
# 🛰️ HYDRA-UMC SERVER

<p align="center">
  <a href="README.md">🇺🇸 English</a> |
  <a href="README_spa.md">🇪🇸 Español</a> |
  🇫🇷 <b>Français</b> |
  <a href="README_ita.md">🇮🇹 Italiano</a> |
  <a href="README_deu.md">🇩🇪 Deutsch</a> |
  <a href="README_zho.md">🇨🇳 简体中文</a> |
  <a href="README_jpn.md">🇯🇵 日本語</a>
</p>


### 🤖 Backend headless API/WebSocket pour la Micro-Usine Multi-Robot HYDRA-UMC

<p align="left">
  <img src="https://img.shields.io/badge/Licence-GPL%203.0-blue.svg" alt="GPL 3.0">
  <img src="https://img.shields.io/badge/Runtime-Node.js-339933.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/Framework-Express-000000.svg" alt="Express">
</p>


---

## 🎯 Vue d'Ensemble

HYDRA-UMC SERVER est le backend autonome qui pilote une cellule de
micro-usine multi-robot HYDRA-UMC : un moteur Node.js/Express + WebSocket
qui possède l'état des robots, le persiste sur disque, authentifie chaque
écriture et diffuse les mises à jour en direct à chaque client connecté.
Il est fourni sans interface utilisateur ni étape de build frontend
propres - c'est un service pur API + WebSocket, conçu pour fonctionner
headless (sans navigateur, sans écran) sur la machine physiquement placée
à côté des robots (typiquement un Raspberry Pi CM5).

Il PEUT aussi, en option, servir le frontend déjà compilé de
**[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)**
comme fichiers statiques, pour le déploiement courant "tout sur une seule
machine, une seule origine" - exécutez **`build-frontend.sh`/`.bat`** une
fois (compile STUDIO depuis un checkout voisin et copie le résultat dans
le propre `public/` de ce dépôt, ignoré par git) et ce serveur commence à
le servir sur `/` dès son prochain démarrage. C'est ce qui permet à
HYDRA-UMC-ANDROID-CONTROL, HYDRA-UMC-IOS-CONTROL et HYDRA-UMC-DSI
d'intégrer le vrai visualiseur 3D de STUDIO dans leur propre WebView
interne, pointant vers le même ip:port de ce serveur. Entièrement
optionnel : sans exécuter ce script, ce serveur reste aussi headless que
décrit ci-dessus - `public/` n'existera simplement pas, et toutes les
routes continuent de fonctionner à l'identique.

Le même `build-frontend.sh`/`.bat` construit aussi le propre
**[`admin-ui/`](admin-ui/README.md)** de ce dépôt - un petit panneau
séparé pour administrer ce SERVEUR lui-même (appareils connectés, son
propre fichier de log, son propre port/nom, ses propres comptes
utilisateurs), servi sur `/admin`. Ce n'est délibérément PAS le contrôle
des robots (qui reste exclusif à STUDIO) - une exception ponctuelle et
explicite à la conception headless ci-dessus, pas un renoncement.

Ce projet faisait partie de **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)**,
distribué comme un "monolithe hybride" : un seul processus Node.js
exécutant à la fois le moteur de contrôle des robots *et* le tableau de
bord web Vite/React (avec le middleware de développement de Vite
directement branché sur la même application Express). Ce processus a été
scindé en deux :

- **HYDRA-UMC SERVER** *(ce dépôt)* - le moteur : état des
  robots/contrôleurs, API REST + WebSocket, authentification, découverte
  mDNS, soumission de modèles. Pas d'UI, pas de bundler, pas d'étape de
  build frontend.
- **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** -
  désormais un client Vite/React pur qui communique avec ce serveur par
  le réseau, exactement comme tout autre client de cette API.

## 🧩 Pourquoi Ce Projet Existe

Séparer le moteur du tableau de bord web était un choix délibéré, pas un
refactoring gratuit :

- **Isolation des ressources.** Une vue 3D lourde qui bloque l'onglet du
  navigateur ne partage plus de processus (et donc de contention
  CPU/E-S) avec le code réellement responsable du déplacement des
  robots. Si l'UI web se bloque, ce serveur continue de répondre aux
  commandes d'arrêt d'urgence de tout autre client connecté.
- **Un vrai contrôleur headless.** Ce processus peut fonctionner sans
  jamais charger d'UI sur l'hôte - le "cerveau" d'une cellule
  industrielle n'a pas besoin d'un onglet de navigateur ouvert pour
  fonctionner. Libère RAM/CPU sur du matériel contraint (un Raspberry Pi
  CM5) pour la partie du travail qui compte réellement : cinématique et
  contrôle.
- **Cycles de vie indépendants.** L'UI web peut être redéployée,
  redémarrée ou remplacée par une build plus récente sans jamais toucher
  ce processus - aucune interruption du contrôle des robots juste pour
  livrer une correction d'UI.
- **Hébergement flexible.** Ce serveur est destiné à fonctionner sur (ou
  juste à côté de) le matériel qu'il contrôle ; le client qui l'affiche
  peut être hébergé ailleurs, joignable par le réseau exactement comme
  les autres clients distants de cette même API.

## 🔌 Surface API et WebSocket

Chaque route, le contrat des messages WebSocket, l'authentification et le
modèle d'accès distant par client sont documentés dans
**[`docs/REMOTE_API.md`](docs/REMOTE_API.md)** - la seule source de
vérité pour tout ce qui communique avec ce serveur, y compris le code
client de HYDRA-UMC STUDIO lui-même. En résumé :

- API REST sous `/api/*` - lecture/écriture des settings, commandes
  atomiques de robot (jog/play/pause/stop/tool/valve/pump/speed/vision),
  gestion des comptes, upload/download de fichiers de travail, soumission
  de modèles, métriques système, découverte.
- Un seul point de terminaison WebSocket `/ws` (jeton bearer dans la
  query string) diffusant des snapshots complets `settings` et des mises
  à jour plus légères `delta` à chaque client connecté lorsque l'état
  change.
- Authentification JWT par jeton bearer sur chaque écriture ; deux rôles
  de compte (`admin`, `operator`) filtrent les écritures de
  settings/gestion des utilisateurs par rapport à l'exploitation
  quotidienne des robots.
- Annonce mDNS/Bonjour `_hydra._tcp` pour une découverte sans
  configuration sur le réseau local, plus un simple `GET /api/hydra-info`
  pour un scan de sous-réseau.
- `GET /metrics` - format d'exposition Prometheus (`prom-client`), pour le
  tableau de bord Grafana optionnel décrit dans "📊 Supervision" ci-dessous.

CORS est activé via une liste blanche configurable
(`CORS_ALLOWED_ORIGINS`, voir "Variables d'Environnement" ci-dessous)
puisque les clients de ce serveur ne partagent plus nécessairement sa
propre origine. Non configurée, elle reste grande ouverte en dehors de
`NODE_ENV=production` (comportement actuel sans configuration pour le
développement local) ; en production, elle refuse toute requête
cross-origin de navigateur tant que la liste blanche n'est pas définie -
voir le commentaire au-dessus de `app.use(cors(corsOptions))` dans
`src/server.ts` pour le raisonnement complet.

## 💾 Données et Persistance

Tout ce que ce serveur possède vit sous `data/`, créé automatiquement au
premier démarrage :

- `data/settings.json` - l'arbre d'état complet : contrôleurs, robots,
  configuration système. Jamais servi comme fichier statique (404
  explicite) - accessible uniquement via la route authentifiée
  `/api/settings`.
- `data/users.json` - identifiants de compte (hash scrypt, salé, jamais
  en clair). Également jamais servi statiquement.
- `data/logs/server.log` - journal industriel en ajout seul de chaque
  commande.
- `data/WORKS/` - trajectoires robot enregistrées, un dossier par robot
  par défaut, servies comme de simples fichiers statiques (index +
  fichiers de travail individuels).
- `data/model_submissions.json` + les dossiers des modèles soumis
  eux-mêmes - le côté serveur du flux de
  [HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)
  pour "pousser un modèle de robot terminé directement dans le catalogue
  de ce serveur".

## 📂 Structure du Dépôt

```
HYDRA-UMC-SERVER/
├── src/
│   ├── server.ts       # App Express + WebSocketServer + toutes les routes /api
│   ├── kinematics.ts   # Aide de cinématique inverse pour le point de terminaison atomique de jog
│   ├── metrics.ts      # Alimente GET /metrics - exposition texte Prometheus (prom-client)
│   └── users.ts        # Magasin de comptes (hachage de mot de passe scrypt)
├── admin-ui/            # Panneau d'administration Vite/React séparé pour CE serveur lui-même
│   │                      (appareils connectés, son propre fichier de log, sa propre config, ses
│   │                      propres utilisateurs - délibérément pas de contrôle robot, réservé à STUDIO)
│   ├── src/
│   │   ├── App.tsx, main.tsx, index.css, api.ts, LoginScreen.tsx
│   │   └── tabs/AboutTab.tsx, ConfigTab.tsx, DevicesTab.tsx, LogsTab.tsx, UsersTab.tsx
│   ├── package.json / tsconfig.json / vite.config.ts
│   └── README.md
├── data/                # État d'exécution - settings, users, logs, fichiers de travail, points enregistrés
│   ├── settings.json
│   ├── users.json
│   ├── logs/
│   ├── points/
│   └── WORKS/
├── docs/
│   ├── REMOTE_API.md              # Contrat complet : routes, protocole WS, auth
│   ├── PRODUCTION_BOOTSTRAP.md    # JWT et administrateur initial obligatoires
│   └── REMOTE_ACCESS_VPN.md       # Guide réel de déploiement accès distant/VPN
├── images/               # Médias et diagrammes
├── systemd/
│   └── hydra-umc-server.service # Unité systemd locale sur la CM5
├── tools/
│   ├── ci_validate.py                                   # Validation manifest/CHANGELOG/docs utilisée par la CI
│   └── verify_*_contract.mjs, verify_auth_negative.mjs  # 11 vérifications réelles de contrat/auth négative
│                                                           contre un serveur réel (relais CAN-OTA, discovery,
│                                                           contrôle/statut des services de l'écosystème,
│                                                           test-connection des intégrations, bootstrap de
│                                                           production, commandes robot, playback, relais de
│                                                           télémétrie, relais vocal)
├── monitoring/           # Stack Prometheus + Grafana optionnel - voir monitoring/README.md
├── scripts/
│   └── bump-version.mjs # Aide native héritée ; les builds standard utilisent bump_manifest_version.py
├── bump_manifest_version.py # Synchronise la version de hydra-umc.project.json avec la version native (--sync)
├── build.bat / build.sh # Installe les dépendances + build de production
├── dev.bat / dev.sh      # Installe les dépendances + démarre le serveur de dev
├── package.json
├── tsconfig.json
├── CHANGELOG.md
└── LICENSE
```

`public/` (le frontend statique compilé de STUDIO, déployé aux côtés de ce
serveur sur `/`) est ignoré par git - rempli en copiant la sortie de build
propre de STUDIO, ne fait pas partie d'un clone neuf.

## 🛠️ Environnement de Développement

### Prérequis
- [Node.js](https://nodejs.org/) (v18 ou supérieur recommandé)
- npm

### Installation

```bash
npm install
```

### Variables d'Environnement

Optionnel - le serveur fonctionne sans aucune configuration, avec des
valeurs par défaut adaptées au développement pour chaque variable
ci-dessous. Définissez des valeurs réelles avant d'exposer ce serveur
au-delà d'un LAN totalement fiable - par exemple sur l'internet ouvert via
le NAT/redirection de ports d'un routeur, ce qui change le modèle de
menace de "LAN de confiance uniquement" à "accessible par n'importe qui"
(voir `.env.example`) :

- `JWT_SECRET` - signe chaque jeton de connexion. Si non définie, une
  valeur de développement fixe intégrée dans `src/server.ts` est utilisée
  à la place (convient au développement local, pas à un déploiement
  accessible hors d'un réseau de confiance). Exportez-la depuis votre
  shell, ou via votre gestionnaire de processus/conteneur préféré
  (`Environment=` de systemd, la configuration d'environnement de `pm2`,
  `-e` de Docker...).
- `NODE_ENV` - définissez `production` pour tout déploiement réel.
  Contrôle les deux comportements de repli ci-dessous (CORS ouvert,
  valeurs par défaut silencieuses) et active des avertissements de
  démarrage bien visibles si `JWT_SECRET` ou le compte `admin`/`admin`
  initial sont encore à leur valeur par défaut. Non définie (ou toute
  autre valeur) conserve le comportement permissif de développement
  actuel.
- `CORS_ALLOWED_ORIGINS` - liste d'origines séparées par des virgules
  autorisées à faire des requêtes cross-origin de navigateur vers cette
  API - le cas réel qui compte ici est HYDRA-UMC STUDIO servi depuis un
  hôte/port différent de ce serveur (ex. `https://studio.example.com`, ou
  `http://192.168.1.20:5173` en développement). Exemple :
  `CORS_ALLOWED_ORIGINS=https://studio.example.com,http://192.168.1.20:5173`.
  Si non définie : `NODE_ENV != production` autorise toute origine (aucune
  configuration nécessaire pour le développement local, comportement
  historique de ce projet) ; `NODE_ENV = production` **refuse** au
  contraire toute requête cross-origin de navigateur tant que ceci n'est
  pas défini, avec un avertissement de démarrage bien visible. Les
  clients non-navigateur (curl, HYDRA-UMC SUITE, les applications
  mobiles) ne sont jamais affectés dans un cas comme dans l'autre - CORS
  est un mécanisme propre aux navigateurs.
- `JWT_EXPIRES_IN` - durée de validité d'un jeton de connexion. Toute
  chaîne acceptée par l'option `expiresIn` propre à `jsonwebtoken`
  (`"24h"`, `"7d"`, un nombre de secondes brut...). Par défaut `30d` si
  non définie (l'hypothèse originelle de ce projet d'un LAN de confiance).
  **Un serveur accessible au-delà d'un LAN de confiance devrait définir
  ceci beaucoup plus court - `24h` est un bon point de départ** - un jeton
  longue durée qui fuite ne peut pas être révoqué individuellement, sauf
  en changeant le mot de passe de ce compte.
- `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` - limite
  uniquement `POST /api/login` (les autres routes ne sont pas affectées).
  Par défaut 5 tentatives par 15 minutes par IP si l'une des deux n'est
  pas définie ; une limite atteinte répond `429` avec une erreur JSON
  claire, pas un `500` générique.
- `TLS_CERT_PATH` / `TLS_KEY_PATH` - définissez les **deux** pour faire
  passer le serveur (API REST + le WebSocket `/ws`, qui partage le même
  listener) de HTTP/WS en clair à HTTPS/WSS. Voir "TLS / HTTPS"
  ci-dessous. Laisser l'une ou l'autre non définie conserve le
  comportement HTTP en clair actuel sans changement.

### TLS / HTTPS

Désactivé par défaut - ce serveur a toujours fonctionné en HTTP/WS en
clair, et continue ainsi sauf activation explicite. Définissez à la fois
`TLS_CERT_PATH` et `TLS_KEY_PATH` (voir ci-dessus) vers un certificat PEM
et sa clé privée correspondante, et le listener partagé REST + WebSocket
passe à `https.createServer()` - `/ws` devient automatiquement WSS avec
lui, sans configuration séparée nécessaire. Un chemin de certificat/clé
défini mais illisible ou invalide fait échouer le démarrage bruyamment
(une vraie erreur `fs`) plutôt que de revenir silencieusement au HTTP en
clair.

Ceci importe surtout une fois que ce serveur est accessible au-delà d'un
LAN totalement fiable (ex. exposé via le NAT/redirection de ports d'un
routeur pour des tests à distance) - le HTTP en clair signifie que chaque
jeton bearer, chaque commande de robot, et la connexion admin/opérateur
elle-même traversent le réseau en clair.

Obtenir un certificat :

- **Vous possédez un domaine pointant vers ce serveur** - utilisez
  [Let's Encrypt](https://letsencrypt.org/) (ex. via
  [Certbot](https://certbot.eff.org/)) pour un certificat réel, reconnu
  par les navigateurs, gratuit et renouvelable automatiquement. Pointez
  `TLS_CERT_PATH` / `TLS_KEY_PATH` vers le `fullchain.pem` / `privkey.pem`
  résultant.
- **Tests locaux, sans domaine** - un certificat auto-signé suffit pour
  exercer le chemin de code HTTPS/WSS (les navigateurs et la plupart des
  clients HTTP avertiront/exigeront une confiance manuelle explicite, ce
  qui est normal et acceptable pour des tests) :
  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"
  ```
  Définissez ensuite `TLS_CERT_PATH=./cert.pem` et `TLS_KEY_PATH=./key.pem`.

### Mode Développement

Exécute le serveur API/WebSocket directement avec `tsx` (pas de bundler,
pas de frontend impliqué) :
- **Windows :** double-cliquez sur `dev.bat` ou lancez `npm run dev`
- **Linux/Mac :** lancez `./dev.sh` ou `npm run dev`

### Build de Production

Empaquette le serveur en un seul fichier déployable avec esbuild :
- **Windows :** utilisez `build.bat` pour un build de publication versionné ; utilisez `npm run build` pour compiler seulement.
- **Linux/Mac :** utilisez `./build.sh` pour un build de publication versionné ; utilisez `npm run build` pour compiler seulement.

Puis démarrez le serveur de production avec :
```bash
npm start
```

Le serveur écoute sur `0.0.0.0:3000` - accessible via
`http://localhost:3000` ou `http://<votre-ip-locale>:3000` sur le réseau
local. Tout l'état persiste dans `data/`.

### Versionnage

Seuls les scripts racine `build*.bat` et `build*.sh` créent un incrément de
version de publication. Ils appellent `bump_manifest_version.py` une seule
fois, en gardant `package.json`, `hydra-umc.project.json` et
[`CHANGELOG.md`](CHANGELOG.md) synchronisés selon la règle du compteur en
base 10 (`0.0.9` -> `0.1.0`, jamais `0.0.10`). `npm run build` compile
volontairement sans versionner ; les builds directs et la validation
`build-test` ne peuvent donc jamais modifier uniquement `package.json`. La
version en cours est lisible depuis `GET /api/hydra-info` (`appVersion`).

## 📊 Supervision (Optionnel)

`GET /metrics` expose le temps de fonctionnement du processus, le nombre
de clients WebSocket connectés, la latence d'écriture de `settings.json`,
les commandes atomiques de robot par type, les échecs d'authentification,
et les mêmes chiffres CPU/mémoire/température que
`GET /api/system/metrics` - le tout au format Prometheus. Une pile
Prometheus + Grafana prête à l'emploi (avec un tableau de bord de départ)
se trouve dans **[`monitoring/`](monitoring/README.md)** : `docker compose
up -d` depuis ce dossier suffit à la démarrer. Entièrement optionnel - rien
ici n'est nécessaire au fonctionnement du serveur lui-même.

## 🔗 Projets Liés

Ce projet fait partie de l'écosystème robotique HYDRA-UMC du même auteur (JuanenRac / Electro Hobby 3D). Bon à savoir, car une demande pourrait en réalité concerner l'un de ceux-ci plutôt que ce dépôt.

**Projets Enfants** — chacun est un vrai client ou un pont de coordination qui ne parle à la flotte de robots que via l'API de ce serveur
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — tableau de bord de contrôle web avec visualisation 3D multi-robot en temps réel.
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — centre de commande d'essaim de bureau (PySide6) pour plusieurs serveurs à la fois, empaqueté en exécutable autonome.
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — application de contrôle Android native avec connexion biométrique et un compagnon Wear OS jumelé.
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — application de contrôle iOS/iPadOS (Flutter) avec synchronisation WebSocket en temps réel.
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — interface tactile native pour l'écran tactile DSI 7" embarqué, intégrée directement sur le CM5.
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — frontière de coordination pour les flottes AGV/AMR via un éditeur MQTT VDA 5050 réel.
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — coordinateur haut niveau pour cellules CNC avec accès réel au statut/octets de contrôle GRBL.
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — frontière de coordination pour droïdes à pattes/humanoïdes, avec un véritable émetteur de commandes Boston Dynamics Spot.
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — coordinateur de sécurité pour cellules laser lisant 3 vraies sécurités GPIO de clé/enceinte/verrouillage.
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — coordinateur haut niveau sûr pour le flux de cartes du pick-and-place OpenPnP.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — frontière de coordination sûre pour imprimantes 3D Moonraker/Klipper, avec de vraies commandes de tâche contrôlées.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — coordinateur de sécurité avec un vrai transport ROS 2 rclpy à importation paresseuse.
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — frontière de coordination pour UAV équipés de caméra, avec un véritable émetteur de commandes MAVLink.

**Directement Liés**
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — ce serveur relaie vers lui des tours de parole limités et authentifiés via une connexion loopback, en gardant le jeton de passerelle côté serveur, pour que la voix ne devienne jamais directement une commande robot.
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — la carte mère physique du bras robotique, avec laquelle le propre service `spi_bridge` de ce serveur communique via la vraie liaison SPI-OTA CM5↔STM32H745.

**Fait Également Partie de l'Écosystème**

*Matériel & Plateforme de Base*
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — couche produit reproductible sur Raspberry Pi OS pour le CM5 sur lequel tourne ce serveur : agent en lecture seule, config/profils validés, provisionnement WiFi de premier contact.
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — le contrat JSON-Schema partagé et la barrière de sécurité contre laquelle chaque bridge ci-dessus valide ses commandes.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — créateur/éditeur graphique de bureau pour URDF qui envoie les modèles terminés vers le propre catalogue de ce serveur.

*Plateforme d'Outils URTC*
- **[URTC](https://github.com/JuanenRac/URTC)** — firmware pour la carte physique Universal Robot Tool Controller, plus de 25 profils d'outil sur bus CAN.
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — outil de bureau à interface graphique pour flasher les cartes URTC, CAN-OTA plus SWD/JTAG puce complète.
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — outil de bureau de diagnostic CAN-bus en direct pour cartes URTC, un panneau par profil d'outil.
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — alternative basée navigateur à URTC-TESTER via la Web Serial API, sans installation locale.

*Nœud IA de Vision (Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — hub d'intégration pour le pipeline de vision Hailo-8, avec une vraie vérification de disponibilité matérielle par étape.
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — registre réel de modèles compilés avec vérification de chargement sécurisé par architecture Hailo/checksum.
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — générateur réel de pipeline GStreamer + config MediaMTX, avec une vraie frontière d'intégration HailoRT.
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — vraie loi de correction Position-Based Visual Servoing, verrouillée sur l'état de zone en amont.
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — vraie vérification de violation de zone et demande d'E-STOP, avec application de la fraîcheur de calibration.

*Nœud IA Cognitif (Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** — hub d'intégration pour le pipeline cognitif Hailo-10 (orchestration LLM/VLA/voix).
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** — vrai encodage/décodage de jetons d'action et génération de trajectoire pour un modèle Vision-Language-Action.
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** — vraie décomposition de tâches basée sur des règles et récupération sémantique d'erreurs sur les codes d'erreur MCU.
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** — vraie recherche documentaire TF-IDF (bibliothèque standard uniquement) sur les propres documents Markdown de cet écosystème.

*Orchestration & Essaim*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — hub d'intégration avec un vrai contrat de rapport de santé gRPC/Protobuf et une machine à états de mission.
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** — vraie file de tâches basée sur la priorité avec déduplication, via une vraie API HTTP.
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — vrai chien de garde de santé de flotte basé sur gRPC, avec retry/backoff et détection d'incohérence d'identité.
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** — vrai planificateur de trajectoire 3D basé sur RRT, avec vraie validation des collisions obstacle/espace de travail.
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** — vraie synchronisation d'état CRDT LWW-Element-Map, testée par propriétés pour la convergence multi-cellule.

*Jumeau Numérique & Simulation*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** — hub d'intégration pour le moteur de jumeau numérique, avec un vrai contrat de synchronisation par compatibilité de version.
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — vrai verrouillage de sécurité hardware-in-the-loop routant les commandes entre simulation et matériel réel.
- **[HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)** — vraie cinématique directe et validation des limites articulaires sur un vrai sous-ensemble URDF.
- **[HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)** — vrai générateur procédural de scènes 2D avec export d'annotations YOLO/COCO.

*Données & Analytique*
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** — vrai magasin de séries temporelles basé sur sqlite3, avec une vraie API HTTP d'ingestion/requête.
- **[HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)** — vrai détecteur d'anomalies FFT + ligne de base statistique, avec surveillance de dérive.
- **[HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)** — vrai calcul OEE/disponibilité sur l'historique de DATALAKE, avec export CSV reproductible.
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** — vrai pipeline d'ingestion CAN/WebSocket vers DATALAKE, avec déduplication par séquence.

*Passerelle Industrielle*
- **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** — hub d'intégration relayant vers les protocoles industriels, avec une vraie couche de liste blanche de commandes/contre-pression.
- **[HYDRA-UMC-OPCUA-SERVER](https://github.com/JuanenRac/HYDRA-UMC-OPCUA-SERVER)** — vrai espace d'adressage OPC-UA, vérifié avec une vraie session client du protocole binaire.
- **[HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)** — vrai broker MQTT avec authentification par client optionnelle et ACL de sujets.
- **[HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)** — vrais points de terminaison XML MTConnect `/probe` et `/current`, avec sortie en mode dégradé.

*Outils Complémentaires & Opérations de l'Écosystème*
- **[HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)** — panneaux Smart Summaries et Anomaly Highlighting sur DATALAKE/ANOMALY-DETECTOR, avec un repli statistique honnête.
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** — CLI de flotte avec un vrai contrat de codes de sortie stable, un vrai client en direct de la propre API de ce serveur.
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — application compagnon WearOS avec de vraies alertes haptiques et un relais vocal vers le téléphone jumelé.
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** — firmware pour un rack de montage de cartes avec décodage réel d'ID d'outil et logique de préchauffage Smart Idle.
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** — firmware plus un vrai compagnon de vision Python pour une tête d'outil d'inspection thermique/RGB.
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** — outil administratif de bureau qui découvre, clone et met à jour chaque dépôt de cet écosystème.

---

## 👤 AUTEUR
**JuanenRac** (Electro Hobby 3D)
📧 electrohobby3d@gmail.com
📺 [youtube.com/@electrohobby3d](https://youtube.com/@electrohobby3d)

## 📜 LICENCE

HYDRA-UMC SERVER est (c) 2026 JuanenRac (Electro Hobby 3D). Cette mention
doit être incluse dans toute distribution de ce projet ou de travaux
dérivés.

Le code source de cette application est disponible sous la **GNU General
Public License v3.0 (GPL-3.0)**. Texte complet sur
https://www.gnu.org/licenses/gpl-3.0.html.

La documentation (ce README et ses propres traductions - `README_spa.md`,
`README_ita.md`, `README_fra.md`, `README_deu.md`, `README_zho.md`,
`README_jpn.md`) est disponible sous
**Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA
4.0)**. Texte complet sur https://creativecommons.org/licenses/by-sa/4.0/.
