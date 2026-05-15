# FileMaker Data API パフォーマンス最適化 提言書

> このドキュメントは、別セッションで実施した FileMaker Server ログ分析の結論と、
> 今後実施すべき最適化作業を**文脈ゼロの担当者がそのまま着手できる粒度**でまとめたもの。
> 分析の元データ・再現スクリプトは `dev/perf/` 配下にある。

最終更新: 2026-05-15

---

## 0. 背景（システム構成の理解）

- **対象**: FileMaker Server (macOS/Linux) 上の業務 DB
- **FM バージョン**: FileMaker Data API Engine 22.0.2
- Data API を叩くクライアントは **2 系統**（以下、IP は伏字。`<IP-A>` / `<IP-B>` として参照）:

| 系統 | アカウント | IP | API ver | 役割 |
|---|---|---|---|---|
| **self-checkin** | `api_self-checkin-system` | `<IP-A>` | vLatest | 受付・自動チェックイン端末 |
| **LIFF / WebViewer** | `api_iec-system` | `<IP-B>` | **v1** | LINE LIFF / FM WebViewer（本リポの WV はこちら系） |

- 本リポジトリ（`fmwv_VAinput`）は LIFF/WebViewer 側の視力入力 WebViewer。

---

## 1. 分析サマリ（何が分かったか）

分析対象ログ（2026-05-15、約 79 分）:

- `Access.log`（FM Server 接続イベントログ）
- `fmdapi.log`（Data API リクエストログ: URL / method / FM error / bytes）
- `wpe0.log`（中身ほぼ空、参考外）

### 1.1 数値の事実

| 指標 | self-checkin | LIFF/WebViewer |
|---|---|---|
| 期間 | 78.7 min | 73.4 min |
| sign-in 回数 | **71,272** | 315 |
| データ操作数 | 71,272 | 1,362 |
| sign-out 回数 | 71,271 | 315 |
| **ops / session** | **1.000（毎回 sign-in/out）** | **4.32（token 再利用あり）** |
| レスポンス総量 | **約 2.6 GB / 79分（≒2 GB/h）** | 22.8 MB |
| FM error 0(OK) | — | — |
| FM error 401 ("No records") | 30,571 件（14.2%） | — |
| FM error 400（不正クエリ） | **2,707 件（self-checkin、特定 EP で 100%）** | — |

> ⚠️ FM Data API の "Error 401" は HTTP 401 ではなく **「該当レコード 0 件」**。
> FM 内部仕様で 0 件ヒットも ERROR レベルでログに残る。認証失敗ではない。

接続ログ側の所見:
- FM Server 内部の認証処理（接続オープン→DB オープン）は **p99 で 3ms** と高速 → **遅さの原因は FM コア処理ではない**
- self-checkin セッション寿命: p50 69ms / p95 177ms / max 1.43s
- `>=1s` の遅延が `>=500ms` とほぼ同数（542 vs 576）→ 緩やかな劣化ではなく**断続的スパイク**（ロック競合 or 一時スタール示唆）
- 同時接続数 最大 8 → スレッドプール枯渇ではない

### 1.2 トランザクション形状（パターン分析の結論）

#### self-checkin（全 71,272 件が同形）

```
POST /sessions  →  <1個の find>  →  DELETE /sessions/{token}
```

| op（=transaction 種別） | 比率 | 平均サイズ | 備考 |
|---|---|---|---|
| `POST api_cPt_VisitRecord/_find` [err=401] | 22.2% | 0.2 KB | 0件ヒット |
| `POST api_cPt_VisitRecord/_find` | 21.9% | **168.7 KB** | **重い。合計 2.5 GB** |
| `POST api_ClinicScheduleException/_find` [err=401] | 20.1% | 0.3 KB | **100% 0件**（無駄打ち） |
| `POST api_m_ClinicSchedule/_find` | 20.1% | 0.8 KB | |
| `GET api_ClinicReceptionStatus/records` | 8.3% | 0.8 KB | |
| `POST api_ClinicReceptionStatus/_find` [err=400] | 3.8% | 0.1 KB | **100% 400（クエリバグ）** |
| `POST api_m_ORCA_DoctorInfo/_find` | 2.9% | 0.8 KB | |
| `PATCH api_cPt_VisitRecord/records/{id}` | 0.3% | 0.1 KB | 唯一の書き込み |

#### LIFF/WebViewer（1 ユーザー操作 = 5〜13 直列コール）

**Flow A「画面を開く/更新」 22.4%（37回）**
```
POST /sessions
 → POST api_Pt_LINE_Connection/_find   LINE userId → 患者逆引き
 → POST api_cPt_Info/_find             患者基本情報
 → POST api_cPt_VisitRecord/_find      受診履歴1
 → POST api_cPt_VisitRecord/_find      受診履歴2（別条件 or 失敗リトライ?）
 → GET  api_m_PtMainStatus/records     ステータスマスタ
DELETE /sessions/{token}
```

