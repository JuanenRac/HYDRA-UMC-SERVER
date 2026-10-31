<!-- =============================================================================
HYDRA-UMC-SERVER - Headless REST and WebSocket backend of the HYDRA-UMC micro-factory
Copyright (C) JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
GPL-3.0-or-later - see LICENSE
============================================================================= -->

<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-SERVER banner" width="100%">
</p>

# 🤖 HYDRA-UMC-SERVER

<p align="center"><a href="README.md">🇺🇸 English</a> | <a href="README_spa.md">🇪🇸 Español</a> | <a href="README_fra.md">🇫🇷 Français</a> | <a href="README_ita.md">🇮🇹 Italiano</a> | <a href="README_deu.md">🇩🇪 Deutsch</a> | <a href="README_zho.md">🇨🇳 简体中文</a> | 🇯🇵 <b>日本語</b> | <a href="README_por.md">🇵🇹 Português</a></p>

### 🤖 HYDRA-UMC マルチロボット・マイクロファクトリー向けヘッドレス API/WebSocket バックエンド

<p align="center">
  <img src="https://img.shields.io/badge/License-GPL%203.0--or--later-blue.svg" alt="GPL 3.0 or later">
  <img src="https://img.shields.io/badge/Runtime-Node.js-339933.svg" alt="Runtime">
  <img src="https://img.shields.io/badge/Framework-Express-000000.svg" alt="Framework">
  <img src="https://img.shields.io/badge/Language-TypeScript-3178C6.svg" alt="Language">
  <img src="https://img.shields.io/badge/Protocol-WebSocket-lightgrey.svg" alt="Protocol">
  <img src="https://img.shields.io/badge/Tests-414%20passing-2ea44f.svg" alt="Tests">
  <img src="https://img.shields.io/badge/Version-0.8.1.4-0f6cbd.svg" alt="Version">
  <img src="https://img.shields.io/badge/Maturity-functional-0F6CBD.svg" alt="Maturity">
</p>

---

> **誠実性チェック - 今日実際に動くもの:** Express + WebSocket のエンジン、その REST と WebSocket の面（58 パスに 63 の操作）、リフレッシュトークンのローテーションと scrypt を使う JWT サインイン、mDNS 探索、ロボットの予約とリビジョン、再生、そして CAN-OTA・テレメトリ・音声・ローカル AI サービス・コネクターハブへのリレーは実在し、テスト自身が起動するこのサーバー自体の実インスタンスに対して試験済みです（ユニットテスト 414 件と、28 本のエンドツーエンド契約スクリプトがすべて合格）。ハードウェアに近く、ここで検証していないもの：STM32H745 ボードを載せた実際の HYDRA-UMC CM5 への接続で、実コードですが API と契約の層でしか試していません。TLS、Bluetooth LE、MQTT ブリッジ、Prometheus と Grafana のスタックは実在し、任意で、既定はオフです。

---

> **安全性とセキュリティの現状:** このエコシステムは認証された安全システムではありません。ハードウェアの E-STOP 経路、ファームウェアが強制する制限やインターロック、検証済みの動作コマンドはまだありません。ファームウェアイメージは CRC-32 と Ed25519 署名で検査し、リリースビルドは公開済みの開発用鍵を拒否します(リレーの先のツールヘッドと拡張ボードは引き続き URTC のブートローダーを使い、署名ではなく共有鍵の HMAC-SHA256 を使います)。TLS と相互 TLS は任意で、既定では無効です。独自基板はまだ実装も試験もされていません。ここに書かれた内容を人の安全のために頼る前に、[セキュリティベースライン](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md)と[脅威モデル](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md)をお読みください。

---

## 📋 ひと目で

| | |
|---|---|
| バージョン | `0.8.1.4` |
| 成熟度 | 機能する |
| テスト | 414 (`npm run test:unit`) |
| 技術 | Node.js 20+ / Express / WebSocket (ws) / REST/OpenAPI |
| 対象 | HYDRA-UMC セルの Raspberry Pi CM5 |
| 実機での確認 | ベンチ環境で動作：上の正直さの確認に、どの部分が実機で動いたかが書かれています |

