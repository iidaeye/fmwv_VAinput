// 視力検査の選択肢定数。
// VA_TITLES は Exm_VisualAcuity::cal_txtData の prefix 分岐
// (遠見/70cm/近見/40cm/30cm) と一致させる必要あり。
export const VA_TITLES = ['遠見', '70cm', '近見', '40cm', '30cm'];

export const EYES = ['R', 'L'];

// 数値視力の刻み（小数点以下は文字列保持）
export const VA_NUMERIC_STEPS = [
  '0.01', '0.02', '0.03', '0.04', '0.05',
  '0.06', '0.07', '0.08', '0.09',
  '0.1', '0.15', '0.2', '0.3', '0.4', '0.5',
  '0.6', '0.7', '0.8', '0.9',
  '1.0', '1.2', '1.5', '2.0',
];

// 特殊値（数値ではない視力）
export const VA_SPECIAL = [
  { value: 'n.d.',  label: 'n.d.'  },
  { value: 'CF',    label: '指数弁' },
  { value: 'HM',    label: '手動弁' },
  { value: 'LP(+)', label: '光覚(+)' },
  { value: 'LP(-)', label: '光覚(-)' },
];

// 検査条件（要ユーザー確認、これは初期値）
export const EXM_CONDITIONS = [
  { value: '',      label: '(なし)' },
  { value: 'p.h.',  label: 'p.h.'   },
  { value: 'sc',    label: 'sc'     },
  { value: 'cc',    label: 'cc'     },
  { value: 'CL',    label: 'CL'     },
  { value: 'mydr',  label: '散瞳後'  },
];

// よく使うサマリタイトル候補（自由入力可）
export const VA_SUMMARY_TITLE_SUGGESTIONS = [
  '通常検査', '散瞳前', '散瞳後', '矯正後', '術前', '術後',
];

// S/C 度数の刻み（0.25 D）
export const DIOPTER_STEP = 0.25;
export const DIOPTER_MIN = -30;
export const DIOPTER_MAX = 30;

// Ax の範囲
export const AXIS_MIN = 0;
export const AXIS_MAX = 180;

// 行モデル：1行 = 明細1レコードに対応
export function makeEmptyRow() {
  return {
    recordId: '',                  // FM 内部 recordId（既存行のみ）
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

// 標準テンプレート：両眼遠見（裸眼+矯正）4行
export function templateDistance() {
  return [
    { ...makeEmptyRow(), eye: 'R', VA_title: '遠見' },
    { ...makeEmptyRow(), eye: 'L', VA_title: '遠見' },
  ];
}

// 標準テンプレート：両眼近見 2行
export function templateNear() {
  return [
    { ...makeEmptyRow(), eye: 'R', VA_title: '近見' },
    { ...makeEmptyRow(), eye: 'L', VA_title: '近見' },
  ];
}

export function templateFull() {
  return [...templateDistance(), ...templateNear()];
}

// 度数の正規化：'-2' → '-2.00'、'2' → '+2.00'、'-.5' → '-0.50' 等
export function normalizeDiopter(input) {
  if (input == null) return '';
  const s = String(input).trim();
  if (s === '') return '';
  const m = s.match(/^([+\-]?)(\d*)(?:\.(\d+))?$/);
  if (!m) return s; // 数値以外はそのまま
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
  const clamped = Math.max(AXIS_MIN, Math.min(AXIS_MAX, Math.round(n)));
  return String(clamped);
}
