import {
  VA_TITLES, EYES, VA_SPECIAL,
  EXM_CONDITIONS, VA_SUMMARY_TITLE_SUGGESTIONS,
  DIOPTER_QUICK_FRAC, AXIS_QUICK_VALUES, VA_APPEND_KEYS,
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
  const span = document.createElement('span');
  span.className = 'val';
  span.textContent = state.draft.exm_condition || '—';
  wrap.appendChild(span);
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

function makeKey(label, onClick, opts = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'keypad-key' + (opts.cls ? ` ${opts.cls}` : '');
  b.textContent = label;
  if (opts.title) b.title = opts.title;
  if (opts.eye) b.dataset.eye = opts.eye;
  b.addEventListener('click', (ev) => {
    ev.preventDefault();
    onClick();
  });
  return b;
}

function buildEyePad() {
  const wrap = document.createElement('div');
  wrap.className = 'pad-eye';
  for (const eye of EYES) {
    const label = eye === 'R' ? 'R（右）' : eye === 'L' ? 'L（左）' : 'B（両眼）';
    wrap.appendChild(makeKey(label, () => {
      state.draft.eye = eye;
      advanceCol();
    }, { cls: `key-eye-${eye}`, eye }));
  }
  return wrap;
}

function buildTitlePad() {
  const wrap = document.createElement('div');
  wrap.className = 'pad-title';
  for (const t of VA_TITLES) {
    wrap.appendChild(makeKey(t, () => {
      state.draft.VA_title = t;
      advanceCol();
    }));
  }
  return wrap;
}

function buildConditionPad() {
  const wrap = document.createElement('div');
  wrap.className = 'pad-condition';
  wrap.appendChild(makeKey('（なし）', () => {
    state.draft.exm_condition = '';
    advanceCol();
  }, { cls: 'key-clear' }));
  for (const c of EXM_CONDITIONS) {
    wrap.appendChild(makeKey(c, () => {
      state.draft.exm_condition = c;
      advanceCol();
    }));
  }
  return wrap;
}

function buildVAPad(col) {
  const wrap = document.createElement('div');
  wrap.className = 'pad-va';

  // 左：特殊値
  const special = document.createElement('div');
  special.className = 'pad-va-special';
  for (const s of VA_SPECIAL) {
    special.appendChild(makeKey(s.label, () => {
      state.draft[col] = s.value;
      renderForm();
      renderKeypad();
    }, { cls: 'key-special', title: s.value }));
  }
  wrap.appendChild(special);

  // 中央：テンキー
  const num = document.createElement('div');
  num.className = 'pad-va-num';
  const rows = [['7','8','9'], ['4','5','6'], ['1','2','3']];
  for (const r of rows) {
    const div = document.createElement('div');
    div.className = 'pad-row';
    for (const d of r) div.appendChild(makeKey(d, () => appendChar(col, d)));
    num.appendChild(div);
  }
  const last = document.createElement('div');
  last.className = 'pad-row';
  last.appendChild(makeKey('0.', () => insertText(col, '0.', { mode: 'replace' })));
  last.appendChild(makeKey('0', () => appendChar(col, '0')));
  last.appendChild(makeKey('.', () => appendChar(col, '.')));
  last.appendChild(makeKey('.0', () => insertText(col, '.0', { mode: 'append' })));
  num.appendChild(last);

  // 末尾追記キー（partial / cm 距離）+ ⌫ + clear
  const appendRow = document.createElement('div');
  appendRow.className = 'pad-row';
  for (const k of VA_APPEND_KEYS) {
    appendRow.appendChild(makeKey(k.label, () => insertText(col, k.value, { mode: 'append' }),
      { cls: 'key-append', title: k.hint }));
  }
  appendRow.appendChild(makeKey('⌫', () => backspace(col), { cls: 'key-back' }));
  appendRow.appendChild(makeKey('clear', () => setVal(col, ''), { cls: 'key-clear' }));
  num.appendChild(appendRow);
  wrap.appendChild(num);

  // 右：Enter
  const ctrl = document.createElement('div');
  ctrl.className = 'pad-va-ctrl';
  ctrl.appendChild(makeKey('Enter', () => advanceCol(), { cls: 'key-enter' }));
  wrap.appendChild(ctrl);

  return wrap;
}

function buildDiopterPad(col) {
  const wrap = document.createElement('div');
  wrap.className = 'pad-diopter';

  // 左：符号
  const sign = document.createElement('div');
  sign.className = 'pad-diopter-sign';
  sign.appendChild(makeKey('+', () => setSign(col, '+'), { cls: 'key-sign' }));
  sign.appendChild(makeKey('−', () => setSign(col, '-'), { cls: 'key-sign' }));
  wrap.appendChild(sign);

  // 中央：テンキー
  const num = document.createElement('div');
  num.className = 'pad-diopter-num';
  const rows = [['7','8','9'], ['4','5','6'], ['1','2','3']];
  for (const r of rows) {
    const div = document.createElement('div');
    div.className = 'pad-row';
    for (const d of r) div.appendChild(makeKey(d, () => appendIntDigit(col, d)));
    num.appendChild(div);
  }
  const last = document.createElement('div');
  last.className = 'pad-row';
  last.appendChild(makeKey('0', () => appendIntDigit(col, '0')));
  last.appendChild(makeKey('.', () => appendChar(col, '.')));
  last.appendChild(makeKey('.0', () => setFraction(col, '00')));
  last.appendChild(makeKey('⌫', () => backspace(col), { cls: 'key-back' }));
  num.appendChild(last);
  wrap.appendChild(num);

  // 右1：0.25 / 0.50 / 0.75 ショートカット + clear
  const frac = document.createElement('div');
  frac.className = 'pad-diopter-frac';
  for (const f of DIOPTER_QUICK_FRAC) {
    frac.appendChild(makeKey(f, () => setFraction(col, f.split('.')[1]), { cls: 'key-frac' }));
  }
  frac.appendChild(makeKey('clear', () => setVal(col, ''), { cls: 'key-clear' }));
  wrap.appendChild(frac);

  // 右2：Enter
  const ctrl = document.createElement('div');
  ctrl.className = 'pad-diopter-ctrl';
  ctrl.appendChild(makeKey('Enter', () => {
    state.draft[col] = normalizeDiopter(state.draft[col]);
    advanceCol();
  }, { cls: 'key-enter' }));
  wrap.appendChild(ctrl);

  return wrap;
}

function buildAxisPad() {
  const col = 'axis';
  const wrap = document.createElement('div');
  wrap.className = 'pad-axis';

  // 左：頻出値
  const quick = document.createElement('div');
  quick.className = 'pad-axis-quick';
  for (const v of AXIS_QUICK_VALUES) {
    quick.appendChild(makeKey(v, () => {
      state.draft[col] = v;
      renderForm();
      renderKeypad();
    }, { cls: 'key-quick' }));
  }
  wrap.appendChild(quick);

  // 中央：テンキー
  const num = document.createElement('div');
  num.className = 'pad-axis-num';
  const rows = [['7','8','9'], ['4','5','6'], ['1','2','3']];
  for (const r of rows) {
    const div = document.createElement('div');
    div.className = 'pad-row';
    for (const d of r) div.appendChild(makeKey(d, () => appendChar(col, d)));
    num.appendChild(div);
  }
  const last = document.createElement('div');
  last.className = 'pad-row';
  last.appendChild(makeKey('0', () => appendChar(col, '0')));
  last.appendChild(makeKey('⌫', () => backspace(col), { cls: 'key-back' }));
  last.appendChild(makeKey('clear', () => setVal(col, ''), { cls: 'key-clear' }));
  num.appendChild(last);
  wrap.appendChild(num);

  // 右：Enter
  const ctrl = document.createElement('div');
  ctrl.className = 'pad-axis-ctrl';
  ctrl.appendChild(makeKey('Enter', () => {
    state.draft[col] = normalizeAxis(state.draft[col]);
    advanceCol();
  }, { cls: 'key-enter' }));
  wrap.appendChild(ctrl);

  return wrap;
}

// =================== セル値操作 ===================

function setVal(col, v) {
  state.draft[col] = v;
  renderForm();
  renderKeypad();
}

function appendChar(col, ch) {
  const cur = state.draft[col] ?? '';
  state.draft[col] = cur + ch;
  renderForm();
  renderKeypad();
}

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

function appendIntDigit(col, digit) {
  const cur = state.draft[col] ?? '';
  state.draft[col] = cur + digit;
  renderForm();
  renderKeypad();
}

function setFraction(col, frac) {
  let cur = state.draft[col] ?? '';
  cur = cur.replace(/\.\d*$/, '').replace(/\.$/, '');
  if (cur === '' || cur === '+' || cur === '-') cur += '0';
  state.draft[col] = `${cur}.${frac}`;
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
  }
  if (/^[0-9.]$/.test(ev.key)) {
    ev.preventDefault();
    appendChar(col, ev.key);
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
  const initData = fm.getInit();
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
