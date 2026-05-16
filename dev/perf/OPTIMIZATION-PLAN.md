# FileMaker Data API パフォーマンス最適化 提言書

> このドキュメントは、別セッションで実施した FileMaker Server ログ分析の結論と、
> 今後実施すべき最適化作業を**文脈ゼロの担当者がそのまま着手できる粒度**でまとめたもの。
> 分析の元データ・再現スクリプトは `dev/perf/` 配下にある。

最終更新: 2026-05-16

## ステータス（2026-05-16 時点）

| 項目 | 状態 |
|---|---|
| **P1 token プール化** | ✅ **完了**（ops/session 1.00 → 163、sign-in 約 99% 削減） |
| **P4 ClinicReceptionStatus 400 バグ** | ✅ **完了**（400 完全消滅、GET パスへ統一） |
| **P2 `cPt_VisitRecord/_find` 縮小** | 🔴 **現在の最優先**（残コストの 98.7%、7.7 GB/13h） |
| P3 / P5 / P6 / P7 | 未着手 |

詳細な前後比較は「§1.3 効果測定履歴」を参照。

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

## 1.3 効果測定履歴（before / after）

計測はすべて `dev/perf/cluster-transactions.mjs` による。時間帯が異なるため
**絶対量ではなく構造指標（ops/session・per-call サイズ・EP 別エラー率）で比較**。

### 取得ログ

| ラベル | 期間 | 位置づけ |
|---|---|---|
| baseline | 2026-05-15 14:31–15:49（79分・日中繁忙） | 修正前。全提言の起点 |
| overnight | 2026-05-15 17:47–05-16 06:32（約13h・夜間中心） | 修正前（cutover 前）。比較は busy 窓 18時台で実施 |
| **post-fix** | **2026-05-16 09:23–22:15（約13h）** | **P1/P4 稼働後** |

### self-checkin（IP-A）構造指標

| 指標 | baseline | post-fix | 判定 |
|---|---|---|---|
| **ops/session** | **1.00** | **163**（12–14時は 376–425） | ✅ P1 成功 |
| sign-in 回数 | ~44,000 /時（18時台） | **~150 /時** | ✅ 約 99% 削減 |
| 13h 窓 sign-in 総数 | （換算 28万超） | **1,682** | ✅ |
| sign-out（DELETE）数 | 73,848 /12h | **2,462 /13h** | ✅ |
| `ClinicReceptionStatus/_find` の 400 | 100%（2,707–2,917件） | **0 件（完全消滅）** | ✅ P4 成功 |
| 〃 置換先 | — | GET `…/records` 28,423 件すべて成功 | ✅ |

### `cPt_VisitRecord/_find`（成功レスポンス）サイズ推移

| | baseline(昼) | overnight(夜) | post-fix(本日) |
|---|---|---|---|
| p50 | 35 KB | 230 KB（一時悪化） | **62 KB** |
| mean | 171 KB | 252 KB | **151 KB** |

→ overnight の肥大化はスキーマ劣化ではなく、履歴の多い患者へクエリが偏った
**データ依存**だった可能性大。post-fix で概ねベースライン水準に回帰。
ただし **token/400 解消後は本 EP が残コストの 98.7%（7.7 GB/13h, 53,580件×147KB）** ＝ P2 が最優先化。

---

## 2. 根本原因の分類

> ✅ = 2026-05-16 時点で解消済み

| # | 原因 | 種別 | 影響 | 状態 |
|---|---|---|---|---|
| A | self-checkin が **1 コール毎に sign-in/out**（token 非再利用） | アプリ設計 | 全 HTTP の 2/3 がセッション管理。WPE/TLS を圧迫 | ✅ P1 で解消 |
| B | **`cPt_VisitRecord/_find` が太い JSON** | レイアウト/クエリ設計 | 帯域・シリアライズ・FM 評価コスト。post-fix で **7.7 GB/13h（残コスト 98.7%）** | 🔴 未（P2） |
| C | LIFF の 1 操作が **5〜13 直列 API コール** | アプリ設計 | 体感 1〜2.5 秒の遅延 | 未（P3） |
| D | `ClinicReceptionStatus/_find` が **100% FM error 400** | アプリのバグ | 完全に無駄な RTT 2,707 回 | ✅ P4 で解消 |
| E | `ClinicScheduleException/_find` が **100% 0件** かつ Flow B で 4 連発 | アプリ設計 | 無駄 RTT。post-fix でも 52,262 件全 0 件 | 未（P5） |
| F | self-checkin の `>=1s` スパイク（断続） | FM 内部 競合 | 要 Top Call 突合（未取得） | 未 |

**重要**: 残る B/C/E は FM Server を増強しても直らない**クライアント側 API 利用パターンの問題**。
最も費用対効果が高いのはアプリ改修。

### 旧・根本原因表（参考: baseline 時点のスナップショット）

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

