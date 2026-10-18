<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-SERVER banner" width="100%">
</p>
# 🛰️ HYDRA-UMC SERVER

<p align="center">
  <a href="README.md">🇺🇸 English</a> |
  <a href="README_spa.md">🇪🇸 Español</a> |
  <a href="README_fra.md">🇫🇷 Français</a> |
  <a href="README_ita.md">🇮🇹 Italiano</a> |
  <a href="README_deu.md">🇩🇪 Deutsch</a> |
  <a href="README_zho.md">🇨🇳 简体中文</a> |
  <a href="README_jpn.md">🇯🇵 日本語</a> |
  🇵🇹 <b>Português</b>
</p>


### 🤖 Back-end headless de API/WebSocket para a microfábrica multirrobô HYDRA-UMC

<p align="center">
  <img src="https://img.shields.io/badge/License-GPL%203.0-blue.svg" alt="GPL 3.0">
  <img src="https://img.shields.io/badge/Runtime-Node.js-339933.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/Framework-Express-000000.svg" alt="Express">
  <img src="https://img.shields.io/badge/Language-TypeScript-3178C6.svg" alt="TypeScript">
  <img src="https://img.shields.io/badge/Protocol-WebSocket-lightgrey.svg" alt="WebSocket">
</p>


**Verificação de honestidade - o que realmente funciona hoje:** o motor Express + WebSocket, a sua superfície de API REST/WS, a autenticação JWT com rotação de tokens de atualização, o hash de palavras-passe com scrypt, a descoberta mDNS, a arbitragem de posse/reivindicação de robôs, a reprodução e os relés para CAN-OTA/telemetria/voz/IA local/connector-hub (`src/server.ts`, `src/users.ts`, `src/kinematics.ts`, `src/metrics.ts`) são reais e testados - não contra simulações, mas contra uma instância viva deste mesmo servidor lançada pelas próprias ferramentas de teste: 122 testes unitários (`npm run test:unit`, `node:test` sobre `src/serverPolicy.ts`/`src/kinematics.ts` e os módulos de política) mais os scripts de contrato de ponta a ponta e de autenticação negativa em `tools/` (descoberta, auth negativa, arranque de produção, comando e posse de robôs, tokens de atualização, relé de voz e os seus caminhos de erro, reprodução, tabela de trabalho/XY persistida, estado do ecossistema/controlo de serviços, relé de telemetria, teste de ligação de integrações, relé CAN-OTA, proxy de IA local, relé do connector-hub, supervisor do sistema, reconexão WS sustentada, Bluetooth, multimédia das câmaras e endurecimento de segurança), todos a passar com `npm run test`. O que é genuinamente próximo do hardware e não está totalmente verificado aqui: a ligação `spi_bridge` a uma placa HYDRA-UMC CM5+STM32H745 real e o caminho opcional de serviço do frontend estático do STUDIO/admin-ui são código real, exercitado através da camada de API/contrato acima, mas este ambiente não tem um CM5/STM32 físico para fechar esse último salto. O TLS/HTTPS e a pilha Prometheus/Grafana em `monitoring/` são reais e opcionais, desativados por defeito. Consulte o `CHANGELOG.md` para saber exatamente o que já foi entregue.

---

## 🎯 Visão geral

O HYDRA-UMC SERVER é o back-end autónomo que comanda uma célula de microfábrica multirrobô HYDRA-UMC: um motor Node.js/Express + WebSocket que guarda o estado dos robôs, o persiste em disco, autentica cada escrita e difunde atualizações em direto a todos os clientes ligados. Não traz interface de utilizador nem passo de compilação de frontend próprios - é um serviço puramente de API + WebSocket, pensado para correr headless (sem navegador, sem ecrã) na máquina que está fisicamente junto dos robôs (tipicamente um Raspberry Pi CM5).

