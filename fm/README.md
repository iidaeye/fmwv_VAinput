# FileMaker 側の準備

WebViewer と連携するために、FM 側で以下を作成します。

## 1. フィールドのリネーム（既存）

既存の `isTypicalValue` を `isRepresentativeValue` に変更。両テーブルとも：

- `Exm_VisualAcuity::isTypicalValue` → `isRepresentativeValue`
- `Exm_VisualAcuity_Summary::isTypicalValue` → `isRepresentativeValue`

`Exm_VisualAcuity::cal_txtData` の計算式は FM がフィールド改名を自動追従しますが、念のため目視確認してください。

## 2. リレーション

`Exm_VisualAcuity_Summary` ↔ `Exm_VisualAcuity` のリレーションを：

- マッチ: `Exm_VisualAcuity_Summary::__k = Exm_VisualAcuity::_fk_Exm_VisualAcuity_Summary`
- リレーション設定で **「このリレーションシップを使用してこのテーブルにレコードの作成を許可」を ON**（明細側）
- TO 名（Summary 側から見た明細 TO）は `_Exm_VisualAcuity` を想定（既存の `cal_txtData` 計算が `List ( _Exm_VisualAcuity::cal_txtData )` を参照しているため）

## 3. API 専用レイアウト `API_VA_Summary`

新規レイアウト作成、ベース TO は `Exm_VisualAcuity_Summary`。

### 配置するフィールド
- `__k`
- `_fk_ptID`
- `VASummaryTitle`
- `visualAcuitySummary`
- `authorName`
- `isRepresentativeValue`
- `timeOfRecord`
- `cal_txtData`
- `isActive`

### ポータル
- TO: `_Exm_VisualAcuity` （Summary から見た明細 TO）
- **ポータル オブジェクト名: `VA_Detail_Portal`**（インスペクタ「位置」タブで設定）
- ポータル行に配置するフィールド：
  - `__k`
  - `eye`
  - `VA_title`
  - `nakedVA`
  - `correctedVA`
  - `sphericalD`
  - `cylindricalD`
  - `axis`
  - `exm_condition`
  - `comment`
  - `isRepresentativeValue`
  - `cal_txtData`

このレイアウトは `Execute FileMaker Data API` ステップの `layouts` 引数に指定されます（実際にユーザーが画面で見るレイアウトではない）。

## 4. WebViewer を配置するレイアウト

カルテ等の任意レイアウトに WebViewer を配置：

- **オブジェクト名: `VA_WebViewer`**（インスペクタ「位置」タブ）
- Web アドレス: 計算式で固定値（最初は GitHub Pages の URL でテスト）
  ```
  "https://iidaeye.github.io/fmwv_VAinput/src/index.html"
  ```
  → 実運用では data:URL（後述のグローバル HTML）に切り替え

## 5. グローバル HTML 格納（実運用時）

WebViewer のソースを患者カルテに data:URL で埋め込むため、HTML 全体（CSS/JS インライン化済み）を保持するグローバル/定数フィールドを作成：

- フィールド名: `globals::g_VA_WebViewerHTML`（テーブル `globals`、Text 型、グローバル指定）
- 値: ビルド後の HTML 文字列（後段で `build/build.mjs` で生成予定）。

開発初期は GitHub Pages 直接読み込みで OK。実運用へ移行時にこのグローバル方式に切替。

## 6. アカウント拡張アクセス権

`Execute FileMaker Data API` スクリプトステップの利用には、アカウントの拡張アクセス権で **`fmrest`** が ON である必要があります（ファイル → 管理 → セキュリティ → 拡張アクセス権）。

---

# 4 つのスクリプト

`fm/scripts/` 以下のファイルを FM スクリプトワークスペースで「ペースト」：

1. **`va-open-webviewer.xml`** … `VA: Open WebViewer ( ptID ; summaryId? )`
2. **`va-load-summary.xml`** … `VA: Load Summary ( recordId )`
3. **`va-save.xml`** … `VA: Save ( payload )`
4. **`va-quote-latest.xml`** … `VA: Quote Latest ( ptID )`

## ペースト手順

1. FM Pro でファイルを開き、**スクリプト → スクリプトワークスペース** を表示
2. 新規スクリプトを作成、上記の名前に
3. `va-XXX.xml` の中身（`<?xml ...>` から `</fmxmlsnippet>` まで）を **クリップボードにコピー**
4. スクリプトワークスペースのステップ領域に **ペースト**（Cmd/Ctrl + V）
5. **全ステップが自動展開**されます（プレースホルダなし、コメント / Set Variable / If / Execute FileMaker Data API / Set Web Viewer / Perform JavaScript in Web Viewer / Show Custom Dialog すべて実ステップ）

## 使用ステップ ID

| ステップ名 | id | 状態 |
|---|---|---|
| `# (comment)` | 89 | ✅ |
| `Perform Script` | 1 | ✅ |
| `Set Variable` | 141 | ✅ |
| `Set Field` | 76 | ✅ |
| `If` / `Else` / `End If` | 68 / 69 / 70 | ✅ |
| `Exit Script` | 103 | ✅ |
| `Insert Text` | 61 | ✅ |
| `Show Custom Dialog` | 87 | ✅ |
| `Set Web Viewer` | **146** | ✅ |
| `Perform JavaScript in Web Viewer` | **175** | ✅ |
| `Execute FileMaker Data API` | **203** | ✅ |

## デバッグダイアログ

各スクリプトには Show Custom Dialog ステップが **無効状態（enable="False"）** で組み込まれています。動作確認時に有効化すると、Data API リクエストとレスポンスの中身が確認できます。完成後は無効のまま or 削除。

---

# テスト手順

## (a) 単体テスト：WebViewer だけ動かす
GitHub Pages の URL `https://iidaeye.github.io/fmwv_VAinput/dev/standalone.html` でブラウザ確認（FM ブリッジは mock）。

## (b) FM 結合：Open → Load → Save の最小フロー
1. 任意の患者レイアウトに WebViewer を配置（オブジェクト名 `VA_WebViewer`）
2. ボタンに `VA: Open WebViewer` を割り当て、引数 `JSONSetElement( "" ; "ptID"; 患者ID; JSONString )`
3. WebViewer が表示されたら値を入れて「保存」
4. `Exm_VisualAcuity_Summary` と関連 `Exm_VisualAcuity` レコードができていることを確認
5. 同じ患者で再度 Open（編集モード、`summaryId` 指定）→ `VA: Load Summary` が呼ばれて UI に既存値が読まれること

## (c) 引用テスト
WebViewer の「引用 ↻」ボタン → `VA: Quote Latest` が呼ばれて直前サマリの明細が UI に追加されること。
