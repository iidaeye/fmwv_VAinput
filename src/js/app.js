import {
  VA_TITLES, EYES, VA_SPECIAL,
  EXM_CONDITIONS, VA_SUMMARY_TITLE_SUGGESTIONS,
  DIOPTER_QUICK_FRAC, DIOPTER_STEP, AXIS_QUICK_VALUES, VA_APPEND_KEYS,
  makeEmptyRow, normalizeDiopter, normalizeAxis,
  rowToDisplayLine, isRowEmpty,
} from './va-values.js';
import {
  buildSavePayload, parseLoadResponse, rowsForQuote,
} from './json-schema.js';
import * as fm from './fm-bridge.js';

// 入力フォームの列順（Enter / 自動進行用）
const COLUMNS = ['eye', 'VA_title', 'nakedVA', 'exm_condition',
  'correctedVA', 'sphericalD', 'cylindricalD', 'axis'];

const COLUMN_LABEL = {
  eye: '測定眼', VA_title: 'タイトル', nakedVA: '裸眼視力',
  exm_condition: '検査条件', correctedVA: '矯正視力',
  sphericalD: '球面度数', cylindricalD: '円柱度数', axis: '乱視軸',
};

const state = {
  mode: 'create',
  summary: {
    recordId: '',
    _fk_ptID: '',
    patientName: '',
    VASummaryTitle: '',
    visualAcuitySummary: '',
    authorName: '',
    isRepresentativeValue: '',
    timeOfRecord: '',
    originalDetailRecordIds: [],
  },
  // 登録済み行リスト
  rows: [],
  // 入力フォームの編集中行
  draft: makeEmptyRow(),
  // 編集モード: -1 = 新規、>=0 = 既存rowsの該当indexを編集中
  editingIdx: -1,
  // 直近に挿入／編集していた行 idx（次の新規追加位置の基準）
  lastFocusedRow: -1,
  // フォーカス中の列（キーパッドのコンテキスト切替）
  activeCol: 'eye',
};

const $ = (sel, root = document) => root.querySelector(sel);

function setStatus(msg, type = 'info') {
  const el = $('#status');
  el.textContent = msg;
  el.dataset.type = type;
}

function formatNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// =================== ヘッダ ===================

function renderHeader() {
  $('#patientId').textContent = state.summary._fk_ptID || '—';
  $('#patientName').textContent = state.summary.patientName || '';
  $('#summaryTitle').value = state.summary.VASummaryTitle || '';
  $('#authorName').value = state.summary.authorName || '';
  $('#summaryComment').value = state.summary.visualAcuitySummary || '';
  $('#timeOfRecord').textContent = state.summary.timeOfRecord || formatNow();

  const list = $('#summaryTitleSuggestions');
  list.innerHTML = '';
  for (const t of VA_SUMMARY_TITLE_SUGGESTIONS) {
    const opt = document.createElement('option');
    opt.value = t;
    list.appendChild(opt);
  }
}

// =================== 入力フォーム ===================

function renderForm() {
  // 編集モードのインジケータ
  const indicator = $('#formMode');
  indicator.textContent = state.editingIdx === -1 ? '新規入力' : `行 #${state.editingIdx + 1} を更新中`;
  indicator.dataset.mode = state.editingIdx === -1 ? 'new' : 'edit';

  // 登録ボタンのラベル
  $('#btnRegister').textContent = state.editingIdx === -1 ? '登録 ＋' : '更新 ✓';

  // 各セル
  renderFormCell('eye', renderEyeCell);
  renderFormCell('VA_title', renderTitleCell);
  renderFormCell('nakedVA', renderTextCell);
  renderFormCell('exm_condition', renderConditionCell);
  renderFormCell('correctedVA', renderTextCell);
  renderFormCell('sphericalD', renderTextCell);
  renderFormCell('cylindricalD', renderTextCell);
  renderFormCell('axis', renderTextCell);

  // 代表値トグル
  const rep = $('#btnRep');
  const isRep = state.draft.isRepresentativeValue === '1';
  rep.textContent = isRep ? '★ 代表' : '☆ 代表';
  rep.classList.toggle('on', isRep);

  // 行コメント
  $('#rowComment').value = state.draft.comment || '';

  // 全体の眼カラーテーマ
  $('#form').dataset.eye = state.draft.eye || '';
}