PODE opcionalmente servir também o frontend compilado do **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** como ficheiros estáticos, para o caso comum de "tudo numa só máquina, uma só origem" - execute uma vez **`build-frontend.sh`/`.bat`** (compila o STUDIO a partir de um clone irmão e copia o resultado para o `public/` deste repositório, ignorado pelo git) e este servidor passa a servi-lo em `/` no arranque seguinte. É isto que permite ao HYDRA-UMC-ANDROID-CONTROL, ao HYDRA-UMC-IOS-CONTROL e ao HYDRA-UMC-DSI incorporar a vista 3D real do STUDIO na sua própria WebView, apontada ao `ip:porta` deste mesmo servidor. É totalmente opcional: se saltar esse script, o servidor continua tão headless como descrito acima - o `public/` simplesmente não existirá, e todas as rotas funcionam de forma idêntica nos dois casos.

O mesmo `build-frontend.sh`/`.bat` compila também o **[`admin-ui/`](admin-ui/README.md)** deste repositório - um pequeno painel separado para administrar este próprio SERVER (dispositivos ligados, o seu ficheiro de registo, a sua porta/nome, as suas contas de utilizador), servido em `/admin`. Deliberadamente NÃO é controlo de robôs (isso continua a ser exclusivo do STUDIO) - uma exceção estreita e explícita ao desenho headless acima, não uma inversão dele.

Este projeto fazia parte do **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)**, que era distribuído como um "monólito híbrido": um único processo Node.js que executava o motor de controlo de robôs *e* servia o painel web Vite/React (com o middleware de desenvolvimento do Vite ligado diretamente à mesma aplicação Express). Esse processo foi dividido em dois:

- **HYDRA-UMC SERVER** *(este repositório)* - o motor: estado de robôs/controladores, a API REST + WebSocket, autenticação, descoberta mDNS, submissões de modelos. Sem interface, sem empacotador, sem passo de compilação de frontend.
- **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** - agora um cliente Vite/React puro que fala com este servidor pela rede, exatamente como todos os outros clientes desta API já fazem.

## 🧩 Porquê existe

Separar o motor do painel web foi uma decisão deliberada, não uma refatoração por si só:

- **Isolamento de recursos.** Uma vista 3D pesada a bloquear o separador do navegador já não partilha um processo (nem a disputa de CPU/E-S) com o código realmente responsável por mover os robôs. Se a interface web bloquear, este servidor continua a responder a comandos de paragem de emergência de qualquer outro cliente ligado.
- **Um controlador headless a sério.** Este processo pode correr sem nunca carregar qualquer interface no anfitrião - o "cérebro" de uma célula industrial não precisa de um separador de navegador aberto para funcionar. Liberta RAM/CPU em hardware limitado (um Raspberry Pi CM5) para a parte do trabalho que realmente importa: cinemática e controlo.
- **Ciclos de vida independentes.** A interface web pode ser reimplantada, reiniciada ou trocada a quente por uma versão mais recente sem tocar neste processo - sem tempo de paragem do controlo dos robôs só para publicar uma correção de interface.
- **Alojamento flexível.** Este servidor foi pensado para correr no (ou mesmo ao lado do) hardware que controla; o cliente que o apresenta pode estar alojado em qualquer outro lugar, acessível pela rede exatamente como os outros clientes remotos desta mesma API.

## 🔌 Superfície de API e WebSocket

Todas as rotas, o contrato de mensagens WebSocket, a autenticação e o modelo de acesso remoto por cliente estão documentados em **[`docs/REMOTE_API.md`](docs/REMOTE_API.md)** - a única fonte de verdade para tudo o que fala com este servidor, incluindo o código cliente do próprio HYDRA-UMC STUDIO. Em resumo:

- API REST em `/api/*` - leitura/escrita de definições, comandos atómicos de robô (jog/play/pause/stop/ferramenta/válvula/bomba/velocidade/visão), gestão de contas, envio/descarga de ficheiros de trabalho, submissões de modelos, métricas do sistema, descoberta.
- Um único ponto final WebSocket `/ws` (token de portador como subprotocolo `hydra.bearer`, ou na query string para os clientes que ainda não migraram) que difunde instantâneos completos `settings` e atualizações mais leves `delta` a todos os clientes ligados sempre que o estado muda.
- Autenticação por token de portador JWT em todas as escritas; dois papéis de conta (`admin`, `operator`) separam as escritas de definições/gestão de utilizadores da operação diária dos robôs. As credenciais das câmaras IP só as lê um `admin`.
- Anúncio mDNS/Bonjour `_hydra._tcp` para descoberta sem configuração na rede local, mais um simples `GET /api/hydra-info` para uma varredura de sub-rede.
- `GET /metrics` - formato de exposição Prometheus (`prom-client`), para o painel Grafana opcional descrito em "📊 Monitorização" mais abaixo.

