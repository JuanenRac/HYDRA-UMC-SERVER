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


**Verificação de honestidade - o que realmente funciona hoje:** o motor Express + WebSocket, a sua superfície de API REST/WS, a autenticação JWT com rotação de tokens de atualização, o hash de palavras-passe com scrypt, a descoberta mDNS, a arbitragem de posse/reivindicação de robôs, a reprodução e os relés para CAN-OTA/telemetria/voz/IA local/connector-hub (`src/server.ts`, `src/users.ts`, `src/kinematics.ts`, `src/metrics.ts`) são reais e testados - não contra simulações, mas contra uma instância viva deste mesmo servidor lançada pelas próprias ferramentas de teste: 211 testes unitários (`npm run test:unit`, `node:test` sobre `src/serverPolicy.ts`/`src/kinematics.ts` e os módulos de política) mais os scripts de contrato de ponta a ponta e de autenticação negativa em `tools/` (descoberta, auth negativa, arranque de produção, comando e posse de robôs, tokens de atualização, relé de voz e os seus caminhos de erro, reprodução, tabela de trabalho/XY persistida, estado do ecossistema/controlo de serviços, relé de telemetria, teste de ligação de integrações, relé CAN-OTA, proxy de IA local, relé do connector-hub, supervisor do sistema, religação WS sustentada, Bluetooth, multimédia das câmaras e endurecimento de segurança), todos a passar com `npm run test`. O que é genuinamente próximo do hardware e não está totalmente verificado aqui: a ligação `spi_bridge` a uma placa HYDRA-UMC CM5+STM32H745 real e o caminho opcional de serviço do frontend estático do STUDIO/admin-ui são código real, exercitado através da camada de API/contrato acima, mas este ambiente não tem um CM5/STM32 físico para fechar esse último salto. O TLS/HTTPS e a pilha Prometheus/Grafana em `monitoring/` são reais e opcionais, desativados por defeito. Consulte o `CHANGELOG.md` para saber exatamente o que já foi entregue.

---

> **Estado de segurança (safety e security):** este ecossistema não é um sistema de segurança certificado. Ainda não existe um caminho de E-STOP por hardware, nem limites ou interlocks impostos pelo firmware, nem um comando de movimento verificado; as imagens de firmware são verificadas com CRC32 e um HMAC-SHA256 de chave partilhada, não com uma assinatura assimétrica; TLS e TLS mútuo são opcionais e estão desativados por defeito; nenhuma placa própria foi ainda montada ou testada. Leia a [base de segurança](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md) e o [modelo de ameaças](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md) antes de confiar em qualquer afirmação aqui para a segurança de uma pessoa.

## 📋 Num relance

| | |
|---|---|
| Versão | `0.8.1.2` |
| Maturidade | Funcional |
| Testes | 348 (`npm run test:unit`) |
| Tecnologia | Node.js 20+ / Express / WebSocket (ws) / REST/OpenAPI |
| Destino | O Raspberry Pi CM5 de uma célula HYDRA-UMC |
| Em hardware real | Ainda não: não há registo de execução em hardware real para esta versão |

## 🚦 Estado do projeto

Cada linha é uma parte deste repositório e a luz diz até onde chega hoje. É escrita com o que o repositório consegue demonstrar (testes, compilações, execuções), não com o que está previsto.

🟢 Feito e verificado · 🟡 Funciona, com limites conhecidos · 🟠 Feito a meio ou ainda por verificar · 🔴 Por fazer ou a não funcionar

| Área | Estado | O que significa aqui |
|---|---|---|
| Software | 🟡 | Funciona para o seu propósito principal; a verificação de honestidade acima lista o que ainda falta |
| Testes | 🟢 | 348 testes automáticos, executados a cada alteração |
| Hardware real | 🔴 | Ainda não: não há registo de execução em hardware real para esta versão |
| Documentação | 🟢 | README em oito idiomas, verificado contra o manifesto a cada alteração |

## 🎯 Visão geral

