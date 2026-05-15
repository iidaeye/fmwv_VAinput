#!/usr/bin/env node
// fmdapi.log を IP ごとに操作分布として可視化する。
//
// 前提:
//   並行 worker 環境では POST /sessions ↔ DELETE /sessions/{token} の厳密ペアリングは
//   不可能 (URL に token が出ない non-session 操作の所属を特定できない)。
//   ただし sessions 数 ≒ ops 数 (1.00 ops/session) が観測されているなら、
//   各 op がそのまま 1 トランザクションを代表すると見做せる。
//
// この前提で:
//  1) op 種別 (method + 正規化 URL + FM error) の分布 = トランザクション種別分布
//  2) 同一 IP の連続 op 間が <gap-ms (default 25ms) のものは「同一 worker の連続 op」と
//     見做してマルチ op バーストとして別途集計
//  3) 上記をテーブル + ASCII バーで可視化、各カノニカル sequence を出力
//
// 使い方:
//   node dev/perf/cluster-transactions.mjs <fmdapi.log> [--ip=A.B.C.D] [--top=15] [--gap-ms=25]

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { argv, exit } from 'node:process';

const args = parseArgs(argv.slice(2));
const path = args._[0];
if (!path) {
  console.error('usage: cluster-transactions.mjs <fmdapi.log> [--ip=...] [--top=15] [--gap-ms=25]');
  exit(2);
}
const ipFilter = args.ip || null;
const top = Number(args.top || 15);
const gapMs = Number(args['gap-ms'] || 25);

const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

// perIp: { rows: [{tsMs, method, op, err, bytes}] }
const perIp = new Map();

let nLines = 0;
for await (const raw of rl) {
  nLines++;
  if (nLines === 1) continue;
  const line = raw.replace(/^﻿/, '');
  const cols = line.split('\t');
  if (cols.length < 8) continue;
  const [ts, err, level, ip, user, method, msg, bytes] = cols;
  if (!ip || ip === '-') continue;
  if (ipFilter && ip !== ipFilter) continue;

  // 正規化 URL → op シグネチャ
  let u = msg
    .replace(/^\/fmi\/data\/v[^/]+\/databases\/[^/]+/, '')
    .replace(/sessions\/[a-f0-9]+/, 'sessions/{token}')
    .replace(/\/records\/\d+/, '/records/{id}')
    .replace(/\?.*$/, '');

  let kind;
  if (u === '/sessions' && method === 'POST') kind = 'SIGN_IN';
  else if (u.startsWith('/sessions/') && method === 'DELETE') kind = 'SIGN_OUT';
  else kind = 'OP';

  const layout = u.match(/\/layouts\/([^/]+)/)?.[1] ?? '';
  const tail = u.includes('/_find') ? '/_find'
            : u.includes('/records/{id}') ? '/records/{id}'
            : u.includes('/records') ? '/records'
            : '';
  const sig = kind === 'OP' ? `${method} ${layout}${tail}${err !== '0' ? `[err=${err}]` : ''}` : kind;

  const tsMs = parseTs(ts);
  const state = perIp.get(ip) ?? { rows: [], counts: { SIGN_IN: 0, SIGN_OUT: 0, OP: 0 }, bytesTotal: 0 };
  perIp.set(ip, state);
  state.rows.push({ tsMs, kind, method, sig, err, bytes: Number(bytes) || 0 });
  state.counts[kind]++;
  state.bytesTotal += Number(bytes) || 0;
}

// 出力
const ipsSorted = [...perIp.entries()].sort((a, b) => b[1].rows.length - a[1].rows.length);
console.log(`# fmdapi.log transaction-level analysis`);
console.log(`file: ${path}`);
console.log(`IP filter: ${ipFilter ?? '(none)'}`);
console.log(`gap threshold for multi-op burst: ${gapMs}ms`);
console.log();

