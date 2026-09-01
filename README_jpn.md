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
  🇯🇵 <b>日本語</b>
</p>


### 🤖 HYDRA-UMC マルチロボット・マイクロファクトリー向けヘッドレス API/WebSocket バックエンド

<p align="left">
  <img src="https://img.shields.io/badge/License-GPL%203.0-blue.svg" alt="GPL 3.0">
  <img src="https://img.shields.io/badge/Runtime-Node.js-339933.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/Framework-Express-000000.svg" alt="Express">
  <img src="https://img.shields.io/badge/Language-TypeScript-3178C6.svg" alt="TypeScript">
  <img src="https://img.shields.io/badge/Protocol-WebSocket-lightgrey.svg" alt="WebSocket">
</p>


---

## 🎯 概要

HYDRA-UMC SERVER は、HYDRA-UMC マルチロボット・マイクロファクトリーセルを駆動するスタンドアロンのバックエンドです。Node.js/Express + WebSocket エンジンとして、ロボットの状態を保持し、ディスクへ永続化し、すべての書き込みを認証したうえで、接続中の全クライアントへリアルタイム更新をブロードキャストします。それ自体にはユーザーインターフェースもフロントエンドのビルド手順も持たず、純粋な API + WebSocket サービスとして、実際にロボットの隣に設置されるマシン（通常は Raspberry Pi CM5）上でヘッドレス（ブラウザなし、ディスプレイなし）に動作することを想定しています。

任意で **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** 自身がビルドしたフロントエンドを静的ファイルとして配信することも **可能** です。「1 台のマシン、1 つのオリジンにすべてをまとめる」という一般的なデプロイ形態に対応するもので、**`build-frontend.sh`/`.bat`** を一度実行するだけで（隣接するチェックアウトから STUDIO をビルドし、その出力を本リポジトリ自身の `public/`（gitignore 対象）へコピーします）、本サーバーは次回起動時からそれを `/` で配信し始めます。これにより、HYDRA-UMC-ANDROID-CONTROL、HYDRA-UMC-IOS-CONTROL、HYDRA-UMC-DSI が、それぞれ自身のアプリ内 WebView に本物の STUDIO 3D ビューポートを埋め込み、同じサーバー自身の `ip:port` を指すことができます。完全に任意機能です——このスクリプトを実行しなければ、本サーバーは上記のとおり完全にヘッドレスなままです。`public/` は単に存在せず、いずれの場合もすべてのルートは同一に動作し続けます。

同じ `build-frontend.sh`/`.bat` は、本リポジトリ自身の **[`admin-ui/`](admin-ui/README.md)**（本 SERVER 自体を管理するための小さな独立パネル——接続デバイス、自身のログファイル、自身のポート／名前、自身のユーザーアカウント）もビルドし、`/admin` で配信します。これは意図的にロボット制御では **ありません**（それは常に STUDIO 専任です）——上記のヘッドレス設計に対する、明確かつ限定的な例外であり、その撤回ではありません。

本プロジェクトはかつて **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** の一部でした。当時は「ハイブリッドモノリス」として提供されており、1 つの Node.js プロセスがロボット制御エンジンと Vite/React 製の Web ダッシュボードの両方を実行していました（Vite 自身の開発ミドルウェアが同じ Express アプリへ直接組み込まれていました）。そのプロセスは現在、次の 2 つに分割されています：

- **HYDRA-UMC SERVER**（本リポジトリ）—— エンジン本体：ロボット／コントローラーの状態、REST + WebSocket API、認証、mDNS ディスカバリー、モデル提出。UI なし、バンドラーなし、フロントエンドビルド手順なし。
- **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** —— 現在は純粋な Vite/React クライアントとなり、本サーバーとネットワーク越しに通信します。これは、この API のすでにある他のすべてのクライアントとまったく同じです。

## 🧩 存在する理由

エンジンを Web ダッシュボードから切り離したのは、単なるリファクタリングのためではなく、意図的な変更です：

