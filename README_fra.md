<!-- =============================================================================
HYDRA-UMC-SERVER - Headless REST and WebSocket backend of the HYDRA-UMC micro-factory
Copyright (C) JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
GPL-3.0-or-later - see LICENSE
============================================================================= -->

<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-SERVER banner" width="100%">
</p>

# 🤖 HYDRA-UMC-SERVER

<p align="center"><a href="README.md">🇺🇸 English</a> | <a href="README_spa.md">🇪🇸 Español</a> | 🇫🇷 <b>Français</b> | <a href="README_ita.md">🇮🇹 Italiano</a> | <a href="README_deu.md">🇩🇪 Deutsch</a> | <a href="README_zho.md">🇨🇳 简体中文</a> | <a href="README_jpn.md">🇯🇵 日本語</a> | <a href="README_por.md">🇵🇹 Português</a></p>

### 🤖 Backend headless API/WebSocket pour la Micro-Usine Multi-Robot HYDRA-UMC

<p align="center">
  <img src="https://img.shields.io/badge/License-GPL%203.0--or--later-blue.svg" alt="GPL 3.0 or later">
  <img src="https://img.shields.io/badge/Runtime-Node.js-339933.svg" alt="Runtime">
  <img src="https://img.shields.io/badge/Framework-Express-000000.svg" alt="Framework">
  <img src="https://img.shields.io/badge/Language-TypeScript-3178C6.svg" alt="Language">
  <img src="https://img.shields.io/badge/Protocol-WebSocket-lightgrey.svg" alt="Protocol">
  <img src="https://img.shields.io/badge/Tests-414%20passing-2ea44f.svg" alt="Tests">
  <img src="https://img.shields.io/badge/Version-0.8.1.5-0f6cbd.svg" alt="Version">
  <img src="https://img.shields.io/badge/Maturity-functional-0F6CBD.svg" alt="Maturity">
</p>

---

> **Vérification d'honnêteté - ce qui fonctionne réellement aujourd'hui :** le moteur Express + WebSocket, sa surface REST et WebSocket (63 opérations sur 58 chemins), la connexion JWT avec rotation du jeton de rafraîchissement et scrypt, la découverte mDNS, les réservations et révisions de robots, la lecture, et les relais vers CAN-OTA, la télémétrie, la voix, les services d'IA locaux et le connector hub sont réels et testés contre une instance réelle de ce même serveur que les tests démarrent eux-mêmes : 414 tests unitaires plus 28 scripts de contrat de bout en bout, tous réussis. Ce qui touche au matériel et n'est pas vérifié ici : la liaison avec une vraie CM5 HYDRA-UMC et une carte STM32H745, du vrai code exercé seulement par la couche API et contrats. TLS, Bluetooth LE, le pont MQTT et la pile Prometheus et Grafana sont réels, facultatifs et désactivés par défaut.

---

> **État de la sûreté et de la cybersécurité :** cet écosystème n'est pas un système de sécurité certifié. Il n'existe pas encore de chaîne d'E-STOP matérielle, ni de limites ou de verrouillages imposés par le firmware, ni de commande de mouvement vérifiée ; les images de firmware sont contrôlées par CRC-32 et une signature Ed25519, et une compilation de version refuse les clés de développement publiées (les têtes d'outil et les cartes d'extension derrière le relais utilisent encore les chargeurs d'URTC, qui prennent un HMAC-SHA256 à clé partagée au lieu d'une signature) ; TLS et TLS mutuel sont optionnels et désactivés par défaut ; aucune carte propre n'a encore été assemblée ni testée. Lisez la [base de sécurité](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md) et le [modèle de menaces](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md) avant de vous fier à une affirmation d'ici pour la sécurité d'une personne.

---

## 📋 En un coup d'œil

| | |
|---|---|
| Version | `0.8.1.5` |
| Maturité | Fonctionnel |
| Tests | 414 (`npm run test:unit`) |
| Technologie | Node.js 20+ / Express / WebSocket (ws) / REST/OpenAPI |
| Cible | Le Raspberry Pi CM5 d'une cellule HYDRA-UMC |
| Sur matériel réel | Exécuté sur un banc d'essai : la vérification d'honnêteté ci-dessus indique quelles parties ont tourné sur du matériel réel |