O HYDRA-UMC SERVER é o back-end autónomo que comanda uma célula de microfábrica multirrobô HYDRA-UMC: um motor Node.js/Express + WebSocket que guarda o estado dos robôs, o persiste em disco, autentica cada escrita e difunde atualizações em direto a todos os clientes ligados. Não traz interface de utilizador nem passo de compilação de frontend próprios - é um serviço puramente de API + WebSocket, pensado para correr headless (sem navegador, sem ecrã) na máquina que está fisicamente junto dos robôs (tipicamente um Raspberry Pi CM5).

O segundo contrato está completo: escritas condicionais (`If-Match` em comandos e reservas, `GET /api/robot/:id`), o comando atómico `table`, um registo de auditoria só de acréscimo (`GET /api/audit`, encadeado por hash, desativável) e uma mensagem `claims` por WebSocket. As palavras-passe das câmaras já não aparecem na lista de processos nem no registo. Ver `docs/CONTRACT_V2.md`.

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
- Um único ponto final WebSocket `/ws` (token de portador como subprotocolo `hydra.bearer`, um token na query string é recusado a menos que a instalação volte a permiti-lo) que difunde instantâneos completos `settings` e atualizações mais leves `delta` a todos os clientes ligados sempre que o estado muda.
- `POST /api/stop-all` é a paragem global: uma chamada, aberta a qualquer conta com sessão, pára todos os robôs e desliga todas as válvulas e bombas,
  seja qual for a reserva, e responde um resultado por robô.