- **リソースの分離。** ブラウザ自身のタブを占有する重量級の 3D ビューは、もはやロボットを実際に動かすコードとプロセス（ひいては CPU/IO の競合）を共有しません。Web UI がフリーズしても、本サーバーは他の接続中クライアントからの緊急停止指令に応答し続けます。
- **真にヘッドレスなコントローラー。** このプロセスは、ホスト上に一切 UI をロードすることなく動作できます——産業用セルの「頭脳」がブラウザタブを開いていなければ機能しない、ということはありません。リソースが限られたハードウェア（Raspberry Pi CM5）上で、本当に重要な部分——運動学と制御——のために RAM/CPU を解放します。
- **独立したライフサイクル。** Web UI は、このプロセスに一切触れることなく、再デプロイ・再起動・新しいビルドへのホットスワップが可能です——UI の修正を配布するためにロボット制御のダウンタイムが発生することはありません。
- **柔軟なホスティング。** 本サーバーは、それが制御するハードウェア上（またはそのすぐ隣）で動作することを想定しています。それを描画するクライアントは、完全に別のどこかでホストされていても構いません——この同じ API の他のリモートクライアントとまったく同様に、ネットワーク越しに到達可能であればよいのです。

## 🔌 API と WebSocket インターフェース

すべてのルート、WebSocket メッセージの契約、認証、そしてクライアントごとのリモートアクセスモデルは、**[`docs/REMOTE_API.md`](docs/REMOTE_API.md)** に記載されています——本サーバーと通信するあらゆるもの（HYDRA-UMC STUDIO 自身のクライアントコードを含む）にとっての唯一の信頼できる情報源です。要約すると：

- `/api/*` 配下の REST API —— 設定の読み書き、原子的なロボット指令（ジョグ／再生／一時停止／停止／ツール／バルブ／ポンプ／速度／ビジョン）、アカウント管理、ワークファイルのアップロード／ダウンロード、モデル提出、システムメトリクス、ディスカバリー。
- 単一の `/ws` WebSocket エンドポイント（クエリ文字列内にベアラートークン）で、状態が変化するたびに全接続クライアントへ完全なツリー形式の `settings` スナップショットと、より軽量な `delta` 更新をブロードキャストします。
- すべての書き込みに JWT ベアラートークン認証が必要です。2 つのアカウントロール（`admin`、`operator`）が、設定／ユーザー管理の書き込みと日常のロボット操作の権限をそれぞれ制御します。
- ローカルネットワーク上でのゼロコンフィグ発見のための `_hydra._tcp` mDNS/Bonjour 広告、加えてサブネットスキャン用の単純な `GET /api/hydra-info`。
- `GET /metrics` —— Prometheus エクスポジション形式（`prom-client`）。下記「📊 モニタリング」で説明する任意の Grafana ダッシュボード向け。

CORS は、設定可能な許可リスト（`CORS_ALLOWED_ORIGINS`、下記「環境変数」参照）を通じて有効化されています。これは、本サーバーのクライアントがもはや自身と同一オリジンであるとは限らないためです。未設定の場合、`NODE_ENV=production` 以外では常に完全に開放されています（今日のローカル開発でのゼロコンフィグ動作）。本番環境では、この許可リストが設定されるまで、すべてのクロスオリジンブラウザリクエストを拒否します——完全な理由は `src/server.ts` の `app.use(cors(corsOptions))` 直上のコメントを参照してください。

## 💾 データと永続化

本サーバーが保持するすべてのものは `data/` 配下に置かれ、初回実行時に自動作成されます：

- `data/settings.json` —— 完全な状態ツリー：コントローラー、ロボット、システム構成。静的ファイルとして配信されることは一切ありません（明示的に 404 を返します）——認証済みの `/api/settings` ルート経由でのみアクセス可能です。
- `data/users.json` —— アカウント資格情報（scrypt によりハッシュ化・ソルト付加、平文では絶対に保存されません）。こちらも静的配信は一切ありません。
- `data/logs/server.log` —— すべての指令の追記専用の産業用ログ。
- `data/WORKS/` —— 保存済みのロボット軌道。デフォルトではロボットごとに 1 フォルダで、純粋な静的ファイル（インデックスおよび個々のワークファイル）として配信されます。
- `data/model_submissions.json` および提出されたモデルフォルダ自体 —— [HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF) の「完成したロボットモデルを本サーバーのカタログへ直接プッシュする」フローのサーバー側部分です。

