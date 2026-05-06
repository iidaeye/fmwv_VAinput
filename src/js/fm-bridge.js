// FileMaker WebViewer 連携層。
// 本番では window.FileMaker.PerformScript(name, param) を呼ぶ。
// FM 側はスクリプト終了時に Perform JavaScript in Web Viewer で
// window.__fmReceiveSummary / window.__fmSaveResult / window.__fmQuoteResult を呼ぶ。

const callbacks = new Map();
let pending = null;

function expect(name) {
  if (pending) {
    pending.reject(new Error(`previous "${pending.name}" still pending`));
  }
  return new Promise((resolve, reject) => {
    pending = { name, resolve, reject };
    callbacks.set(name, (payload) => {
      if (pending && pending.name === name) {
        const p = pending;
        pending = null;
        callbacks.delete(name);
        p.resolve(payload);
      }
    });
  });
}

function installCallback(globalName, key) {
  window[globalName] = (rawJson) => {
    let parsed = rawJson;
    if (typeof rawJson === 'string') {
      try { parsed = JSON.parse(rawJson); } catch { /* keep string */ }
    }
    const cb = callbacks.get(key);
    if (cb) cb(parsed);
  };
}

installCallback('__fmReceiveSummary', 'load');
installCallback('__fmSaveResult', 'save');
installCallback('__fmQuoteResult', 'quote');

function performScript(scriptName, paramObj) {
  const param = typeof paramObj === 'string'
    ? paramObj
    : JSON.stringify(paramObj ?? {});
  if (window.FileMaker?.PerformScript) {
    window.FileMaker.PerformScript(scriptName, param);
    return;
  }
  // ブラウザ単体時：mock があれば呼ぶ
  if (window.__fmMock?.performScript) {
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