**Aller à :** [Présentation](#-présentation) · [Architecture](#-architecture) · [Fonctionnalités](#-fonctionnalités) · [Sécurité et protection](#-sécurité-et-protection) · [Interfaces](#-interfaces) · [Configuration](#-configuration) · [Démarrage rapide](#-démarrage-rapide) · [Tests](#-tests) · [Dépannage](#-dépannage) · [Structure du dépôt](#-structure-du-dépôt) · [Projets liés](#-projets-liés)

## 🚦 État du projet

Chaque ligne est une partie de ce dépôt et le feu dit où elle en est aujourd'hui. Elle est écrite d'après ce que le dépôt peut montrer (tests, compilations, exécutions), pas d'après ce qui est prévu.

🟢 Fait et vérifié · 🟡 Fonctionne, avec des limites connues · 🟠 À moitié fait ou pas encore vérifié · 🔴 Pas fait ou ne fonctionne pas

| Domaine | État | Ce que cela veut dire ici |
|---|---|---|
| Logiciel | 🟡 | Fonctionne pour son usage principal ; la vérification d'honnêteté ci-dessus liste ce qui manque encore |
| Tests | 🟢 | 414 tests automatiques, exécutés à chaque modification |
| Matériel réel | 🟡 | Exécuté sur un banc d'essai : la vérification d'honnêteté ci-dessus indique quelles parties ont tourné sur du matériel réel |
| Documentation | 🟢 | README en huit langues, vérifié par rapport au manifeste à chaque modification |

## 🎯 Présentation

HYDRA-UMC SERVER est le backend autonome qui pilote une cellule de
micro-usine multi-robot HYDRA-UMC : un moteur Node.js/Express + WebSocket
qui possède l'état des robots, le persiste sur disque, authentifie chaque
écriture et diffuse les mises à jour en direct à chaque client connecté.
Il est fourni sans interface utilisateur ni étape de build frontend
propres - c'est un service pur API + WebSocket, conçu pour fonctionner
headless (sans navigateur, sans écran) sur la machine physiquement placée
à côté des robots (typiquement un Raspberry Pi CM5).

Le second contrat est complet : écritures conditionnelles (`If-Match` sur les commandes et les réservations, `GET /api/robot/:id`), la commande atomique `table`, un journal d'audit en ajout seul (`GET /api/audit`, chaîné par hachage, désactivable) et un message WebSocket `claims`. Les mots de passe des caméras n'apparaissent plus dans la liste des processus ni dans le journal. Voir `docs/CONTRACT_V2.md`.

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

## 🧩 Rôle dans HYDRA-UMC

**HYDRA-UMC-SERVER** est le moteur de la cellule : un backend Node.js et Express sans interface qui détient l'état des robots, l'enregistre sur disque, exige un rôle pour chaque écriture et pousse des mises à jour en direct à tous les clients par un seul WebSocket. Tous les clients (STUDIO, SUITE, les applications mobiles, l'écran tactile, la montre, l'outil en ligne de commande) passent par lui, et lui seul décide qui peut déplacer quel robot et jusqu'où.

## 🏛️ Architecture

<p align="center">
  <img src="images/architecture.svg" alt="HYDRA-UMC-SERVER architecture" width="100%">
</p>

### Pourquoi Ce Projet Existe

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

## ✨ Fonctionnalités

### Données et Persistance

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
- `data/totp.json` - le second facteur des comptes qui l'ont activé (facultatif, désactivé pour chaque compte jusqu'à ce que son propriétaire l'active) : chaque secret est chiffré en AES-GCM sous `HYDRA_UMC_TOTP_KEY` (ou une clé dérivée de `JWT_SECRET`) et les dix codes de récupération ne sont gardés que sous forme de hachages ; le fichier n'existe pas tant qu'un compte n'active pas la deuxième étape.

## 🔒 Sécurité et protection

| Menace | Défense | Où |
|---|---|---|
| Jetons signés avec une clé connue | Avec `NODE_ENV=production` le serveur refuse de démarrer avec un `JWT_SECRET` vide, d'exemple ou trop court et sans administrateur initial ; en développement une valeur intégrée est utilisée et un avertissement `[SECURITY]` s'affiche | `src/auth.ts`, `src/secretsPolicy.ts` |
| Force brute sur la connexion, ou déluge d'arrêts | 5 connexions échouées par 15 minutes et par adresse (`429`), 120 rafraîchissements et 60 arrêts globaux par minute, réglables avec `LOGIN_RATE_LIMIT_MAX`, `REFRESH_RATE_LIMIT_MAX` et `STOP_ALL_RATE_LIMIT_MAX` ; les mots de passe utilisent scrypt avec un sel aléatoire, 4 à la fois au plus et 20 en file, donc un déluge ne peut pas affamer le serveur | `src/auth.ts`, `src/users.ts` |
| Un jeton volé, ou un jeton lu dans l'adresse | Les jetons d'accès expirent (`JWT_EXPIRES_IN`, 30 jours par défaut, 24 h conseillé hors d'un LAN de confiance) et sont renouvelés par un jeton de rafraîchissement rotatif ; le WebSocket prend le jeton comme sous-protocole `hydra.bearer` et refuse `?token=` sauf si `HYDRA_UMC_WS_QUERY_TOKEN=allow` le réautorise, avec un avertissement à chaque démarrage | `src/refresh_tokens.ts`, `src/ws.ts` |
| Deux clients déplaçant le même robot, ou une commande que le robot ne doit pas recevoir | Un robot est réservé pour un compte et une fenêtre, les écritures exigent `If-Match` (une révision périmée reçoit `412`), le rôle observateur ne peut pas écrire, et la taille d'un déplacement et la cible la plus chaude du lit chauffant viennent des limites de sécurité qu'un administrateur fixe ; l'arrêt global fonctionne quoi que disent les réservations | `src/claimPolicy.ts`, `src/safetyLimits.ts`, `src/routes/commandRoutes.ts` |
| Images de caméra ouvertes à n'importe qui sur le réseau | Les flux en direct, photos et enregistrements exigent un ticket signé valable 5 minutes (ou un jeton porteur) ; 8 caméras au plus ; les mots de passe de caméra restent hors de la liste des processus et du journal ; `HYDRA_UMC_CAMERA_AUTH=open` est la dérogation temporaire | `src/mediaTickets.ts`, `src/serverPolicy.ts` |
| Requêtes énormes ou hostiles, et accès inter-origines ouvert | Les corps JSON sont limités à 1 Mo (50 Mo seulement sur la route d'envoi volumineux) ; `CORS_ALLOWED_ORIGINS` est une liste d'autorisation et, en production, une liste non définie refuse toute requête inter-origines de navigateur (le développement autorise toute origine, avec un avertissement) ; `settings.json` et `users.json` ne sont jamais servis comme fichiers | `src/server.ts` |
| Options d'accès faibles laissées actives : texte vocal, confiance du moteur de reconnaissance, signature MAVLink, Bluetooth, MQTT, TLS | Chacune a un interrupteur qu'un administrateur modifie par `PUT /api/admin/server-config` (admin seulement), avec un défaut prudent et l'environnement qui l'emporte sur l'enregistré ; la réponse liste des avertissements comme `voice_heard_text_on`, `voice_confidence_off`, `mavlink_unsigned_allowed` et `mavlink_signing_off` ; le relais vocal remplace toute `options` envoyée par un client par celles de l'administrateur, et un fichier de clé MAVLink est vérifié (32 octets ou 64 caractères hexadécimaux) avant d'enregistrer son chemin | `src/securityConfig.ts`, `src/routes/adminRoutes.ts`, `src/routes/assistantRoutes.ts` |
| Un registre falsifié de qui a fait quoi | Un registre d'audit en ajout seul dont les entrées sont chaînées par hachage (`GET /api/audit`, `?verify=1` vérifie la chaîne), un journal du serveur qui tourne selon la taille et une étape de masquage qui retire les secrets avant toute écriture | `src/auditLog.ts`, `src/logRotation.ts`, `src/redaction.ts` |

**Ce qu'il ne fait jamais :** servir de fonction de sécurité certifiée. Les limites et l'arrêt sont du logiciel dans ce processus ; il n'y a pas encore derrière de chemin d'arrêt d'urgence matériel, de limite imposée par le firmware ni de vraie carte contrôleur.

## 🔌 Interfaces

### Surface API et WebSocket

Chaque route, le contrat des messages WebSocket, l'authentification et le
modèle d'accès distant par client sont documentés dans
**[`docs/REMOTE_API.md`](docs/REMOTE_API.md)** - la seule source de
vérité pour tout ce qui communique avec ce serveur, y compris le code
client de HYDRA-UMC STUDIO lui-même. En résumé :

- API REST sous `/api/*` - lecture/écriture des settings, commandes
  atomiques de robot (jog/play/pause/stop/tool/valve/pump/speed/vision),
  gestion des comptes, upload/download de fichiers de travail, soumission
  de modèles, métriques système, découverte.
- Un seul point de terminaison WebSocket `/ws` (jeton bearer comme sous-protocole `hydra.bearer`, un jeton dans la query string est refusé sauf si l'installation le réautorise) diffusant des snapshots complets `settings` et des mises
  à jour plus légères `delta` à chaque client connecté lorsque l'état
  change.
- `POST /api/stop-all` est l'arrêt global : un appel, ouvert à tout compte connecté, arrête tous les robots et coupe toutes les vannes et pompes,
  quelle que soit la réservation, et répond un résultat par robot.
- Bluetooth LE (désactivé par défaut) : un téléphone proche de la CM5 peut lire l'état des robots et, si un administrateur l'autorise, envoyer des commandes que le serveur n'acquitte qu'une fois que la même route qu'utilise un client réseau a répondu. Voir [`docs/BLE_GATT.md`](docs/BLE_GATT.md).
- Authentification JWT par jeton bearer sur chaque écriture ; trois rôles
  de compte (`admin`, `operator`, `viewer` en lecture seule) filtrent les écritures de
  settings/gestion des utilisateurs par rapport à l'exploitation
  quotidienne des robots et à la simple lecture.
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

### Supervision (Optionnel)

`GET /metrics` expose le temps de fonctionnement du processus, le nombre
de clients WebSocket connectés, la latence d'écriture de `settings.json`,
les commandes atomiques de robot par type, les échecs d'authentification,
et les mêmes chiffres CPU/mémoire/température que
`GET /api/system/metrics` - le tout au format Prometheus. Une pile
Prometheus + Grafana prête à l'emploi (avec un tableau de bord de départ)
se trouve dans **[`monitoring/`](monitoring/README.md)** : `docker compose
up -d` depuis ce dossier suffit à la démarrer. Entièrement optionnel - rien
ici n'est nécessaire au fonctionnement du serveur lui-même.

| Topic ou route | Ce qu'il porte |
|---|---|
| `/api/login`, `/api/refresh`, `/api/logout` | se connecter (débit limité), faire tourner le jeton de rafraîchissement, se déconnecter |
| `/api/users`, `/api/users/:username` | lister, créer, modifier et supprimer des comptes (`admin`, `operator`, `viewer`) ; admin seulement |
| `/api/settings`, `/api/robot/:id`, `/api/robot/:id/command` | l'arbre d'état et les commandes atomiques typées (déplacement, lecture, pause, arrêt, outil, vanne, pompe, vitesse, vision, table) avec `If-Match` |
| `/api/robot/:id/claim`, `/release`, `/jog-arm`, `/api/claims`, `/api/stop-all`, `/api/safety-limits` | réservations, armement du déplacement, qui détient quoi, l'arrêt global et les limites de sécurité |
| `/api/admin/server-config`, `/clients`, `/logs`, `/restart`, `/safety-limits` | administration : les interrupteurs d'accès, les applications connectées, le journal du serveur, un redémarrage et les limites de sécurité ; admin seulement |
| `/api/camera/*`, `/api/cameras/status` | flux de caméra, instantanés, enregistrements, PTZ et `POST /api/camera/ticket` |
| `/api/system/metrics`, `/api/system/supervisor`, `/api/ecosystem/status`, `/api/system/bluetooth/*` | informations de l'hôte, le superviseur de processus, l'état et le contrôle des services de l'écosystème, appairage Bluetooth |
| `/api/voice/turn`, `/api/voice/confirm`, `/api/watch/system-status`, `/api/ai/*` | relais vers le service vocal, l'état de la montre et les services d'IA locaux |
| `/ws` | un WebSocket : instantanés complets `settings`, mises à jour légères `delta` et un message `claims` ; le jeton voyage comme sous-protocole `hydra.bearer` |
| `GET /api/hydra-info`, `_hydra._tcp` | découverte : la version du contrat distant (`remoteApiVersion` 2), la version de l'application et le nombre de contrôleurs et de robots, annoncés par mDNS |
| `/admin`, `/dashboard-ai`, `/` | pages statiques facultatives, servies seulement quand `build-frontend` les a construites à côté de ce dépôt : le panneau d'administration, DASHBOARD-AI et STUDIO |
| `/metrics` | texte Prometheus : durée de fonctionnement, clients WebSocket, latence d'écriture, commandes par type, échecs d'authentification, chiffres de l'hôte |

## ⚙️ Configuration

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
- `REFRESH_RATE_LIMIT_MAX` - budget de requêtes de `POST /api/refresh` par fenêtre et par IP (120 par défaut). Seules les connexions échouées comptent pour la limite de connexion ci-dessus.
- `TLS_CERT_PATH` / `TLS_KEY_PATH` - définissez les **deux** pour faire
  passer le serveur (API REST + le WebSocket `/ws`, qui partage le même
  listener) de HTTP/WS en clair à HTTPS/WSS. Voir "TLS / HTTPS"
  ci-dessous. Laisser l'une ou l'autre non définie conserve le
  comportement HTTP en clair actuel sans changement.
- `HYDRA_UMC_CAMERA_AUTH` - les images des caméras (flux en direct, photos et enregistrements sauvegardés) exigent **par défaut** un `?ticket=` de courte durée (`POST /api/camera/ticket` en remet un à un client connecté) ou un jeton Bearer ; `HYDRA_UMC_CAMERA_AUTH=open` est l'issue temporaire pour les clients qui ne demandent pas encore de tickets.
- `HYDRA_UMC_WS_QUERY_TOKEN` - `/ws?token=` est **refusé par défaut** (le jeton voyage comme sous-protocole `hydra.bearer`) ; `HYDRA_UMC_WS_QUERY_TOKEN=allow` est l'issue temporaire pour les clients qui n'ont pas encore migré. Le serveur avertit à chaque démarrage tant qu'une issue est active.
- `HYDRA_UMC_BLE_GATT` - le service Bluetooth LE : `off` (par défaut), `state` (les téléphones lisent l'état) ou `commands` (et envoient des commandes, chacune avec le jeton d'accès du compte). `HYDRA_UMC_BLE_ENCRYPTION=off` cesse d'exiger une liaison chiffrée (elle est exigée par défaut). Les deux se règlent aussi depuis l'écran d'administration du serveur ; un changement s'applique au prochain démarrage. Nécessite BlueZ, `python3-dbus` et `python3-gi` sur la machine.
- `HYDRA_UMC_MQTT_BRIDGE` - le pont vers le broker MQTT de la cellule : `off` (par défaut), `state` (l'état de chaque robot sort sur des topics retenus) ou `commands` (et une commande publiée sur le topic d'un robot est exécutée par la même route qu'un client du réseau, avec le jeton d'un compte dédié nommé par `HYDRA_UMC_MQTT_COMMAND_USER`). L'adresse, le préfixe des topics et les noms d'utilisateur peuvent aussi se régler depuis l'écran Server Admin ; les mots de passe seulement par l'environnement. Voir [`docs/MQTT_BRIDGE.md`](docs/MQTT_BRIDGE.md).
- `HYDRA_UMC_INFO_AUTH=required` - exige un client connecté pour les informations en lecture seule de la machine (`/metrics`, `/api/system/metrics`, `/api/system/supervisor`, `/api/ecosystem/status`, `/api/models`). Désactivé par défaut pour qu'un client qui n'envoie pas encore son jeton sur ces routes continue de fonctionner ; un démarrage en production avertit tant qu'il est désactivé.
- `HYDRA_UMC_VOICE_UI_INCLUDE_HEARD_TEXT`, `HYDRA_UMC_VOICE_UI_MIN_CONFIDENCE`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_KEY_FILE`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_ALLOW_UNSIGNED` - les options de voix et d'UAV qu'un administrateur peut aussi régler depuis Server Admin (`voice` et `mavlink` dans `data/server-config.json`) : si une réponse vocale répète ce qui a été dit (`1` l'active ; désactivé par défaut), la confiance minimale du moteur de reconnaissance vocale (de 0 à 1, 0,6 par défaut) avant d'accepter une demande qui lance un mouvement, et le fichier de clé de la signature MAVLink 2 ainsi que l'acceptation ou non des messages non signés (par défaut pas de signature et les messages non signés sont refusés). L'environnement l'emporte sur ce qui est enregistré, et l'écran affiche alors la valeur comme fixée.
- `HYDRA_UMC_AI_ACCESS=admin` - réserve aux administrateurs le relais vers les services d'IA locaux (`/api/ai/*`). Désactivé par défaut : tout utilisateur connecté peut l'utiliser, comme avant.
- `HYDRA_UMC_VISUAL_SERVOING_TOKEN`, `HYDRA_UMC_VLA_ENGINE_TOKEN`, `HYDRA_UMC_COGNITIVE_NODE_TOKEN`, `HYDRA_UMC_DETECTION_HEF_TOKEN`, `HYDRA_UMC_VISION_NODE_TOKEN` et `HYDRA_UMC_ANOMALY_TOKEN` (pour le relais `/api/ai/*`), `HYDRA_UMC_VISION_STREAMER_TOKEN` (pour les flux caméra) et `HYDRA_UMC_DATALAKE_READ_TOKEN`, sinon `HYDRA_UMC_DATALAKE_TOKEN` (pour la télémétrie) - le jeton Bearer que ce serveur présente à un service qui en demande un ; chacune lit aussi `..._FILE`, un fichier dont la première ligne est le jeton. Ce sont les noms que les services lisent eux-mêmes, un seul fichier d'environnement sert donc aux deux, et aucun client ne les voit jamais. Un service sans jeton configuré est joint exactement comme avant. Le relais refuse en outre une session qui n'est ni administrateur ni opérateur, et seul un administrateur peut modifier la base de référence du détecteur d'anomalies (tout `POST` autre que `/detect`) ; `vision-node` et `anomaly-detector` rejoignent le relais.
- `HYDRA_UMC_VOICE_UI_RESULT_KEY` (ou `..._FILE`) - la clé avec laquelle HYDRA-UMC-VOICE-UI signe un résultat vocal confirmé (16 caractères ou plus, la même valeur qu'il détient). `POST /api/voice/confirm` relaie une confirmation avec l'utilisateur connecté comme sujet et ne croit une réponse `confirmed` que si elle nomme cet utilisateur et que sa signature est valide ; sans la clé la réponse est transmise avec `verified: false`, et `HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE=1` la refuse à la place. Cette route n'exécute rien.
- `HYDRA_UMC_TELEMETRY_COLLECTOR_URL` (avec `HYDRA_UMC_TELEMETRY_COLLECTOR_TOKEN` ou `..._FILE`, et `HYDRA_UMC_TELEMETRY_INTERVAL_MS`, de 100 à 60000, 1000 par défaut) - active le producteur de télémétrie : les valeurs de chaque delta de robot que ce serveur diffuse (position, articulations, état de lecture) sont envoyées à HYDRA-UMC-TELEMETRY-COLLECTOR sous la forme d'un échantillon `robot_state` par robot, au plus un par intervalle, fusionnés, pour que le data lake ait quelque chose de réel à conserver. Désactivé si l'adresse manque ; il ne retarde jamais une commande, garde une quantité de données bornée et se met en pause 30 secondes après un échec.
- `/dashboard-ai` - quand HYDRA-UMC-DASHBOARD-AI est récupéré à côté de ce dépôt, `build-frontend` le compile et ce serveur le sert à cet endroit. La page lit le data lake (`/api/ai/datalake/*`, en lecture seule : `GET` sur `/query`, `/aggregate`, `/stats`, `/stats/range`, `/series` et `/health`, tout le reste est refusé) et le détecteur d'anomalies (`/api/ai/anomaly-detector/*`) par le relais, avec la session de la personne connectée à STUDIO dans le même navigateur ; les rôles et les jetons de service de ce serveur s'appliquent donc. Le détecteur d'anomalies peut alors être démarré avec `HYDRA_UMC_ANOMALY_PROTECT_READS=1`.
- `HYDRA_UMC_LOG_MAX_BYTES` et `HYDRA_UMC_LOG_KEEP` - la taille à laquelle le journal du serveur tourne (10 Mo par défaut) et le nombre de fichiers archivés conservés (1 par défaut).
- `HYDRA_UMC_SETTINGS_STORE`, `HYDRA_UMC_SETTINGS_BACKUPS` et `HYDRA_UMC_SETTINGS_BACKUP_INTERVAL_S` - par défaut, les réglages (`settings.json` et les fichiers de points) s'écrivent comme un bloc tout ou rien avec un journal : une écriture interrompue est terminée ou annulée au démarrage suivant, une copie de `settings.json` est conservée dans `data/backups/` (10 copies, au plus une toutes les 600 s) et un `settings.json` abîmé est restauré à partir de la dernière bonne copie. `HYDRA_UMC_SETTINGS_STORE=plain` revient à l'écriture fichier par fichier ; `HYDRA_UMC_SETTINGS_BACKUPS=0` désactive les copies.
- L'accès au relais d'IA, l'exigence de connexion des informations de l'hôte et TLS (chemins du certificat et de la clé, avec l'empreinte SHA-256 du certificat) peuvent aussi être modifiés par un administrateur depuis l'écran Administration du serveur de l'application de contrôle. Une valeur définie dans l'environnement l'emporte et s'affiche verrouillée ; l'exigence de connexion demande confirmation avant d'être désactivée ; TLS s'applique au prochain démarrage.
- `STOP_ALL_RATE_LIMIT_MAX` / `STOP_ALL_RATE_LIMIT_WINDOW_MS` - budget de l'arrêt global (`POST /api/stop-all`) par adresse, distinct de celui de la connexion (60 par minute par défaut). En production, le serveur refuse aussi de démarrer avec un `JWT_SECRET` ou un mot de passe d'amorçage d'exemple issu d'un modèle de déploiement, un `JWT_SECRET` de moins de 32 caractères ou un mot de passe d'amorçage de moins de 12.

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

### Interrupteurs d'accès, historique des connexions et signe de vie

Neuf options élargissent ce que le serveur répond ou enregistre ; toutes démarrent sur la valeur prudente et chacune a une variable d'environnement et un interrupteur d'administrateur (`PUT /api/admin/server-config`, visible dans Server Admin de STUDIO ; une variable d'environnement verrouille l'interrupteur). Le tableau complet est dans la section 2k de [`docs/REMOTE_API.md`](docs/REMOTE_API.md).

- `HYDRA_UMC_HEALTH_OPEN=1` (`health.open`) - `GET /health` répond sans connexion par un rapport de santé minimal (sans version, hôte ni compteurs) ; désactivé, il répond `404`.
- `HYDRA_UMC_SAFETY_PUBLISH_STOP=1` (`safety.publishGlobalStop`) - un arrêt global est aussi annoncé sur le pont MQTT comme un `SAFE_STOP` retenu sur `<préfixe>/safety/estop` (voir `docs/GLOBAL_STOP.md`).
- `HYDRA_UMC_CONNECTION_RECORD_ADDRESS=1` (`connections.recordAddress`) - l'historique des connexions garde aussi l'adresse et l'agent utilisateur de chaque client, visibles des seuls administrateurs.
- `HYDRA_UMC_CAMERA_AUTH=open` (`camera.open`) - images de caméra sans ticket ; par défaut elles en exigent un.
- `HYDRA_UMC_WS_QUERY_TOKEN=allow` (`websocket.allowQueryToken`) - un jeton dans l'adresse du WebSocket ; par défaut il est refusé.
- `HYDRA_UMC_LOG_REDACTION=off` (`logging.redactSecrets`) - cesse de masquer les secrets dans le journal ; par défaut ils sont masqués.
- `HYDRA_UMC_CAMERA_CREDENTIALS_VIA_ENV=off` (`camera.credentialsViaEnv`) - le mot de passe d'une caméra IP figure sur la ligne de commande de son processus au lieu de son environnement ; par défaut il passe par l'environnement (s'applique au prochain démarrage d'un processus de caméra).
- `HYDRA_UMC_NEW_INSTALL_TLS=off` (`install.newInstallTls`) - une nouvelle installation n'active pas TLS d'elle-même ; par défaut elle le fait lorsqu'elle a déjà les certificats de sa propre autorité (lu seulement au premier démarrage d'une installation).

- **Qui se connecte :** `GET /api/connections/clients` et `GET /api/connections/events` répondent dans les contrats fermés `ConnectionClient` et `ConnectionEvent` de HYDRA-UMC-SDK (première vue, connexions réussies ou échouées, second facteur, déconnexions, sessions terminées). Un administrateur voit toutes les entrées, tout autre compte seulement les siennes ; aucun mot de passe, jeton ni secret n'est conservé.
- **Signe de vie :** `GET /api/robots/liveness` dit si le serveur a eu des nouvelles de chaque robot du parc (`live`, `stale` ou `unknown`, avec l'âge de la dernière nouvelle), au lieu de répéter l'indicateur `online` qui n'enregistre que ce qu'un opérateur a activé ; `liveness.staleAfterS` de `data/server-config.json` fixe la limite (30 s par défaut).
- `HYDRA_UMC_SERVER_PORT` - le port d'écoute ; il l'emporte sur le `PORT` partagé. `HYDRA_UMC_PORTS_REGISTRY` et `HYDRA_UMC_SDK_DIR` / `HYDRA_UMC_REQUIRE_SDK=1` sont décrits dans le même tableau.

Les interrupteurs d'accès ci-dessous sont ceux que modifient les écrans Server Admin de STUDIO et SUITE. Chacun se résout dans le même ordre : d'abord l'environnement du déploiement (l'écran l'affiche verrouillé), puis ce que l'administrateur a enregistré dans `data/server-config.json`, puis le défaut prudent. Les variables listées plus haut couvrent tout le reste.

| Variable | Par défaut | Ce qu'elle définit |
|---|---|---|
| `aiAccess`, `HYDRA_UMC_AI_ACCESS` | `open` | qui peut utiliser le relais d'IA local : `open` est tout compte connecté, `admin` seulement les administrateurs |
| `infoAuth`, `HYDRA_UMC_INFO_AUTH` | désactivé | exiger une connexion pour les informations en lecture seule de l'hôte (métriques, superviseur de processus, état de l'écosystème) |
| `tls.enabled`, `TLS_CERT_PATH, TLS_KEY_PATH` | désactivé (HTTP simple) | HTTPS et WSS avec le certificat et la clé indiqués ; l'écran montre l'empreinte du certificat utilisé |
| `ble.mode`, `HYDRA_UMC_BLE_GATT` | `off` | Bluetooth LE pour les téléphones proches du serveur : `off`, `state` (publie seulement l'état) ou `commands` (accepte aussi des commandes) ; un mot inconnu signifie éteint |
| `ble.requireEncryption`, `HYDRA_UMC_BLE_ENCRYPTION` | activé | la caractéristique de commande est écrite, et l'état lu, seulement sur un lien chiffré ; seul `off` dans la variable le désactive |
| `mqtt.mode`, `MQTT environment of the deployment` | `off` | le pont MQTT vers le broker de la cellule : `off`, `state` ou `commands`, avec son URL, son préfixe et ses utilisateurs |
| `voice.includeHeardText`, `HYDRA_UMC_VOICE_UI_INCLUDE_HEARD_TEXT` | désactivé | une réponse vocale répète ce qui a été dit ; ce sont des données personnelles, donc c'est désactivé, et dans la variable seul le mot exact `1` l'active |
| `voice.minConfidence`, `HYDRA_UMC_VOICE_UI_MIN_CONFIDENCE` | `0.6` | la confiance minimale du moteur de reconnaissance vocale, de 0 à 1, pour accepter une demande qui lance un mouvement ; 0 désactive le contrôle, un arrêt n'est jamais retenu, et un nombre invalide dans la variable est ignoré |
| `mavlink.signingKeyFile`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_KEY_FILE` | vide (pas de signature) | signature MAVLink 2 de la passerelle UAV : le chemin d'un fichier avec la clé de 32 octets (32 octets bruts ou 64 caractères hexadécimaux) ; seul le chemin est enregistré, jamais la clé, et la passerelle le lit au démarrage |
| `mavlink.signingAllowUnsigned`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_ALLOW_UNSIGNED` | désactivé | continuer à accepter les messages non signés (un véhicule qui ne signe pas encore) ; l'écran avertit tant que c'est activé |

## 🚀 Démarrage rapide

Nécessite Node.js 22 ou plus récent avec npm. Le serveur fonctionne sans configuration avec des valeurs de développement ; définissez les variables de la section Configuration avant qu'il soit joignable hors d'un LAN de confiance.

```bash
npm install
./dev.sh                    # runs the server with tsx on port 3000, no frontend (dev.bat on Windows)
npm run test:unit           # the unit tests
npm test                    # unit tests, the OpenAPI check and the contract scripts against a live instance
npm run build && npm start  # one bundled file (build.sh and build.bat make a versioned release build)
```

Le serveur écoute sur `0.0.0.0:3000` ; tout son état vit dans `data/`. Ce dépôt n'a volontairement pas de Dockerfile : HYDRA-UMC-OS l'installe sur la CM5 (`provisioning/install_server.sh`). La version en cours se lit dans `GET /api/hydra-info` (`appVersion`) ; seuls les scripts `build*.sh` et `build*.bat` de la racine font un build de version, `npm run build` ne fait que compiler.

## 🧪 Tests

414 tests automatiques s'exécutent avec `npm run test:unit`. En plus, `npm test` exécute la vérification OpenAPI et 28 scripts de contrat de bout en bout dans `tools/` contre une instance réelle de ce serveur (découverte, connexion sans et avec identifiants, démarrage de production, commandes et propriété des robots, jetons de rafraîchissement, relais vocal et ses chemins d'erreur, lecture, l'arrêt global, ponts Bluetooth et MQTT, médias de caméra, relais IA et connector-hub, rôle observateur et plus) ; tous passent. Aucun n'a besoin de matériel.

La CI exécute `HYDRA_UMC_CI=1 python tools/ci_validate.py`, qui vérifie le manifeste, les documents, les huit README et les images.

## 🏗️ Compilation et publication

### Prérequis

- [Node.js](https://nodejs.org/) (v18 ou supérieur recommandé)
- npm

### Installation

```bash
npm install
```

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

Ce dépôt n'a volontairement pas de Dockerfile : le serveur est empaqueté et installé sur la CM5 par [HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS) (`provisioning/install_server.sh`).

## 🩺 Dépannage

| Vous voyez | Parce que | Faites |
|---|---|---|
| Le serveur s'arrête au démarrage en production | `NODE_ENV=production` exige un vrai `JWT_SECRET` (32 caractères au moins, pas un exemple) et un administrateur initial au premier démarrage | Définissez `JWT_SECRET`, `HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME` et `HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD` (voir `docs/PRODUCTION_BOOTSTRAP.md`) |
| `429` à la connexion | Plus de 5 connexions échouées depuis une adresse en 15 minutes | Attendez la fin de la fenêtre ; n'augmentez `LOGIN_RATE_LIMIT_MAX` que sur un réseau de confiance |
| L'application du navigateur est bloquée par CORS | En production, un `CORS_ALLOWED_ORIGINS` non défini refuse toute requête inter-origines de navigateur (curl, SUITE et les applications mobiles ne sont pas touchés) | Définissez `CORS_ALLOWED_ORIGINS=https://studio.example.com,...` avec les origines de la page |
| Le WebSocket se ferme aussitôt, ou une image de caméra ne se charge pas | Le client envoie le jeton dans l'adresse (`/ws?token=`, refusé par défaut) ou ouvre l'image sans ticket (exigé par défaut) | Utilisez le sous-protocole `hydra.bearer` et `POST /api/camera/ticket` ; les dérogations `HYDRA_UMC_WS_QUERY_TOKEN=allow` et `HYDRA_UMC_CAMERA_AUTH=open` sont temporaires |
| Un interrupteur d'accès est refusé parce qu'il est verrouillé, ou un fichier de clé MAVLink est refusé | La valeur est fixée par une variable d'environnement (elle l'emporte sur l'enregistré), ou le fichier de clé est illisible ou n'a ni 32 octets ni 64 caractères hexadécimaux | Changez ou retirez la variable et redémarrez, ou corrigez le fichier ; la passerelle MAVLink lit ses options au démarrage |

## 📂 Structure du dépôt

<p align="center">
  <img src="images/repository-structure.svg" alt="Repository structure of HYDRA-UMC-SERVER" width="100%">
</p>

<details>
<summary>Version texte de l'arborescence</summary>

```text
HYDRA-UMC-SERVER/
├── src/                       code source
│   ├── server.ts              Démarrage léger qui relie les modules ci-dessous ; les routes /api sont dans src/routes/, les connexions en direct dans ws.ts, les fichiers de réglages dans settingsStore.ts
│   ├── kinematics.ts          Aide de cinématique inverse pour le point de terminaison atomique de jog
│   ├── metrics.ts             Alimente GET /metrics - exposition texte Prometheus (prom-client)
│   ├── ble/                   Service Bluetooth LE : trames, passerelle (commandes, acquittements, état) et transport de l'assistant
│   ├── users.ts               Magasin de comptes (hachage de mot de passe scrypt)
│   ├── routes/                Les routes /api par domaine : auth, réglages, réservations de robot, commandes, limites de sécurité, caméras, Bluetooth, admin, système, relais vers les services frères, IA locale, assistant, fichiers de travail, alimentation, infos et fichiers statiques
│   ├── auth.ts                Vérification des jetons, la porte administrateur et les limiteurs de débit ; le magasin de jetons de rafraîchissement ; ce que la production accepte comme secret de signature et premier mot de passe ; les options d'accès ; les jetons présentés aux services relayés
│   ├── claimPolicy.ts         Qui contrôle quel robot ; les modifications qu'un opérateur fait sur un robot ; les limites auxquelles tout client est tenu ; le déplacement de la table XY en une requête ; la lecture faisant autorité côté serveur
│   ├── settingsStore.ts       Les fichiers de réglages sur disque, leurs sauvegardes, les écritures tout-ou-rien de plusieurs fichiers, l'enregistrement d'audit et la rotation des journaux
│   ├── ws.ts                  Le hub des connexions en direct (WebSocket), le pont MQTT vers le broker de la cellule et son démarrage, et le premier producteur de télémétrie
│   ├── cameraHealth.ts        Si un flux de caméra livre vraiment des images, sondage des caméras IP et PTZ, le superviseur des processus de flux et les tickets de courte durée pour les images de caméra
│   └── ecosystemStatus.ts     Découverte et vivacité de l'écosystème, le registre des ports de services, les métriques de l'hôte, l'environnement d'exécution du processus (mDNS, port), des aides de politique pures, l'expurgation des secrets, des aides d'appairage Bluetooth, les adresses des services en amont et la confirmation d'une demande vocale
├── admin-ui/                  Panneau d'administration Vite/React séparé pour CE serveur lui-même
├── data/                      État d'exécution - settings, users, logs, fichiers de travail, points enregistrés
├── docs/                      documents du projet
├── images/                    Médias et diagrammes
├── systemd/                   unité de service
├── tools/                     outils du projet et vérifications de la CI
├── tests/                     tests automatiques
├── monitoring/                Stack Prometheus + Grafana optionnel - voir monitoring/README.md
├── scripts/                   l'assistant Bluetooth LE (BlueZ) et un ancien assistant de versions
├── .github/                   workflow de CI et modèles de tickets
├── bump_manifest_version.py   Synchronise la version de hydra-umc.project.json avec la version native (--sync)
├── build.bat / build.sh       Installe les dépendances + build de production
├── dev.bat / dev.sh           Installe les dépendances + démarre le serveur de dev
├── package.json               métadonnées et scripts du paquet
├── tsconfig.json              configuration TypeScript
├── CHANGELOG.md               ce qui a changé à chaque version
├── LICENSE
├── build-test.sh              vérification de build sans modification
├── hydra-umc.project.json     manifeste : version, maturité, famille
└── test.sh                    lance les tests
```

</details>

## 🗺️ Feuille de route et limites connues

**Limites connues aujourd'hui**

* La liaison avec une vraie CM5 et une carte STM32H745 (`spi_bridge`) est du vrai code exercé seulement par la couche API et contrats ; il n'y a jamais eu de carte physique pour fermer le dernier saut.
* Le serveur écoute sur toutes les interfaces (`0.0.0.0`) ; il n'y a pas encore d'interrupteur pour l'adresse d'écoute, donc un pare-feu ou les interrupteurs d'accès ci-dessus limitent l'exposition.
* En développement (`NODE_ENV` différent de `production`) une clé de signature intégrée, le compte `admin`/`admin` et une politique CORS ouverte sont utilisés, chacun avec un avertissement ; la production les refuse.
* TLS, Bluetooth LE et le pont MQTT sont facultatifs et désactivés par défaut.

**Ensuite :** chaque nouvelle route suit la même liste de contrôle (documentée dans `docs/REMOTE_API.md`, nommée dans `docs/openapi.json`, typée dans les clients du SDK).

## 🌍 Langues

Ce README et les documents du dépôt existent en huit langues : anglais, espagnol, allemand, français, italien, japonais, chinois et portugais (Portugal). Ils sont écrits ensemble et la CI vérifie que les huit fichiers ont les mêmes sections et les mêmes liens. Ce dépôt n'a ni écran ni catalogue de messages propre, il n'y a donc aucune chaîne d'interface à traduire.

## 🔗 Projets liés

Ce projet fait partie de l'écosystème robotique HYDRA-UMC du même auteur (JuanenRac / Electro Hobby 3D). Bon à savoir, car une demande pourrait en réalité concerner l'un de ceux-ci plutôt que ce dépôt.

**Projets Enfants** — chacun est un vrai client ou un pont de coordination qui ne parle à la flotte de robots que via l'API de ce serveur
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — tableau de bord de contrôle web avec visualisation 3D multi-robot en temps réel.
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — centre de commande d'essaim de bureau (PySide6) pour plusieurs serveurs à la fois, empaqueté en exécutable autonome.
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — application de contrôle Android native avec connexion biométrique et un compagnon Wear OS jumelé.
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — application de contrôle iOS/iPadOS (Flutter) avec synchronisation WebSocket en temps réel.
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — interface tactile native pour l'écran tactile DSI 7" embarqué, intégrée directement sur le CM5.
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — frontière de coordination pour les flottes AGV/AMR via un éditeur MQTT VDA 5050 (testé uniquement contre une flotte émulée).
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — coordinateur haut niveau pour cellules CNC avec accès au statut/octets de contrôle GRBL (testé uniquement contre un émulateur).
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — frontière de coordination pour droïdes à pattes/humanoïdes, avec un émetteur de commandes Boston Dynamics Spot (testé uniquement contre un émulateur).
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — coordinateur de cellules laser lisant 3 signaux GPIO de clé/enceinte/verrouillage (testé uniquement contre une puce simulée ; il ne peut ni armer ni tirer un laser).
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — coordinateur haut niveau sûr pour le flux de cartes du pick-and-place OpenPnP.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — frontière de coordination sûre pour imprimantes 3D Moonraker/Klipper, avec de vraies commandes de tâche contrôlées.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — coordinateur avec un transport ROS 2 rclpy à importation paresseuse (pas encore exécuté contre une installation ROS 2).
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — frontière de coordination pour UAV équipés de caméra, avec un émetteur de commandes MAVLink (testé uniquement contre un émulateur).

**Directement Liés**
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — ce serveur relaie vers lui des tours de parole limités et authentifiés via une connexion loopback, en gardant le jeton de passerelle côté serveur, pour que la voix ne devienne jamais directement une commande robot.
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — la conception de la carte mère du bras robotique (aucune carte assemblée pour l'instant) ; le propre service `spi_bridge` de ce serveur est destiné à lui parler via la liaison SPI-OTA CM5↔STM32H745 (testé uniquement avec des doublures).

**Fait Également Partie de l'Écosystème**

*Matériel & Plateforme de Base*
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — couche produit reproductible sur Raspberry Pi OS pour le CM5 sur lequel tourne ce serveur : agent en lecture seule, config/profils validés, provisionnement WiFi de premier contact.
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — le contrat JSON-Schema partagé et la barrière logicielle de contrôle des jobs contre laquelle chaque bridge valide ses commandes (pas une fonction de sécurité certifiée).
- **[HYDRA-UMC-CONNECTOR-HUB](https://github.com/JuanenRac/HYDRA-UMC-CONNECTOR-HUB)** — registre déclaratif et validateur de manifestes d'adaptateur pour les connecteurs de machines externes ; étend la propre idée de contrat du SDK aux machines externes sans remplacer les projets de passerelle industrielle.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — créateur/éditeur graphique de bureau pour URDF qui envoie les modèles terminés vers le propre catalogue de ce serveur.
- **[HYDRA-UMC-EDITOR-STL](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-STL)** — éditeur de bureau de modèles STL, transformant/remplaçant/retirant/ajoutant de vraies pièces dans le même catalogue de modèles qu'édite aussi HYDRA-UMC-EDITOR-URDF.

*Plateforme d'Outils URTC*
- **[URTC](https://github.com/JuanenRac/URTC)** — firmware pour la carte physique Universal Robot Tool Controller, plus de 25 profils d'outil sur bus CAN.
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — outil de bureau à interface graphique pour flasher les cartes URTC, CAN-OTA plus SWD/JTAG puce complète.
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — outil de bureau de diagnostic CAN-bus en direct pour cartes URTC, un panneau par profil d'outil.
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — alternative basée navigateur à URTC-TESTER via la Web Serial API, sans installation locale.
- **[URTC-GATEWAY](https://github.com/JuanenRac/URTC-GATEWAY)** — passerelle devant le bus CAN d'URTC : liste d'identifiants autorisés, limite de débit et clé de session ; logiciel testé sur ordinateur, pas encore sur un bus réel.

*Nœud IA de Vision (Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — hub d'intégration pour le pipeline de vision Hailo-8, avec une vraie vérification de disponibilité matérielle par étape.
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — registre réel de modèles compilés avec vérification de chargement sécurisé par architecture Hailo/checksum.
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — générateur réel de pipeline GStreamer + config MediaMTX, avec une vraie frontière d'intégration HailoRT.
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — loi de correction Position-Based Visual Servoing avec autorisation conditionnée à l'état de zone ; pas encore d'estimation de pose par caméra.
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — logique v0 de violation de zone, de fraîcheur de calibration et de demande d'E-STOP qui lit les positions d'objets dans un fichier ; aucun détecteur ne l'alimente et aucun E-STOP physique n'y est encore relié.

*Nœud IA Cognitif (Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** — hub d'intégration pour le pipeline cognitif Hailo-10 (orchestration LLM/VLA/voix).
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** — vrai encodage/décodage de jetons d'action et génération de trajectoire pour un modèle Vision-Language-Action.
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** — vraie décomposition de tâches basée sur des règles et récupération sémantique d'erreurs sur les codes d'erreur MCU.
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** — vraie recherche documentaire TF-IDF (bibliothèque standard uniquement) sur les propres documents Markdown de cet écosystème.
- **[HYDRA-UMC-LOCAL-TECHNICIAN](https://github.com/JuanenRac/HYDRA-UMC-LOCAL-TECHNICIAN)** — technicien de maintenance IA local et à portes de politique pour l'écosystème lui-même - observe, diagnostique et propose des corrections ; les deux niveaux de risque les plus élevés ne sont délibérément pas encore implémentés.

*Orchestration & Essaim*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — hub d'intégration avec un vrai contrat de rapport de santé gRPC/Protobuf et une machine à états de mission.
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** — vraie file de tâches basée sur la priorité avec déduplication, via une vraie API HTTP.
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — vrai chien de garde de santé de flotte basé sur gRPC, avec retry/backoff et détection d'incohérence d'identité.
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** — vrai planificateur de trajectoire 3D basé sur RRT, avec vraie validation des collisions obstacle/espace de travail.
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** — vraie synchronisation d'état CRDT LWW-Element-Map, testée par propriétés pour la convergence multi-cellule.

*Jumeau Numérique & Simulation*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** — hub d'intégration pour le moteur de jumeau numérique, avec un vrai contrat de synchronisation par compatibilité de version.
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — routeur hardware-in-the-loop avec un verrouillage logiciel de collision entre simulation et matériel réel (testé sans matériel réel).
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
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — application compagnon WearOS avec des motifs d'alerte haptique et un relais vocal vers le téléphone jumelé (pas encore exécutée sur une montre physique).
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** — firmware pour un rack de montage de cartes avec décodage réel d'ID d'outil et logique de préchauffage Smart Idle.
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** — firmware plus un vrai compagnon de vision Python pour une tête d'outil d'inspection thermique/RGB.
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** — outil administratif de bureau qui découvre, clone et met à jour chaque dépôt de cet écosystème.
- **[HYDRA-UMC-OS-REBUILDER](https://github.com/JuanenRac/HYDRA-UMC-OS-REBUILDER)** — outil de bureau Windows/Linux qui construit une image de la CM5 prête à graver, préchargée avec les versions les plus actuelles de l'écosystème, avec une configuration de premier démarrage Wi-Fi/utilisateur/SSH façon Raspberry Pi Imager.
- **[HYDRA-UMC-OPS-AGENT](https://github.com/JuanenRac/HYDRA-UMC-OPS-AGENT)** — coordinateur d'incidents de maintenance : un rôle edge à faible privilège collecte un instantané d'inventaire/santé assaini, un rôle control-plane le rend en lecture seule et demande à un fournisseur d'IA de suggérer un diagnostic - n'applique jamais de correctif ni ne déploie rien.
- **[HYDRA-UMC-DEV-SERVER](https://github.com/JuanenRac/HYDRA-UMC-DEV-SERVER)** — hôte de développement reproductible (Raspberry Pi 5 / CM5) qui héberge le code source de l'écosystème et exécute des tâches de compilation/test délimitées via une file d'attente durable ; un rôle de développement dédié, explicitement distinct d'un CM5 opérationnel.

## 📚 Documentation

Où lire la suite :

* [Base de sécurité de l'écosystème](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md)
* [Modèle de menaces de l'écosystème](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md)
* [Journal des modifications de ce dépôt](CHANGELOG.md)
* [Licence de ce dépôt](LICENSE.md)

## 🤝 Contribuer et communauté

* Avant une pull request, exécutez `HYDRA_UMC_CI=1 py -3 tools/ci_validate.py` (ou `HYDRA_UMC_CI=1 python3 tools/ci_validate.py`) : il doit afficher `CI_VALIDATION=PASS`. N'exécutez pas `build.sh` ni `build.bat` pour cette vérification ; compiler n'est pas vérifier.
* Les huit README sont écrits à partir d'une source unique dans HYDRA-UMC-DOCS ; ne les modifiez pas à la main. Changez la source et réécrivez-les avec `tools/make_readmes.py`.
* N'affirmez pas dans un README ce qui n'a pas tourné : écrivez « simulé » ou « non essayé sur matériel » quand c'est la vérité.
* Voir [CONTRIBUTING.md](CONTRIBUTING.md), le [code de conduite](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md) et [SUPPORT.md](SUPPORT.md).

## 👤 AUTEUR

**JuanenRac (Electro Hobby 3D)** · electrohobby3d@gmail.com

## 📜 LICENCE

GPL-3.0-or-later - [LICENSE](LICENSE).