O CORS é ativado através de uma lista de permissões configurável (`CORS_ALLOWED_ORIGINS`, ver "Variáveis de ambiente" mais abaixo), dado que os clientes deste servidor já não partilham necessariamente a sua origem. Sem definição, fica totalmente aberto fora de `NODE_ENV=production` (o comportamento de zero configuração para desenvolvimento local); em produção nega todos os pedidos de navegador de origem cruzada até a lista ser definida - veja o comentário acima de `app.use(cors(corsOptions))` em `src/server.ts` para o raciocínio completo.

## 💾 Dados e persistência

Tudo o que este servidor possui vive em `data/`, criado automaticamente no primeiro arranque:

- `data/settings.json` - a árvore completa de estado: controladores, robôs, configuração do sistema. Nunca é servido como ficheiro estático (devolve 404 explicitamente) - só é acessível pela rota autenticada `/api/settings`.
- `data/users.json` - credenciais das contas (com hash scrypt e sal, nunca em texto simples). Também nunca é servido de forma estática.
- `data/logs/server.log` - registo industrial só de acrescentar de cada comando.
- `data/WORKS/` - trajetórias de robô guardadas, uma pasta por robô por defeito, servidas como ficheiros estáticos simples (índice + ficheiros de trabalho individuais).
- `data/model_submissions.json` + as próprias pastas dos modelos submetidos - o lado servidor do fluxo "enviar um modelo de robô terminado diretamente para o catálogo deste servidor" do [HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF).

## 📂 Estrutura do repositório

```
HYDRA-UMC-SERVER/
├── src/
│   ├── server.ts       # Aplicação Express + WebSocketServer + todas as rotas /api
│   ├── kinematics.ts   # Auxiliar de cinemática inversa para o ponto final atómico de jog
│   ├── metrics.ts      # Alimenta GET /metrics - exposição de texto Prometheus (prom-client)
│   └── users.ts        # Armazém de contas (hash de palavras-passe com scrypt)
├── admin-ui/            # Painel de administração Vite/React separado para ESTE servidor
│   │                      (dispositivos ligados, registo próprio, configuração própria, utilizadores próprios -
│   │                      deliberadamente não é controlo de robôs, que continua exclusivo do STUDIO)
│   ├── src/
│   │   ├── App.tsx, main.tsx, index.css, api.ts, LoginScreen.tsx
│   │   └── tabs/AboutTab.tsx, ConfigTab.tsx, DevicesTab.tsx, LogsTab.tsx, UsersTab.tsx
│   ├── package.json / tsconfig.json / vite.config.ts
│   └── README.md
├── data/                # Estado em execução - definições, utilizadores, registos, ficheiros de trabalho, pontos guardados
│   ├── settings.json
│   ├── users.json
│   ├── logs/
│   ├── points/
│   └── WORKS/
├── docs/
│   ├── REMOTE_API.md              # Contrato completo: todas as rotas, o protocolo WS, autenticação
│   ├── PRODUCTION_BOOTSTRAP.md    # Configuração obrigatória de produção do JWT e do primeiro administrador
│   └── REMOTE_ACCESS_VPN.md       # Guia real de acesso remoto/VPN
├── images/               # Multimédia e diagramas
├── systemd/
│   └── hydra-umc-server.service # Unidade systemd local do CM5
├── tools/
│   ├── ci_validate.py                                   # Validação de manifesto/CHANGELOG/docs usada pelo CI
│   └── verify_*_contract.mjs, verify_auth_negative.mjs  # Verificações reais de contrato/autenticação negativa
│                                                           executadas contra um servidor vivo
├── tests/
│   └── *.test.ts        # Testes unitários diretos (node:test via tsx --test, `npm run test:unit`) das funções
│                           realmente puras em src/ - em processo, sem lançar servidor, a complementar as
│                           verificações de ponta a ponta de tools/ acima
├── monitoring/           # Pilha opcional Prometheus + Grafana - ver monitoring/README.md
├── scripts/
│   └── bump-version.mjs # Auxiliar legado só nativo; as compilações normais usam bump_manifest_version.py
├── bump_manifest_version.py # Sincroniza a versão de hydra-umc.project.json com a nativa (--sync)
├── build.bat / build.sh # Instala dependências + compilação de produção
├── dev.bat / dev.sh      # Instala dependências + inicia o servidor de desenvolvimento
├── package.json
├── tsconfig.json
├── CHANGELOG.md
└── LICENSE
```