- Bluetooth LE (desligado por defeito): um telemóvel perto da CM5 pode ler o estado dos robôs e, quando um administrador o permite, enviar comandos que o servidor só confirma depois de a mesma rota que um cliente de rede usa ter respondido. Ver [`docs/BLE_GATT.md`](docs/BLE_GATT.md).
- Autenticação por token de portador JWT em todas as escritas; três papéis de conta (`admin`, `operator`, `viewer` só de leitura) separam as escritas de definições/gestão de utilizadores da operação diária dos robôs. As credenciais das câmaras IP só as lê um `admin`.
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
│   ├── server.ts       # Arranque fino que liga os módulos abaixo; as rotas /api estão em src/routes/, as ligações em direto em ws.ts, os ficheiros de definições em settingsStore.ts
│   ├── kinematics.ts   # Auxiliar de cinemática inversa para o ponto final atómico de jog
│   ├── metrics.ts      # Alimenta GET /metrics - exposição de texto Prometheus (prom-client)
│   ├── ble/            # Serviço Bluetooth LE: tramas, gateway (comandos, confirmações, estado) e transporte do auxiliar
│   ├── users.ts        # Armazém de contas (hash de palavras-passe com scrypt)
│   ├── routes/         # As rotas /api por área: autenticação, definições, reservas de robô, comandos, limites de segurança, câmaras, Bluetooth, administração, sistema, relés para os serviços irmãos, IA local, assistente, ficheiros de trabalho, energia, informação e ficheiros estáticos
│   ├── auth.ts, refresh_tokens.ts, secretsPolicy.ts, securityConfig.ts, upstreamAuth.ts # Verificação de tokens, a porta de administrador e os limitadores de taxa; o armazém de tokens de renovação; o que a produção aceita como segredo de assinatura e primeira palavra-passe; as opções de acesso; os tokens apresentados aos serviços retransmitidos
│   ├── claimPolicy.ts, robotEdit.ts, safetyLimits.ts, tableCommand.ts, playback.ts # Quem controla que robô; as edições que um operador faz num robô; os limites a que todo o cliente está sujeito; o movimento da mesa XY num só pedido; a reprodução com autoridade no servidor
│   ├── settingsStore.ts, settingsBackups.ts, transactionalFiles.ts, auditLog.ts, logRotation.ts # Os ficheiros de definições em disco, as suas cópias de segurança, escritas tudo-ou-nada de vários ficheiros, o registo de auditoria e a rotação de logs
│   ├── ws.ts, mqttBridge.ts, mqttStart.ts, telemetryProducer.ts # O centro de ligações em direto (WebSocket), a ponte MQTT para o broker da célula e o seu arranque, e o primeiro produtor de telemetria
│   ├── cameraHealth.ts, cameraProbe.ts, cameraSupervisor.ts, mediaTickets.ts # Se um fluxo de câmara entrega mesmo imagens, sondagem de câmaras IP e PTZ, o supervisor dos processos de fluxo e bilhetes de curta duração para as imagens das câmaras
│   └── ecosystemStatus.ts, portsRegistry.ts, systemMetrics.ts, runtime.ts, serverPolicy.ts, redaction.ts, bluetooth.ts, upstreamConfig.ts, voiceConfirm.ts # Descoberta e vitalidade do ecossistema, o registo das portas dos serviços, métricas do equipamento, o ambiente de execução do processo (mDNS, porta), auxiliares de política puros, ocultação de segredos, auxiliares de emparelhamento Bluetooth, os endereços dos serviços a montante e a confirmação de um pedido falado
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
│   ├── CONTRACT_V2.md             # Desenho do segundo contrato, por blocos
│   ├── PRODUCTION_BOOTSTRAP.md    # Configuração obrigatória de produção do JWT e do primeiro administrador
│   ├── REMOTE_ACCESS_VPN.md       # Guia real de acesso remoto/VPN
│   ├── BLE_GATT.md                # Serviço Bluetooth LE: caraterísticas, tramas, comandos e confirmações
│   ├── MQTT_BRIDGE.md             # A ponte MQTT para o broker da célula: modos (desligada por omissão), tópicos e comandos
│   └── openapi.json               # A descrição OpenAPI da API HTTP (gerada por tools/generate_openapi.mjs)
├── images/               # Multimédia e diagramas
├── systemd/
│   └── hydra-umc-server.service # Unidade systemd local do CM5
├── tools/
│   ├── build_test.py            # Verificação de compilação sem alterar versões
│   ├── ci_validate.py                                   # Validação de manifesto/CHANGELOG/docs usada pelo CI
│   ├── generate_openapi.mjs, openapi_types.mjs          # Geram docs/openapi.json a partir das rotas e, a partir dele, os tipos TypeScript
│   ├── verify_*_contract.mjs, verify_auth_negative.mjs  # Verificações reais de contrato/autenticação negativa
│   │                                                       executadas contra um servidor vivo
│   ├── _doc_policy.py                                   # Regras de documentação partilhadas pela família (cópia da de HYDRA-UMC-SDK, mantida em sincronia)
│   ├── _readme_parity.py                                # Verificação de que os oito README partilham a mesma estrutura (cópia da de HYDRA-UMC-SDK, mantida em sincronia)
│   └── hydra_project_tool.py                            # Os mesmos comandos em todos os repositórios: validate, test, ci, version, status, bump
├── tests/
│   └── *.test.ts        # Testes unitários diretos (node:test via tsx --test, `npm run test:unit`) dos módulos puros: política, cinemática, reservas, limites de segurança, tokens, segredos, tramagem e gateway BLE, saúde e sondagem de câmaras, a ponte MQTT, telemetria e mais - no mesmo processo, sem lançar um servidor, como complemento das verificações de ponta a ponta de tools/ acima
├── monitoring/           # Pilha opcional Prometheus + Grafana - ver monitoring/README.md
├── scripts/
│   ├── ble_gatt_helper.py # O lado BlueZ do serviço Bluetooth LE (D-Bus), comandado por linhas JSON
│   └── bump-version.mjs # Subida de versão ao estilo conta-quilómetros (executada só pelo comando `bump` explícito)
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
- `HYDRA_UMC_CAMERA_AUTH` - as imagens das câmaras (transmissões em direto, fotos e gravações guardadas) exigem **por defeito** um `?ticket=` de curta duração (`POST /api/camera/ticket` entrega um a um cliente com sessão) ou um token Bearer; `HYDRA_UMC_CAMERA_AUTH=open` é a saída temporária para os clientes que ainda não pedem tickets.
- `HYDRA_UMC_WS_QUERY_TOKEN` - `/ws?token=` é **recusado por defeito** (o token viaja como subprotocolo `hydra.bearer`); `HYDRA_UMC_WS_QUERY_TOKEN=allow` é a saída temporária para os clientes que ainda não migraram. O servidor avisa em cada arranque enquanto houver uma saída ativa.
- `HYDRA_UMC_BLE_GATT` - o serviço Bluetooth LE: `off` (por defeito), `state` (os telemóveis leem o estado) ou `commands` (e enviam comandos, cada um com o token de acesso da conta). `HYDRA_UMC_BLE_ENCRYPTION=off` deixa de exigir uma ligação cifrada (é exigida por defeito). Ambos podem também ser definidos no ecrã de administração do servidor; uma alteração aplica-se no arranque seguinte. Precisa de BlueZ, `python3-dbus` e `python3-gi` na máquina.
- `HYDRA_UMC_MQTT_BRIDGE` - a ponte para o broker MQTT da célula: `off` (por defeito), `state` (o estado de cada robô sai em tópicos retidos) ou `commands` (e um comando publicado no tópico de um robô é executado pela mesma rota que usa um cliente de rede, com o token de uma conta dedicada indicada por `HYDRA_UMC_MQTT_COMMAND_USER`). O endereço, o prefixo dos tópicos e os nomes de utilizador também se definem no ecrã Server Admin; as palavras-passe apenas pelo ambiente. Ver [`docs/MQTT_BRIDGE.md`](docs/MQTT_BRIDGE.md).
- `HYDRA_UMC_INFO_AUTH=required` - faz com que a informação só de leitura do equipamento (`/metrics`, `/api/system/metrics`, `/api/system/supervisor`, `/api/ecosystem/status`, `/api/models`) exija um cliente com sessão. Desativado por defeito para que um cliente que ainda não envia o seu token nessas rotas continue a funcionar; um arranque em produção avisa enquanto estiver desativado.
- `HYDRA_UMC_AI_ACCESS=admin` - limita aos administradores o reencaminhamento para os serviços de IA locais (`/api/ai/*`). Desativado por omissão: qualquer utilizador autenticado o pode usar, como antes.
- `HYDRA_UMC_VISUAL_SERVOING_TOKEN`, `HYDRA_UMC_VLA_ENGINE_TOKEN`, `HYDRA_UMC_COGNITIVE_NODE_TOKEN`, `HYDRA_UMC_DETECTION_HEF_TOKEN`, `HYDRA_UMC_VISION_NODE_TOKEN` e `HYDRA_UMC_ANOMALY_TOKEN` (para o relay `/api/ai/*`), `HYDRA_UMC_VISION_STREAMER_TOKEN` (para as transmissões das câmaras) e `HYDRA_UMC_DATALAKE_READ_TOKEN`, ou então `HYDRA_UMC_DATALAKE_TOKEN` (para a telemetria) - o token Bearer que este servidor apresenta a um serviço que o peça; cada uma lê também `..._FILE`, um ficheiro cuja primeira linha é o token. São os nomes que os próprios serviços leem, pelo que um só ficheiro de ambiente serve a ambos, e nenhum cliente os vê. Um serviço sem token configurado alcança-se exatamente como antes. O relay recusa ainda uma sessão que não seja de administrador nem de operador, e só um administrador pode alterar a linha de base do detetor de anomalias (qualquer `POST` que não seja `/detect`); o `vision-node` e o `anomaly-detector` juntam-se ao relay.
- `HYDRA_UMC_VOICE_UI_RESULT_KEY` (ou `..._FILE`) - a chave com que o HYDRA-UMC-VOICE-UI assina um resultado de voz confirmado (16 caracteres ou mais, o mesmo valor que ele tem). `POST /api/voice/confirm` retransmite uma confirmação com o utilizador com sessão como sujeito e só acredita numa resposta `confirmed` se nomear esse utilizador e a sua assinatura for válida; sem a chave a resposta é passada com `verified: false`, e `HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE=1` recusa-a em vez disso. Esta rota não executa nada.
- `HYDRA_UMC_TELEMETRY_COLLECTOR_URL` (com `HYDRA_UMC_TELEMETRY_COLLECTOR_TOKEN` ou `..._FILE`, e `HYDRA_UMC_TELEMETRY_INTERVAL_MS`, de 100 a 60000, 1000 por omissão) - ativa o produtor de telemetria: os valores de cada delta de robô que este servidor difunde (posição, articulações, estado de reprodução) são enviados ao HYDRA-UMC-TELEMETRY-COLLECTOR como uma amostra `robot_state` por robô, no máximo uma por intervalo e fundidas, para que o data lake tenha algo real para guardar. Desativado se faltar o endereço; nunca atrasa um comando, guarda uma quantidade limitada de dados e fica em pausa 30 segundos após uma falha.
- `/dashboard-ai` - se o HYDRA-UMC-DASHBOARD-AI estiver descarregado ao lado deste repositório, o `build-frontend` compila-o e este servidor serve-o aí. A página lê o data lake (`/api/ai/datalake/*`, só leitura: `GET` de `/query`, `/aggregate`, `/stats`, `/stats/range`, `/series` e `/health`; tudo o resto é recusado) e o detetor de anomalias (`/api/ai/anomaly-detector/*`) através do relay, com a sessão de quem iniciou sessão no STUDIO no mesmo navegador, pelo que se aplicam os papéis e os tokens de serviço deste servidor. Com isso, o detetor de anomalias pode arrancar com `HYDRA_UMC_ANOMALY_PROTECT_READS=1`.
- `HYDRA_UMC_LOG_MAX_BYTES` e `HYDRA_UMC_LOG_KEEP` - o tamanho a que o registo do servidor roda (10 MB por omissão) e quantos ficheiros rodados se guardam (1 por omissão).
- `HYDRA_UMC_SETTINGS_STORE`, `HYDRA_UMC_SETTINGS_BACKUPS` e `HYDRA_UMC_SETTINGS_BACKUP_INTERVAL_S` - por omissão as definições (`settings.json` e os ficheiros de pontos) são escritas como uma unidade de tudo ou nada com um diário: uma escrita interrompida é terminada ou descartada no arranque seguinte, é guardada uma cópia de `settings.json` em `data/backups/` (10 cópias, no máximo uma a cada 600 s) e um `settings.json` danificado é restaurado a partir da última cópia boa. `HYDRA_UMC_SETTINGS_STORE=plain` volta a escrever os ficheiros um a um; `HYDRA_UMC_SETTINGS_BACKUPS=0` desativa as cópias.
- O acesso ao reencaminhamento de IA, a exigência de sessão da informação do equipamento e o TLS (caminhos do certificado e da chave, com a impressão digital SHA-256 do certificado) também podem ser alterados por um administrador no ecrã Administração do servidor da app de controlo. Um valor definido no ambiente prevalece e aparece bloqueado; a exigência de sessão pede confirmação antes de ser desativada; o TLS aplica-se no arranque seguinte.
- `STOP_ALL_RATE_LIMIT_MAX` / `STOP_ALL_RATE_LIMIT_WINDOW_MS` - orçamento da paragem global (`POST /api/stop-all`) por endereço, separado do do início de sessão (por defeito 60 por minuto). Em produção o servidor recusa ainda arrancar com um `JWT_SECRET` ou uma palavra-passe de arranque de exemplo de um modelo de implantação, um `JWT_SECRET` com menos de 32 caracteres ou uma palavra-passe de arranque com menos de 12.

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

