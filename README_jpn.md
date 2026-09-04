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
│   ├── metrics.ts      # GET /metrics を支える —— Prometheus テキスト形式（prom-client）
│   └── users.ts        # アカウントストア（scrypt パスワードハッシュ化）
├── admin-ui/            # この本サーバー自身のための独立した Vite/React 管理パネル
│   │                      （接続デバイス、自身のログファイル、自身の設定、自身のユーザー——
│   │                      意図的にロボット制御は含まない。それは引き続き STUDIO 専用）
│   ├── src/
│   │   ├── App.tsx, main.tsx, index.css, api.ts, LoginScreen.tsx
│   │   └── tabs/AboutTab.tsx, ConfigTab.tsx, DevicesTab.tsx, LogsTab.tsx, UsersTab.tsx
│   ├── package.json / tsconfig.json / vite.config.ts
│   └── README.md
├── data/                # ランタイム状態 —— 設定、ユーザー、ログ、ワークファイル、保存済みポイント
│   ├── settings.json
│   ├── users.json
│   ├── logs/
│   ├── points/
│   └── WORKS/
├── docs/
│   ├── REMOTE_API.md              # 完全な契約：ルート、WS プロトコル、認証
│   ├── PRODUCTION_BOOTSTRAP.md    # 必須の JWT と初期管理者設定
│   └── REMOTE_ACCESS_VPN.md       # 本物のリモートアクセス/VPN デプロイガイド
├── images/               # メディアと図版
├── systemd/
│   └── hydra-umc-server.service # CM5 上のローカル systemd ユニット
├── tools/
│   ├── ci_validate.py                                   # CI が使用する manifest/CHANGELOG/docs の検証
│   └── verify_*_contract.mjs, verify_auth_negative.mjs  # 実サーバーに対する 11 個の実際の契約/認証否定
│                                                           チェック（CAN-OTA リレー、discovery、エコシステム
│                                                           サービス制御/ステータス、統合の test-connection、
│                                                           本番ブートストラップ、ロボットコマンド、再生、
│                                                           テレメトリリレー、音声リレー）
├── monitoring/           # 任意の Prometheus + Grafana スタック —— monitoring/README.md 参照
├── scripts/
│   └── bump-version.mjs # 旧式のネイティブ版ヘルパー。標準ビルドは bump_manifest_version.py を使用
├── bump_manifest_version.py # hydra-umc.project.json のバージョンをネイティブ側と同期（--sync）
├── build.bat / build.sh # 依存関係のインストール + プロダクションビルド
├── dev.bat / dev.sh      # 依存関係のインストール + 開発サーバーの起動
├── package.json
├── tsconfig.json
├── CHANGELOG.md
└── LICENSE
```

`public/`（STUDIO のビルド済み静的フロントエンド。このサーバーの `/` に
一緒にデプロイされる）は gitignore 対象——STUDIO 自身のビルド出力をコピー
して生成され、新規クローンには含まれません。

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

本プロジェクトは、同じ作者(JuanenRac / Electro Hobby 3D)による HYDRA-UMC ロボティクスエコシステムの一部です。リクエストが実はこの中のどれかについてのものである可能性があるため、知っておく価値があります。

**子プロジェクト** —— いずれも、本サーバーの API 経由でのみロボットフリートと通信する、実際のクライアントまたは調整用ブリッジです
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** —— リアルタイムのマルチロボット 3D 可視化を備えたウェブ制御ダッシュボード。
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** —— 複数のサーバーを同時に扱えるデスクトップ(PySide6)スウォームコマンドセンター、スタンドアロン実行ファイルとしてパッケージ化。
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** —— 生体認証ログインとペアリングされた Wear OS コンパニオンを備えたネイティブ Android 制御アプリ。
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** —— リアルタイム WebSocket 同期を備えた iOS/iPadOS 制御アプリ(Flutter)。
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** —— 本体搭載の 7 インチ DSI タッチスクリーン向けネイティブタッチ UI、CM5 自体に組み込み。
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** —— 実際の VDA 5050 MQTT パブリッシャーによる AGV/AMR フリートの調整境界。
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** —— 実際の GRBL ステータス/制御バイトへのアクセスを持つ、CNC セルの高レベルコーディネーター。
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** —— 実際の Boston Dynamics Spot コマンド送信機能を持つ、脚型/ヒューマノイドドロイドの調整境界。
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** —— 実際のキー/筐体/インターロック GPIO セーフガード 3 系統を読み取る、レーザーセルの安全コーディネーター。
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** —— OpenPnP ピックアンドプレースの基板フローを安全に統括する高レベルコーディネーター。
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** —— 実際にゲート制御されたジョブコマンドを持つ、Moonraker/Klipper 3D プリンター向けの安全な調整境界。
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** —— 実際の遅延インポート rclpy ROS 2 トランスポートを持つ安全コーディネーター。
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** —— 実際の MAVLink コマンド送信機能を持つ、カメラ搭載 UAV の調整境界。

**直接関連**
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** —— 本サーバーは、ゲートウェイトークンをサーバー側に保持したまま、ループバック接続経由で限定的かつ認証済みの発話ターンをこれへ中継する。音声が直接ロボットコマンドになることは決してない。
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** —— 実際のロボットアームのマザーボードであり、本サーバー自身の `spi_bridge` サービスが実際の CM5↔STM32H745 SPI-OTA 接続を介して通信する相手。

**エコシステムの他のプロジェクト**

*コアハードウェア&プラットフォーム*
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** —— 本サーバーが動作する CM5 向けの再現可能な Raspberry Pi OS プロダクト層——読み取り専用エージェント、検証済み設定/プロファイル、WiFi 初回接続プロビジョニング。
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** —— 上記の各ブリッジが自身のコマンドを検証する共有 JSON-Schema 契約と安全ゲートの境界。
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** —— 完成したモデルを本サーバー自身のカタログへ送信するデスクトップ用グラフィカル URDF 作成/編集ツール。

*URTC ツールプラットフォーム*
- **[URTC](https://github.com/JuanenRac/URTC)** —— 物理的な Universal Robot Tool Controller 基板向けファームウェア、CAN バス経由の 25 以上のツールプロファイル。
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** —— URTC 基板用のデスクトップ GUI 書き込みツール、CAN-OTA およびフルチップ SWD/JTAG。
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** —— URTC 基板向けのデスクトップ CAN バスライブ診断ツール、ツールプロファイルごとに 1 パネル。
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** —— Web Serial API を使ったブラウザベースの URTC-TESTER の代替、ローカルインストール不要。

*ビジョン AI ノード(Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** —— Hailo-8 ビジョンパイプラインの統合ハブ、段階ごとの実際のハードウェア準備状況チェック付き。
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** —— Hailo アーキテクチャ/チェックサムによる安全読み込み検証を備えた、実際のコンパイル済みモデルレジストリ。
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** —— 実際の HailoRT 統合境界を持つ、実際の GStreamer パイプライン + MediaMTX 設定生成器。
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** —— 上流のゾーン状態に応じて安全ゲート制御される、実際の Position-Based Visual Servoing 補正則。
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** —— キャリブレーションの鮮度を強制する、実際のゾーン侵入チェックと E-STOP 要求。

*コグニティブ AI ノード(Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** —— Hailo-10 コグニティブパイプライン(LLM/VLA/音声オーケストレーション)の統合ハブ。
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** —— Vision-Language-Action モデル向けの、実際のアクショントークンのエンコード/デコードと軌道生成。
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** —— MCU エラーコードに対する、実際のルールベースのタスク分解と意味的エラー復旧。
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** —— このエコシステム自身の Markdown ドキュメントに対する、標準ライブラリのみの実際の TF-IDF 文書検索。

*オーケストレーション&スウォーム*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** —— 実際の gRPC/Protobuf ヘルスレポート契約とミッションステートマシンを持つ統合ハブ。
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** —— 実際の HTTP API 上に構築された、優先度ベースの実際のジョブキュー(重複排除付き)。
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** —— リトライ/バックオフとアイデンティティ不一致検出を備えた、実際の gRPC ベースのフリートヘルスウォッチドッグ。
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** —— 実際の障害物/ワークスペース衝突検証を備えた、実際の RRT ベースの 3D 経路プランナー。
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** —— 複数セルの収束についてプロパティテストされた、実際の CRDT LWW-Element-Map 状態同期。

*デジタルツイン&シミュレーション*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** —— 実際のバージョン互換性同期契約を持つ、デジタルツインエンジンの統合ハブ。
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** —— シミュレーションと実際のハードウェアの間でコマンドをルーティングする、実際のハードウェア・イン・ザ・ループ安全インターロック。
- **[HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)** —— 実際の URDF サブセットに対する、実際の順運動学と関節限界検証。
- **[HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)** —— YOLO/COCO アノテーションのエクスポート機能を持つ、実際のプロシージャル 2D シーンジェネレーター。

*データ&分析*
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** —— 実際の取り込み/クエリ HTTP API を備えた、実際の sqlite3 ベースの時系列ストア。
- **[HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)** —— ドリフト監視を備えた、実際の FFT + 統計ベースラインによる異常検知器。
- **[HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)** —— DATALAKE の履歴に対する実際の OEE/稼働率計算、再現可能な CSV エクスポート付き。
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** —— シーケンス重複排除機能を備えた、DATALAKE への実際の CAN/WebSocket 取り込みパイプライン。

*産業用ゲートウェイ*
- **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** —— 実際のコマンド許可リスト/バックプレッシャー層を持つ、産業用プロトコルへ中継する統合ハブ。
- **[HYDRA-UMC-OPCUA-SERVER](https://github.com/JuanenRac/HYDRA-UMC-OPCUA-SERVER)** —— 実際のバイナリプロトコルクライアントセッションで検証された、実際の OPC-UA アドレス空間。
- **[HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)** —— クライアント単位のオプション認証とトピック ACL を備えた、実際の MQTT ブローカー。
- **[HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)** —— 縮退モード出力を備えた、実際の MTConnect `/probe` および `/current` XML エンドポイント。

*補完ツール&エコシステム運用*
- **[HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)** —— 誠実な統計フォールバックを備えた、DATALAKE/ANOMALY-DETECTOR 上のスマートサマリーと異常ハイライトパネル。
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** —— 実際の安定した終了コード契約を持つフリート CLI、本サーバー自身の API の本物のライブクライアント。
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** —— 実際の触覚アラートとペアリングされたスマートフォンへの音声リレーを備えた WearOS コンパニオンアプリ。
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** —— 実際の工具 ID デコードと Smart Idle 予熱ロジックを備えた、基板搭載ラック用ファームウェア。
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** —— サーマル/RGB 検査ツールヘッド向けの、ファームウェアと実際の Python ビジョンコンパニオン。
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** —— このエコシステム内のすべてのリポジトリを検出・クローン・更新する、管理用デスクトップツール。
- **[HYDRA-UMC-OS-REBUILDER](https://github.com/JuanenRac/HYDRA-UMC-OS-REBUILDER)** — エコシステムの最新バージョンをプリロードした、書き込み可能なCM5イメージを構築するWindows/Linuxデスクトップツール。Raspberry Pi Imager方式の初回起動Wi-Fi/ユーザー/SSH設定を備える。

---

## 📚 ドキュメント & コミュニティ

- **[CONTRIBUTING.md](CONTRIBUTING.md)** —— プルリクエストのための技術スタックとコーディング指針。
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** —— このコミュニティで期待される行動規範。
- **[SECURITY.md](SECURITY.md)** —— 脆弱性の報告方法と、このプロジェクトの実際のセキュリティ重点領域。
- **[SUPPORT.md](SUPPORT.md)** —— 質問の投稿先とバグの報告先。
- **[LICENSE.md](LICENSE.md)** —— このプロジェクト自身のライセンス。

## 👤 作者
**JuanenRac** (Electro Hobby 3D)
📧 electrohobby3d@gmail.com
📺 [youtube.com/@electrohobby3d](https://youtube.com/@electrohobby3d)

## 📜 ライセンス

HYDRA-UMC SERVER の著作権は (c) 2026 JuanenRac（Electro Hobby 3D）に帰属します。本プロジェクトまたはその派生物を配布する際は、この表示を必ず含めてください。

本アプリケーションのソースコードは、**GNU General Public License v3.0（GPL-3.0）** の下で提供されます。全文は
https://www.gnu.org/licenses/gpl-3.0.html を参照してください。

ドキュメント（本 README およびその自身の翻訳版——`README_spa.md`、`README_ita.md`、`README_fra.md`、`README_deu.md`、`README_zho.md`、`README_jpn.md`）は、**クリエイティブ・コモンズ 表示-継承 4.0 国際（CC BY-SA 4.0）** の下で提供されます。全文は
https://creativecommons.org/licenses/by-sa/4.0/ を参照してください。