## 📂 リポジトリ構成

```
HYDRA-UMC-SERVER/
├── src/
│   ├── server.ts       # Express アプリ + WebSocketServer + 全 /api ルート
│   ├── kinematics.ts   # 原子的ジョグエンドポイント用の逆運動学ヘルパー
│   └── users.ts        # アカウントストア（scrypt パスワードハッシュ化）
├── data/                # ランタイム状態 —— 設定、ユーザー、ログ、ワークファイル
│   ├── settings.json
│   ├── users.json
│   ├── logs/
│   └── WORKS/
├── docs/
│   ├── REMOTE_API.md              # 完全な契約：ルート、WS プロトコル、認証
│   └── PRODUCTION_BOOTSTRAP.md    # 必須の JWT と初期管理者設定
├── tools/
│   └── verify_production_bootstrap_contract.mjs # 本番環境での安全な失敗を検証
├── monitoring/           # 任意の Prometheus + Grafana スタック —— monitoring/README.md 参照
├── scripts/
│   └── bump-version.mjs # 旧式のネイティブ版ヘルパー。標準ビルドは bump_manifest_version.py を使用
├── build.bat / build.sh # 依存関係のインストール + プロダクションビルド
├── dev.bat / dev.sh      # 依存関係のインストール + 開発サーバーの起動
├── package.json
├── tsconfig.json
├── CHANGELOG.md
└── LICENSE
```

## 🛠️ 開発環境