**Flow B「初期ダッシュボード」 7.3%（12回, 13コール）**
```
POST /sessions
 → GET  api_m_PtMainStatus/records
 → POST api_ClinicScheduleException/_find [err=401]
 → GET  api_m_PtSubStatus/records
 → GET  api_m_ClinicSchedule/records
 → GET  api_ClinicReceptionStatus/records
 → POST api_ClinicScheduleException/_find [err=401]   ← 同条件を
 → POST api_ClinicScheduleException/_find [err=401]   ← 連続
 → POST api_ClinicScheduleException/_find [err=401]   ← 4回
 → POST api_Pt_LINE_Connection/_find
 → POST api_cPt_Info/_find
 → POST api_cPt_VisitRecord/_find
 → POST api_cPt_VisitRecord/_find
 → GET  api_m_PtMainStatus/records   ← 2回目
DELETE /sessions/{token}
```

---

## 2. 根本原因の分類

| # | 原因 | 種別 | 影響 |
|---|---|---|---|
| A | self-checkin が **1 コール毎に sign-in/out**（token 非再利用） | アプリ設計 | 全 HTTP の 2/3 がセッション管理。WPE/TLS を圧迫 |
| B | **`cPt_VisitRecord/_find` が平均 173 KB** の太い JSON | レイアウト/クエリ設計 | 帯域・シリアライズ・FM 評価コスト。2.5 GB/79分 |
| C | LIFF の 1 操作が **5〜13 直列 API コール** | アプリ設計 | 体感 1〜2.5 秒の遅延 |
| D | `ClinicReceptionStatus/_find` が **100% FM error 400** | アプリのバグ | 完全に無駄な RTT 2,707 回 |
| E | `ClinicScheduleException/_find` が **100% 0件** かつ Flow B で 4 連発 | アプリ設計 | 無駄 RTT。キャッシュ可能 |
| F | self-checkin の `>=1s` スパイク（断続） | FM 内部 競合 | 要 Top Call 突合（未取得） |

**重要**: A〜E は FM Server を増強しても直らない**クライアント側 API 利用パターンの問題**。
最も費用対効果が高いのはアプリ改修。

---

## 3. 実施すべき最適化（優先順）

### ★★★ P1: self-checkin の token プール化

**現状**: `ops/session = 1.000`。`POST /sessions` → 1 find → `DELETE /sessions` を 71,272 回。

**対応**:
- self-checkin クライアント（端末側 or その BFF）で **Data API token をプール/再利用**する
- token は FM Data API 既定で **15 分**有効。1 token で複数 find を捌く
- 実装の置き場所は self-checkin 側コード（**本リポ外**の可能性大 → 要確認）

**期待効果**: 71k sign-in/out → 数十〜数百回。HTTP リクエスト総数が約 1/3、WPE/TLS 負荷が大幅減。

**検証**: 改修後に `fmdapi.log` を再取得し
`node dev/perf/cluster-transactions.mjs <log> --ip=<IP-A>`
で `ops/session` が 1.0 → 大きく上昇することを確認。

---

### ★★★ P2: `cPt_VisitRecord/_find` のレスポンス縮小

**現状**: 平均 168.7 KB（max 692 KB）、合計 2.5 GB/79分。p50=35KB / p90=628KB のバイモーダル。

**対応（要 FM スキーマ調査）**:
1. `_find` が叩いている**レイアウトのフィールド数 / ポータル**を確認
2. API 専用の **slim レイアウト**（必要フィールドのみ、ポータル除外）を作成し、そちらを叩く
3. `limit` を明示（1件で良い用途で全件返っていないか）
4. ポータル行が大量なら `portalData` を必要分に絞る or 別 EP 化
5. FM 22 なら **OData の `$select`** で列指定の読みも検討余地（別途 PoC）

**期待効果**: 173 KB → 数 KB 級。帯域・FM レイアウト評価・JSON 化が 3〜10 倍改善見込み。

**検証**: `cluster-transactions.mjs` の "mean KB" 列が劇的に下がること。

---

### ★★★ P3: LIFF Flow A/B の API 集約（BFF 化）

**現状**: 1 ユーザー操作で 5〜13 本の API を**直列**に叩く（Flow A 22.4%, Flow B 7.3%）。

**対応**:
- LIFF/WebViewer と FM の間に **BFF（同一リージョン）** を置き、画面が必要とするデータを **1 リクエストで返す集約エンドポイント**を作る
- BFF 側で token プール（P1 と共通基盤）
- 段階導入なら、まず Flow A（最頻 22.4%）の 5 コールを 1 集約 API に

**期待効果**: 体感 1〜2.5 秒 → 300〜500ms（直列 RTT を 1 本化 + WAN を BFF 内 LAN 化）。

---

### ★★ P4: `ClinicReceptionStatus/_find` の 400 バグ修正

