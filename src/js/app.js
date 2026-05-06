import {
  VA_TITLES, EYES, VA_NUMERIC_STEPS, VA_SPECIAL,
  EXM_CONDITIONS, VA_SUMMARY_TITLE_SUGGESTIONS,
  makeEmptyRow, templateDistance, templateNear, templateFull,
  normalizeDiopter, normalizeAxis,
} from './va-values.js';
import {
  buildSavePayload, parseLoadResponse, rowsForQuote, isRowEmpty,
} from './json-schema.js';
import * as fm from './fm-bridge.js';

const COLS = ['eye', 'VA_title', 'nakedVA', 'exm_condition',
  'correctedVA', 'sphericalD', 'cylindricalD', 'axis'];

const state = {
  mode: 'create',
  summary: {
    recordId: '',
    _fk_ptID: '',
    VASummaryTitle: '通常検査',
    visualAcuitySummary: '',
    authorName: '',
    isRepresentativeValue: '',
    originalDetailRecordIds: [],
  },
  rows: [],
  active: { rowIdx: 0, col: 'nakedVA' },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function setStatus(msg, type = 'info') {
  const el = $('#status');
  el.textContent = msg;
  el.dataset.type = type;
}

// --- レンダリング ---

function renderHeader() {
  $('#patientId').textContent = state.summary._fk_ptID || '—';
  $('#summaryTitle').value = state.summary.VASummaryTitle;
  $('#authorName').value = state.summary.authorName;
  $('#summaryComment').value = state.summary.visualAcuitySummary;
  const titleList = $('#summaryTitleSuggestions');
  titleList.innerHTML = '';
  VA_SUMMARY_TITLE_SUGGESTIONS.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    titleList.appendChild(opt);
  });
}

function renderRows() {
  const tbody = $('#rowsBody');
  tbody.innerHTML = '';
  state.rows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    tr.dataset.idx = String(idx);
    if (idx === state.active.rowIdx) tr.classList.add('row-active');

    tr.appendChild(buildSelectCell(idx, 'eye', row.eye, EYES));
    tr.appendChild(buildSelectCell(idx, 'VA_title', row.VA_title, VA_TITLES));
    tr.appendChild(buildTextCell(idx, 'nakedVA', row.nakedVA));
    tr.appendChild(buildSelectCell(
      idx, 'exm_condition', row.exm_condition,
      EXM_CONDITIONS.map((c) => c.value),
      EXM_CONDITIONS.map((c) => c.label),
    ));
    tr.appendChild(buildTextCell(idx, 'correctedVA', row.correctedVA));
    tr.appendChild(buildTextCell(idx, 'sphericalD', row.sphericalD));
    tr.appendChild(buildTextCell(idx, 'cylindricalD', row.cylindricalD));
    tr.appendChild(buildTextCell(idx, 'axis', row.axis));
    tr.appendChild(buildRepCell(idx, row.isRepresentativeValue));
    tr.appendChild(buildDeleteCell(idx));
    tbody.appendChild(tr);
  });
  renderKeypad();
}

function buildSelectCell(idx, col, value, options, labels) {
  const td = document.createElement('td');
  td.className = `cell cell-${col}`;
  const sel = document.createElement('select');
  options.forEach((opt, i) => {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = labels ? labels[i] : opt;
    if (opt === value) o.selected = true;
    sel.appendChild(o);
  });
  if (!options.includes(value)) {
    const o = document.createElement('option');
    o.value = value; o.textContent = value || '(空)'; o.selected = true;
    sel.insertBefore(o, sel.firstChild);
  }
  sel.addEventListener('change', () => {
    state.rows[idx][col] = sel.value;
    activateCell(idx, col);
  });
  sel.addEventListener('focus', () => activateCell(idx, col));
  td.appendChild(sel);
  return td;
}

function buildTextCell(idx, col, value) {
  const td = document.createElement('td');
  td.className = `cell cell-${col}`;
  if (state.active.rowIdx === idx && state.active.col === col) {
    td.classList.add('cell-active');
  }
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.inputMode = (col === 'axis') ? 'numeric' : 'decimal';
  inp.value = value ?? '';
  inp.addEventListener('focus', () => activateCell(idx, col));
  inp.addEventListener('input', () => {
    state.rows[idx][col] = inp.value;
  });
  inp.addEventListener('blur', () => {
    if (col === 'sphericalD' || col === 'cylindricalD') {
      state.rows[idx][col] = normalizeDiopter(inp.value);
    } else if (col === 'axis') {
      state.rows[idx][col] = normalizeAxis(inp.value);
    }
    inp.value = state.rows[idx][col];
  });
  td.appendChild(inp);
  return td;
}

