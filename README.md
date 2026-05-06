# 視力入力 WebViewer (FileMaker)

眼科電子カルテの FileMaker ファイルに、Windows タッチパネル PC（タッチ／マウス／テンキー併用）から
視力検査結果を効率よく入力する WebViewer ベース UI。

データは `Exm_VisualAcuity_Summary`（サマリ）と `Exm_VisualAcuity`（明細）の2層構造に対し、
**FileMaker Data API スクリプトステップ互換の JSON** を `FileMaker.PerformScript()` 1回呼び出しで一括 upsert する。

## ディレクトリ

```
src/                   開発用ソース
  index.html           UI コンテナ + window.__fmInit プレースホルダ
  css/app.css          タッチ最適化スタイル
  js/app.js            UI 状態管理・キーパッド・引用・保存
  js/va-values.js      VA 刻み・S/C/Ax 定数・行モデル・正規化
  js/json-schema.js    Data API ペイロード生成 / GET レスポンス解析
  js/fm-bridge.js      PerformScript ラッパ + コールバック
dev/standalone.html    ブラウザ単体検証ハーネス（FM ブリッジをモック）
build/build.mjs        単一HTMLバンドラ（CSS/JS をインライン化）
build/index.bundle.html FM 取り込み用シングルファイル（生成物）
```

## ビルド

```sh
node build/build.mjs
```

`build/index.bundle.html` が生成される（`.gitignore` 対象）。

## ブラウザ単体検証

```sh
python3 -m http.server 8080
# → http://localhost:8080/dev/standalone.html
```

`dev/standalone.html` は `window.__fmMock` で `VA: Save` / `VA: Quote Latest` の応答をシミュレートする。

## FileMaker 側 セットアップ

### 1. スキーマ前提

| 項目 | 状態 |
| --- | --- |
| `Exm_VisualAcuity_Summary` | 既存テーブル |
| `Exm_VisualAcuity` | 既存テーブル |
| リレーション `Summary::__k = Detail::_fk_Exm_VisualAcuity_Summary` | 既存。**「このリレーションシップを使用してこのテーブルにレコードの作成を許可」を ON** にする |
| `isTypicalValue` → `isRepresentativeValue` リネーム | **要実施**（明細・サマリ両方） |

### 2. API 専用レイアウト

`API_VA_Summary` を新規作成（基底 TO は `Exm_VisualAcuity_Summary`）。

- 配置フィールド：`__k`, `_fk_ptID`, `VASummaryTitle`, `visualAcuitySummary`, `authorName`,
  `isRepresentativeValue`, `timeOfRecord`, `cal_txtData`
- ポータル（TO `_Exm_VisualAcuity`、オブジェクト名 `VA_Detail_Portal`）に以下を配置：
  `__k`, `eye`, `VA_title`, `nakedVA`, `correctedVA`, `sphericalD`, `cylindricalD`, `axis`,
  `exm_condition`, `comment`, `isRepresentativeValue`, `cal_txtData`

### 3. グローバル/定数フィールド

`globals::g_VA_WebViewerHTML`（テキスト型 / グローバル保管）に
`build/index.bundle.html` の中身を貼り付ける。

ビルド後、起動スクリプト内で `Substitute` を使って `/*FM_INIT_JSON*/` プレースホルダを実 JSON に
置換してから WebViewer に読み込ませる。

### 4. スクリプト

- **`VA: Open WebViewer ( ptID ; summaryRecordId ; mode )`**
  ```
  Set Variable [ $html ; globals::g_VA_WebViewerHTML ]
  Set Variable [ $init ; "{\"ptID\":\"" & $ptID & "\",\"summaryRecordId\":\""
                & $summaryRecordId & "\",\"mode\":\"" & $mode
                & "\",\"authorName\":\"" & Get(AccountName) & "\"}" ]
  Set Variable [ $html ; Substitute ( $html ; "/*FM_INIT_JSON*/" ; $init ) ]
  Set Variable [ $url ; "data:text/html;charset=utf-8," & GetAsURLEncoded ( $html ) ]
  Set Web Viewer [ Object Name: "VA_WV" ; URL: $url ]
  ```

- **`VA: Load Summary ( recordId )`**
  ```
  Set Variable [ $req ; JSONSetElement ( "" ; "layouts" ; "API_VA_Summary" ; JSONString )
                                       & ... ]   // ※ get に layouts と recordId を渡す
  Execute FileMaker Data API [ Action: get ; ... ; Target: $result ]
  Perform JavaScript in Web Viewer [ Object: "VA_WV"
                                   ; Function: "__fmReceiveSummary" ; Param: $result ]
  ```
  最小実装は `Execute FileMaker Data API` の Action `get` でレイアウト
  `API_VA_Summary` から `recordId` を1件取得し、その JSON をそのまま
  `__fmReceiveSummary` に渡す。