**現状**: self-checkin で 2,707 件、**100% FM error 400**（不正クエリ）。
同レイアウトの `GET .../records?_limit=1&_offset=1` は 5,894 件成功している → **正解パスは GET 側**。POST `_find` のクエリ JSON が壊れている疑い。

**対応**:
- self-checkin クライアントの該当呼び出し箇所を特定し、`_find` の query を修正 or 成功している GET パスへ統一
- 直近の改修で query 構造が変わったのに旧コールが残っている可能性

**期待効果**: 無駄 RTT 2,707 回を完全消去。

---

### ★★ P5: `ClinicScheduleException` のキャッシュ化＋連発解消

**現状**:
- self-checkin: 14,357 件 **100% 0件**
- LIFF Flow B: 同一条件を**1 操作内で 4 連続**呼び出し

**対応**:
- 結果が常に「無い」/低頻度更新ならクライアント側で**短時間キャッシュ**（例 5 分）
- Flow B の 4 連発はコードレビューで重複呼び出し or 日付ループのバグを特定し 1 回に集約

**期待効果**: LIFF 1 操作あたり -3 RTT、self-checkin の無駄打ち削減。

---

### ★ P6: LIFF を v1 → vLatest に統一

**現状**: LIFF は `/fmi/data/v1/...`、self-checkin は `/vLatest/...`。同一 EP でも挙動差の懸念。

**対応**: LIFF 側を vLatest に揃え、回帰確認。優先度低だが技術的負債として記録。

---

### ★ P7: ピーク帯のスケジュール調整

**現状**: 15:09 / 15:28 / 15:42 に 83 req/sec のスパイク。

**対応**: self-checkin のポーリング間隔/バッチ時刻を分散。P1 実施で大幅緩和されるため P1 後に再評価。

---

## 4. まだ取得できていないデータ（次に依頼すべきもの）

完全なボトルネック分解には以下が必要:

1. **WPE HTTP Access ログ**（リクエスト URI + duration 付き）
   - 既存の `Access.log` は接続イベントログで duration なし
   - 設置場所候補: `/Library/FileMaker Server/HTTPServer/logs/` 配下（別名配信のことあり）
2. **Top Call Statistics**（CSV エクスポート or `TopCallStats.log`）
   - Admin Console → Configuration → Log Settings で有効化
   - 同一時間帯で取得し、特に **F（self-checkin の >=1s スパイク）**の時刻と突合
3. **self-checkin クライアントのソース / 配置場所**
   - P1・P4 はこのコードを直さないと完結しない（本リポ外と推定）

これらが揃えば次の分解が完成する:

```
client 体感
  └─ WAN/TLS/CDN
      └─ WPE Access duration         ← #1 が必要
          └─ FM session lifetime     ← 取得済 (p50 69ms / p95 177ms)
              └─ Top Call duration   ← #2 が必要
```

---

## 5. 再現・計測ツール（このリポに同梱済み）

| ファイル | 用途 |
|---|---|
| `dev/perf/README.md` | サーバ側ログ有効化・取得手順、計測シナリオ定義 |
| `dev/perf/measure.mjs` | 外部から Data API を叩き client_ms を CSV 出力（Node 18+、依存なし）。`reuse-token` と `per-call` で P1 の効果を定量化できる |
| `dev/perf/cluster-transactions.mjs` | `fmdapi.log` を IP 別にトランザクション分布として可視化（本分析の再現） |
| `dev/perf/.env.example` | 計測スクリプト用の環境変数テンプレート |

代表的な使い方:

```sh
# fmdapi.log のトランザクション分布を再分析
node dev/perf/cluster-transactions.mjs /path/to/fmdapi.log --ip=<self-checkin-IP> --top=15
node dev/perf/cluster-transactions.mjs /path/to/fmdapi.log --ip=<liff-IP> --gap-ms=500

# 改修前後の sign-in コスト差を実測（要 dev/perf/.env）
node dev/perf/measure.mjs --scenarios=B,C --iterations=30 --mode=reuse-token --out=dev/perf/out/after-reuse.csv
node dev/perf/measure.mjs --scenarios=B,C --iterations=30 --mode=per-call   --out=dev/perf/out/before-percall.csv
```

---

## 6. 着手順の推奨

1. **P4（バグ修正）** — 影響局所・低リスク・即効。まず手を付ける
2. **P1（token プール）** — 最大の負荷削減。self-checkin コードの所在確認から
3. **P2（slim レイアウト）** — FM スキーマ調査が必要。FM 管理者と連携
4. **P3（BFF 集約）** — 設計を要するため P1 の基盤（token プール）と一体で計画
5. **P5/P6/P7** — 上記の効果測定後に再評価

> 各 P の完了判定は必ず `fmdapi.log` 再取得 →
> `cluster-transactions.mjs` で before/after 比較すること。
> 体感ではなく数値（ops/session, mean KB, req/sec, 0件率）で評価する。