function buildRepCell(idx, value) {
  const td = document.createElement('td');
  td.className = 'cell cell-rep';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-rep' + (value === '1' ? ' on' : '');
  btn.textContent = value === '1' ? '★' : '☆';
  btn.title = '代表値';
  btn.addEventListener('click', () => {
    state.rows[idx].isRepresentativeValue =
      state.rows[idx].isRepresentativeValue === '1' ? '' : '1';
    renderRows();
  });
  td.appendChild(btn);
  return td;
}

function buildDeleteCell(idx) {
  const td = document.createElement('td');
  td.className = 'cell cell-delete';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-delete';
  btn.textContent = '×';
  btn.title = '行削除';
  btn.addEventListener('click', () => {
    state.rows.splice(idx, 1);
    if (state.active.rowIdx >= state.rows.length) {
      state.active.rowIdx = Math.max(0, state.rows.length - 1);
    }
    renderRows();
  });
  td.appendChild(btn);
  return td;
}

function activateCell(rowIdx, col) {
  state.active = { rowIdx, col };
  renderRows();
}

// --- キーパッド ---

function renderKeypad() {
  const pad = $('#keypad');
  pad.innerHTML = '';
  const col = state.active.col;
  const hint = document.createElement('div');
  hint.className = 'keypad-hint';
  hint.textContent = `行 ${state.active.rowIdx + 1} / ${columnLabel(col)}`;
  pad.appendChild(hint);

  if (col === 'nakedVA' || col === 'correctedVA') {
    pad.appendChild(buildVAKeypad(col));
  } else if (col === 'sphericalD' || col === 'cylindricalD') {
    pad.appendChild(buildDiopterKeypad(col));
  } else if (col === 'axis') {
    pad.appendChild(buildNumericKeypad(col, /*allowSign*/ false, /*allowDot*/ false));
  } else {
    const empty = document.createElement('div');
    empty.className = 'keypad-empty';
    empty.textContent = 'このセルにキーパッドはありません';
    pad.appendChild(empty);
  }
}

function columnLabel(col) {
  return ({
    eye: '眼', VA_title: '区分', nakedVA: '裸眼視力',
    exm_condition: '条件', correctedVA: '矯正視力',
    sphericalD: 'S 球面', cylindricalD: 'C 円柱', axis: 'Ax 軸',
  })[col] ?? col;
}

function buildVAKeypad(col) {
  const wrap = document.createElement('div');
  wrap.className = 'keypad-va';

  const special = document.createElement('div');
  special.className = 'keypad-row keypad-special';
  VA_SPECIAL.forEach((s) => {
    special.appendChild(makeKey(s.label, () => setActiveValue(col, s.value)));
  });
  wrap.appendChild(special);

  const grid = document.createElement('div');
  grid.className = 'keypad-grid';
  VA_NUMERIC_STEPS.forEach((v) => {
    grid.appendChild(makeKey(v, () => setActiveValue(col, v)));
  });
  wrap.appendChild(grid);

  const ctrl = document.createElement('div');
  ctrl.className = 'keypad-row keypad-ctrl';
  ctrl.appendChild(makeKey('CLR', () => setActiveValue(col, '')));
  wrap.appendChild(ctrl);
  return wrap;
}

function buildDiopterKeypad(col) {
  const wrap = document.createElement('div');
  wrap.className = 'keypad-diopter';

  const sign = document.createElement('div');
  sign.className = 'keypad-row';
  sign.appendChild(makeKey('+', () => stepDiopter(col, +0.25)));
  sign.appendChild(makeKey('−', () => stepDiopter(col, -0.25)));
  sign.appendChild(makeKey('±反転', () => flipDiopter(col)));
  wrap.appendChild(sign);

  wrap.appendChild(buildNumericKeypad(col, true, true));
  return wrap;
}

function buildNumericKeypad(col, allowSign, allowDot) {
  const wrap = document.createElement('div');
  wrap.className = 'keypad-numeric';
  const rows = [['7', '8', '9'], ['4', '5', '6'], ['1', '2', '3']];
  rows.forEach((r) => {
    const div = document.createElement('div');
    div.className = 'keypad-row';
    r.forEach((d) => div.appendChild(makeKey(d, () => appendChar(col, d))));
    wrap.appendChild(div);
  });
  const last = document.createElement('div');
  last.className = 'keypad-row';
  if (allowSign) last.appendChild(makeKey('-', () => appendChar(col, '-')));
  last.appendChild(makeKey('0', () => appendChar(col, '0')));
  if (allowDot) last.appendChild(makeKey('.', () => appendChar(col, '.')));
  last.appendChild(makeKey('⌫', () => backspace(col)));
  last.appendChild(makeKey('CLR', () => setActiveValue(col, '')));
  wrap.appendChild(last);
  return wrap;
}

