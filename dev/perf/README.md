# Data API パフォーマンス計測手順

LIFF / WebViewer から叩いている FileMaker Data API のレスポンス劣化を、**FM Server 側のログ**と**外部からの計測スクリプト**の 2 軸で切り分けるための手順書。

対象 OS：macOS / Linux 上の FileMaker Server。

---

## 1. 何を測るか

| 取るもの | 何が分かる |
|---|---|
| **Top Call Statistics** | FM Server **内部**で各コールに何ミリ秒かかったか。レイアウト評価・スクリプト・検索の重さ |
| **WPE Access Log** (`Access.log`) | HTTP レベルの所要時間。**WAN / TLS / WPE 取次込み**の実測（クライアント体感に近い） |
| **fmdapi / wpe ログ** | Data API リクエスト種別・エラー |
| **Event.log / Stats.log** | 同時セッション数・CPU/IO の傾向（裏で混雑していないか） |
| **計測スクリプトの client_ms** | 外部から見た所要時間。Access Log と突き合わせて WAN を切り分け |

差分の読み方：

```
client_ms (外部スクリプト)
  └─ WAN/TLS/プロキシ
      └─ Access.log duration (WPE での所要時間)
          └─ Top Call duration (FM Server 純粋処理)
```

---

## 2. サーバ側の事前準備（macOS / Linux）

### 2.1 ログ・統計の有効化

Admin Console（`https://<server>:16001/admin-console`）にて：

1. **Configuration → Log Settings**
   - **Top Call Statistics Log** を **Enable**
   - **Statistics Log** を Enable（既定で ON のことが多い）
   - **Access Log** が記録されていることを確認
2. **Statistics → Top Call Statistics** タブで、リアルタイムにコール一覧が出ることを確認

### 2.2 ログファイルの場所（macOS / Linux）

既定パス：

```
/Library/FileMaker Server/Logs/
├── Access.log              # WPE: HTTP リクエストごとの所要時間
├── fmdapi.log              # Data API 固有のイベント
├── wpe.log                 # Web Publishing Engine
├── Event.log               # サーバ全体のイベント
├── Stats.log               # 集計統計
└── TopCallStats.log        # Top Call Statistics (有効化後)
```

ローテーション設定により `.1`, `.2` … の世代ファイルあり。圧縮されていることも。

### 2.3 計測専用アカウント

ログを**アカウント名でフィルタ**できるよう、計測専用アカウントを作成：

- アカウント名：`va_perf_probe`（識別しやすい名前）
- 権限セット：fmrest 拡張アクセス権あり、最小権限
- 既存ユーザと混ざらないようにする

### 2.4 テストデータ

- 既存患者を壊さない用に **テスト患者レコード** を 1 件作成（`_fk_ptID = "PERFTEST"` など）
- そこに `Exm_VisualAcuity_Summary` を 1 件用意し、`recordId` をメモ
- 計測スクリプトに `FM_RECORD_ID` / `FM_PT_ID` として渡す

---

## 3. 計測の実行

### 3.1 時間帯

- **低負荷帯**（例：22:00–翌6:00、休日早朝）
- 直前に Stats.log で同時セッション数・CPU を確認
- ピーク時との比較が必要なら、後日同条件で再実行

### 3.2 シナリオ

| # | 操作 | エンドポイント | 目的 |
|---|---|---|---|
| A | sign-in | `POST /fmi/data/vLatest/databases/{db}/sessions` | トークン取得コスト |
| B | レコード取得 | `GET .../layouts/{layout}/records/{id}` | 読みパス・レイアウト処理コスト |
| C | find | `POST .../layouts/{layout}/_find` | 履歴検索相当・インデックス効果 |
| D | 軽い update | `PATCH .../records/{id}` (fieldData のみ少量) | 書きパス最小 |
| E | ポータル込み update | `PATCH .../records/{id}` (fieldData + portalData + deleteRelated) | 実態に近い書きパス |
| F | sign-out | `DELETE /sessions/{token}` | 後片付け |

### 3.3 手順

```sh
# 環境変数を埋めてから実行（後述の measure.mjs 参照）
cp dev/perf/.env.example dev/perf/.env
# .env を編集

# 読み取り中心（B, C）30回、トークン再利用
node dev/perf/measure.mjs --scenarios=B,C --iterations=30 --mode=reuse-token \
  --out=dev/perf/out/read-reuse-$(date +%Y%m%d-%H%M).csv

# 同じく、毎回 sign-in/out（A+B+F のオーバーヘッド可視化）
node dev/perf/measure.mjs --scenarios=B,C --iterations=30 --mode=per-call \
  --out=dev/perf/out/read-percall-$(date +%Y%m%d-%H%M).csv

# 書き込み（D）— テスト患者の固定レコードに対し、同値で update（実質ロールバック）
node dev/perf/measure.mjs --scenarios=D --iterations=30 --mode=reuse-token \
  --out=dev/perf/out/write-light-$(date +%Y%m%d-%H%M).csv

# 書き込み（E）— ポータル 10 行込み update
node dev/perf/measure.mjs --scenarios=E --iterations=30 --mode=reuse-token \
  --out=dev/perf/out/write-heavy-$(date +%Y%m%d-%H%M).csv
```

### 3.4 ログ突き合わせ

1. 計測スクリプト実行時刻をメモ（CSV の最初・最後の `timestamp`）
2. Admin Console → Statistics → Top Call Statistics を CSV エクスポート（または `TopCallStats.log` を回収）
3. `Access.log` のうち、計測時間帯 × アカウント `va_perf_probe` の行を抽出：

   ```sh
   awk -v from="2026-05-15 22:00:00" -v to="2026-05-15 22:30:00" \
       '$1" "$2 >= from && $1" "$2 <= to' \
       /Library/FileMaker\ Server/Logs/Access.log \
     | grep "va_perf_probe" > dev/perf/out/access-extract.log
   ```

4. 操作別に min / median / p95 / max を出して比較

### 3.5 読みどころ

- **`client_ms` >> `Access.log duration`** → WAN / TLS / プロキシが支配的（LIFF 側 BFF・CDN を検討）
- **`Access.log duration` >> `Top Call duration`** → WPE 取次や認証で待っている（トークン再利用、コネクション保持）
- **`Top Call duration` 自体が大きい** → FM Server 内部処理（レイアウトの非保存計算・ポータル行数・インデックス・ロック競合）
- **A (sign-in) が遅い** → 認証経路がボトルネック。トークン再利用 / BFF プールで効果大
- **`reuse-token` と `per-call` の差** = sign-in/out コスト。差が大きいほどトークンプール化の価値が高い

---

## 4. このあと

計測結果を見たうえで：

- 内部処理が支配的 → API 用レイアウト最適化（非保存計算の削除・ポータル行制限・インデックス見直し）
- 認証 / セッションが支配的 → BFF + トークンプール
- 読み取り系の重さが支配的 → OData での読み（`$select` で列を絞る）を試す価値あり
- WAN が支配的 → LIFF の API を BFF（同一リージョン）経由に