function renderFormCell(col, fn) {
  const wrap = $(`#cell-${col}`);
  wrap.innerHTML = '';
  wrap.classList.toggle('cell-active', state.activeCol === col);
  wrap.dataset.col = col;
  fn(wrap, col);
}

function renderEyeCell(wrap) {
  const v = state.draft.eye || '';
  const span = document.createElement('span');
  span.className = 'val val-eye';
  span.dataset.eye = v;
  span.textContent = v || '—';
  wrap.appendChild(span);
}

function renderTitleCell(wrap) {
  const span = document.createElement('span');
  span.className = 'val';
  span.textContent = state.draft.VA_title || '—';
  wrap.appendChild(span);
}

function renderConditionCell(wrap) {
  const raw = state.draft.exm_condition || '';
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    const span = document.createElement('span');
    span.className = 'val';
    span.textContent = '—';
    wrap.appendChild(span);
    return;
  }
  const list = document.createElement('div');
  list.className = 'val val-list';
  for (const p of parts) {
    const item = document.createElement('div');
    item.className = 'val-list-item';
    item.textContent = p;
    list.appendChild(item);
  }
  wrap.appendChild(list);
}

function renderTextCell(wrap, col) {
  const span = document.createElement('span');
  span.className = 'val';
  span.textContent = state.draft[col] || '—';
  wrap.appendChild(span);
}

function activateCol(col) {
  state.activeCol = col;
  renderForm();
  renderKeypad();
}

// =================== 登録済み行リスト ===================

function renderRows() {
  const tbody = $('#rowsBody');
  tbody.innerHTML = '';
  if (state.rows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'rows-empty';
    td.textContent = '（まだ登録された行はありません）';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  state.rows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    tr.dataset.idx = String(idx);
    tr.dataset.eye = row.eye || '';
    if (idx === state.editingIdx) tr.classList.add('row-editing');
    if (idx === state.lastFocusedRow) tr.classList.add('row-focused');

    const tdNo = document.createElement('td');
    tdNo.className = 'col-no';
    tdNo.textContent = `#${idx + 1}`;
    tr.appendChild(tdNo);

    const tdLine = document.createElement('td');
    tdLine.className = 'col-line';
    tdLine.textContent = rowToDisplayLine(row);
    tr.appendChild(tdLine);

    const tdRep = document.createElement('td');
    tdRep.className = 'col-rep';
    tdRep.textContent = row.isRepresentativeValue === '1' ? '★' : '';
    tr.appendChild(tdRep);

    const tdActions = document.createElement('td');
    tdActions.className = 'col-actions';
    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'btn-edit';
    btnEdit.textContent = '編集';
    btnEdit.addEventListener('click', (ev) => { ev.stopPropagation(); loadRowToForm(idx); });
    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.className = 'btn-delete';
    btnDel.textContent = '×';
    btnDel.title = '行削除';
    btnDel.addEventListener('click', (ev) => { ev.stopPropagation(); deleteRow(idx); });
    tdActions.appendChild(btnEdit);
    tdActions.appendChild(btnDel);
    tr.appendChild(tdActions);

    tr.addEventListener('click', () => {
      state.lastFocusedRow = idx;
      renderRows();
    });
    tr.addEventListener('dblclick', () => loadRowToForm(idx));

    tbody.appendChild(tr);
  });
}

function loadRowToForm(idx) {
  const row = state.rows[idx];
  if (!row) return;
  state.draft = { ...row };
  state.editingIdx = idx;
  state.lastFocusedRow = idx;
  state.activeCol = 'eye';
  renderForm();
  renderRows();
  renderKeypad();
}

function deleteRow(idx) {
  if (!confirm(`行 #${idx + 1} を削除しますか？`)) return;
  state.rows.splice(idx, 1);
  if (state.editingIdx === idx) {
    resetForm();
    renderForm();
  } else if (state.editingIdx > idx) {
    state.editingIdx -= 1;
  }
  if (state.lastFocusedRow >= state.rows.length) {
    state.lastFocusedRow = state.rows.length - 1;
  }
  renderRows();
  renderForm();
}

