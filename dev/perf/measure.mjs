#!/usr/bin/env node
// FileMaker Data API パフォーマンス計測プローブ
// Node 18+ / 依存なし
//
// 使い方:
//   cp dev/perf/.env.example dev/perf/.env  (各値を埋める)
//   node dev/perf/measure.mjs --scenarios=B,C --iterations=30 --mode=reuse-token \
//        --out=dev/perf/out/run-$(date +%Y%m%d-%H%M).csv
//
// シナリオ:
//   A  POST /sessions                              sign-in
//   B  GET  /records/{id}                          レコード取得
//   C  POST /_find (_fk_ptID, timeOfRecord desc, limit=1)  履歴検索相当
//   D  PATCH /records/{id} (fieldData 1列 no-op)   軽い書き込み
//   E  PATCH /records/{id} (portalData N行)        ※スタブ。schema 合わせ必須
//   F  DELETE /sessions/{token}                    sign-out
//
// モード:
//   reuse-token  最初に1回 sign-in、以降のシナリオで使い回し
//   per-call     B/C/D/E のたびに sign-in → 操作 → sign-out
//
// 出力 CSV 列: timestamp,scenario,mode,iteration,status,client_ms,bytes,error

import { readFile, mkdir, appendFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, env, exit, stdout, stderr } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- args ----------
const args = parseArgs(argv.slice(2));
const scenarios = (args.scenarios || 'A,B,C,F')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const iterations = Number(args.iterations || 30);
const intervalMs = Number(args['interval-ms'] || 5000);
const jitterMs = Number(args['jitter-ms'] || 500);
const mode = (args.mode || 'reuse-token').toLowerCase();
const outPath = args.out ? resolve(args.out) : null;
const dryRun = !!args['dry-run'];
const allowWriteHeavy = !!args['allow-write-heavy'];

if (!['reuse-token', 'per-call'].includes(mode)) {
  stderr.write(`invalid --mode: ${mode}\n`); exit(2);
}

// ---------- env ----------
await loadDotenv(resolve(HERE, '.env'));
const FM_HOST = env.FM_HOST;
const FM_DB = env.FM_DB;
const FM_USER = env.FM_USER;
const FM_PASS = env.FM_PASS;
const FM_LAYOUT = env.FM_LAYOUT;
const FM_PT_ID = env.FM_PT_ID;
const FM_RECORD_ID = env.FM_RECORD_ID;
const missing = ['FM_HOST', 'FM_DB', 'FM_USER', 'FM_PASS', 'FM_LAYOUT']
  .filter(k => !env[k]);
if (missing.length) {
  stderr.write(`Missing required env: ${missing.join(', ')}\n`); exit(2);
}
const base = `${FM_HOST.replace(/\/$/, '')}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}`;
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const UA = `fmperf-probe/${runId}`;

// ---------- output ----------
const csvHeader = 'timestamp,scenario,mode,iteration,status,client_ms,bytes,error\n';
if (outPath) {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, csvHeader);
} else {
  stdout.write(csvHeader);
}

log(`runId=${runId} mode=${mode} scenarios=${scenarios.join(',')} iterations=${iterations} interval=${intervalMs}ms`);
if (dryRun) { log('--dry-run: 実リクエストは送信しません'); exit(0); }

if (scenarios.includes('E') && !allowWriteHeavy) {
  stderr.write('シナリオ E は --allow-write-heavy フラグが必要です (ポータル行を作成します)。\n');
  exit(2);
}
if ((scenarios.includes('B') || scenarios.includes('D')) && !FM_RECORD_ID) {
  stderr.write('B / D は FM_RECORD_ID が必要です\n'); exit(2);
}
if (scenarios.includes('C') && !FM_PT_ID) {
  stderr.write('C は FM_PT_ID が必要です\n'); exit(2);
}

// ---------- main loop ----------
let sharedToken = null;
try {
  if (mode === 'reuse-token') sharedToken = await signIn();

  for (let i = 1; i <= iterations; i++) {
    for (const s of scenarios) {
      await runScenario(s, i);
    }
    if (i < iterations) {
      const wait = intervalMs + Math.floor(Math.random() * jitterMs);
      await sleep(wait);
    }
  }
} catch (e) {
  stderr.write(`fatal: ${e?.stack || e}\n`);
  exit(1);
} finally {
  if (sharedToken) { try { await signOut(sharedToken); } catch {} }
}

log('done');

// ---------- scenario dispatch ----------
async function runScenario(s, iter) {
  const needsToken = ['B', 'C', 'D', 'E'].includes(s);
  let tok = sharedToken;
  let minted = false;

  if (needsToken && mode === 'per-call') {
    tok = await signIn(); minted = true;
  }

  try {
    switch (s) {
      case 'A': {
        // 純粋に sign-in だけを測る (sign-out はクリーンアップ、untimed)
        await measure('A', iter, async () => {
          const t = await signInTimed();
          // ↑ measure 側で時間を取りたいので、内部関数で
          await signOut(t).catch(() => {});
          return 0;
        });
        break;
      }
      case 'B': await measure('B', iter, () => apiGetRecord(tok)); break;
      case 'C': await measure('C', iter, () => apiFind(tok)); break;
      case 'D': await measure('D', iter, () => apiUpdateLight(tok)); break;
      case 'E': await measure('E', iter, () => apiUpdateHeavy(tok, iter)); break;
      case 'F': {
        // sign-out 単体: 直前に untimed sign-in
        const t = await signIn();
        await measure('F', iter, async () => {
          await signOut(t); return 0;
        });
        break;
      }
      default:
        stderr.write(`unknown scenario: ${s}\n`);
    }
  } finally {
    if (minted) { try { await signOut(tok); } catch {} }
  }
}