**移動：** [概要](#-概要) · [アーキテクチャ](#-アーキテクチャ) · [機能](#-機能) · [セキュリティと安全](#-セキュリティと安全) · [インターフェース](#-インターフェース) · [設定](#-設定) · [クイックスタート](#-クイックスタート) · [テスト](#-テスト) · [トラブルシューティング](#-トラブルシューティング) · [リポジトリの構成](#-リポジトリの構成) · [関連プロジェクト](#-関連プロジェクト)

## 🚦 プロジェクトの状況

各行はこのリポジトリの一部分で、信号は今日どこまで進んでいるかを示します。計画ではなく、リポジトリが示せるもの（テスト、ビルド、実行）に基づいて書かれています。

🟢 完了・検証済み · 🟡 動作する（既知の制限あり） · 🟠 一部のみ、または未検証 · 🔴 未実装または動作しない

| 領域 | 状態 | ここでの意味 |
|---|---|---|
| ソフトウェア | 🟡 | 主な目的では動作します。足りない点は上の正直さの確認に書かれています |
| テスト | 🟢 | 自動テスト 414 件。変更のたびに実行されます |
| 実機 | 🟡 | ベンチ環境で動作：上の正直さの確認に、どの部分が実機で動いたかが書かれています |
| ドキュメント | 🟢 | 8 言語の README。変更のたびにマニフェストと照合されます |

## 🎯 概要

HYDRA-UMC SERVER は、HYDRA-UMC マルチロボット・マイクロファクトリーセルを駆動するスタンドアロンのバックエンドです。Node.js/Express + WebSocket エンジンとして、ロボットの状態を保持し、ディスクへ永続化し、すべての書き込みを認証したうえで、接続中の全クライアントへリアルタイム更新をブロードキャストします。それ自体にはユーザーインターフェースもフロントエンドのビルド手順も持たず、純粋な API + WebSocket サービスとして、実際にロボットの隣に設置されるマシン（通常は Raspberry Pi CM5）上でヘッドレス（ブラウザなし、ディスプレイなし）に動作することを想定しています。

第2版の契約が完成しました。条件付き書き込み(コマンドと予約の `If-Match`、`GET /api/robot/:id`)、アトミックな `table` コマンド、追記専用の監査記録(`GET /api/audit`、ハッシュ連鎖、無効化可能)、WebSocket の `claims` メッセージ。カメラのパスワードはプロセス一覧にもログにも表示されません。`docs/CONTRACT_V2.md` を参照してください。

任意で **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** 自身がビルドしたフロントエンドを静的ファイルとして配信することも **可能** です。「1 台のマシン、1 つのオリジンにすべてをまとめる」という一般的なデプロイ形態に対応するもので、**`build-frontend.sh`/`.bat`** を一度実行するだけで（隣接するチェックアウトから STUDIO をビルドし、その出力を本リポジトリ自身の `public/`（gitignore 対象）へコピーします）、本サーバーは次回起動時からそれを `/` で配信し始めます。これにより、HYDRA-UMC-ANDROID-CONTROL、HYDRA-UMC-IOS-CONTROL、HYDRA-UMC-DSI が、それぞれ自身のアプリ内 WebView に本物の STUDIO 3D ビューポートを埋め込み、同じサーバー自身の `ip:port` を指すことができます。完全に任意機能です——このスクリプトを実行しなければ、本サーバーは上記のとおり完全にヘッドレスなままです。`public/` は単に存在せず、いずれの場合もすべてのルートは同一に動作し続けます。

同じ `build-frontend.sh`/`.bat` は、本リポジトリ自身の **[`admin-ui/`](admin-ui/README.md)**（本 SERVER 自体を管理するための小さな独立パネル——接続デバイス、自身のログファイル、自身のポート／名前、自身のユーザーアカウント）もビルドし、`/admin` で配信します。これは意図的にロボット制御では **ありません**（それは常に STUDIO 専任です）——上記のヘッドレス設計に対する、明確かつ限定的な例外であり、その撤回ではありません。

本プロジェクトはかつて **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** の一部でした。当時は「ハイブリッドモノリス」として提供されており、1 つの Node.js プロセスがロボット制御エンジンと Vite/React 製の Web ダッシュボードの両方を実行していました（Vite 自身の開発ミドルウェアが同じ Express アプリへ直接組み込まれていました）。そのプロセスは現在、次の 2 つに分割されています：

- **HYDRA-UMC SERVER**（本リポジトリ）—— エンジン本体：ロボット／コントローラーの状態、REST + WebSocket API、認証、mDNS ディスカバリー、モデル提出。UI なし、バンドラーなし、フロントエンドビルド手順なし。
- **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** —— 現在は純粋な Vite/React クライアントとなり、本サーバーとネットワーク越しに通信します。これは、この API のすでにある他のすべてのクライアントとまったく同じです。

## 🧩 HYDRA-UMC での役割

**HYDRA-UMC-SERVER** はセルのエンジンです。画面を持たない Node.js と Express のバックエンドで、ロボットの状態を保持してディスクに保存し、すべての書き込みにロールを要求し、1 本の WebSocket で全クライアントにライブ更新を送ります。すべてのクライアント（STUDIO、SUITE、スマートフォンアプリ、タッチスクリーン、ウォッチ、コマンドラインツール）はこれを通り、誰がどのロボットをどこまで動かせるかはこのサーバーだけが決めます。

## 🏛️ アーキテクチャ

<p align="center">
  <img src="images/architecture.svg" alt="HYDRA-UMC-SERVER architecture" width="100%">
</p>

### 存在する理由

エンジンを Web ダッシュボードから切り離したのは、単なるリファクタリングのためではなく、意図的な変更です：

- **リソースの分離。** ブラウザ自身のタブを占有する重量級の 3D ビューは、もはやロボットを実際に動かすコードとプロセス（ひいては CPU/IO の競合）を共有しません。Web UI がフリーズしても、本サーバーは他の接続中クライアントからの緊急停止指令に応答し続けます。
- **真にヘッドレスなコントローラー。** このプロセスは、ホスト上に一切 UI をロードすることなく動作できます——産業用セルの「頭脳」がブラウザタブを開いていなければ機能しない、ということはありません。リソースが限られたハードウェア（Raspberry Pi CM5）上で、本当に重要な部分——運動学と制御——のために RAM/CPU を解放します。
- **独立したライフサイクル。** Web UI は、このプロセスに一切触れることなく、再デプロイ・再起動・新しいビルドへのホットスワップが可能です——UI の修正を配布するためにロボット制御のダウンタイムが発生することはありません。
- **柔軟なホスティング。** 本サーバーは、それが制御するハードウェア上（またはそのすぐ隣）で動作することを想定しています。それを描画するクライアントは、完全に別のどこかでホストされていても構いません——この同じ API の他のリモートクライアントとまったく同様に、ネットワーク越しに到達可能であればよいのです。

## ✨ 機能

### データと永続化

本サーバーが保持するすべてのものは `data/` 配下に置かれ、初回実行時に自動作成されます：

- `data/settings.json` —— 完全な状態ツリー：コントローラー、ロボット、システム構成。静的ファイルとして配信されることは一切ありません（明示的に 404 を返します）——認証済みの `/api/settings` ルート経由でのみアクセス可能です。
- `data/users.json` —— アカウント資格情報（scrypt によりハッシュ化・ソルト付加、平文では絶対に保存されません）。こちらも静的配信は一切ありません。
- `data/logs/server.log` —— すべての指令の追記専用の産業用ログ。
- `data/WORKS/` —— 保存済みのロボット軌道。デフォルトではロボットごとに 1 フォルダで、純粋な静的ファイル（インデックスおよび個々のワークファイル）として配信されます。
- `data/model_submissions.json` および提出されたモデルフォルダ自体 —— [HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF) の「完成したロボットモデルを本サーバーのカタログへ直接プッシュする」フローのサーバー側部分です。
- `data/totp.json` - 2 段階目を有効にしたアカウントの第二要素です(任意で、所有者が有効にするまでどのアカウントでもオフ)。各シークレットは `HYDRA_UMC_TOTP_KEY`(または `JWT_SECRET` から導いた鍵)で AES-GCM により暗号化され、10 個のリカバリーコードはハッシュとしてのみ保存されます。アカウントが 2 段階目を有効にするまで、このファイルは存在しません。

## 🔒 セキュリティと安全

| 脅威 | 防御 | 場所 |
|---|---|---|
| 既知の鍵で署名されたトークン | `NODE_ENV=production` では、`JWT_SECRET` が空・例のまま・短い場合や初期管理者が無い場合、サーバーは起動を拒否します。開発では組み込みの値を使い、`[SECURITY]` の警告を出します | `src/auth.ts`, `src/secretsPolicy.ts` |
| サインインへの総当たり、または停止の大量送信 | サインイン失敗はアドレスごとに 15 分で 5 回まで（`429`）、リフレッシュは毎分 120 回、全体停止は毎分 60 回までで、`LOGIN_RATE_LIMIT_MAX`、`REFRESH_RATE_LIMIT_MAX`、`STOP_ALL_RATE_LIMIT_MAX` で変更できます。パスワードはランダムなソルト付きの scrypt で、同時 4 件・待ち 20 件までなので、大量送信でサーバーが枯渇しません | `src/auth.ts`, `src/users.ts` |
| 盗まれたトークン、またはアドレスから読み取られたトークン | アクセストークンは期限切れになり（`JWT_EXPIRES_IN`、既定 30 日、信頼できる LAN の外では 24 時間を推奨）、ローテーションするリフレッシュトークンで更新されます。WebSocket はトークンを `hydra.bearer` サブプロトコルで受け取り、`HYDRA_UMC_WS_QUERY_TOKEN=allow` で許可しない限り `?token=` を拒否し、起動のたびに警告します | `src/refresh_tokens.ts`, `src/ws.ts` |
| 同じロボットを 2 つのクライアントが動かす、またはロボットが受け取るべきでないコマンド | ロボットは 1 つのアカウントとウィンドウに予約され、書き込みには `If-Match` が必要で（古いリビジョンは `412`）、閲覧者ロールは書き込めません。ジョグの大きさとヒートベッドの最高目標は管理者が設定した安全制限から来ます。全体停止は予約に関係なく動きます | `src/claimPolicy.ts`, `src/safetyLimits.ts`, `src/routes/commandRoutes.ts` |
| ネットワーク上の誰にでも見えるカメラ映像 | ライブ映像、写真、録画には 5 分間有効の署名付きチケット（またはベアラートークン）が必要です。カメラは最大 8 台で、カメラのパスワードはプロセス一覧とログに出ません。`HYDRA_UMC_CAMERA_AUTH=open` は一時的な除外設定です | `src/mediaTickets.ts`, `src/serverPolicy.ts` |
| 巨大または悪意のあるリクエスト、開放されたクロスオリジンアクセス | JSON の本文は 1 MB まで（大きなアップロード用ルートのみ 50 MB）。`CORS_ALLOWED_ORIGINS` は許可リストで、本番では未設定だとブラウザーのクロスオリジン要求をすべて拒否します（開発では警告付きで任意のオリジンを許可）。`settings.json` と `users.json` はファイルとして配信されません | `src/server.ts` |
| 弱いアクセスオプションが有効のまま：音声テキスト、認識信頼度、MAVLink 署名、Bluetooth、MQTT、TLS | それぞれに、管理者が `PUT /api/admin/server-config`（管理者のみ）で編集するスイッチがあり、既定は保守的で、環境変数が保存値より優先されます。応答は `voice_heard_text_on`、`voice_confidence_off`、`mavlink_unsigned_allowed`、`mavlink_signing_off` などの警告を返します。音声リレーはクライアントが送る `options` を管理者の値で置き換え、MAVLink の鍵ファイルはパスを保存する前に確認されます（32 バイトまたは 16 進 64 文字） | `src/securityConfig.ts`, `src/routes/adminRoutes.ts`, `src/routes/assistantRoutes.ts` |
| 誰が何をしたかの記録の改ざん | 追記のみの監査記録で、各エントリーはハッシュで連鎖します（`GET /api/audit`、`?verify=1` で連鎖を確認）。サーバーログはサイズでローテーションし、書き込みの前に秘密を除く秘匿処理が入ります | `src/auditLog.ts`, `src/logRotation.ts`, `src/redaction.ts` |

**絶対にしないこと：** 認証済みの安全機能として働くこと。制限と停止はこのプロセス内のソフトウェアで、背後にはハードウェアの非常停止経路も、ファームウェアが強制する制限も、実際のコントローラーボードもまだありません。

## 🔌 インターフェース

### API と WebSocket インターフェース

すべてのルート、WebSocket メッセージの契約、認証、そしてクライアントごとのリモートアクセスモデルは、**[`docs/REMOTE_API.md`](docs/REMOTE_API.md)** に記載されています——本サーバーと通信するあらゆるもの（HYDRA-UMC STUDIO 自身のクライアントコードを含む）にとっての唯一の信頼できる情報源です。要約すると：

- `/api/*` 配下の REST API —— 設定の読み書き、原子的なロボット指令（ジョグ／再生／一時停止／停止／ツール／バルブ／ポンプ／速度／ビジョン）、アカウント管理、ワークファイルのアップロード／ダウンロード、モデル提出、システムメトリクス、ディスカバリー。
- 単一の `/ws` WebSocket エンドポイント（ベアラートークンは `hydra.bearer` サブプロトコルで、クエリ文字列内のトークンは、インストール側が再び許可しない限り拒否されます）で、状態が変化するたびに全接続クライアントへ完全なツリー形式の `settings` スナップショットと、より軽量な `delta` 更新をブロードキャストします。
- `POST /api/stop-all` はグローバル停止です。ログイン済みのどのアカウントでも呼べる 1 回の呼び出しで、予約に関わらず全ロボットを停止し、全バルブとポンプをオフにし、ロボットごとの結果を返します。
- Bluetooth LE(既定ではオフ):CM5 の近くにあるスマートフォンはロボットの状態を読み取れ、管理者が許可した場合はコマンドも送れます。サーバーは、ネットワーククライアントが使うのと同じルートが応答した後にのみ確認応答を返します。[`docs/BLE_GATT.md`](docs/BLE_GATT.md) を参照してください。
- すべての書き込みに JWT ベアラートークン認証が必要です。3 つのアカウントロール（`admin`、`operator`、読み取り専用の `viewer`）が、設定／ユーザー管理の書き込みと日常のロボット操作の権限をそれぞれ制御します。
- ローカルネットワーク上でのゼロコンフィグ発見のための `_hydra._tcp` mDNS/Bonjour 広告、加えてサブネットスキャン用の単純な `GET /api/hydra-info`。
- `GET /metrics` —— Prometheus エクスポジション形式（`prom-client`）。下記「📊 モニタリング」で説明する任意の Grafana ダッシュボード向け。

CORS は、設定可能な許可リスト（`CORS_ALLOWED_ORIGINS`、下記「環境変数」参照）を通じて有効化されています。これは、本サーバーのクライアントがもはや自身と同一オリジンであるとは限らないためです。未設定の場合、`NODE_ENV=production` 以外では常に完全に開放されています（今日のローカル開発でのゼロコンフィグ動作）。本番環境では、この許可リストが設定されるまで、すべてのクロスオリジンブラウザリクエストを拒否します——完全な理由は `src/server.ts` の `app.use(cors(corsOptions))` 直上のコメントを参照してください。

### モニタリング（任意）

`GET /metrics` は、プロセスの稼働時間、接続中の WebSocket クライアント数、`settings.json` の書き込みレイテンシ、種類別の原子的ロボット指令、認証失敗、および `GET /api/system/metrics` と同じ CPU／メモリ／温度の数値を、すべて Prometheus 形式で公開します。すぐに実行可能な Prometheus + Grafana スタック（初期ダッシュボード付き）は **[`monitoring/`](monitoring/README.md)** にあります。そのフォルダから `docker compose up -d` を実行すれば動作します。完全に任意です —— サーバー自体の動作にここにあるものは一切必要ありません。

| トピックまたはルート | 内容 |
|---|---|
| `/api/login`, `/api/refresh`, `/api/logout` | サインイン（回数制限あり）、リフレッシュトークンのローテーション、サインアウト |
| `/api/users`, `/api/users/:username` | アカウントの一覧・作成・変更・削除（`admin`、`operator`、`viewer`）。管理者のみ |
| `/api/settings`, `/api/robot/:id`, `/api/robot/:id/command` | 状態ツリーと原子的な型付きコマンド（ジョグ、再生、一時停止、停止、ツール、バルブ、ポンプ、速度、ビジョン、テーブル）。`If-Match` 付き |
| `/api/robot/:id/claim`, `/release`, `/jog-arm`, `/api/claims`, `/api/stop-all`, `/api/safety-limits` | 予約、ジョグの有効化、誰が何を持つか、全体停止、安全制限 |
| `/api/admin/server-config`, `/clients`, `/logs`, `/restart`, `/safety-limits` | 管理：アクセススイッチ、接続中のアプリ、サーバーログ、再起動、安全制限。管理者のみ |
| `/api/camera/*`, `/api/cameras/status` | カメラのストリーム、スナップショット、録画、PTZ、`POST /api/camera/ticket` |
| `/api/system/metrics`, `/api/system/supervisor`, `/api/ecosystem/status`, `/api/system/bluetooth/*` | ホスト情報、プロセス監視、エコシステムサービスの状態と制御、Bluetooth ペアリング |
| `/api/voice/turn`, `/api/voice/confirm`, `/api/watch/system-status`, `/api/ai/*` | 音声サービス、ウォッチの状態、ローカル AI サービスへのリレー |
| `/ws` | 1 本の WebSocket：`settings` の全スナップショット、軽量な `delta` 更新、`claims` メッセージ。トークンは `hydra.bearer` サブプロトコルで送ります |
| `GET /api/hydra-info`, `_hydra._tcp` | 探索：リモート契約のバージョン（`remoteApiVersion` 2）、アプリのバージョン、コントローラーとロボットの数。mDNS で告知されます |
| `/admin`, `/dashboard-ai`, `/` | 任意の静的ページ。`build-frontend` がこのリポジトリの隣でビルドした場合にのみ配信されます：管理パネル、DASHBOARD-AI、STUDIO |
| `/metrics` | Prometheus 形式：稼働時間、WebSocket クライアント、書き込み遅延、種類別コマンド、認証失敗、ホストの数値 |

## ⚙️ 設定

### 環境変数

いずれも任意です——本サーバーは、以下の各変数について組み込みの開発向けデフォルト値を用いることで、ゼロコンフィグでも動作します。完全に信頼されたローカルネットワークの外へ本サーバーを公開する前に（例えばルーターの NAT／ポートフォワード経由でインターネットへ公開する場合、脅威モデルが「信頼済み LAN のみ」から「誰でも到達可能」へと変わります）、実際の値を設定してください（`.env.example` 参照）：

- `JWT_SECRET` —— すべてのログイントークンに署名します。未設定の場合、`src/server.ts` に組み込まれた固定の開発用値が代わりに使用されます（ローカル開発には問題ありませんが、信頼されたネットワークの外から到達可能なデプロイには適しません）。シェルでエクスポートするか、お使いのプロセスマネージャー／コンテナ（systemd の `Environment=`、`pm2` 自身の環境設定、Docker の `-e` など）を通じて設定してください。
- `NODE_ENV` —— 実運用のデプロイでは `production` に設定してください。以下 2 つのフォールバック（開放的な CORS、静かなデフォルト値の使用）を制御し、`JWT_SECRET` や初期投入された `admin`/`admin` アカウントがまだデフォルトのままである場合に、目立つ起動時警告を有効化します。未設定（またはそれ以外の値）の場合は、現在の寛容な開発向け動作を維持します。
- `CORS_ALLOWED_ORIGINS` —— 本 API へのクロスオリジンブラウザリクエストを許可するオリジンのカンマ区切りリスト —— 実際に関係してくるのは、HYDRA-UMC STUDIO が本サーバーとは異なるホスト／ポートから配信される場合です（例：`https://studio.example.com`、開発時であれば `http://192.168.1.20:5173`）。例：
  `CORS_ALLOWED_ORIGINS=https://studio.example.com,http://192.168.1.20:5173`。
  未設定の場合：`NODE_ENV != production` であれば任意のオリジンを許可します（ローカル開発では設定不要、本プロジェクトの従来の挙動と一致）。`NODE_ENV = production` の場合は、これが設定されるまで、すべてのクロスオリジンブラウザリクエストを **拒否** し、目立つ起動時警告を表示します。非ブラウザクライアント（curl、HYDRA-UMC SUITE、モバイル制御アプリ）はいずれの場合も影響を受けません —— CORS はブラウザのみに関わる仕組みです。
- `JWT_EXPIRES_IN` —— ログイントークンの有効期間。`jsonwebtoken` 自身の `expiresIn` オプションが受け付ける任意の文字列（`"24h"`、`"7d"`、秒数の裸の数値など）を指定できます。未設定の場合、デフォルトは `30d`（本プロジェクト当初の信頼済み LAN を前提とした値）です。**信頼済み LAN の外から到達可能なサーバーでは、これをより短く設定すべきです —— `24h` は妥当な出発点です** —— 漏洩した長期有効トークンは、そのアカウントのパスワードを変更する以外に個別に無効化する方法がありません。
- `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` —— `POST /api/login` のみをスロットリングします（他のすべてのルートは影響を受けません）。いずれか未設定の場合、デフォルトは IP ごとに 15 分あたり 5 回の試行です。制限に達した場合は、一般的な `500` ではなく、明確な JSON エラーを伴う `429` を返します。
- `REFRESH_RATE_LIMIT_MAX` —— `POST /api/refresh` のウィンドウおよび IP ごとのリクエスト上限です（デフォルトは 120）。上記のログイン制限には、失敗したログインのみが数えられます。
- `TLS_CERT_PATH` / `TLS_KEY_PATH` —— **両方を** 設定すると、サーバー（REST API + 同じリスナーを共有する `/ws` WebSocket）がプレーンな HTTP/WS から HTTPS/WSS へ切り替わります。詳細は下記「TLS / HTTPS」を参照してください。いずれか一方でも未設定の場合、現在のプレーン HTTP の挙動が維持されます。
- `HYDRA_UMC_CAMERA_AUTH` —— カメラ映像(ライブストリーム、保存済みの写真と録画)は**既定で**短寿命の `?ticket=`(ログイン済みクライアントに `POST /api/camera/ticket` が渡します)または Bearer トークンを要求します。`HYDRA_UMC_CAMERA_AUTH=open` は、まだチケットを要求しないクライアント向けの一時的な回避策です。
- `HYDRA_UMC_WS_QUERY_TOKEN` —— `/ws?token=` は**既定で拒否**されます(トークンは `hydra.bearer` サブプロトコルで送られます)。`HYDRA_UMC_WS_QUERY_TOKEN=allow` は、まだ移行していないクライアント向けの一時的な回避策です。回避策が有効な間、サーバーは起動のたびに警告します。
- `HYDRA_UMC_BLE_GATT` - Bluetooth LE サービス:`off`(既定)、`state`(スマートフォンが状態を読む)、`commands`(コマンドも送る。各コマンドにアカウントのアクセストークンを付ける)。`HYDRA_UMC_BLE_ENCRYPTION=off` で暗号化リンクを要求しなくなります(既定では要求します)。どちらもサーバー管理画面から設定でき、変更は次回の起動時に反映されます。ホストに BlueZ、`python3-dbus`、`python3-gi` が必要です。
- `HYDRA_UMC_MQTT_BRIDGE` - セルの MQTT ブローカーへのブリッジ:`off`(既定)、`state`(各ロボットの状態を retained トピックに出力)、`commands`(ロボットのトピックに発行されたコマンドを、ネットワーククライアントと同じルートで、`HYDRA_UMC_MQTT_COMMAND_USER` が指す専用アカウントのトークンで実行)。アドレス、トピックの接頭辞、ユーザー名は Server Admin 画面からも設定でき、パスワードは環境変数のみです。[`docs/MQTT_BRIDGE.md`](docs/MQTT_BRIDGE.md) を参照。
- `HYDRA_UMC_INFO_AUTH=required` —— 読み取り専用のホスト情報(`/metrics`、`/api/system/metrics`、`/api/system/supervisor`、`/api/ecosystem/status`、`/api/models`)にログイン済みクライアントを要求します。それらのルートでまだトークンを送らないクライアントが動き続けるよう既定ではオフで、本番起動時はオフの間警告します。
- `HYDRA_UMC_VOICE_UI_INCLUDE_HEARD_TEXT`、`HYDRA_UMC_VOICE_UI_MIN_CONFIDENCE`、`HYDRA_UMC_BRIDGE_UAV_SIGNING_KEY_FILE`、`HYDRA_UMC_BRIDGE_UAV_SIGNING_ALLOW_UNSIGNED` - 管理者が Server Admin からも設定できる音声と UAV のオプション(`data/server-config.json` の `voice` と `mavlink`):音声の返答が聞き取った内容を繰り返すか(`1` で有効、既定はオフ)、動作を開始する要求を受け付ける前に必要な音声認識の最小信頼度(0〜1、既定 0.6)、MAVLink 2 署名の鍵ファイルと未署名メッセージを引き続き受け付けるか(既定は署名なしで、未署名は拒否)。環境変数が保存値より優先され、その場合は画面に固定値として表示されます。
- `HYDRA_UMC_AI_ACCESS=admin` - ローカル AI サービスへのリレー（`/api/ai/*`）を管理者のみに制限します。既定ではオフで、これまでどおりログイン済みのユーザーなら誰でも使えます。
- `HYDRA_UMC_VISUAL_SERVOING_TOKEN`、`HYDRA_UMC_VLA_ENGINE_TOKEN`、`HYDRA_UMC_COGNITIVE_NODE_TOKEN`、`HYDRA_UMC_DETECTION_HEF_TOKEN`、`HYDRA_UMC_VISION_NODE_TOKEN`、`HYDRA_UMC_ANOMALY_TOKEN`(リレー `/api/ai/*` 用)、`HYDRA_UMC_VISION_STREAMER_TOKEN`(カメラストリーム用)、`HYDRA_UMC_DATALAKE_READ_TOKEN`(なければ `HYDRA_UMC_DATALAKE_TOKEN`、テレメトリ用)- トークンを要求するサービスにこのサーバーが提示する Bearer トークン。いずれも `..._FILE`(1 行目がトークンのファイル)でも指定できます。サービス自身が読む名前なので 1 つの環境ファイルが両方に使え、クライアントには決して見えません。トークン未設定のサービスは従来どおり到達できます。リレーは管理者でもオペレーターでもないセッションも拒否し、異常検知器のベースラインを変更できる(`/detect` 以外の `POST`)のは管理者だけです。`vision-node` と `anomaly-detector` がリレーに加わります。
- `HYDRA_UMC_VOICE_UI_RESULT_KEY`（または `..._FILE`）- HYDRA-UMC-VOICE-UI が確認済みの音声結果に署名する鍵（16 文字以上、同じ値）。`POST /api/voice/confirm` はサインイン中のユーザーを subject として確認を中継し、そのユーザーを名指しし署名が検証できる場合にのみ `confirmed` の応答を信じます。鍵がなければ応答は `verified: false` で渡され、`HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE=1` ではその代わりに拒否します。このルートは何も実行しません。
- `HYDRA_UMC_TELEMETRY_COLLECTOR_URL`（`HYDRA_UMC_TELEMETRY_COLLECTOR_TOKEN` または `..._FILE`、および `HYDRA_UMC_TELEMETRY_INTERVAL_MS`：100〜60000、既定は 1000）- テレメトリのプロデューサーを有効にします。このサーバーが配信するロボットのデルタ（位置、関節、再生状態）の数値が、ロボットごとに 1 つの `robot_state` サンプルとして、間隔ごとに最大 1 つ、まとめて HYDRA-UMC-TELEMETRY-COLLECTOR に送られ、データレイクが保存する実データを持てるようになります。アドレスがなければ無効です。コマンドを遅らせることはなく、保持するデータ量には上限があり、失敗後は 30 秒間停止します。
- `/dashboard-ai` - HYDRA-UMC-DASHBOARD-AI がこのリポジトリの隣にある場合、`build-frontend` がビルドし、このサーバーがそこで配信します。このページは、同じブラウザーで STUDIO にサインインした人のセッションで、リレーを通してデータレイク（`/api/ai/datalake/*`、読み取り専用：`/query`、`/aggregate`、`/stats`、`/stats/range`、`/series`、`/health` への `GET` のみで、それ以外は拒否）と異常検知器（`/api/ai/anomaly-detector/*`）を読みます。そのため、このサーバーのロールとサービストークンが適用されます。これで異常検知器を `HYDRA_UMC_ANOMALY_PROTECT_READS=1` で起動できます。
- `HYDRA_UMC_LOG_MAX_BYTES` と `HYDRA_UMC_LOG_KEEP` - サーバーログをローテーションするサイズ（既定 10 MB）と、保持するローテーション済みファイルの数（既定 1）。
- `HYDRA_UMC_SETTINGS_STORE`、`HYDRA_UMC_SETTINGS_BACKUPS`、`HYDRA_UMC_SETTINGS_BACKUP_INTERVAL_S` - 既定では設定（`settings.json` とポイントファイル）はジャーナル付きの全か無かの単位として書き込まれます。中断された書き込みは次回起動時に完了または破棄され、`settings.json` のコピーが `data/backups/` に保存され（10 件、最短 600 秒間隔）、壊れた `settings.json` は最新の正常なコピーから復元されます。`HYDRA_UMC_SETTINGS_STORE=plain` でファイルを 1 つずつ書く方式に戻せ、`HYDRA_UMC_SETTINGS_BACKUPS=0` でコピーを無効にできます。
- AI リレーのアクセス、ホスト情報のサインイン要否、TLS（証明書と鍵のパス、証明書の SHA-256 フィンガープリント付き）は、管理者が制御アプリのサーバー管理画面から変更することもできます。環境変数で設定された値が優先され、ロック表示になります。サインイン要否は無効にする前に確認を求め、TLS は次回起動時に反映されます。
- `STOP_ALL_RATE_LIMIT_MAX` / `STOP_ALL_RATE_LIMIT_WINDOW_MS` —— グローバル停止(`POST /api/stop-all`)のアドレスごとの上限。ログインとは別枠です(既定は毎分 60 回)。本番では、デプロイ用テンプレートの例の `JWT_SECRET` やブートストラップパスワード、32 文字未満の `JWT_SECRET`、12 文字未満のブートストラップパスワードでは起動を拒否します。

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

以下のアクセススイッチは、STUDIO と SUITE の Server Admin 画面が編集するものです。どれも同じ順序で決まります。まずデプロイの環境変数（画面ではロック表示）、次に管理者が `data/server-config.json` に保存した値、最後に保守的な既定値です。ほかのすべては上に挙げた変数が扱います。

| 変数 | 既定値 | 設定する内容 |
|---|---|---|
| `aiAccess`, `HYDRA_UMC_AI_ACCESS` | `open` | ローカル AI リレーを使える人。`open` はサインイン済みの全アカウント、`admin` は管理者のみ |
| `infoAuth`, `HYDRA_UMC_INFO_AUTH` | オフ | 読み取り専用のホスト情報（メトリクス、プロセス監視、エコシステム状態）にサインインを要求する |
| `tls.enabled`, `TLS_CERT_PATH, TLS_KEY_PATH` | オフ（平文 HTTP） | 指定した証明書と鍵で HTTPS / WSS にする。使用中の証明書のフィンガープリントを画面に表示 |
| `ble.mode`, `HYDRA_UMC_BLE_GATT` | `off` | サーバー近くのスマートフォン向け Bluetooth LE：`off`、`state`（状態の公開のみ）、`commands`（コマンドも受付）。不明な語はオフ扱い |
| `ble.requireEncryption`, `HYDRA_UMC_BLE_ENCRYPTION` | オン | コマンド用キャラクタリスティックへの書き込みと状態の読み出しは暗号化されたリンクのみ。変数が `off` のときだけ無効 |
| `mqtt.mode`, `MQTT environment of the deployment` | `off` | セルのブローカーへの MQTT ブリッジ：`off`、`state`、`commands`。URL・プレフィックス・ユーザーも設定 |
| `voice.includeHeardText`, `HYDRA_UMC_VOICE_UI_INCLUDE_HEARD_TEXT` | オフ | 音声の返答が話した内容を繰り返す。個人データなので既定はオフで、変数では `1` という語だけがオンにします |
| `voice.minConfidence`, `HYDRA_UMC_VOICE_UI_MIN_CONFIDENCE` | `0.6` | 動作を始める要求を受け付ける音声認識の最小信頼度（0〜1）。0 で確認をオフにし、停止は決して保留されません。変数の不正な数値は無視されます |
| `mavlink.signingKeyFile`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_KEY_FILE` | 空（署名なし） | UAV ブリッジの MAVLink 2 署名：32 バイトの鍵（生の 32 バイトまたは 16 進 64 文字）を入れたファイルのパス。保存するのはパスだけで鍵は保存せず、ブリッジは起動時に読みます |
| `mavlink.signingAllowUnsigned`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_ALLOW_UNSIGNED` | オフ | 署名のないメッセージも受け付ける（まだ署名しない機体向け）。オンの間は画面が警告します |

## 🚀 クイックスタート

Node.js 22 以上と npm が必要です。サーバーは設定なしで開発向けの既定値で動きます。信頼できる LAN の外から届くようにする前に、設定セクションの変数を指定してください。

```bash
npm install
./dev.sh                    # runs the server with tsx on port 3000, no frontend (dev.bat on Windows)
npm run test:unit           # the unit tests
npm test                    # unit tests, the OpenAPI check and the contract scripts against a live instance
npm run build && npm start  # one bundled file (build.sh and build.bat make a versioned release build)
```

サーバーは `0.0.0.0:3000` で待ち受け、状態はすべて `data/` に置かれます。このリポジトリには意図的に Dockerfile がありません。HYDRA-UMC-OS が CM5 にインストールします（`provisioning/install_server.sh`）。実行中のバージョンは `GET /api/hydra-info`（`appVersion`）で読めます。バージョン付きリリースビルドを作るのはルートの `build*.sh` / `build*.bat` だけで、`npm run build` はコンパイルのみです。

## 🧪 テスト

`npm run test:unit` で自動テスト 414 件を実行します。 さらに `npm test` は OpenAPI の確認と、このサーバーの実インスタンスに対する `tools/` の 28 本のエンドツーエンド契約スクリプトを実行します（探索、認証情報なし／ありのサインイン、本番ブートストラップ、ロボットのコマンドと所有、リフレッシュトークン、音声リレーとそのエラー経路、再生、全体停止、Bluetooth と MQTT のブリッジ、カメラメディア、AI とコネクターハブのリレー、閲覧者ロールなど）。すべて合格しており、ハードウェアは不要です。

CI は `HYDRA_UMC_CI=1 python tools/ci_validate.py` を実行し、マニフェスト、文書、8 つの README、図を検査します。

## 🏗️ ビルドとリリース

### 必要環境

- [Node.js](https://nodejs.org/)（v18 以上推奨）
- npm

### インストール

```bash
npm install
```

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

このリポジトリには意図的に Dockerfile がありません。サーバーは [HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)（`provisioning/install_server.sh`）によってパッケージ化され CM5 にインストールされます。

## 🩺 トラブルシューティング

| 表示 | 原因 | 対処 |
|---|---|---|
| 本番でサーバーが起動時に止まる | `NODE_ENV=production` では、本物の `JWT_SECRET`（32 文字以上、例のままは不可）と、初回起動時の初期管理者が必要です | `JWT_SECRET`、`HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME`、`HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD` を設定する（`docs/PRODUCTION_BOOTSTRAP.md` を参照） |
| サインインで `429` | 1 つのアドレスから 15 分以内に 6 回以上サインインに失敗した | 時間枠が過ぎるのを待つ。`LOGIN_RATE_LIMIT_MAX` を上げるのは信頼できるネットワークだけにする |
| ブラウザーアプリが CORS で遮断される | 本番では `CORS_ALLOWED_ORIGINS` が未設定だとブラウザーのクロスオリジン要求をすべて拒否します（curl、SUITE、スマートフォンアプリは影響なし） | ページのオリジンを `CORS_ALLOWED_ORIGINS=https://studio.example.com,...` に設定する |
| WebSocket がすぐ閉じる、またはカメラ映像が読み込まれない | クライアントがトークンをアドレスで送っている（`/ws?token=` は既定で拒否）、またはチケット無しで映像を開いている（既定で必須） | `hydra.bearer` サブプロトコルと `POST /api/camera/ticket` を使う。除外設定 `HYDRA_UMC_WS_QUERY_TOKEN=allow` と `HYDRA_UMC_CAMERA_AUTH=open` は一時的なものです |
| アクセススイッチがロックされていて拒否される、または MAVLink の鍵ファイルが拒否される | 値が環境変数で設定されている（保存値より優先）、または鍵ファイルが読めない、あるいは 32 バイトでも 16 進 64 文字でもない | 変数を変更または削除して再起動するか、ファイルを直す。MAVLink ブリッジは起動時にオプションを読みます |

## 📂 リポジトリの構成

<p align="center">
  <img src="images/repository-structure.svg" alt="Repository structure of HYDRA-UMC-SERVER" width="100%">
</p>

<details>
<summary>ツリーのテキスト版</summary>

```text
HYDRA-UMC-SERVER/
├── src/                       ソースコード
│   ├── server.ts              以下のモジュールをつなぐ薄い起動部。/api ルートは src/routes/、ライブ接続は ws.ts、設定ファイルは settingsStore.ts
│   ├── kinematics.ts          原子的ジョグエンドポイント用の逆運動学ヘルパー
│   ├── metrics.ts             GET /metrics を支える —— Prometheus テキスト形式（prom-client）
│   ├── ble/                   Bluetooth LE サービス:フレーム、ゲートウェイ(コマンド、確認応答、状態)、ヘルパー転送
│   ├── users.ts               アカウントストア（scrypt パスワードハッシュ化）
│   ├── routes/                /api ルートを領域別に: 認証、設定、ロボットの予約、コマンド、安全上限、カメラ、Bluetooth、管理、システム、兄弟サービスへの中継、ローカル AI、アシスタント、作業ファイル、電源、情報、静的ファイル
│   ├── auth.ts                トークン検証、管理者ゲート、レート制限、リフレッシュトークンの保管、本番が署名シークレットと初期パスワードとして受け入れるもの、アクセスオプション、中継先サービスに提示するトークン
│   ├── claimPolicy.ts         どのロボットを誰が制御するか、オペレーターが1台のロボットに行う編集、全クライアントが守る上限、1回のリクエストでの XY テーブル移動、サーバーが正とする再生
│   ├── settingsStore.ts       ディスク上の設定ファイル、そのバックアップ、複数ファイルのオール・オア・ナッシング書き込み、監査記録、ログローテーション
│   ├── ws.ts                  ライブ接続のハブ (WebSocket)、セルのブローカーへの MQTT ブリッジとその起動、最初のテレメトリ生成元
│   ├── cameraHealth.ts        カメラのストリームが実際にフレームを届けているか、IP カメラの探索と PTZ、ストリームプロセスの監督、カメラ画像用の短命チケット
│   └── ecosystemStatus.ts     エコシステムの検出と稼働確認、サービスポートの登録簿、ホストのメトリクス、プロセスのランタイム (mDNS、ポート)、純粋なポリシー補助、秘密情報の伏せ字処理、Bluetooth ペアリング補助、上流アドレス、音声リクエストの確認
├── admin-ui/                  この本サーバー自身のための独立した Vite/React 管理パネル
├── data/                      ランタイム状態 —— 設定、ユーザー、ログ、ワークファイル、保存済みポイント
├── docs/                      プロジェクトの文書
├── images/                    メディアと図版
├── systemd/                   サービスユニット
├── tools/                     プロジェクトのツールと CI の検査
├── tests/                     自動テスト
├── monitoring/                任意の Prometheus + Grafana スタック —— monitoring/README.md 参照
├── scripts/                   Bluetooth LE ヘルパー（BlueZ）と旧式のバージョン用ヘルパー
├── .github/                   CI ワークフローと Issue テンプレート
├── bump_manifest_version.py   hydra-umc.project.json のバージョンをネイティブ側と同期（--sync）
├── build.bat / build.sh       依存関係のインストール + プロダクションビルド
├── dev.bat / dev.sh           依存関係のインストール + 開発サーバーの起動
├── package.json               パッケージのメタデータとスクリプト
├── tsconfig.json              TypeScript 設定
├── CHANGELOG.md               各バージョンの変更点
├── LICENSE
├── build-test.sh              変更を伴わないビルド確認
├── hydra-umc.project.json     マニフェスト：バージョン、成熟度、ファミリー
└── test.sh                    テストを実行
```

</details>

## 🗺️ ロードマップと既知の制限

**現時点の既知の制限**

* STM32H745 ボードを載せた実際の CM5 への接続（`spi_bridge`）は実在のコードですが、API と契約の層を通してしか試していません。最後の一歩を確かめる物理ボードはありませんでした。
* サーバーはすべてのインターフェース（`0.0.0.0`）で待ち受けます。待ち受けアドレスのスイッチはまだ無いため、公開範囲を抑えるのはファイアウォールか上のアクセススイッチです。
* 開発（`NODE_ENV` が `production` でない）では、組み込みの署名鍵、アカウント `admin`/`admin`、開放された CORS ポリシーが警告付きで使われ、本番ではこれらを拒否します。
* TLS、Bluetooth LE、MQTT ブリッジは任意で、既定はオフです。

**次：** 新しいルートはすべて同じチェックリストに従います（`docs/REMOTE_API.md` に記述、`docs/openapi.json` に名前付け、SDK のクライアントで型付け）。

## 🌍 言語

この README とリポジトリの文書は、英語・スペイン語・ドイツ語・フランス語・イタリア語・日本語・中国語・ポルトガル語（ポルトガル）の 8 言語で提供されています。8 つのファイルは同時に書かれ、同じ節と同じリンクを持つことを CI が確認します。 このリポジトリには独自の画面もメッセージカタログもないため、翻訳すべきインターフェース文字列はありません。

## 🔗 関連プロジェクト

本プロジェクトは、同じ作者(JuanenRac / Electro Hobby 3D)による HYDRA-UMC ロボティクスエコシステムの一部です。リクエストが実はこの中のどれかについてのものである可能性があるため、知っておく価値があります。

**子プロジェクト** —— いずれも、本サーバーの API 経由でのみロボットフリートと通信する、実際のクライアントまたは調整用ブリッジです
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** —— リアルタイムのマルチロボット 3D 可視化を備えたウェブ制御ダッシュボード。
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** —— 複数のサーバーを同時に扱えるデスクトップ(PySide6)スウォームコマンドセンター、スタンドアロン実行ファイルとしてパッケージ化。
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** —— 生体認証ログインとペアリングされた Wear OS コンパニオンを備えたネイティブ Android 制御アプリ。
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** —— リアルタイム WebSocket 同期を備えた iOS/iPadOS 制御アプリ(Flutter)。
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** —— 本体搭載の 7 インチ DSI タッチスクリーン向けネイティブタッチ UI、CM5 自体に組み込み。
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** —— VDA 5050 MQTT パブリッシャーによる AGV/AMR フリートの調整境界(エミュレートしたフリートに対してのみテスト済み)。
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** —— GRBL ステータス/制御バイトへのアクセスを持つ、CNC セルの高レベルコーディネーター(エミュレーターに対してのみテスト済み)。
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** —— Boston Dynamics Spot コマンド送信機能を持つ、脚型/ヒューマノイドドロイドの調整境界(エミュレーターに対してのみテスト済み)。
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** —— キー/筐体/インターロックの GPIO 信号 3 系統を読み取るレーザーセルのコーディネーター(模擬チップに対してのみテスト済み。レーザーの武装や発射はできない)。
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** —— OpenPnP ピックアンドプレースの基板フローを安全に統括する高レベルコーディネーター。
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** —— 実際にゲート制御されたジョブコマンドを持つ、Moonraker/Klipper 3D プリンター向けの安全な調整境界。
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** —— 遅延インポートの rclpy ROS 2 トランスポートを持つコーディネーター(ROS 2 環境ではまだ実行していない)。
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** —— MAVLink コマンド送信機能を持つ、カメラ搭載 UAV の調整境界(エミュレーターに対してのみテスト済み)。

**直接関連**
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** —— 本サーバーは、ゲートウェイトークンをサーバー側に保持したまま、ループバック接続経由で限定的かつ認証済みの発話ターンをこれへ中継する。音声が直接ロボットコマンドになることは決してない。
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** —— ロボットアームのマザーボードの設計(実装済みの基板はまだない)。本サーバー自身の `spi_bridge` サービスは、CM5↔STM32H745 の SPI-OTA 接続を介してこれと通信することを想定している(テストは模擬部品に対してのみ)。

**エコシステムの他のプロジェクト**

*コアハードウェア&プラットフォーム*
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** —— 本サーバーが動作する CM5 向けの再現可能な Raspberry Pi OS プロダクト層——読み取り専用エージェント、検証済み設定/プロファイル、WiFi 初回接続プロビジョニング。
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** —— すべてのブリッジが自身のコマンドを検証する共有 JSON-Schema 契約とソフトウェアのジョブゲート境界(認証済みの安全機能ではない)。
- **[HYDRA-UMC-CONNECTOR-HUB](https://github.com/JuanenRac/HYDRA-UMC-CONNECTOR-HUB)** — 外部マシン用コネクタのための宣言的アダプターマニフェストのレジストリとバリデーター。SDK 自身の契約という発想を外部マシンにまで拡張し、産業用ゲートウェイ系のプロジェクトを置き換えることはありません。
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** —— 完成したモデルを本サーバー自身のカタログへ送信するデスクトップ用グラフィカル URDF 作成/編集ツール。
- **[HYDRA-UMC-EDITOR-STL](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-STL)** — HYDRA-UMC-EDITOR-URDF も編集する同じモデルカタログ内で、実在するパーツを変換/置換/削除/追加するデスクトップ STL モデルエディタ。

*URTC ツールプラットフォーム*
- **[URTC](https://github.com/JuanenRac/URTC)** —— 物理的な Universal Robot Tool Controller 基板向けファームウェア、CAN バス経由の 25 以上のツールプロファイル。
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** —— URTC 基板用のデスクトップ GUI 書き込みツール、CAN-OTA およびフルチップ SWD/JTAG。
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** —— URTC 基板向けのデスクトップ CAN バスライブ診断ツール、ツールプロファイルごとに 1 パネル。
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** —— Web Serial API を使ったブラウザベースの URTC-TESTER の代替、ローカルインストール不要。
- **[URTC-GATEWAY](https://github.com/JuanenRac/URTC-GATEWAY)** —— URTC の CAN バスの前に置くゲートウェイ：許可する識別子のリスト、レート制限、セッション鍵。コンピューター上でテスト済みで、実際のバスではまだ試していません。

*ビジョン AI ノード(Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** —— Hailo-8 ビジョンパイプラインの統合ハブ、段階ごとの実際のハードウェア準備状況チェック付き。
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** —— Hailo アーキテクチャ/チェックサムによる安全読み込み検証を備えた、実際のコンパイル済みモデルレジストリ。
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** —— 実際の HailoRT 統合境界を持つ、実際の GStreamer パイプライン + MediaMTX 設定生成器。
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** —— ゾーン状態を条件に承認する Position-Based Visual Servoing 補正則。カメラによる姿勢推定はまだない。
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** —— ファイルから物体位置を受け取る、ゾーン侵入・キャリブレーション鮮度・E-STOP 要求の v0 ロジック。検出器は接続されておらず、物理 E-STOP もまだ配線されていない。

*コグニティブ AI ノード(Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** —— Hailo-10 コグニティブパイプライン(LLM/VLA/音声オーケストレーション)の統合ハブ。
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** —— Vision-Language-Action モデル向けの、実際のアクショントークンのエンコード/デコードと軌道生成。
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** —— MCU エラーコードに対する、実際のルールベースのタスク分解と意味的エラー復旧。
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** —— このエコシステム自身の Markdown ドキュメントに対する、標準ライブラリのみの実際の TF-IDF 文書検索。
- **[HYDRA-UMC-LOCAL-TECHNICIAN](https://github.com/JuanenRac/HYDRA-UMC-LOCAL-TECHNICIAN)** — エコシステム自身のための、ローカルでポリシーゲート付きのAIメンテナンス技術者 — 観察、診断し、修正を提案する;最上位の2つのリスクレベルは意図的にまだ実装されていない。

*オーケストレーション&スウォーム*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** —— 実際の gRPC/Protobuf ヘルスレポート契約とミッションステートマシンを持つ統合ハブ。
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** —— 実際の HTTP API 上に構築された、優先度ベースの実際のジョブキュー(重複排除付き)。
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** —— リトライ/バックオフとアイデンティティ不一致検出を備えた、実際の gRPC ベースのフリートヘルスウォッチドッグ。
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** —— 実際の障害物/ワークスペース衝突検証を備えた、実際の RRT ベースの 3D 経路プランナー。
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** —— 複数セルの収束についてプロパティテストされた、実際の CRDT LWW-Element-Map 状態同期。

*デジタルツイン&シミュレーション*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** —— 実際のバージョン互換性同期契約を持つ、デジタルツインエンジンの統合ハブ。
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** —— シミュレーションと実機の間にソフトウェアの衝突インターロックを備えたハードウェア・イン・ザ・ループのルーター(実機なしでテスト済み)。
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
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** —— 触覚アラートのパターンとペアリング済みスマートフォンへの音声リレーを備えた WearOS コンパニオンアプリ(物理的なウォッチではまだ実行していない)。
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** —— 実際の工具 ID デコードと Smart Idle 予熱ロジックを備えた、基板搭載ラック用ファームウェア。
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** —— サーマル/RGB 検査ツールヘッド向けの、ファームウェアと実際の Python ビジョンコンパニオン。
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** —— このエコシステム内のすべてのリポジトリを検出・クローン・更新する、管理用デスクトップツール。
- **[HYDRA-UMC-OS-REBUILDER](https://github.com/JuanenRac/HYDRA-UMC-OS-REBUILDER)** — エコシステムの最新バージョンをプリロードした、書き込み可能なCM5イメージを構築するWindows/Linuxデスクトップツール。Raspberry Pi Imager方式の初回起動Wi-Fi/ユーザー/SSH設定を備える。
- **[HYDRA-UMC-OPS-AGENT](https://github.com/JuanenRac/HYDRA-UMC-OPS-AGENT)** — 保守インシデントコーディネーター: 低権限のエッジ役割がサニタイズされたインベントリ/ヘルスのスナップショットを収集し、コントロールプレーン役割がそれを読み取り専用でレンダリングして AI プロバイダーに診断の提案を依頼します - パッチを適用することも、何かをデプロイすることも決してありません。
- **[HYDRA-UMC-DEV-SERVER](https://github.com/JuanenRac/HYDRA-UMC-DEV-SERVER)** — 再現可能な開発ホスト（Raspberry Pi 5 / CM5）。エコシステムのソースコードを保管し、永続キューのもとで境界の明確なビルド/テストタスクを実行する。運用中の CM5 とは明確に異なる、開発専用の役割。

## 📚 ドキュメント

さらに読むには：

* [エコシステムのセキュリティ基準](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md)
* [エコシステムの脅威モデル](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md)
* [このリポジトリの変更履歴](CHANGELOG.md)
* [このリポジトリのライセンス](LICENSE.md)

## 🤝 コントリビュートとコミュニティ

* プルリクエストの前に `HYDRA_UMC_CI=1 py -3 tools/ci_validate.py`（または `HYDRA_UMC_CI=1 python3 tools/ci_validate.py`）を実行してください。`CI_VALIDATION=PASS` と表示される必要があります。この確認に `build.sh` や `build.bat` は使わないでください。ビルドは検査ではありません。
* 8 つの README は HYDRA-UMC-DOCS の 1 つのソースから書かれます。手で編集しないでください。ソースを変更し、`tools/make_readmes.py` で書き直します。
* 実行していないことを README に書かないでください。事実であれば「シミュレーションのみ」「実機では未確認」と書きます。
* [CONTRIBUTING.md](CONTRIBUTING.md)、[行動規範](CODE_OF_CONDUCT.md)、[SECURITY.md](SECURITY.md)、[SUPPORT.md](SUPPORT.md) を参照してください。

## 👤 作者

**JuanenRac (Electro Hobby 3D)** · electrohobby3d@gmail.com

## 📜 ライセンス

GPL-3.0-or-later - [LICENSE](LICENSE).