function onRegister() {
  const draft = state.draft;
  if (!draft.eye) {
    setStatus('測定眼を選択してください', 'warn');
    activateCol('eye');
    return;
  }
  if (isRowEmpty(draft)) {
    setStatus('値が未入力です', 'warn');
    return;
  }

  if (state.editingIdx === -1) {
    // 新規追加：フォーカス行（直近に編集／クリックした行）の直下に挿入
    const insertAt = (state.lastFocusedRow >= 0 && state.lastFocusedRow < state.rows.length)
      ? state.lastFocusedRow + 1
      : state.rows.length;
    state.rows.splice(insertAt, 0, { ...draft });
    state.lastFocusedRow = insertAt;
    setStatus(`行 #${insertAt + 1} を登録しました`, 'ok');
  } else {
    state.rows[state.editingIdx] = { ...draft };
    state.lastFocusedRow = state.editingIdx;
    setStatus(`行 #${state.editingIdx + 1} を更新しました`, 'ok');
  }
  resetForm();
  renderRows();
  renderForm();
  renderKeypad();
}

function resetForm() {
  // 連続入力のサポート：直前の eye / VA_title / exm_condition は引き継ぐ。
  // R を入れた直後は L、L の直後は R を提案。
  const prevEye = state.draft.eye;
  const nextEye = prevEye === 'R' ? 'L' : prevEye === 'L' ? 'R' : '';
  const keepTitle = state.draft.VA_title || '遠見';
  const keepCond = state.draft.exm_condition || '';

  state.draft = { ...makeEmptyRow(), eye: nextEye, VA_title: keepTitle, exm_condition: keepCond };
  state.editingIdx = -1;
  state.activeCol = nextEye ? 'nakedVA' : 'eye';
}

// =================== キーパッド ===================

function renderKeypad() {
  const pad = $('#keypad');
  pad.innerHTML = '';
  const col = state.activeCol;

  const hint = document.createElement('div');
  hint.className = 'keypad-hint';
  hint.textContent = COLUMN_LABEL[col] || col;
  const cur = document.createElement('span');
  cur.className = 'keypad-current';
  cur.dataset.eye = state.draft.eye || '';
  cur.textContent = state.draft[col] || '—';
  hint.appendChild(cur);
  pad.appendChild(hint);

  if (col === 'eye') pad.appendChild(buildEyePad());
  else if (col === 'VA_title') pad.appendChild(buildTitlePad());
  else if (col === 'exm_condition') pad.appendChild(buildConditionPad());
  else if (col === 'nakedVA' || col === 'correctedVA') pad.appendChild(buildVAPad(col));
  else if (col === 'sphericalD' || col === 'cylindricalD') pad.appendChild(buildDiopterPad(col));
  else if (col === 'axis') pad.appendChild(buildAxisPad());
}

// 全キーパッドで共通の固定グリッド (7列 × 4行)。ボタンサイズ／位置は同一。
// 各行・列の物理位置を覚えやすくするため、数字 7-9/4-6/1-3/0,.の位置は全パッド固定。

function pos(row, col, rowSpan = 1, colSpan = 1) {
  return {
    gridRow: `${row} / span ${rowSpan}`,
    gridColumn: `${col} / span ${colSpan}`,
  };
}

function makeKey(label, onClick, opts = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'keypad-key' + (opts.cls ? ` ${opts.cls}` : '');
  b.textContent = label;
  if (opts.title) b.title = opts.title;
  if (opts.eye) b.dataset.eye = opts.eye;
  if (opts.pos) {
    b.style.gridRow = opts.pos.gridRow;
    b.style.gridColumn = opts.pos.gridColumn;
  }
  b.addEventListener('click', (ev) => {
    ev.preventDefault();
    onClick();
  });
  return b;
}