### ✅ P1: self-checkin の token プール化 — **完了（2026-05-16）**

**実施前**: `ops/session = 1.000`。`POST /sessions` → 1 find → `DELETE /sessions` を 71,272 回。

**実施内容**: self-checkin 側で Data API token をプール/再利用するよう改修。

**実測結果（post-fix ログ）**:
- `ops/session` 1.00 → **163**（繁忙帯 12–14時は 376–425）
- sign-in 約 **99% 削減**（~44,000/時 → ~150/時）
- sign-out（DELETE）も 73,848/12h → 2,462/13h に激減

→ §1.3 効果測定履歴 参照。狙い通りの効果を確認。

---

### 🔴 P2: `cPt_VisitRecord/_find` のレスポンス縮小 — **現在の最優先**

**現状（post-fix 2026-05-16）**: P1/P4 解消後、本 EP が**残コストの 98.7%**。
post-fix で **53,580 件 × mean 147 KB ≒ 7.7 GB / 13h**（p50 62 KB）。
token/セッション・オーバーヘッドが消えた今、**体感速度の支配項はこの 1 本**。

**対応（要 FM スキーマ調査）**:
1. `_find` が叩いている**レイアウトのフィールド数 / ポータル**を確認
2. API 専用の **slim レイアウト**（必要フィールドのみ、ポータル除外）を作成し、そちらを叩く
3. `limit` を明示（1件で良い用途で全件返っていないか）
4. ポータル行が大量なら `portalData` を必要分に絞る or 別 EP 化
5. FM 22 なら **OData の `$select`** で列指定の読みも検討余地（別途 PoC）

**期待効果**: 147 KB → 数 KB 級。帯域・FM レイアウト評価・JSON 化が 3〜10 倍改善見込み。
これが現状の最大ボトルネックなので、体感速度に最も直結する。

**検証**: `cluster-transactions.mjs` の `cPt_VisitRecord/_find` 行 "mean KB" が劇的に下がること。

> 注: overnight ログで p50 が一時 230 KB に肥大したが post-fix で 62 KB に回帰。
> これはデータ依存（履歴の多い患者）の変動であり、slim 化すれば
> この変動自体も縮小する。

---

### ★★★ P3: LIFF Flow A/B の API 集約（BFF 化）

**現状**: 1 ユーザー操作で 5〜13 本の API を**直列**に叩く（Flow A 22.4%, Flow B 7.3%）。

**対応**:
- LIFF/WebViewer と FM の間に **BFF（同一リージョン）** を置き、画面が必要とするデータを **1 リクエストで返す集約エンドポイント**を作る
- BFF 側で token プール（P1 と共通基盤）
- 段階導入なら、まず Flow A（最頻 22.4%）の 5 コールを 1 集約 API に

**期待効果**: 体感 1〜2.5 秒 → 300〜500ms（直列 RTT を 1 本化 + WAN を BFF 内 LAN 化）。

---

### ✅ P4: `ClinicReceptionStatus/_find` の 400 バグ修正 — **完了（2026-05-16）**

**実施前**: self-checkin で 2,707〜2,917 件、**100% FM error 400**（不正クエリ）。
同レイアウトの `GET .../records?_limit=1&_offset=1` は成功 → 正解パスは GET 側だった。

**実施内容**: 壊れた POST `_find` を、成功している GET `…/records` パスへ統一。

**実測結果（post-fix ログ）**:
- POST `api_ClinicReceptionStatus/_find[err=400]` … **0 件（完全消滅）**
- GET `api_ClinicReceptionStatus/records` … 28,423 件すべて成功（err=0）

→ §1.3 効果測定履歴 参照。無駄 RTT を完全消去。

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

- ~~P4（バグ修正）~~ ✅ **完了（2026-05-16）**
- ~~P1（token プール）~~ ✅ **完了（2026-05-16）**

残りの推奨順:

1. **P2（slim レイアウト）** — 🔴 **最優先**。残コストの 98.7%（7.7 GB/13h）。
   FM スキーマ調査が必要。FM 管理者と連携。体感速度に最も直結
2. **P5（ClinicScheduleException キャッシュ）** — post-fix でも 52,262 件全 0 件の無駄打ち。
   クライアント側短時間キャッシュで RTT 削減。比較的低リスク
3. **P3（BFF 集約）** — LIFF 側の多段直列。P1 の token 基盤を流用して設計
4. **P6/P7／F（>=1s スパイク）** — 上記の効果測定後に再評価。F は Top Call ログ取得が前提

> 各 P の完了判定は必ず `fmdapi.log` 再取得 →
> `cluster-transactions.mjs` で before/after 比較すること。
> 体感ではなく数値（ops/session, mean KB, req/sec, 0件率）で評価する。
> 実績は §1.3 効果測定履歴 に追記していく。
