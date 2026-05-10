// FileMaker WebViewer 連携層。
// 本番では window.FileMaker.PerformScript(name, param) を呼ぶ。
// FM 側はスクリプト終了時に Perform JavaScript in Web Viewer で
// window.__fmReceiveSummary / window.__fmSaveResult / window.__fmQuoteResult を呼ぶ。

// デバッグログ。?fmdebug=0 で無効化、それ以外は ON。
// window.__fmDebug = false でも切れる。
const DEBUG = (() => {
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('fmdebug') === '0') return false;
  } catch { /* noop */ }
  return window.__fmDebug !== false;
})();
const log = (...args) => { if (DEBUG) console.log('[fm-bridge]', ...args); };
const warn = (...args) => console.warn('[fm-bridge]', ...args);
function preview(v, max = 200) {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (!s) return String(v);
    return s.length > max ? s.slice(0, max) + `…(+${s.length - max} chars)` : s;
  } catch {
    return String(v);
  }
}

const READY_SCRIPT_NAME = 'VA: WebViewer Ready';
const READY_POLL_INTERVAL_MS = 100;
const READY_POLL_MAX_TRIES = 50; // 約 5 秒
const INIT_WAIT_TIMEOUT_MS = 8000;

const callbacks = new Map();
let pending = null;

function expect(name) {
  log('expect()', name, '— pending was:', pending?.name ?? 'none');
  if (pending) {
    warn(`expect("${name}") rejecting stale pending "${pending.name}" `
      + '(FM 側スクリプトがコールバック (__fmXxxResult) を呼ばずに終わった可能性)');
    pending.reject(new Error(`previous "${pending.name}" still pending`));
  }
  return new Promise((resolve, reject) => {
    pending = { name, resolve, reject };
    callbacks.set(name, (payload) => {
      log('callback resolved', name, '— payload:', preview(payload));
      if (pending && pending.name === name) {
        const p = pending;
        pending = null;
        callbacks.delete(name);
        p.resolve(payload);
      } else {
        warn(`callback "${name}" fired but pending was "${pending?.name ?? 'none'}" — ignored`);
      }
    });
  });
}

function installCallback(globalName, key) {
  window[globalName] = (rawJson) => {
    log(`window.${globalName}() called — type=${typeof rawJson}, len=${String(rawJson ?? '').length}, raw=${preview(rawJson)}`);
    let parsed = rawJson;
    if (typeof rawJson === 'string') {
      try { parsed = JSON.parse(rawJson); }
      catch (e) { warn(`${globalName}: JSON.parse failed`, e.message); }
    }
    const cb = callbacks.get(key);
    if (cb) cb(parsed);
    else warn(`${globalName}: no callback registered for key "${key}" — payload dropped`);
  };
}

installCallback('__fmReceiveSummary', 'load');
installCallback('__fmSaveResult', 'save');
installCallback('__fmQuoteResult', 'quote');

// FM 側の "VA: Open WebViewer" は URL を貼っただけでは init データを送れないので、
// JS 側が読み込み完了後に "VA: WebViewer Ready" を呼び返し、FM がそのコールバックの中で
// Perform JavaScript in Web Viewer [__fmSetInit, $$VA_initJSON] を打つ。
// __fmSetInit が呼ばれた時点で window.__fmInit を更新し、'fm:init' イベントで通知する。
window.__fmSetInit = function (rawJson) {
  log('__fmSetInit() called — raw:', preview(rawJson));
  let parsed = rawJson;
  if (typeof rawJson === 'string') {
    try {
      parsed = JSON.parse(rawJson);
    } catch (e) {
      console.error('[fm-bridge] __fmSetInit: invalid JSON', e, rawJson);
      return;
    }
  }
  window.__fmInit = parsed && typeof parsed === 'object' ? parsed : {};
  log('__fmSetInit applied:', window.__fmInit);
  window.dispatchEvent(new CustomEvent('fm:init', { detail: window.__fmInit }));
};

function performScript(scriptName, paramObj) {
  const param = typeof paramObj === 'string'
    ? paramObj
    : JSON.stringify(paramObj ?? {});
  log(`performScript("${scriptName}") — param ${param.length} chars: ${preview(param)}`);
  if (window.FileMaker?.PerformScript) {
    window.FileMaker.PerformScript(scriptName, param);
    return;
  }
  if (window.__fmMock?.performScript) {
    log('  → mock route');
    window.__fmMock.performScript(scriptName, param);
    return;
  }
  throw new Error('FileMaker.PerformScript is unavailable');
}

export function isInFileMaker() {
  return Boolean(window.FileMaker?.PerformScript);
}

// 起動時に WebViewer に注入される初期化情報
//   { ptID, summaryId?, mode: 'create' | 'update', authorName? }
export function getInit() {
  return window.__fmInit ?? { ptID: '', mode: 'create' };
}

// FM の WebViewer に乗っている時のみ、window.FileMaker が利用可能になるのを
// ポーリングして "VA: WebViewer Ready" を呼ぶ。FM 側はこの呼び出しを受けてから
// Perform JS in Web Viewer で __fmSetInit を打つ。
// ブラウザ単体（standalone / dev）では何もしない。

// window.FileMaker.PerformScript が見えるまで polling する Promise。
// 他のシーンでも FM ブリッジ待ちを await したい場合に使える。
export function whenFileMakerReady({
  intervalMs = READY_POLL_INTERVAL_MS,
  maxTries = READY_POLL_MAX_TRIES,
} = {}) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tick = () => {
      if (window.FileMaker?.PerformScript) return resolve(window.FileMaker);
      if (tries++ >= maxTries) {
        return reject(new Error('FileMaker bridge did not become ready in time'));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

export async function notifyReady() {
  log('notifyReady() — waiting for window.FileMaker…');
  try {
    const fmObj = await whenFileMakerReady();
    log(`notifyReady() — bridge ready, calling PerformScript("${READY_SCRIPT_NAME}")`);
    fmObj.PerformScript(READY_SCRIPT_NAME, '');
  } catch (e) {
    warn('notifyReady:', e.message);
  }
}

// init データが届くまで待つ。
//   - 既に window.__fmInit.ptID が入っていれば即解決（standalone / data:URL 方式）
//   - そうでなければ 'fm:init' イベントを待つ（FM 方式 A）
//   - timeoutMs を超えたら現状の __fmInit でフォールバック
export function waitForInit({ timeoutMs = INIT_WAIT_TIMEOUT_MS } = {}) {
  const cur = window.__fmInit;
  if (cur && cur.ptID) return Promise.resolve(cur);
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      window.removeEventListener('fm:init', onInit);
      resolve(val);
    };
    const onInit = (ev) => finish(ev.detail);
    window.addEventListener('fm:init', onInit);
    if (timeoutMs > 0) {
      setTimeout(() => finish(window.__fmInit ?? { ptID: '', mode: 'create' }), timeoutMs);
    }
  });
}

export async function loadSummary(recordId) {
  const promise = expect('load');
  performScript('VA: Load Summary', { recordId });
  return promise;
}

export async function saveSummary(payload) {
  const promise = expect('save');
  performScript('VA: Save', payload);
  return promise;
}

export async function quoteLatest(ptID) {
  const promise = expect('quote');
  performScript('VA: Quote Latest', { ptID });
  return promise;
}