### 必要環境
- [Node.js](https://nodejs.org/)（v18 以上推奨）
- npm

### インストール

```bash
npm install
```

### 環境変数

いずれも任意です——本サーバーは、以下の各変数について組み込みの開発向けデフォルト値を用いることで、ゼロコンフィグでも動作します。完全に信頼されたローカルネットワークの外へ本サーバーを公開する前に（例えばルーターの NAT／ポートフォワード経由でインターネットへ公開する場合、脅威モデルが「信頼済み LAN のみ」から「誰でも到達可能」へと変わります）、実際の値を設定してください（`.env.example` 参照）：

- `JWT_SECRET` —— すべてのログイントークンに署名します。未設定の場合、`src/server.ts` に組み込まれた固定の開発用値が代わりに使用されます（ローカル開発には問題ありませんが、信頼されたネットワークの外から到達可能なデプロイには適しません）。シェルでエクスポートするか、お使いのプロセスマネージャー／コンテナ（systemd の `Environment=`、`pm2` 自身の環境設定、Docker の `-e` など）を通じて設定してください。
- `NODE_ENV` —— 実運用のデプロイでは `production` に設定してください。以下 2 つのフォールバック（開放的な CORS、静かなデフォルト値の使用）を制御し、`JWT_SECRET` や初期投入された `admin`/`admin` アカウントがまだデフォルトのままである場合に、目立つ起動時警告を有効化します。未設定（またはそれ以外の値）の場合は、現在の寛容な開発向け動作を維持します。
- `CORS_ALLOWED_ORIGINS` —— 本 API へのクロスオリジンブラウザリクエストを許可するオリジンのカンマ区切りリスト —— 実際に関係してくるのは、HYDRA-UMC STUDIO が本サーバーとは異なるホスト／ポートから配信される場合です（例：`https://studio.example.com`、開発時であれば `http://192.168.1.20:5173`）。例：
  `CORS_ALLOWED_ORIGINS=https://studio.example.com,http://192.168.1.20:5173`。
  未設定の場合：`NODE_ENV != production` であれば任意のオリジンを許可します（ローカル開発では設定不要、本プロジェクトの従来の挙動と一致）。`NODE_ENV = production` の場合は、これが設定されるまで、すべてのクロスオリジンブラウザリクエストを **拒否** し、目立つ起動時警告を表示します。非ブラウザクライアント（curl、HYDRA-UMC SUITE、モバイル制御アプリ）はいずれの場合も影響を受けません —— CORS はブラウザのみに関わる仕組みです。
- `JWT_EXPIRES_IN` —— ログイントークンの有効期間。`jsonwebtoken` 自身の `expiresIn` オプションが受け付ける任意の文字列（`"24h"`、`"7d"`、秒数の裸の数値など）を指定できます。未設定の場合、デフォルトは `30d`（本プロジェクト当初の信頼済み LAN を前提とした値）です。**信頼済み LAN の外から到達可能なサーバーでは、これをより短く設定すべきです —— `24h` は妥当な出発点です** —— 漏洩した長期有効トークンは、そのアカウントのパスワードを変更する以外に個別に無効化する方法がありません。
- `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` —— `POST /api/login` のみをスロットリングします（他のすべてのルートは影響を受けません）。いずれか未設定の場合、デフォルトは IP ごとに 15 分あたり 5 回の試行です。制限に達した場合は、一般的な `500` ではなく、明確な JSON エラーを伴う `429` を返します。
- `TLS_CERT_PATH` / `TLS_KEY_PATH` —— **両方を** 設定すると、サーバー（REST API + 同じリスナーを共有する `/ws` WebSocket）がプレーンな HTTP/WS から HTTPS/WSS へ切り替わります。詳細は下記「TLS / HTTPS」を参照してください。いずれか一方でも未設定の場合、現在のプレーン HTTP の挙動が維持されます。

### TLS / HTTPS

デフォルトでは無効です —— 本サーバーは常にプレーンな HTTP/WS として動作してきており、明示的に有効化しない限り現在もそうです。`TLS_CERT_PATH` と `TLS_KEY_PATH`（上記参照）を、PEM 証明書とそれに対応する秘密鍵に設定すると、共有 REST + WebSocket リスナーが `https.createServer()` へ切り替わります —— `/ws` も追加設定不要で自動的に WSS になります。証明書／鍵のパスが設定されているものの読み取り不能または無効な場合、起動は静かにプレーン HTTP へフォールバックするのではなく、明確に失敗します（実際の `fs` エラー）。

これは、本サーバーが完全に信頼された LAN の外から到達可能になる場合（例えば、リモートテストのためにルーターの NAT／ポートフォワード経由で公開する場合）に、特に重要になります —— プレーンな HTTP では、すべてのベアラートークン、すべてのロボット指令、そして admin/operator のログイン自体が、平文でネットワークを通過してしまいます。

証明書の取得方法：

- **本サーバーを指すドメインを所有している場合** —— [Let's Encrypt](https://letsencrypt.org/)（例えば [Certbot](https://certbot.eff.org/) 経由）を使用して、本物のブラウザに信頼された証明書を、無料かつ自動更新可能な形で取得してください。`TLS_CERT_PATH` / `TLS_KEY_PATH` を、生成された `fullchain.pem` / `privkey.pem` に向けてください。
- **ローカルテスト、ドメインなしの場合** —— 自己署名証明書でも HTTPS/WSS のコードパスを試すには十分です（ブラウザおよびほとんどの HTTP クライアントは警告を出すか、明示的な信頼の上書きを要求します——テストにおいてはこれが想定どおりの正常な動作です）：
  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"
  ```
  その後、`TLS_CERT_PATH=./cert.pem` および `TLS_KEY_PATH=./key.pem` を設定してください。

### 開発モード

`tsx` を用いて API/WebSocket サーバーを直接実行します（バンドラーなし、フロントエンドは関与しません）：
- **Windows：** `dev.bat` をダブルクリックするか、`npm run dev` を実行
- **Linux/Mac：** `./dev.sh` または `npm run dev` を実行

### プロダクションビルド

esbuild を用いてサーバーを単一のデプロイ可能なファイルへバンドルします：
- **Windows：** バージョンを増やすリリースビルドには `build.bat` を使用し、コンパイルのみには `npm run build` を使用
- **Linux/Mac：** バージョンを増やすリリースビルドには `./build.sh` を使用し、コンパイルのみには `npm run build` を使用

その後、以下でプロダクションサーバーを起動します：
```bash
npm start
```

サーバーは `0.0.0.0:3000` でリッスンします —— `http://localhost:3000`、またはローカルネットワーク内の `http://<あなたのローカルIP>:3000` でアクセス可能です。すべての状態は `data/` に永続化されます。

### バージョン管理

リリース版のバージョン増分を行うのは、ルートの `build*.bat` と `build*.sh` だけです。これらは `bump_manifest_version.py` を一度だけ呼び出し、10 進オドメーター規則（`0.0.9` -> `0.1.0`、`0.0.10` にはしない）に従って `package.json`、`hydra-umc.project.json`、[`CHANGELOG.md`](CHANGELOG.md) を同期します。`npm run build` は意図的にコンパイル専用なので、直接のビルドや `build-test` 検証が `package.json` だけのバージョンを変更することはありません。実行中のバージョンは `GET /api/hydra-info`（`appVersion`）から取得できます。

## 📊 モニタリング（任意）

`GET /metrics` は、プロセスの稼働時間、接続中の WebSocket クライアント数、`settings.json` の書き込みレイテンシ、種類別の原子的ロボット指令、認証失敗、および `GET /api/system/metrics` と同じ CPU／メモリ／温度の数値を、すべて Prometheus 形式で公開します。すぐに実行可能な Prometheus + Grafana スタック（初期ダッシュボード付き）は **[`monitoring/`](monitoring/README.md)** にあります。そのフォルダから `docker compose up -d` を実行すれば動作します。完全に任意です —— サーバー自体の動作にここにあるものは一切必要ありません。

## 🔗 関連プロジェクト

本プロジェクトは、同一著者（JuanenRac／Electro Hobby 3D）による、より大きなロボティクスエコシステムの一部です。このエコシステムは、ファームウェア、制御ソフトウェア、AI ノード、車両群ツールにまたがる多数のプロジェクトで構成されています。ご要望が実際にはこれらのプロジェクトのいずれかに関するものであり、本リポジトリのものではない可能性もあるため、知っておく価値があります。

### 本サーバーと直接関連

- **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** —— OPC-UA/MQTT 経由で本サーバーの状態を公開します。
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** —— 本サーバーが生成するログを取り込みます。
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** —— 本サーバーが生成するログを取り込みます。
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** —— 本サーバーの複数インスタンスを協調させます。
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** —— 本サーバーの複数インスタンスを協調させ、そのフェイルオーバーを管理します。
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** —— 本サーバーとデジタルツインを橋渡しします。
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** —— 本サーバーの API に対して車両群 DevOps を実行します。
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** —— このサーバーと ROS 2 間の認証済み高レベル協調のみを公開します。
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** —— サーバーの認可済み経路を通じて追跡可能な PCB 受け渡しを協調します。
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** —— サーバー経由でプリンター補助を協調し、ネイティブファームウェアが権限を維持します。
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** —— コントローラー安全性を置き換えず、制限された CNC セル補助を要求します。
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** —— レーザーのアームまたは発射への経路なしに、レーザーセル補助を要求します。

### エコシステムのその他のプロジェクト

**HYDRA-UMC プラットフォーム** —— マルチロボット・マイクロファクトリーセル
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** —— マザーボード本体：Raspberry Pi CM5 ホスト + デュアルコア STM32H745 リアルタイムコプロセッサ、CAN-OTA/SPI-OTA 経由で最大 8 台の分散ロボットアームを統括します。自社ハードウェア + ファームウェア、GPL-3.0/CERN-OHL-S v2/CC BY-SA 4.0。
- **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** —— HYDRA-UMC 向けの Web 制御ダッシュボード：マルチロボット 3D 可視化、運動学／軌道記録、プラットフォーム全体の CAN-OTA 書き込みとテスト。React + Vite + Three.js —— 現在は純粋なフロントエンドクライアントとなり、この同じサーバーとネットワーク越しに通信します。下記の他のすべてのクライアントとまったく同様です。
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** —— Wi-Fi／Bluetooth 経由で HYDRA-UMC を制御する Android アプリ。実際に動作するアプリです —— 完全なリモート制御機能セット、JWT 認証、暗号化された資格情報の保存。
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** —— Wi-Fi 経由で HYDRA-UMC を制御する iOS/iPadOS アプリ、Flutter 製（クロスプラットフォーム、Mac なしで Windows 上でも検証可能。最終的な `.ipa` パッケージングには Xcode が必要）。実際に動作するアプリです —— Android アプリと同じ機能セット。
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** —— デスクトップ（Python/PySide6）製の群制御コマンドセンター：マルチコントローラーのネットワークディスカバリー、リアルタイムの双方向同期、実際の 3D ロボットビューポート、Photoshop 風のドッキング可能なワークスペース。実際に動作します、プレースホルダーではありません。
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** —— デスクトップ（Python/PySide6）製のグラフィカル URDF 作成／編集ツール。本プロジェクト自身のモデルカタログ向け：GitHub またはローカルフォルダからソースファイルを取得し、自由度の実現可能性を検証し、リアルタイム 3D プレビューで色／スケール／運動学を編集し、完成した結果を本サーバーのカタログへ直接プッシュします。実際に動作します、プレースホルダーではありません。
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** —— HYDRA-UMC 自身の 5"/7" DSI タッチスクリーン（両サイズとも解像度は 1280×720）向けのネイティブ Flutter タッチ UI。Compute Module 5 上で動作し、ボードから直接この同じサーバーを制御します。実際に動作する雛形で、全 6 のカタログ画面がすべて実際のサーバーに接続済みです。実機での実際の Linux ターゲットビルドはまだ実行されていません。

**URTC プラットフォーム** —— HYDRA-UMC の各ロボットアームが搭載するツールヘッドコントローラー
- **[URTC](https://github.com/JuanenRac/URTC)** —— 汎用ロボットツールコントローラー：STM32F303 ベースの CAN バスツールヘッドコントローラー、25 種の完全実装済みツールプロファイル、CAN-OTA ファームウェア更新に対応。
- **[URTC Flasher](https://github.com/JuanenRac/URTC-FLASHER)** —— URTC ボード向けのデスクトップ製 CAN-OTA + フルチップ SWD/JTAG 書き込みツール（Windows/Linux）。
- **[URTC Tester](https://github.com/JuanenRac/URTC-TESTER)** —— URTC ボード向けのデスクトップ製リアルタイム CAN バス診断ツール、ツールプロファイルごとに 1 つのパネル（Windows/Linux）。
- **[URTC Web Studio](https://github.com/JuanenRac/URTC-WEB-STUDIO)** —— 上記 2 つのデスクトップツールに代わるブラウザベースの選択肢（Web Serial API + SLCAN）、ローカルインストール不要。

**👁️ Vision AI Node (Hailo-8)**
- [HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)
- [HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)
- [HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)
- [HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)
- [HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)

**🧠 Cognitive AI Node (Hailo-10)**
- [HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)
- [HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)
- [HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)
- [HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)
- [HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)

**🐝 Orchestration & Swarm**
- [HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)
- [HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)
- [HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)

**🎮 Digital Twin & Simulation**
- [HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)
- [HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)
- [HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)

**📊 Data & Analytics**
- [HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)
- [HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)

**🏭 Industrial Gateway**
- [HYDRA-UMC-OPCUA-SERVER](https://github.com/JuanenRac/HYDRA-UMC-OPCUA-SERVER)
- [HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)
- [HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)

**🛠️ Complementary Tools**
- [URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)
- [URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)
- [HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)
- [HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)

---

## 👤 作者

**JuanenRac**（Electro Hobby 3D）
📧 electrohobby3d@gmail.com
📺 youtube.com/@electrohobby3d

---

## 📜 ライセンスと著作権表示

HYDRA-UMC SERVER の著作権は (c) 2026 JuanenRac（Electro Hobby 3D）に帰属します。本プロジェクトまたはその派生物を配布する際は、この表示を必ず含めてください。

本アプリケーションのソースコードは、**GNU General Public License v3.0（GPL-3.0）** の下で提供されます。全文は
https://www.gnu.org/licenses/gpl-3.0.html を参照してください。

ドキュメント（本 README およびその自身の翻訳版——`README_spa.md`、`README_ita.md`、`README_fra.md`、`README_deu.md`、`README_zho.md`、`README_jpn.md`）は、**クリエイティブ・コモンズ 表示-継承 4.0 国際（CC BY-SA 4.0）** の下で提供されます。全文は
https://creativecommons.org/licenses/by-sa/4.0/ を参照してください。