// 数字テンキー (cols 4-6, rows 1-4) を全パッド共通で配置
function appendNumpad(grid, col) {
  const layout = [
    ['7', 1, 4], ['8', 1, 5], ['9', 1, 6],
    ['4', 2, 4], ['5', 2, 5], ['6', 2, 6],
    ['1', 3, 4], ['2', 3, 5], ['3', 3, 6],
    ['0', 4, 4],
  ];
  for (const [d, r, c] of layout) {
    grid.appendChild(makeKey(d, () => appendDigit(col, d), { pos: pos(r, c) }));
  }
  grid.appendChild(makeKey('.', () => appendDot(col), { pos: pos(4, 5) }));
  grid.appendChild(makeKey('⌫', () => backspace(col), { cls: 'key-back', pos: pos(4, 6) }));
}

// 右端の clear / Enter (col 7) を共通配置
function appendClearEnter(grid, col, onEnter) {
  grid.appendChild(makeKey('clear', () => setVal(col, ''), { cls: 'key-clear', pos: pos(1, 7) }));
  grid.appendChild(makeKey('Enter', onEnter, { cls: 'key-enter', pos: pos(2, 7, 3) }));
}

function newPadGrid() {
  const g = document.createElement('div');
  g.className = 'keypad-grid';
  return g;
}

function buildEyePad() {
  const grid = newPadGrid();
  // R/L/B を col 1, rows 1-3 に縦並び
  grid.appendChild(makeKey('R', () => { state.draft.eye = 'R'; advanceCol(); },
    { cls: 'key-eye-R', eye: 'R', pos: pos(1, 1) }));
  grid.appendChild(makeKey('L', () => { state.draft.eye = 'L'; advanceCol(); },
    { cls: 'key-eye-L', eye: 'L', pos: pos(2, 1) }));
  grid.appendChild(makeKey('B', () => { state.draft.eye = 'B'; advanceCol(); },
    { cls: 'key-eye-B', eye: 'B', pos: pos(3, 1) }));
  appendClearEnter(grid, 'eye', () => advanceCol());
  return grid;
}

function buildTitlePad() {
  const grid = newPadGrid();
  // 遠見 (1,1)、近見 (2,1)、30/40/70cm (2,2-4) の FM 既存配置
  grid.appendChild(makeKey('遠見', () => { state.draft.VA_title = '遠見'; advanceCol(); }, { pos: pos(1, 1) }));
  grid.appendChild(makeKey('近見', () => { state.draft.VA_title = '近見'; advanceCol(); }, { pos: pos(2, 1) }));
  grid.appendChild(makeKey('30cm', () => { state.draft.VA_title = '30cm'; advanceCol(); }, { pos: pos(2, 2) }));
  grid.appendChild(makeKey('40cm', () => { state.draft.VA_title = '40cm'; advanceCol(); }, { pos: pos(2, 3) }));
  grid.appendChild(makeKey('70cm', () => { state.draft.VA_title = '70cm'; advanceCol(); }, { pos: pos(2, 4) }));
  appendClearEnter(grid, 'VA_title', () => advanceCol());
  return grid;
}