`public/` (o frontend estático compilado do STUDIO, implantado junto a este servidor em `/`) está ignorado pelo git - é preenchido copiando o resultado da compilação do próprio STUDIO, não faz parte de um clone novo.

## 🛠️ Ambiente de desenvolvimento

### Requisitos
- [Node.js](https://nodejs.org/) (recomendada a v18 ou superior)
- npm

### Instalação

```bash
npm install
```

### Variáveis de ambiente

Opcionais - o servidor corre sem qualquer configuração, com valores por defeito amigáveis para desenvolvimento em todas as variáveis abaixo. Defina valores reais antes de expor este servidor para além de uma LAN totalmente fiável - por exemplo, à Internet aberta através do NAT/redirecionamento de portas de um router, o que muda o modelo de ameaça de "só LAN fiável" para "acessível por qualquer pessoa" (ver `.env.example`):

- `JWT_SECRET` - assina todos os tokens de início de sessão. Se não estiver definida, usa-se um valor fixo de desenvolvimento incluído em `src/server.ts` (adequado para desenvolvimento local, não para uma implantação acessível fora de uma rede fiável). Exporte-a na sua shell ou através do gestor de processos/contentor que preferir (`Environment=` do systemd, a configuração de ambiente do `pm2`, `-e` do Docker, ...). Em produção tem de ter pelo menos 32 caracteres e não pode ser um valor de exemplo.
- `NODE_ENV` - defina como `production` em qualquer implantação real. Controla as duas alternativas abaixo (CORS aberto, valores por defeito silenciosos) e ativa avisos de arranque bem visíveis se `JWT_SECRET` ou a conta `admin`/`admin` semeada continuarem nos valores por defeito. Sem definição (ou com qualquer outro valor) mantém o comportamento permissivo de desenvolvimento.
- `CORS_ALLOWED_ORIGINS` - lista, separada por vírgulas, de origens autorizadas a fazer pedidos de origem cruzada de navegador a esta API - o caso real em que isto importa é o HYDRA-UMC STUDIO servido a partir de outro anfitrião/porta (por exemplo `https://studio.example.com`, ou `http://192.168.1.20:5173` em desenvolvimento). Exemplo: `CORS_ALLOWED_ORIGINS=https://studio.example.com,http://192.168.1.20:5173`. Se não estiver definida: com `NODE_ENV != production` aceita qualquer origem (sem configuração para desenvolvimento local, igual ao comportamento histórico do projeto); com `NODE_ENV = production` **nega** todos os pedidos de navegador de origem cruzada até ser definida, com um aviso de arranque bem visível. Os clientes que não são navegadores (curl, HYDRA-UMC SUITE, as apps móveis de controlo) nunca são afetados - o CORS é um mecanismo exclusivo dos navegadores.
- `JWT_EXPIRES_IN` - durante quanto tempo um token de sessão continua válido. Qualquer texto que a opção `expiresIn` do próprio `jsonwebtoken` aceite (`"24h"`, `"7d"`, um número simples de segundos, ...). Por defeito `30d` (o pressuposto original de LAN fiável do projeto). **Um servidor acessível para além de uma LAN fiável deve definir um valor muito mais curto - `24h` é um bom ponto de partida** - um token de longa duração que vaze não pode ser revogado individualmente sem alterar a palavra-passe dessa conta.
- `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` - limita apenas `POST /api/login` (todas as outras rotas não são afetadas). Por defeito 5 tentativas por 15 minutos por IP se alguma não estiver definida; um limite excedido responde `429` com um erro JSON claro, não um `500` genérico.
- `REFRESH_RATE_LIMIT_MAX` - orçamento de pedidos de `POST /api/refresh` por janela e IP (por defeito 120). Só os inícios de sessão falhados contam para o limite de início de sessão acima.
- `TLS_CERT_PATH` / `TLS_KEY_PATH` - defina **ambas** para passar o servidor (API REST + o WebSocket `/ws`, que partilha o mesmo ouvinte) de HTTP/WS simples para HTTPS/WSS. Ver "TLS / HTTPS" abaixo. Deixar qualquer uma por definir mantém o comportamento HTTP simples inalterado.
- `HYDRA_UMC_CAMERA_AUTH=required` / `HYDRA_UMC_INFO_AUTH=required` - fazem com que as imagens das câmaras (transmissões em direto, fotos e gravações guardadas, através de um `?ticket=` de curta duração que `POST /api/camera/ticket` entrega a um cliente com sessão) e a informação só de leitura do equipamento (`/metrics`, `/api/system/metrics`, `/api/system/supervisor`, `/api/ecosystem/status`, `/api/models`) exijam um cliente com sessão. Desativado por defeito para que um cliente que ainda não pede tickets continue a funcionar; um arranque em produção avisa enquanto estiverem desativados. Em produção o servidor recusa ainda arrancar com um `JWT_SECRET` ou uma palavra-passe de arranque de exemplo de um modelo de implantação, um `JWT_SECRET` com menos de 32 caracteres ou uma palavra-passe de arranque com menos de 12.

### TLS / HTTPS

Desativado por defeito - este servidor sempre correu em HTTP/WS simples e continua assim a menos que opte por outra coisa. Defina `TLS_CERT_PATH` e `TLS_KEY_PATH` (ver acima) para um certificado PEM e a sua chave privada correspondente, e o ouvinte partilhado REST + WebSocket passa a `https.createServer()` - o `/ws` torna-se automaticamente WSS, sem configuração adicional. Um caminho de certificado/chave definido mas ilegível ou inválido faz o arranque falhar de forma audível (um erro real de `fs`) em vez de recorrer silenciosamente a HTTP simples.

Isto importa sobretudo quando o servidor é acessível para além de uma LAN totalmente fiável (por exemplo, exposto por NAT/redirecionamento de portas de um router para testes remotos) - em HTTP simples, cada token de portador, cada comando de robô e o próprio início de sessão de administrador/operador atravessam a rede em texto claro.

Como obter um certificado:

- **Tem um domínio que aponta para este servidor** - use o [Let's Encrypt](https://letsencrypt.org/) (por exemplo com o [Certbot](https://certbot.eff.org/)) para um certificado real, confiável nos navegadores, gratuito e renovável automaticamente. Aponte `TLS_CERT_PATH` / `TLS_KEY_PATH` para o `fullchain.pem` / `privkey.pem` resultantes.
- **Teste local, sem domínio** - um certificado autoassinado basta para exercitar o caminho HTTPS/WSS (os navegadores e a maioria dos clientes HTTP avisam/exigem uma exceção de confiança explícita, o que é esperado e adequado para testes):
  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"
  ```
  Depois defina `TLS_CERT_PATH=./cert.pem` e `TLS_KEY_PATH=./key.pem`.

### Modo de desenvolvimento

Executa o servidor de API/WebSocket diretamente com `tsx` (sem empacotador, sem frontend):
- **Windows:** faça duplo clique em `dev.bat` ou execute `npm run dev`
- **Linux/Mac:** execute `./dev.sh` ou `npm run dev`

### Compilação de produção

Empacota o servidor num único ficheiro implantável com o esbuild:
- **Windows:** use `build.bat` para uma compilação de lançamento com versão; use `npm run build` para uma compilação apenas de compilação.
- **Linux/Mac:** use `./build.sh` para uma compilação de lançamento com versão; use `npm run build` para uma compilação apenas de compilação.

Depois inicie o servidor de produção com:
```bash
npm start
```

O servidor escuta em `0.0.0.0:3000` - acessível em `http://localhost:3000` ou `http://<o-seu-ip-local>:3000` pela rede local. Todo o estado persiste em `data/`.

### Versionamento

Apenas os scripts `build*.bat` e `build*.sh` da raiz criam um incremento de versão de lançamento. Chamam `bump_manifest_version.py` exatamente uma vez, mantendo `package.json`, `hydra-umc.project.json` e o [`CHANGELOG.md`](CHANGELOG.md) sincronizados com a regra do odómetro de base 10 (`0.0.9` -> `0.1.0`, nunca `0.0.10`). O `npm run build` é deliberadamente só de compilação, pelo que as compilações diretas e a validação `build-test` nunca fazem uma alteração de versão só do pacote. A versão em execução pode ser lida em direto em `GET /api/hydra-info` (`appVersion`).

## 📊 Monitorização (opcional)

`GET /metrics` expõe o tempo de atividade do processo, os clientes WebSocket ligados, a latência de escrita do `settings.json`, os comandos atómicos de robô por tipo, as falhas de autenticação e os mesmos valores de CPU/memória/temperatura de `GET /api/system/metrics` - tudo em formato Prometheus. Uma pilha Prometheus + Grafana pronta a usar (com um painel inicial) está em **[`monitoring/`](monitoring/README.md)**: execute `docker compose up -d` a partir dessa pasta e fica a funcionar. Totalmente opcional - nada disto é necessário para o servidor funcionar.

## 🔗 Projetos relacionados

Este projeto faz parte do ecossistema de robótica HYDRA-UMC do mesmo autor (JuanenRac / Electro Hobby 3D). Vale a pena conhecê-los, porque um pedido pode ser, na verdade, sobre um destes e não sobre este repositório.

**Projetos filhos** — cada um destes é um cliente real ou uma ponte de coordenação que só fala com a frota de robôs através da própria API deste servidor
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — painel web de controlo com visualização 3D em tempo real de vários robôs.
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — centro de comando de enxame para desktop (PySide6) para vários servidores ao mesmo tempo, empacotado como executável independente.
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — aplicação Android nativa de controlo, com início de sessão biométrico e um companheiro Wear OS emparelhado.
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — aplicação de controlo para iOS/iPadOS (Flutter) com sincronização WebSocket em tempo real.
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — interface tátil nativa para o ecrã tátil DSI de 7" integrado, executada no próprio CM5.
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — fronteira de coordenação para frotas AGV/AMR através de um publicador MQTT VDA 5050 real.
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — coordenador de células CNC de alto nível com acesso real ao estado GRBL e aos bytes de controlo.
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — fronteira de coordenação para droides com patas/humanoides, com um emissor real de comandos para o Boston Dynamics Spot.
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — coordenador de segurança de células laser que lê 3 proteções reais por GPIO (chave, caixa e interlock).
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — coordenador seguro de fluxo de placa de alto nível para pick-and-place com OpenPnP.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — fronteira de coordenação segura para impressoras 3D Moonraker/Klipper, com comandos de trabalho reais protegidos por portas.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — coordenador de segurança com um transporte ROS 2 real baseado em rclpy importado sob demanda.
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — fronteira de coordenação para UAV com câmara, com um emissor real de comandos MAVLink.

**Diretamente relacionados**
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — este servidor retransmite-lhe turnos de voz limitados e autenticados por uma ligação de loopback, mantendo o token do gateway no lado do servidor para que a voz nunca se torne um comando direto a um robô.
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — a placa-mãe física do braço robótico com a qual o serviço `spi_bridge` deste servidor fala através da ligação real SPI-OTA CM5↔STM32H745.

**Também fazem parte do ecossistema**

*Hardware e plataforma centrais*
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — camada de produto reproduzível do Raspberry Pi OS para o CM5 em que este servidor corre: agente só de leitura, configuração/perfis validados, provisionamento Wi-Fi no primeiro contacto.
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — o contrato JSON Schema partilhado e a fronteira de porta de segurança contra a qual cada ponte acima valida os seus comandos.
- **[HYDRA-UMC-CONNECTOR-HUB](https://github.com/JuanenRac/HYDRA-UMC-CONNECTOR-HUB)** — registo declarativo de manifestos de adaptador e validador para conectores de máquinas externas; estende a ideia de contrato do SDK a máquinas externas sem substituir os projetos de gateway industrial.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — criador/editor gráfico de URDF para desktop que envia os modelos terminados para o catálogo deste servidor.
- **[HYDRA-UMC-EDITOR-STL](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-STL)** — editor de modelos STL para desktop que transforma/substitui/remove/adiciona peças reais no mesmo catálogo de modelos que o HYDRA-UMC-EDITOR-URDF também edita.

*Plataforma de ferramentas URTC*
- **[URTC](https://github.com/JuanenRac/URTC)** — firmware da placa física Universal Robot Tool Controller, mais de 25 perfis de ferramenta por barramento CAN.
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — ferramenta gráfica de gravação para desktop das placas URTC, por CAN-OTA e também SWD/JTAG de chip completo.
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — ferramenta de diagnóstico CAN em tempo real para desktop das placas URTC, com um painel por perfil de ferramenta.
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — alternativa no navegador ao URTC-TESTER através da Web Serial API, sem instalação local.

*Nó de IA de visão (Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — centro de integração do pipeline de visão Hailo-8, com uma verificação real de prontidão de hardware por fase.
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — registo real de modelos compilados com verificação segura de carga por arquitetura Hailo e soma de verificação.
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — pipeline GStreamer real e gerador de configuração MediaMTX com uma fronteira de integração HailoRT real.
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — lei de correção real de servovisão baseada em posição, protegida pelo estado da zona a montante.
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — verificação real de violação de zonas e pedido de E-STOP, com exigência de calibração recente.

*Nó de IA cognitiva (Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** — centro de integração do pipeline cognitivo do Hailo-10 (orquestração de LLM/VLA/voz).
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** — codificação/descodificação real de tokens de ação e geração de trajetórias para um modelo Visão-Linguagem-Ação.
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** — decomposição real de tarefas baseada em regras e recuperação semântica de erros sobre os códigos de erro do MCU.
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** — pesquisa real de documentos TF-IDF só com a biblioteca padrão sobre a documentação Markdown deste ecossistema.
- **[HYDRA-UMC-LOCAL-TECHNICIAN](https://github.com/JuanenRac/HYDRA-UMC-LOCAL-TECHNICIAN)** — técnico de manutenção de IA local, protegido por políticas, para o próprio ecossistema: observa, diagnostica e propõe correções; os dois níveis de maior risco não estão implementados de propósito.

*Orquestração e enxame*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — centro de integração com um contrato real de relatório de saúde gRPC/Protobuf e uma máquina de estados de missões.
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** — fila real de trabalhos por prioridade com deduplicação, sobre uma API HTTP real.
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — vigilante real de saúde da frota por gRPC com repetição/recuo e deteção de identidade incoerente.
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** — planeador real de trajetórias 3D baseado em RRT com validação real de colisões com obstáculos e espaço de trabalho.
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** — sincronização real de estado CRDT LWW-Element-Map, testada por propriedades para a convergência de várias células.

*Gémeo digital e simulação*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** — centro de integração do motor de gémeo digital, com um contrato real de sincronização de compatibilidade de versões.
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — interlock de segurança real de hardware-in-the-loop que encaminha comandos entre a simulação e o hardware real.
- **[HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)** — cinemática direta real e validação de limites de juntas sobre um subconjunto real de URDF.
- **[HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)** — gerador procedural real de cenas 2D com exportação de anotações YOLO/COCO.

*Dados e análise*
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** — armazém real de séries temporais sobre sqlite3 com uma API HTTP real de ingestão/consulta.
- **[HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)** — detetor real de anomalias por FFT e linha de base estatística, com monitorização de deriva.
- **[HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)** — cálculo real de OEE/disponibilidade sobre o histórico do DATALAKE, com exportação CSV reprodutível.
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** — pipeline real de ingestão CAN/WebSocket para o DATALAKE, com deduplicação por sequência.

*Gateway industrial*
- **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** — centro de integração que retransmite para protocolos industriais, com uma camada real de lista de comandos permitidos e contrapressão.
- **[HYDRA-UMC-OPCUA-SERVER](https://github.com/JuanenRac/HYDRA-UMC-OPCUA-SERVER)** — espaço de endereços OPC-UA real, verificado com uma sessão de cliente real do protocolo binário.
- **[HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)** — broker MQTT real com autenticação opcional por cliente e ACL de tópicos.
- **[HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)** — endpoints XML MTConnect `/probe` e `/current` reais com saída em modo degradado.

*Ferramentas complementares e operações do ecossistema*
- **[HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)** — painéis de Resumos Inteligentes e Realce de Anomalias sobre o DATALAKE/ANOMALY-DETECTOR, com um recurso estatístico honesto.
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** — CLI de frota com um contrato real e estável de códigos de saída, um cliente vivo genuíno da API deste próprio servidor.
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — aplicação companheira WearOS com alertas hápticos reais e um relé de voz para o telemóvel emparelhado.
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** — firmware de um rack de montagem de placas com descodificação real do ID da ferramenta e lógica de pré-aquecimento Smart Idle.
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** — firmware mais um companheiro de visão em Python real para uma cabeça de ferramenta de inspeção térmica/RGB.
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** — ferramenta administrativa de desktop que descobre, clona e atualiza todos os repositórios deste ecossistema.
- **[HYDRA-UMC-OS-REBUILDER](https://github.com/JuanenRac/HYDRA-UMC-OS-REBUILDER)** — ferramenta de desktop para Windows/Linux que constrói uma imagem do CM5 pronta a gravar com as versões mais recentes do ecossistema, com configuração de primeiro arranque de Wi-Fi/utilizador/SSH ao estilo do Raspberry Pi Imager.
- **[HYDRA-UMC-OPS-AGENT](https://github.com/JuanenRac/HYDRA-UMC-OPS-AGENT)** — coordenador de incidentes de manutenção: um papel de borda de poucos privilégios recolhe um inventário/estado higienizado, um papel de plano de controlo mostra-o só de leitura e pede a um fornecedor de IA que sugira um diagnóstico; nunca aplica um patch nem implanta nada.
- **[HYDRA-UMC-DEV-SERVER](https://github.com/JuanenRac/HYDRA-UMC-DEV-SERVER)** — anfitrião de desenvolvimento reproduzível (Raspberry Pi 5 / CM5) que guarda o código-fonte do ecossistema e executa tarefas limitadas de compilação/teste numa fila durável; um papel de desenvolvimento dedicado, explicitamente não um CM5 operacional.

---

## 📚 Documentação e comunidade

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — pilha tecnológica e diretrizes de código para um pull request.
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — as normas de comportamento esperadas nesta comunidade.
- **[SECURITY.md](SECURITY.md)** — como comunicar uma vulnerabilidade e as áreas de segurança em que este projeto se concentra.
- **[SUPPORT.md](SUPPORT.md)** — onde fazer perguntas e comunicar erros.
- **[LICENSE.md](LICENSE.md)** — a licença deste projeto.

## 👤 AUTOR
**JuanenRac** (Electro Hobby 3D)
📧 electrohobby3d@gmail.com
📺 [youtube.com/@electrohobby3d](https://youtube.com/@electrohobby3d)

## 📜 LICENÇA

O HYDRA-UMC SERVER é (c) 2026 JuanenRac (Electro Hobby 3D). Este aviso
deve ser incluído em qualquer distribuição deste projeto ou de trabalhos derivados.

O código-fonte desta aplicação está disponível sob a **GNU General
Public License v3.0 (GPL-3.0)**. Texto completo em
https://www.gnu.org/licenses/gpl-3.0.html.

A documentação (este README e as suas próprias traduções -
`README_spa.md`, `README_ita.md`, `README_fra.md`, `README_deu.md`,
`README_zho.md`, `README_jpn.md`, `README_por.md`) está
disponível sob a **Creative Commons Attribution-ShareAlike 4.0
International (CC BY-SA 4.0)**. Texto completo em
https://creativecommons.org/licenses/by-sa/4.0/.