for (const [ip, state] of ipsSorted) {
  const { rows, counts, bytesTotal } = state;
  if (rows.length === 0) continue;

  const opsRows = rows.filter(r => r.kind === 'OP');
  const opsPerSession = counts.SIGN_IN > 0 ? counts.OP / counts.SIGN_IN : 0;
  const first = rows[0].tsMs, last = rows[rows.length - 1].tsMs;
  const minutes = (last - first) / 60000;

  console.log(`## IP ${ip}`);
  console.log(`window: ${minutes.toFixed(1)} min`);
  console.log(`SIGN_IN: ${counts.SIGN_IN}  OP: ${counts.OP}  SIGN_OUT: ${counts.SIGN_OUT}`);
  console.log(`ops/session: **${opsPerSession.toFixed(3)}**  → 典型 transaction は SIGN_IN → 1 op → SIGN_OUT`);
  console.log(`total response bytes: ${(bytesTotal / 1024 / 1024).toFixed(1)} MB  (${(bytesTotal / 1024 / 1024 / minutes * 60).toFixed(1)} MB/h)`);
  console.log();

  // === 1) op 種別分布 = transaction 種別分布 ===
  const dist = new Map();
  const bytesBySig = new Map();
  for (const r of opsRows) {
    dist.set(r.sig, (dist.get(r.sig) ?? 0) + 1);
    if (!bytesBySig.has(r.sig)) bytesBySig.set(r.sig, []);
    bytesBySig.get(r.sig).push(r.bytes);
  }
  const ranked = [...dist.entries()].sort((a, b) => b[1] - a[1]);
  const totalOps = opsRows.length;
  const maxCount = ranked[0]?.[1] ?? 1;

  console.log(`### transaction type distribution (op 単位, 上位 ${Math.min(top, ranked.length)} / ${ranked.length})`);
  console.log();
  console.log('| #  | count | share  | mean KB | total MB | pattern (SIGN_IN → op → SIGN_OUT, op = ...) |');
  console.log('|----|------:|-------:|--------:|---------:|-----------------------------------------------|');
  for (let i = 0; i < Math.min(top, ranked.length); i++) {
    const [sig, n] = ranked[i];
    const bArr = bytesBySig.get(sig);
    const meanB = bArr.reduce((s, x) => s + x, 0) / bArr.length;
    const totalMB = bArr.reduce((s, x) => s + x, 0) / 1024 / 1024;
    console.log(`| ${String(i + 1).padStart(2)} | ${String(n).padStart(5)} | ${(100 * n / totalOps).toFixed(2)}% | ${(meanB / 1024).toFixed(1).padStart(7)} | ${totalMB.toFixed(1).padStart(8)} | ${sig} |`);
  }
  console.log();

  // ASCII bar chart
  console.log(`### shape (top ${Math.min(top, ranked.length)})`);
  console.log('```');
  for (let i = 0; i < Math.min(top, ranked.length); i++) {
    const [sig, n] = ranked[i];
    const len = Math.round(60 * n / maxCount);
    const bar = '█'.repeat(len) + ' '.repeat(60 - len);
    const label = sig.length > 55 ? sig.slice(0, 52) + '...' : sig;
    console.log(`${label.padEnd(55)} ${bar} ${n}`);
  }
  console.log('```');
  console.log();

  // === 2) multi-op バースト検出: 同一 IP の連続 op で gap < gapMs を 1 つの worker のバーストと見做す ===
  const bursts = [];
  let current = null;
  for (const r of opsRows) {
    if (current && r.tsMs - current.lastTs <= gapMs) {
      current.ops.push(r);
      current.lastTs = r.tsMs;
    } else {
      if (current) bursts.push(current);
      current = { ops: [r], start: r.tsMs, lastTs: r.tsMs };
    }
  }
  if (current) bursts.push(current);

  const burstByLen = new Map();
  for (const b of bursts) {
    const k = b.ops.length;
    burstByLen.set(k, (burstByLen.get(k) ?? 0) + 1);
  }
  console.log(`### multi-op バースト (gap ≤ ${gapMs}ms で隣接した op の連続)`);
  console.log();
  console.log('| ops in burst | count | share  |');
  console.log('|-------------:|------:|-------:|');
  const sortedLens = [...burstByLen.keys()].sort((a, b) => a - b);
  const totalBursts = bursts.length;
  for (const k of sortedLens.slice(0, 10)) {
    const n = burstByLen.get(k);
    console.log(`| ${String(k).padStart(12)} | ${String(n).padStart(5)} | ${(100 * n / totalBursts).toFixed(2)}% |`);
  }
  console.log();

  // 多 op バーストの上位パターン (length>=2)
  const multiPatterns = new Map();
  for (const b of bursts) {
    if (b.ops.length < 2) continue;
    const sig = b.ops.map(o => o.sig).join('  ▸  ');
    multiPatterns.set(sig, (multiPatterns.get(sig) ?? 0) + 1);
  }
  const rankedMulti = [...multiPatterns.entries()].sort((a, b) => b[1] - a[1]);
  if (rankedMulti.length > 0) {
    console.log(`### multi-op バーストの上位パターン (length ≥ 2, 上位 ${Math.min(top, rankedMulti.length)})`);
    console.log();
    console.log('| #  | count | share | sequence |');
    console.log('|----|------:|------:|----------|');
    const totalMulti = rankedMulti.reduce((s, [, n]) => s + n, 0);
    for (let i = 0; i < Math.min(top, rankedMulti.length); i++) {
      const [sig, n] = rankedMulti[i];
      console.log(`| ${String(i + 1).padStart(2)} | ${String(n).padStart(5)} | ${(100 * n / totalMulti).toFixed(1)}% | ${sig} |`);
    }
    console.log();
  }

  // === 3) canonical sequence diagram for top 3 single-op transactions ===
  console.log(`### canonical transaction sequence (top 3)`);
  console.log();
  for (let i = 0; i < Math.min(3, ranked.length); i++) {
    const [sig, n] = ranked[i];
    console.log(`#${i + 1}  ${(100 * n / totalOps).toFixed(1)}% (${n}×)`);
    console.log('```');
    console.log('  client ───POST /sessions────────────────────→  FM Server');
    console.log(`         ───${sig}───────────────────→`);
    console.log('         ───DELETE /sessions/{token}─────────→');
    console.log('```');
  }
  console.log();
}

// ---------- utils ----------
function parseTs(s) {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) ([+-]\d{4})/);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
}

function parseArgs(a) {
  const out = { _: [] };
  for (const x of a) {
    const m = x.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(x);
  }
  return out;
}