function makeKey(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'keypad-key';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function setActiveValue(col, value) {
  const r = state.rows[state.active.rowIdx];
  if (!r) return;
  r[col] = value;
  renderRows();
}

function appendChar(col, ch) {
  const r = state.rows[state.active.rowIdx];
  if (!r) return;
  const cur = r[col] ?? '';
  // 符号は先頭のみ許可
  if (ch === '-') {
    r[col] = cur.startsWith('-') ? cur.slice(1) : '-' + cur;
  } else {
    r[col] = cur + ch;
  }
  renderRows();
}

function backspace(col) {
  const r = state.rows[state.active.rowIdx];
  if (!r) return;
  r[col] = (r[col] ?? '').slice(0, -1);
  renderRows();
}

function stepDiopter(col, delta) {
  const r = state.rows[state.active.rowIdx];
  if (!r) return;
  const cur = parseFloat(r[col]);
  const base = Number.isFinite(cur) ? cur : 0;
  const next = Math.round((base + delta) * 100) / 100;
  r[col] = normalizeDiopter(String(next));
  renderRows();
}

function flipDiopter(col) {
  const r = state.rows[state.active.rowIdx];
  if (!r) return;
  const cur = parseFloat(r[col]);
  if (!Number.isFinite(cur)) return;
  r[col] = normalizeDiopter(String(-cur));
  renderRows();
}

// --- 物理キーボード入力 ---
document.addEventListener('keydown', (ev) => {
  const tag = (ev.target?.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  const col = state.active.col;
  if (!['nakedVA', 'correctedVA', 'sphericalD', 'cylindricalD', 'axis'].includes(col)) {
    return;
  }
  if (ev.key === 'Backspace') { backspace(col); ev.preventDefault(); return; }
  if (ev.key === 'Enter') { advanceCell(); ev.preventDefault(); return; }
  if (/^[0-9.\-]$/.test(ev.key)) {
    appendChar(col, ev.key);
    ev.preventDefault();
  }
});

function advanceCell() {
  const order = ['nakedVA', 'exm_condition', 'correctedVA',
    'sphericalD', 'cylindricalD', 'axis'];
  const i = order.indexOf(state.active.col);
  if (i === -1) return;
  if (i < order.length - 1) {
    activateCell(state.active.rowIdx, order[i + 1]);
  } else if (state.active.rowIdx + 1 < state.rows.length) {
    activateCell(state.active.rowIdx + 1, order[0]);
  }
}

// --- ヘッダ操作 ---

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

  $('#btnAddRow').addEventListener('click', () => {
    state.rows.push(makeEmptyRow());
    state.active.rowIdx = state.rows.length - 1;
    state.active.col = 'eye';
    renderRows();
  });
  $('#btnTplDistance').addEventListener('click', () => {
    state.rows.push(...templateDistance());
    renderRows();
  });
  $('#btnTplNear').addEventListener('click', () => {
    state.rows.push(...templateNear());
    renderRows();
  });
  $('#btnTplFull').addEventListener('click', () => {
    state.rows = templateFull();
    state.active = { rowIdx: 0, col: 'nakedVA' };
    renderRows();
  });

  $('#btnQuoteLatest').addEventListener('click', onQuoteLatest);
  $('#btnSave').addEventListener('click', onSave);
  $('#btnCancel').addEventListener('click', onCancel);
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
    setStatus(`${newRows.length} 件を引用しました`);
    renderRows();
  } catch (err) {
    setStatus('引用に失敗: ' + err.message, 'error');
  }
}

async function onSave() {
  // 全空行は捨てる
  const liveRows = state.rows.filter((r) => !isRowEmpty(r));
  if (liveRows.length === 0) {
    setStatus('保存対象の行がありません', 'warn');
    return;
  }
  state.rows = liveRows;
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

// --- 起動 ---

async function init() {
  const initData = fm.getInit();
  state.mode = initData.mode || 'create';
  state.summary._fk_ptID = String(initData.ptID ?? '');
  state.summary.authorName = initData.authorName ?? '';

  if (state.mode === 'update' && initData.summaryRecordId) {
    setStatus('既存サマリ読み込み中…');
    try {
      const res = await fm.loadSummary(initData.summaryRecordId);
      const parsed = parseLoadResponse(res);
      state.summary = { ...state.summary, ...parsed.summary };
      state.rows = parsed.rows;
      if (state.rows.length === 0) state.rows = templateFull();
      setStatus('読み込み完了');
    } catch (err) {
      setStatus('読み込み失敗: ' + err.message, 'error');
      state.rows = templateFull();
    }
  } else {
    state.rows = templateFull();
    setStatus('新規入力');
  }

  state.active = { rowIdx: 0, col: 'nakedVA' };
  bindHeader();
  renderHeader();
  renderRows();
}

init();
