// 視力検査の選択肢定数。
// VA_TITLES は Exm_VisualAcuity::cal_txtData の prefix 分岐
// (遠見/70cm/近見/40cm/30cm) と一致させる必要あり。
export const VA_TITLES = ['遠見', '近見', '30cm', '40cm', '70cm'];

// 測定眼。B = 両眼（calc では BV = と表示）
export const EYES = ['R', 'L', 'B'];

// 数値視力の刻み（小数点以下は文字列保持）
export const VA_NUMERIC_STEPS = [
  '0.01', '0.02', '0.03', '0.04', '0.05',
  '0.06', '0.07', '0.08', '0.09',
  '0.1', '0.15', '0.2', '0.3', '0.4', '0.5',
  '0.6', '0.7', '0.8', '0.9',
  '1.0', '1.2', '1.5', '2.0',
];

// 特殊値（数値ではない視力）。ラテン語表記で保存値＝表示ラベル。
// 対応：s.l.=sensus luminis(光覚)、m.m.=manus motus(手動)、n.d.=測定不能/指数弁未満
export const VA_SPECIAL = [
  { value: 's.l.+', label: 's.l.+' }, // 光覚弁(+) ≒ LP(+)
  { value: 's.l.-', label: 's.l.-' }, // 光覚弁(-) ≒ LP(-)
  { value: 'm.m.',  label: 'm.m.'  }, // 手動弁    ≒ HM
  { value: 'n.d.',  label: 'n.d.'  }, // 測定不能 / 指数弁未満
];

// 検査条件 (exm_condition フィールド)
// レンズ条件 (KB/CL/IOL) と検査方法 (字ひとつ) を1フィールドに格納
export const EXM_CONDITIONS = ['KB', 'CL', 'IOL', '字ひとつ'];

// よく使うサマリタイトル候補（自由入力可）
export const VA_SUMMARY_TITLE_SUGGESTIONS = [
  '通常検査', '散瞳前', '散瞳後', '矯正前', '矯正後', '術前', '術後', 'CL処方',
];

// 度数の 0.25 D ショートカット小数部
export const DIOPTER_QUICK_FRAC = ['0.25', '0.50', '0.75'];

// レンズ度数の ▲▼ / ↑↓ 1 ステップ（D）
export const DIOPTER_STEP = 0.25;

// 軸の頻出値
export const AXIS_QUICK_VALUES = ['90', '180'];

// VA キーパッドの末尾追記キー
export const VA_APPEND_KEYS = [
  { value: 'p',  label: 'p',  hint: 'partial（弱）' },
  { value: 'cm', label: 'cm', hint: 'HM/CF 認識距離' },
];

// 行モデル：1行 = 明細1レコードに対応
export function makeEmptyRow() {
  return {
    recordId: '',
    __k: '',
    eye: '',
    VA_title: '遠見',
    nakedVA: '',
    correctedVA: '',
    sphericalD: '',
    cylindricalD: '',
    axis: '',
    exm_condition: '',
    comment: '',
    isRepresentativeValue: '',
  };
}

// 度数の正規化：'-2' → '-2.00'、'2' → '+2.00'、'-.5' → '-0.50' 等
export function normalizeDiopter(input) {
  if (input == null) return '';
  const s = String(input).trim();
  if (s === '') return '';
  const m = s.match(/^([+\-]?)(\d*)(?:\.(\d+))?$/);
  if (!m) return s;
  const sign = m[1] === '-' ? '-' : '+';
  const intPart = m[2] === '' ? '0' : m[2];
  const fracPart = (m[3] ?? '').padEnd(2, '0').slice(0, 2);
  return `${sign}${intPart}.${fracPart}`;
}

// 軸の正規化：0..180、空入力は空のまま
export function normalizeAxis(input) {
  if (input == null) return '';
  const s = String(input).trim();
  if (s === '') return '';
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  const clamped = Math.max(0, Math.min(180, Math.round(n)));
  return String(clamped);
}

// 行の表示用1行サマリ（cal_txtData の形式を JS で再現）
export function rowToDisplayLine(row) {
  if (!row) return '';
  const prefix = row.VA_title === '遠見' ? ''
    : row.VA_title === '70cm' ? 'm'
    : (row.VA_title === '近見' || row.VA_title === '40cm' || row.VA_title === '30cm') ? 'N'
    : '';
  const letterX = (!row.sphericalD && !row.cylindricalD) ? '' : ' x ';
  const letterCyl = !row.cylindricalD ? '' : ' =cyl ';
  const letterAx = !row.axis ? '' : ' Ax ';
  const isFar = row.VA_title === '遠見';
  const star = row.isRepresentativeValue === '1' ? '*' : '';
  const naked = row.nakedVA || '';
  const corrected = row.correctedVA || '';
  const cond = row.exm_condition ? ` ${row.exm_condition}` : '';
  const titleSuffix = isFar ? '' : row.VA_title;
  const commentSuffix = row.comment ? ` ${row.comment}` : '';
  const slash = (titleSuffix || commentSuffix) ? ' / ' : '';

  return `${prefix}${row.eye || '?'}V = ${naked}${cond} ( ${corrected}${letterX}${row.sphericalD}${letterCyl}${row.cylindricalD}${letterAx}${row.axis} )${star}${slash}${titleSuffix}${commentSuffix}`;
}

// 行が「空」(全主要項目が未入力) かどうか
export function isRowEmpty(row) {
  return [
    row.eye, row.nakedVA, row.correctedVA,
    row.sphericalD, row.cylindricalD, row.axis,
    row.exm_condition, row.comment,
  ].every((v) => !v || String(v).trim() === '');
}