// ---------- timing helper ----------
async function measure(scenario, iter, fn) {
  const ts = new Date().toISOString();
  const t0 = performance.now();
  let status = 'ok', bytes = 0, err = '';
  try {
    bytes = (await fn()) | 0;
  } catch (e) {
    status = 'error';
    err = (e?.message || String(e)).slice(0, 200).replace(/[\r\n,"]/g, ' ');
  }
  const ms = (performance.now() - t0).toFixed(1);
  const line = `${ts},${scenario},${mode},${iter},${status},${ms},${bytes},"${err}"\n`;
  if (outPath) await appendFile(outPath, line);
  else stdout.write(line);
}

// ---------- Data API helpers ----------
async function signIn() {
  const auth = Buffer.from(`${FM_USER}:${FM_PASS}`).toString('base64');
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'User-Agent': UA
    },
    body: '{}'
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`signIn ${res.status} ${t.slice(0, 120)}`);
  }
  const j = await res.json();
  const token = j?.response?.token;
  if (!token) throw new Error('signIn: no token in response');
  return token;
}

// シナリオAで使用: signIn本体と同じだが、計測関数の中で呼ばれる
async function signInTimed() { return signIn(); }

async function signOut(tok) {
  if (!tok) return;
  await fetch(`${base}/sessions/${encodeURIComponent(tok)}`, {
    method: 'DELETE',
    headers: { 'User-Agent': UA }
  });
}

async function apiGetRecord(tok) {
  const url = `${base}/layouts/${encodeURIComponent(FM_LAYOUT)}/records/${encodeURIComponent(FM_RECORD_ID)}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${tok}`, 'User-Agent': UA }
  });
  const buf = await res.arrayBuffer();
  if (!res.ok) throw new Error(`GET ${res.status}`);
  return buf.byteLength;
}

async function apiFind(tok) {
  const body = JSON.stringify({
    query: [{ "_fk_ptID": `==${FM_PT_ID}` }],
    sort: [{ fieldName: 'timeOfRecord', sortOrder: 'descend' }],
    limit: 1
  });
  const res = await fetch(`${base}/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${tok}`,
      'Content-Type': 'application/json',
      'User-Agent': UA
    },
    body
  });
  const buf = await res.arrayBuffer();
  // 0件は 404 で返るので ok 扱い
  if (!res.ok && res.status !== 404) throw new Error(`FIND ${res.status}`);
  return buf.byteLength;
}

// D: 軽い update — まず GET して VASummaryTitle を読み、同値で PATCH (no-op)
async function apiUpdateLight(tok) {
  const getUrl = `${base}/layouts/${encodeURIComponent(FM_LAYOUT)}/records/${encodeURIComponent(FM_RECORD_ID)}`;
  const g = await fetch(getUrl, { headers: { 'Authorization': `Bearer ${tok}`, 'User-Agent': UA } });
  if (!g.ok) throw new Error(`UPDATE/GET ${g.status}`);
  const gj = await g.json();
  const current = gj?.response?.data?.[0]?.fieldData?.VASummaryTitle ?? '';
  const body = JSON.stringify({ fieldData: { VASummaryTitle: current } });
  const p = await fetch(getUrl, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${tok}`,
      'Content-Type': 'application/json',
      'User-Agent': UA
    },
    body
  });
  const buf = await p.arrayBuffer();
  if (!p.ok) throw new Error(`PATCH ${p.status}`);
  return buf.byteLength;
}

// E: ポータル込み update。**スキーマ依存のスタブ**。
// 各イテレーションで N 個のポータル行を新規追加し、comment に `${runId}/E/${iter}` マーカーを入れる。
// クリーンアップは手動 (テスト患者レコードからマーカー付き行を削除)。
async function apiUpdateHeavy(tok, iter) {
  const url = `${base}/layouts/${encodeURIComponent(FM_LAYOUT)}/records/${encodeURIComponent(FM_RECORD_ID)}`;
  const marker = `PERFTEST-${runId}-E-${iter}`;
  const N = 10;
  const portalRows = Array.from({ length: N }, (_, k) => ({
    "Exm_VisualAcuity::eye": k % 2 === 0 ? "R" : "L",
    "Exm_VisualAcuity::VA_title": "遠見",
    "Exm_VisualAcuity::nakedVA": "0.7",
    "Exm_VisualAcuity::correctedVA": "0.9",
    "Exm_VisualAcuity::sphericalD": "-2.00",
    "Exm_VisualAcuity::cylindricalD": "-0.50",
    "Exm_VisualAcuity::axis": "180",
    "Exm_VisualAcuity::exm_condition": "",
    "Exm_VisualAcuity::comment": marker,
    "Exm_VisualAcuity::isRepresentativeValue": ""
  }));
  const body = JSON.stringify({
    fieldData: {},
    portalData: { "VA_Detail_Portal": portalRows }
  });
  const p = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${tok}`,
      'Content-Type': 'application/json',
      'User-Agent': UA
    },
    body
  });
  const buf = await p.arrayBuffer();
  if (!p.ok) throw new Error(`PATCH/E ${p.status}`);
  return buf.byteLength;
}

// ---------- utils ----------
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

async function loadDotenv(path) {
  if (!existsSync(path)) return;
  const txt = await readFile(path, 'utf8');
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in env)) env[m[1]] = v;
  }
}

function log(msg) {
  stderr.write(`[perf] ${msg}\n`);
}