Este repositório não tem Dockerfile de propósito: o servidor é empacotado e instalado na CM5 pelo [HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS) (`provisioning/install_server.sh`).

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
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — fronteira de coordenação para frotas AGV/AMR através de um publicador MQTT VDA 5050 (testado apenas contra uma frota emulada).
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — coordenador de células CNC de alto nível com acesso ao estado GRBL e aos bytes de controlo (testado apenas contra um emulador).
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — fronteira de coordenação para droides com patas/humanoides, com um emissor de comandos para o Boston Dynamics Spot (testado apenas contra um emulador).
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — coordenador de células laser que lê 3 sinais GPIO (chave, caixa e interlock) (testado apenas contra um chip simulado; não pode armar nem disparar um laser).
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — coordenador seguro de fluxo de placa de alto nível para pick-and-place com OpenPnP.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — fronteira de coordenação segura para impressoras 3D Moonraker/Klipper, com comandos de trabalho reais protegidos por portas.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — coordenador com um transporte ROS 2 baseado em rclpy importado sob demanda (ainda não executado contra uma instalação ROS 2).
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — fronteira de coordenação para UAV com câmara, com um emissor de comandos MAVLink (testado apenas contra um emulador).

**Diretamente relacionados**
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — este servidor retransmite-lhe turnos de voz limitados e autenticados por uma ligação de loopback, mantendo o token do gateway no lado do servidor para que a voz nunca se torne um comando direto a um robô.
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — o desenho da placa-mãe do braço robótico (ainda sem placa montada); o serviço `spi_bridge` deste servidor destina-se a comunicar com ela pela ligação SPI-OTA CM5↔STM32H745 (testado só com simulações).

