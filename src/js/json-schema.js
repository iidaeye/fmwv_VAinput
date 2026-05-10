// FileMaker Data API 互換ペイロードの生成・パース
// FM 側 `Execute FileMaker Data API` スクリプトステップにそのまま投入できる構造を作る。

const SUMMARY_LAYOUT = 'api_Exm_VisualAcuity_Summary';
const PORTAL_NAME = 'VA_Detail_Portal';
// Summary レイアウトに置かれた portal が参照する TO 名。
// FM 側でリレーション TO を `_Exm_VisualAcuity`（アンダースコア付き）にする運用なので、
// portalData / fieldData のキーも一字一句この名前で送る必要がある。
// ベース TO 名 `Exm_VisualAcuity` ではなく、Summary 側から見た関連 TO 名であることに注意。
const DETAIL_TO = '_Exm_VisualAcuity';

// fieldData 用にすべて文字列化（数値は "12345" でも FM 側で型変換される）
function s(v) {
  if (v == null) return '';
  return String(v);
}

// 行が空かどうか（保存前のフィルタ用）
export function isRowEmpty(row) {
  return [
    row.eye, row.nakedVA, row.correctedVA,
    row.sphericalD, row.cylindricalD, row.axis,
    row.exm_condition, row.comment,
  ].every((v) => !v || String(v).trim() === '');
}

function rowToPortalEntry(row) {
  const entry = {
    [`${DETAIL_TO}::eye`]: s(row.eye),
    [`${DETAIL_TO}::VA_title`]: s(row.VA_title),
    [`${DETAIL_TO}::nakedVA`]: s(row.nakedVA),
    [`${DETAIL_TO}::correctedVA`]: s(row.correctedVA),
    [`${DETAIL_TO}::sphericalD`]: s(row.sphericalD),
    [`${DETAIL_TO}::cylindricalD`]: s(row.cylindricalD),
    [`${DETAIL_TO}::axis`]: s(row.axis),
    [`${DETAIL_TO}::exm_condition`]: s(row.exm_condition),
    [`${DETAIL_TO}::comment`]: s(row.comment),
    [`${DETAIL_TO}::isRepresentativeValue`]: s(row.isRepresentativeValue),
  };
  if (row.recordId) entry.recordId = s(row.recordId);
  return entry;
}

// 状態オブジェクト → Data API リクエストボディ
//
// state = {
//   mode: 'create' | 'update',
//   summary: { recordId, _fk_ptID, VASummaryTitle, visualAcuitySummary,
//              authorName, isRepresentativeValue, originalDetailRecordIds: [] },
//   rows: [ ...rowModel ],
// }
export function buildSavePayload(state) {
  const summaryFieldData = {
    _fk_ptID: s(state.summary._fk_ptID),
    VASummaryTitle: s(state.summary.VASummaryTitle),
    visualAcuitySummary: s(state.summary.visualAcuitySummary),
    authorName: s(state.summary.authorName),
    isRepresentativeValue: s(state.summary.isRepresentativeValue),
  };

  const liveRows = state.rows.filter((r) => !isRowEmpty(r));
  const portalRows = liveRows.map(rowToPortalEntry);

  const request = {
    fieldData: summaryFieldData,
    portalData: { [PORTAL_NAME]: portalRows },
  };

  if (state.mode === 'update') {
    // 編集前にあった明細のうち、現在の rows に含まれない recordId は削除対象
    const liveIds = new Set(
      liveRows.map((r) => r.recordId).filter((id) => id),
    );
    const original = state.summary.originalDetailRecordIds ?? [];
    const deletedIds = original.filter((id) => !liveIds.has(id));
    if (deletedIds.length > 0) {
      request.deleteRelated = deletedIds.map((id) => `${PORTAL_NAME}.${id}`);
    }
    return {
      mode: 'update',
      summary: {
        layout: SUMMARY_LAYOUT,
        recordId: s(state.summary.recordId),
        request,
      },
    };
  }

  return {
    mode: 'create',
    summary: {
      layout: SUMMARY_LAYOUT,
      request,
    },
  };
}

// FM Data API GET レスポンス → 内部状態
//
// response = { data: [{ recordId, fieldData, portalData }] }
export function parseLoadResponse(response) {
  const rec = response?.data?.[0];
  if (!rec) {
    throw new Error('Load response is empty');
  }
  const fd = rec.fieldData ?? {};
  const portalRows = rec.portalData?.[PORTAL_NAME] ?? [];

  const summary = {
    recordId: s(rec.recordId),
    __k: s(fd['__k']),
    _fk_ptID: s(fd['_fk_ptID']),
    VASummaryTitle: s(fd['VASummaryTitle']),
    visualAcuitySummary: s(fd['visualAcuitySummary']),
    authorName: s(fd['authorName']),
    isRepresentativeValue: s(fd['isRepresentativeValue']),
    timeOfRecord: s(fd['timeOfRecord']),
    originalDetailRecordIds: portalRows.map((p) => s(p.recordId)),
  };

  const rows = portalRows.map((p) => ({
    recordId: s(p.recordId),
    eye: s(p[`${DETAIL_TO}::eye`]),
    VA_title: s(p[`${DETAIL_TO}::VA_title`]),
    nakedVA: s(p[`${DETAIL_TO}::nakedVA`]),
    correctedVA: s(p[`${DETAIL_TO}::correctedVA`]),
    sphericalD: s(p[`${DETAIL_TO}::sphericalD`]),
    cylindricalD: s(p[`${DETAIL_TO}::cylindricalD`]),
    axis: s(p[`${DETAIL_TO}::axis`]),
    exm_condition: s(p[`${DETAIL_TO}::exm_condition`]),
    comment: s(p[`${DETAIL_TO}::comment`]),
    isRepresentativeValue: s(p[`${DETAIL_TO}::isRepresentativeValue`]),
  }));

  return { summary, rows };
}

// 引用：FM から受け取った行群を、recordId / __k を空にした「新規行」として返す
export function rowsForQuote(loadedRows) {
  return loadedRows.map((r) => ({ ...r, recordId: '' }));
}
