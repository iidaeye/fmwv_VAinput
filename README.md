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

`api_Exm_VisualAcuity_Summary` を新規作成（基底 TO 名を `api_Exm_VisualAcuity_Summary` に）。

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
  Set Variable [ $req ; JSONSetElement ( "" ; "layouts" ; "api_Exm_VisualAcuity_Summary" ; JSONString )
                                       & ... ]   // ※ get に layouts と recordId を渡す
  Execute FileMaker Data API [ Action: get ; ... ; Target: $result ]
  Perform JavaScript in Web Viewer [ Object: "VA_WV"
                                   ; Function: "__fmReceiveSummary" ; Param: $result ]
  ```
  最小実装は `Execute FileMaker Data API` の Action `get` でレイアウト
  `api_Exm_VisualAcuity_Summary` から `recordId` を1件取得し、その JSON をそのまま
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
                             ; Layout: "api_Exm_VisualAcuity_Summary"
                             ; Query: $query ; Limit: 1
                             ; Sort: $sort ; Target: $result ]
  Perform JavaScript in Web Viewer [ Object: "VA_WV"
                                   ; Function: "__fmQuoteResult" ; Param: $result ]
  ```

- **`VA: Cancel`** … WebViewer を閉じる／親スクリプトに戻す（任意実装）

### 5. アクセス権

`Execute FileMaker Data API` を使うアカウントの拡張アクセス権で **`fmrest`** を有効化する。
（プライバシセット → 拡張アクセス権 → fmrest にチェック）

## FM への配布（更新手順）

`src/` を変更したら、以下で稼働中の FileMaker ファイルへ反映する。
WebViewer 本体（バンドル HTML）と FM スクリプトは **別経路** で配布する点に注意。
git push だけではどちらも FM には反映されない。

### A. WebViewer バンドルの配布

1. ビルド
   ```sh
   npm run build        # = node build/build.mjs
   ```
   `build/index.bundle.html` が再生成される。出力末尾の
   `built: ... ( NNNNN bytes )` のバイト数を控えておくと貼り付け後の照合に使える。
2. `build/index.bundle.html` をテキストエディタで開き、**全文をコピー**
   （先頭 `<!doctype html>` 〜 末尾 `</html>`）。
3. FileMaker で `globals::g_VA_WebViewerHTML`（テキスト型／グローバル保管）を
   **全選択して削除 → 貼り付け** で全置換する。部分置換は事故のもと。
   グローバルフィールドなので任意の 1 レコードで編集すれば全体に反映される。
4. `VA: Open WebViewer` を実行し、WebViewer が起動してキーパッドが描画され、
   今回の変更（例：度数パッドの ▲▼ ボタン）が見た目に出ているか目視確認する。
   WebViewer には DevTools がないため、確認は画面表示と実操作で行う。
5. バンドルは `.gitignore` 対象でリポジトリ管理外。**どの commit のソースから
   生成したか**（コミットハッシュ＋日付）を貼り付け時にメモしておくと、
   後で挙動差分を追える。

### B. FM スクリプトの配布

`fm/scripts/*.xml` はスクリプト本体。`fm/README.md` の手順どおり、各 XML を
コピー → FileMaker のスクリプトワークスペースに貼り付け → 保存（Cmd+S）。
各スクリプト先頭の `Version:` コメントがリポジトリ最新と一致しているか必ず確認する。
スキーマやレイアウト構成を変えた場合は「FileMaker 側 セットアップ」の該当節も再適用する。

### 配布チェックリスト

- [ ] `npm run build` 実行済み（最新ソースを反映）
- [ ] `g_VA_WebViewerHTML` を全文置換で更新
- [ ] 変更したスクリプト XML を再ペースト＋保存（`Version:` 一致を確認）
- [ ] `VA: Open WebViewer` で起動し、変更点を目視確認
- [ ] 貼り付け元コミット（ハッシュ／日付）を記録

## WebViewer ↔ FM の JSON

### 保存（WebViewer → FM `VA: Save`）

create:
```json
{
  "mode": "create",
  "summary": {
    "layout": "api_Exm_VisualAcuity_Summary",
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
    "layout": "api_Exm_VisualAcuity_Summary",
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