**Também fazem parte do ecossistema**

*Hardware e plataforma centrais*
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — camada de produto reproduzível do Raspberry Pi OS para o CM5 em que este servidor corre: agente só de leitura, configuração/perfis validados, provisionamento Wi-Fi no primeiro contacto.
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — o contrato JSON-Schema partilhado e a fronteira de software de controlo de trabalhos contra a qual cada bridge valida os seus comandos (não é uma função de segurança certificada).
- **[HYDRA-UMC-CONNECTOR-HUB](https://github.com/JuanenRac/HYDRA-UMC-CONNECTOR-HUB)** — registo declarativo de manifestos de adaptador e validador para conectores de máquinas externas; estende a ideia de contrato do SDK a máquinas externas sem substituir os projetos de gateway industrial.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — criador/editor gráfico de URDF para desktop que envia os modelos terminados para o catálogo deste servidor.
- **[HYDRA-UMC-EDITOR-STL](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-STL)** — editor de modelos STL para desktop que transforma/substitui/remove/adiciona peças reais no mesmo catálogo de modelos que o HYDRA-UMC-EDITOR-URDF também edita.

*Plataforma de ferramentas URTC*
- **[URTC](https://github.com/JuanenRac/URTC)** — firmware da placa física Universal Robot Tool Controller, mais de 25 perfis de ferramenta por barramento CAN.
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — ferramenta gráfica de gravação para desktop das placas URTC, por CAN-OTA e também SWD/JTAG de chip completo.
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — ferramenta de diagnóstico CAN em tempo real para desktop das placas URTC, com um painel por perfil de ferramenta.
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — alternativa no navegador ao URTC-TESTER através da Web Serial API, sem instalação local.
- **[URTC-GATEWAY](https://github.com/JuanenRac/URTC-GATEWAY)** — gateway à frente do barramento CAN do URTC: lista de identificadores permitidos, limite de taxa e chave de sessão; software testado num computador, ainda não num barramento real.

*Nó de IA de visão (Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — centro de integração do pipeline de visão Hailo-8, com uma verificação real de prontidão de hardware por fase.
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — registo real de modelos compilados com verificação segura de carga por arquitetura Hailo e soma de verificação.
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — pipeline GStreamer real e gerador de configuração MediaMTX com uma fronteira de integração HailoRT real.
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — lei de correção de servovisão baseada em posição com autorização condicionada ao estado da zona; ainda sem estimativa de pose por câmara.
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — lógica v0 de violação de zonas, atualidade da calibração e pedido de E-STOP que lê as posições dos objetos de um ficheiro; nenhum detetor a alimenta e ainda não há E-STOP físico ligado.

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
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — encaminhador hardware-in-the-loop com um interlock de software de colisão entre a simulação e o hardware real (testado sem hardware real).
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
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — aplicação companheira WearOS com padrões de alerta tátil e um relé de voz para o telemóvel emparelhado (ainda não executada num relógio físico).
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