- **`VA: Save ( payload )`**
  ```
  Set Variable [ $payload ; Get(ScriptParameter) ]
  Set Variable [ $mode ; JSONGetElement ( $payload ; "mode" ) ]
  If [ $mode = "create" ]
    Execute FileMaker Data API [ Action: create
                               ; Layout: JSONGetElement ( $payload ; "summary.layout" )
                               ; Body: JSONGetElement ( $payload ; "summary.request" )
                               ; Target: $result ]
  Else
    Execute FileMaker Data API [ Action: update
                               ; Layout: JSONGetElement ( $payload ; "summary.layout" )
                               ; recordId: JSONGetElement ( $payload ; "summary.recordId" )
                               ; Body: JSONGetElement ( $payload ; "summary.request" )
                               ; Target: $result ]
  End If
  Perform JavaScript in Web Viewer [ Object: "VA_WV"
                                   ; Function: "__fmSaveResult" ; Param: $result ]
  ```

- **`VA: Quote Latest ( ptID )`**
  ```
  // findRecords で _fk_ptID = $ptID を timeOfRecord 降順で1件取得
  Execute FileMaker Data API [ Action: findRecords
                             ; Layout: "API_VA_Summary"
                             ; Query: $query ; Limit: 1
                             ; Sort: $sort ; Target: $result ]
  Perform JavaScript in Web Viewer [ Object: "VA_WV"
                                   ; Function: "__fmQuoteResult" ; Param: $result ]
  ```

- **`VA: Cancel`** … WebViewer を閉じる／親スクリプトに戻す（任意実装）

### 5. アクセス権

`Execute FileMaker Data API` を使うアカウントの拡張アクセス権で **`fmrest`** を有効化する。
（プライバシセット → 拡張アクセス権 → fmrest にチェック）

## WebViewer ↔ FM の JSON

### 保存（WebViewer → FM `VA: Save`）

create:
```json
{
  "mode": "create",
  "summary": {
    "layout": "API_VA_Summary",
    "request": {
      "fieldData": {
        "_fk_ptID": "12345",
        "VASummaryTitle": "通常検査",
        "visualAcuitySummary": "",
        "authorName": "山田",
        "isRepresentativeValue": ""
      },
      "portalData": {
        "VA_Detail_Portal": [
          { "Exm_VisualAcuity::eye": "R", "Exm_VisualAcuity::VA_title": "遠見",
            "Exm_VisualAcuity::nakedVA": "0.7", "Exm_VisualAcuity::correctedVA": "0.9",
            "Exm_VisualAcuity::sphericalD": "-2.00", "Exm_VisualAcuity::cylindricalD": "-0.50",
            "Exm_VisualAcuity::axis": "180", "Exm_VisualAcuity::exm_condition": "",
            "Exm_VisualAcuity::comment": "", "Exm_VisualAcuity::isRepresentativeValue": "1" }
        ]
      }
    }
  }
}
```

update:
```json
{
  "mode": "update",
  "summary": {
    "layout": "API_VA_Summary",
    "recordId": "1234",
    "request": {
      "fieldData": { "VASummaryTitle": "再検査" },
      "portalData": {
        "VA_Detail_Portal": [
          { "recordId": "5678", "Exm_VisualAcuity::nakedVA": "0.8" },
          { "Exm_VisualAcuity::eye": "L", "Exm_VisualAcuity::VA_title": "遠見", "Exm_VisualAcuity::nakedVA": "0.9" }
        ]
      },
      "deleteRelated": ["VA_Detail_Portal.7777"]
    }
  }
}
```

### ロード（FM → WebViewer `__fmReceiveSummary`）

`Execute FileMaker Data API` の `get` レスポンスをそのまま渡す：
```json
{
  "data": [{
    "recordId": "1234",
    "fieldData": { ...サマリ各フィールド... },
    "portalData": {
      "VA_Detail_Portal": [
        { "recordId": "5678", "Exm_VisualAcuity::eye": "R", "...": "..." }
      ]
    }
  }]
}
```

## v1 で未対応の項目

- 履歴検索ダイアログ（v1.1）
- 他検査テーブルからの S/C/Ax 引用（v1.2）
- `exm_condition` / `VASummaryTitle` の値リスト確定
- PD・装用レンズの保存先確定