// exm_condition は複数選択可（カンマ区切り）。トグルで追加／削除し、表示順は EXM_CONDITIONS 準拠。
function toggleCondition(value) {
  const cur = String(state.draft.exm_condition || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const has = cur.includes(value);
  const next = has ? cur.filter((v) => v !== value) : [...cur, value];
  // EXM_CONDITIONS の順序で並べ直して安定化
  const sorted = EXM_CONDITIONS.filter((c) => next.includes(c));
  state.draft.exm_condition = sorted.join(',');
  renderForm();
  renderKeypad();
}

function isConditionSelected(value) {
  return String(state.draft.exm_condition || '')
    .split(',').map((s) => s.trim()).includes(value);
}

function buildConditionPad() {
  const grid = newPadGrid();
  // KB/CL/IOL/字ひとつ を col 1 縦並び（トグル方式・複数選択 OK）
  // タップでオン／オフ切替。確定は Enter でないと次セルへ進まない。
  EXM_CONDITIONS.forEach((c, i) => {
    const on = isConditionSelected(c);
    grid.appendChild(makeKey(c, () => toggleCondition(c), {
      cls: on ? 'key-cond-on' : 'key-cond',
      pos: pos(i + 1, 1),
    }));
  });
  // 「なし」: 全クリア
  grid.appendChild(makeKey('なし', () => {
    state.draft.exm_condition = '';
    renderForm();
    renderKeypad();
  }, { cls: 'key-clear', pos: pos(1, 7) }));
  // Enter: 次セルへ
  grid.appendChild(makeKey('Enter', () => advanceCol(), { cls: 'key-enter', pos: pos(2, 7, 3) }));
  return grid;
}

function buildVAPad(col) {
  const grid = newPadGrid();
  // 特殊値 cols 1-2, rows 1-2 (4値: s.l.+/s.l.-/m.m./n.d.)
  const specials = [
    { v: 's.l.+', r: 1, c: 1 },
    { v: 's.l.-', r: 1, c: 2 },
    { v: 'm.m.',  r: 2, c: 1 },
    { v: 'n.d.',  r: 2, c: 2 },
  ];
  for (const s of specials) {
    grid.appendChild(makeKey(s.v, () => setVal(col, s.v), { cls: 'key-special', pos: pos(s.r, s.c) }));
  }
  // 小数点ショートカット col 3
  grid.appendChild(makeKey('0.', () => applyDecimalShortcut(col, 'zerodot'),
    { cls: 'key-shortcut', title: '整数部を 0 に置換', pos: pos(1, 3) }));
  grid.appendChild(makeKey('.0', () => applyDecimalShortcut(col, 'dotzero'),
    { cls: 'key-shortcut', title: '小数部を 0 に置換', pos: pos(2, 3) }));
  // 末尾追記キー (partial / cm)
  grid.appendChild(makeKey('p', () => insertText(col, 'p', { mode: 'append' }),
    { cls: 'key-append', title: 'partial（弱）', pos: pos(3, 3) }));
  grid.appendChild(makeKey('cm', () => insertText(col, 'cm', { mode: 'append' }),
    { cls: 'key-append', title: 'HM/CF 認識距離', pos: pos(4, 3) }));
  // テンキー + clear/Enter
  appendNumpad(grid, col);
  appendClearEnter(grid, col, () => advanceCol());
  return grid;
}

// 度数を delta D ずつ増減（レンズ度数の ▲▼ / ↑↓ 用）。空欄は 0 起点。
// 整数の cents で計算し浮動小数誤差を回避、出力は normalizeDiopter と同じ ±N.NN。
function bumpDiopter(col, delta) {
  const cur = parseFloat(state.draft[col]);
  const base = Number.isFinite(cur) ? cur : 0;
  const cents = Math.round((base + delta) * 100);
  const clamped = Math.max(-3000, Math.min(3000, cents)); // ±30.00 D で頭打ち
  const sign = clamped < 0 ? '-' : '+';
  const abs = Math.abs(clamped);
  const intPart = Math.floor(abs / 100);
  const fracPart = String(abs % 100).padStart(2, '0');
  state.draft[col] = `${sign}${intPart}.${fracPart}`;
  renderForm();
  renderKeypad();
}

function buildDiopterPad(col) {
  const grid = newPadGrid();
  // 符号 col 1, rows 1-2
  grid.appendChild(makeKey('+', () => setSign(col, '+'), { cls: 'key-sign', pos: pos(1, 1) }));
  grid.appendChild(makeKey('−', () => setSign(col, '-'), { cls: 'key-sign', pos: pos(2, 1) }));
  // 0.25 ステップ ▲▼（キーボード ↑↓ と同機能）col 2
  grid.appendChild(makeKey('▲', () => bumpDiopter(col, +DIOPTER_STEP),
    { cls: 'key-step', title: '0.25 上げる（↑キー）', pos: pos(1, 2, 2) }));
  grid.appendChild(makeKey('▼', () => bumpDiopter(col, -DIOPTER_STEP),
    { cls: 'key-step', title: '0.25 下げる（↓キー）', pos: pos(3, 2, 2) }));
  // 0.25 / 0.50 / 0.75 / .0 ショートカット col 3
  grid.appendChild(makeKey('0.25', () => applyDecimalShortcut(col, 'frac25'), { cls: 'key-frac', pos: pos(1, 3) }));
  grid.appendChild(makeKey('0.50', () => applyDecimalShortcut(col, 'frac50'), { cls: 'key-frac', pos: pos(2, 3) }));
  grid.appendChild(makeKey('0.75', () => applyDecimalShortcut(col, 'frac75'), { cls: 'key-frac', pos: pos(3, 3) }));
  grid.appendChild(makeKey('.0',   () => applyDecimalShortcut(col, 'dotzero'), { cls: 'key-shortcut', pos: pos(4, 3) }));
  // テンキー + clear/Enter
  appendNumpad(grid, col);
  appendClearEnter(grid, col, () => {
    state.draft[col] = normalizeDiopter(state.draft[col]);
    advanceCol();
  });
  return grid;
}

// 軸を delta 度ずつ増減（クロスシリンダー調整用）。180° で循環、0° は 180° として表示。
function bumpAxis(delta) {
  const cur = parseInt(state.draft.axis, 10);
  const base = Number.isFinite(cur) ? cur : 0;
  let next = (base + delta) % 180;
  if (next < 0) next += 180;
  if (next === 0) next = 180; // 0 は使わず 180 表記に統一
  state.draft.axis = String(next);
  renderForm();
  renderKeypad();
}

function buildAxisPad() {
  const col = 'axis';
  const grid = newPadGrid();
  // +5 / -5（クロスシリンダー調整用、180° 循環）col 1, rows 1-2
  grid.appendChild(makeKey('+5', () => bumpAxis(+5), { cls: 'key-bump', title: '軸を +5°（180° 循環）', pos: pos(1, 1) }));
  grid.appendChild(makeKey('−5', () => bumpAxis(-5), { cls: 'key-bump', title: '軸を -5°（180° 循環）', pos: pos(2, 1) }));
  // 90 / 180 頻出値 col 1, rows 3-4
  grid.appendChild(makeKey('90',  () => setVal(col, '90'),  { cls: 'key-quick', pos: pos(3, 1) }));
  grid.appendChild(makeKey('180', () => setVal(col, '180'), { cls: 'key-quick', pos: pos(4, 1) }));
  // テンキー + clear/Enter（符号なし）
  appendNumpad(grid, col);
  appendClearEnter(grid, col, () => {
    state.draft[col] = normalizeAxis(state.draft[col]);
    advanceCol();
  });
  return grid;
}

// =================== セル値操作 ===================

function setVal(col, v) {
  state.draft[col] = v;
  renderForm();
  renderKeypad();
}

// 数値セルのパース：sign / int / hasDot / frac に分解。
// 純粋な数値文字列以外（s.l.+ 等）は parts==null を返す。
function parseNumeric(value) {
  const s = String(value ?? '');
  const m = s.match(/^([+\-]?)(\d*)(\.(\d*))?$/);
  if (!m) return null;
  return {
    sign: m[1] || '',
    int:  m[2] || '',
    hasDot: !!m[3],
    frac: m[4] || '',
  };
}

function buildNumeric({ sign, int, hasDot, frac }) {
  return sign + int + (hasDot ? '.' + frac : '');
}

// 数字キー：単純に末尾追加。小数点が既にあるかどうかで自動的に整数部 / 小数部に積まれる。
function appendDigit(col, digit) {
  const cur = state.draft[col] ?? '';
  state.draft[col] = cur + digit;
  renderForm();
  renderKeypad();
}

// 小数点キー：1値に1つだけ。既に '.' があれば無視。
function appendDot(col) {
  const cur = state.draft[col] ?? '';
  if (cur.includes('.')) return;
  state.draft[col] = cur + '.';
  renderForm();
  renderKeypad();
}

// 任意テキストの追記／置換（p / cm / 0. などの自由形式に使用）
function insertText(col, text, opts = {}) {
  const cur = state.draft[col] ?? '';
  if (opts.mode === 'replace' || cur === '') {
    state.draft[col] = text;
  } else {
    state.draft[col] = cur + text;
  }
  renderForm();
  renderKeypad();
}

function backspace(col) {
  state.draft[col] = (state.draft[col] ?? '').slice(0, -1);
  renderForm();
  renderKeypad();
}

function setSign(col, sign) {
  const cur = (state.draft[col] ?? '').replace(/^[+\-]/, '');
  state.draft[col] = sign + cur;
  renderForm();
  renderKeypad();
}

// 小数点ショートカット：小数点を境に整数部 or 小数部を置換し、'.' は常に1つに保つ。
//   'zerodot'  ：'0.' ボタン  → 整数部を '0' に置換、小数部は維持（無ければ空）
//   'dotzero'  ：'.0' ボタン  → 小数部を '0' に置換、整数部は維持（無ければ '0'）
//   'frac25/50/75' ：度数の小数部を '25/50/75' に置換、整数部は維持（無ければ '0'）
function applyDecimalShortcut(col, kind) {
  const parts = parseNumeric(state.draft[col]) || { sign: '', int: '', hasDot: false, frac: '' };
  let { sign, int, hasDot, frac } = parts;

  switch (kind) {
    case 'zerodot':
      int = '0';
      hasDot = true;
      // frac は維持
      break;
    case 'dotzero':
      if (!int) int = '0';
      hasDot = true;
      frac = '0';
      break;
    case 'frac25':
      if (!int) int = '0';
      hasDot = true;
      frac = '25';
      break;
    case 'frac50':
      if (!int) int = '0';
      hasDot = true;
      frac = '50';
      break;
    case 'frac75':
      if (!int) int = '0';
      hasDot = true;
      frac = '75';
      break;
  }
  state.draft[col] = buildNumeric({ sign, int, hasDot, frac });
  renderForm();
  renderKeypad();
}

function advanceCol() {
  const cur = state.activeCol;
  if (cur === 'sphericalD' || cur === 'cylindricalD') {
    state.draft[cur] = normalizeDiopter(state.draft[cur]);
  } else if (cur === 'axis') {
    state.draft[cur] = normalizeAxis(state.draft[cur]);
  }
  const i = COLUMNS.indexOf(cur);
  if (i === -1 || i === COLUMNS.length - 1) {
    $('#btnRegister').focus();
    renderForm();
    renderKeypad();
    return;
  }
  state.activeCol = COLUMNS[i + 1];
  renderForm();
  renderKeypad();
}

// =================== 物理キーボード ===================

document.addEventListener('keydown', (ev) => {
  const tag = (ev.target?.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  const col = state.activeCol;
  if (ev.key === 'Tab') {
    ev.preventDefault();
    if (ev.shiftKey) {
      const i = COLUMNS.indexOf(col);
      if (i > 0) activateCol(COLUMNS[i - 1]);
    } else {
      advanceCol();
    }
    return;
  }
  if (ev.key === 'Enter') {
    if (ev.metaKey || ev.ctrlKey) {
      ev.preventDefault();
      onRegister();
    } else {
      ev.preventDefault();
      advanceCol();
    }
    return;
  }
  if (ev.key === 'Backspace') {
    ev.preventDefault();
    backspace(col);
    return;
  }
  if (col === 'sphericalD' || col === 'cylindricalD') {
    if (ev.key === '+' || ev.key === '-') {
      ev.preventDefault();
      setSign(col, ev.key);
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      bumpDiopter(col, +DIOPTER_STEP);
      return;
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      bumpDiopter(col, -DIOPTER_STEP);
      return;
    }
  }
  if (ev.key === '.') {
    ev.preventDefault();
    appendDot(col);
    return;
  }
  if (/^[0-9]$/.test(ev.key)) {
    ev.preventDefault();
    appendDigit(col, ev.key);
  }
});

// =================== バインド ===================

function bindHeader() {
  $('#summaryTitle').addEventListener('input', (e) => {
    state.summary.VASummaryTitle = e.target.value;
  });
  $('#authorName').addEventListener('input', (e) => {
    state.summary.authorName = e.target.value;
  });
  $('#summaryComment').addEventListener('input', (e) => {
    state.summary.visualAcuitySummary = e.target.value;
  });
  $('#rowComment').addEventListener('input', (e) => {
    state.draft.comment = e.target.value;
  });
  $('#btnRep').addEventListener('click', () => {
    state.draft.isRepresentativeValue =
      state.draft.isRepresentativeValue === '1' ? '' : '1';
    renderForm();
  });

  $('#btnRegister').addEventListener('click', onRegister);
  $('#btnRegisterCancel').addEventListener('click', () => {
    resetForm();
    renderForm();
    renderKeypad();
  });
  $('#btnQuoteLatest').addEventListener('click', onQuoteLatest);
  $('#btnSave').addEventListener('click', onSave);
  $('#btnCancel').addEventListener('click', onCancel);

  for (const col of COLUMNS) {
    const el = $(`#cell-${col}`);
    if (el) el.addEventListener('click', () => activateCol(col));
  }
}

async function onQuoteLatest() {
  if (!state.summary._fk_ptID) {
    setStatus('患者ID 未設定のため引用できません', 'warn');
    return;
  }
  setStatus('引用元を取得中…');
  try {
    const res = await fm.quoteLatest(state.summary._fk_ptID);
    const parsed = parseLoadResponse(res);
    const newRows = rowsForQuote(parsed.rows);
    if (newRows.length === 0) {
      setStatus('引用できるデータがありません', 'warn');
      return;
    }
    state.rows.push(...newRows);
    renderRows();
    setStatus(`${newRows.length} 件を引用しました`, 'ok');
  } catch (err) {
    setStatus('引用に失敗: ' + err.message, 'error');
  }
}

async function onSave() {
  if (!isRowEmpty(state.draft)) {
    if (!confirm('入力中の行が未登録です。登録せず保存に進みますか？')) {
      return;
    }
  }
  if (state.rows.length === 0) {
    setStatus('保存対象の行がありません', 'warn');
    return;
  }
  const btn = $('#btnSave');
  if (btn.disabled) return; // 二度押し防止
  btn.disabled = true;
  const payload = buildSavePayload(state);
  setStatus('保存中…');
  try {
    const res = await fm.saveSummary(payload);
    const ok = !(res?.messages?.[0]?.code) || res.messages[0].code === '0';
    if (ok) {
      setStatus('保存しました', 'ok');
    } else {
      const m = res.messages[0];
      setStatus(`保存エラー: [${m.code}] ${m.message}`, 'error');
    }
  } catch (err) {
    setStatus('保存に失敗: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function onCancel() {
  if (!confirm('編集内容を破棄して閉じますか？')) return;
  if (window.FileMaker?.PerformScript) {
    window.FileMaker.PerformScript('VA: Cancel', '');
  }
}

// =================== 起動 ===================

async function init() {
  // FM 経由のとき：window.FileMaker の準備を待って "VA: WebViewer Ready" を投げ、
  // FM 側のコールバックで __fmSetInit が呼ばれる。
  // standalone / data:URL 方式では既に window.__fmInit が埋まっているので即進む。
  if (fm.isInFileMaker()) {
    setStatus('FileMaker 接続待ち…');
    fm.notifyReady();
  }
  const initData = await fm.waitForInit();

  state.mode = initData.mode || 'create';
  state.summary._fk_ptID = String(initData.ptID ?? '');
  state.summary.authorName = initData.authorName ?? '';
  state.summary.patientName = initData.patientName ?? '';

  if (state.mode === 'update' && initData.summaryRecordId) {
    setStatus('既存サマリ読み込み中…');
    try {
      const res = await fm.loadSummary(initData.summaryRecordId);
      const parsed = parseLoadResponse(res);
      state.summary = { ...state.summary, ...parsed.summary };
      state.rows = parsed.rows;
      setStatus(`既存 ${state.rows.length} 件を読み込みました`, 'ok');
    } catch (err) {
      setStatus('読み込み失敗: ' + err.message, 'error');
    }
  } else {
    setStatus('新規入力');
  }

  state.activeCol = 'eye';
  bindHeader();
  renderHeader();
  renderForm();
  renderRows();
  renderKeypad();
}

init();
