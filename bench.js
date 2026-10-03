// Benchmark: Jev (TypeSafe AI model, via AI Gateway) vs Heuristic (hand-written rules, no AI) on Lagos Run
// Needs AI_GATEWAY_API_KEY for the jev player (e.g. node --env-file=.env bench.js).
// Usage:
//   node bench.js                         5 runs per player, heuristic vs jev
//   RUNS=10 node bench.js                 10 runs per player
//   RUN_CAP=90 node bench.js              stop a run after 90 s of game time (default 120)
//   PLAYERS=heuristic node bench.js       only one player (no API key needed)
//   SAVE=1 node bench.js                  let players spend the spare-tyre "save" (default: death is final)
//   HEADED=1 node bench.js                watch
// Every run gets a fresh browser page; players alternate (heuristic, jev, heuristic, jev, ...) so any
// drift in network/machine load hits both equally. Results land in results/bench-<time>.json.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { initScript } from './lib/init.js';
import * as jev from './players/jev.js';
import * as heuristic from './players/heuristic.js';

const REGISTRY = { heuristic, jev };
const RUNS = Number(process.env.RUNS || 5);
const RUN_CAP = Number(process.env.RUN_CAP || 120);
const HEADED = !!process.env.HEADED;
const USE_SAVE = !!process.env.SAVE;
const PLAYERS = (process.env.PLAYERS || 'heuristic,jev').split(',').map(s => s.trim()).filter(Boolean);
for (const p of PLAYERS) if (!REGISTRY[p]) throw new Error(`unknown player "${p}" (have: ${Object.keys(REGISTRY).join(', ')})`);

if (PLAYERS.includes('jev') && !process.env.AI_GATEWAY_API_KEY) {
  console.error('The jev player needs AI_GATEWAY_API_KEY (Vercel AI Gateway key). Set it, or run PLAYERS=heuristic.');
  process.exit(1);
}

const TICK_MS = 80; // identical decision cadence for every player (same as bot.js)
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString();

// One page-side step: let the player act, clear nuisance overlays the same way for everyone,
// and read the game state back. Returns { mode, score, dist, coins, speed, runT, modal }.
const stepExpr = (tick, useSave) => `(() => {
  ${tick ? `try { ${tick}; } catch (e) {}` : ''}
  let modal = null;
  const vis = sel => { const el = document.querySelector(sel); return el && el.offsetParent !== null ? el : null; };
  const streak = vis('#streak-screen');
  if (streak) { (document.querySelector('#streak-go') || streak.querySelector('button')).click(); modal = 'streak'; }
  else if (vis('#saveme')) { if (${useSave}) { document.querySelector('#save-use')?.click(); modal = 'spare-tyre'; } else modal = 'save-offered'; }
  else { for (const s of ['#consent-no', '#consent-yes']) { const b = vis(s); if (b) { b.click(); modal = 'consent'; break; } } }
  const N = window.__N;
  if (!N) return null;
  return { mode: N.mode, score: Math.round(N.score), dist: Math.round(N.dist), coins: N.coins,
           speed: Math.round(N.speed), runT: +N.runT.toFixed(2), modal };
})()`;

async function playOne(player, idx) {
  const browser = await chromium.launch({ headless: !HEADED });
  const t0 = Date.now();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(initScript);
    await page.goto('https://danfo.horpey.dev/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(player.script);
    await page.waitForFunction('window.__botReady && window.__N && window.__scene', null, { timeout: 90000 });
    await sleep(1200);

    const ctl = player.attach ? player.attach(page) : null;
    const step = stepExpr(player.tick, USE_SAVE);
    const restart = () => page.evaluate(() => window.__botRestart());

    // start the run (Enter), wait for mode === 'play'
    let s = null;
    for (let i = 0; i < 40; i++) {
      await restart();
      s = await page.evaluate(step);
      if (s && s.mode === 'play') break;
      await sleep(400);
    }
    if (!s || s.mode !== 'play') throw new Error('run never started');

    let last = s, maxSpeed = 0, capped = false, saves = 0, bumps = 0;
    while (true) {
      const tickStart = Date.now();
      ctl?.onTick(); // throws if the player hit a fatal error (e.g. bad API key)
      s = await page.evaluate(step);
      if (!s) break;
      if (s.modal === 'spare-tyre') saves++;
      if (s.mode !== 'play' || s.modal === 'save-offered') { last = s; break; }
      last = s;
      if (s.speed > maxSpeed) maxSpeed = s.speed;
      if (s.runT >= RUN_CAP) { capped = true; break; } // cap in game seconds, not wall time
      const spent = Date.now() - tickStart;
      if (spent < TICK_MS) await sleep(TICK_MS - spent);
    }
    ctl?.close();
    const toasts = await page.evaluate(() => [...new Set((window.__botToasts || []).slice(-6))].slice(-3));
    return {
      player: player.name, run: idx + 1, ok: true, capped,
      score: last.score, dist: last.dist, coins: last.coins, survivedS: last.runT, maxSpeed, saves,
      wallS: +((Date.now() - t0) / 1000).toFixed(1), lastToasts: toasts,
      ai: ctl ? ctl.summary() : null,
    };
  } catch (e) {
    return { player: player.name, run: idx + 1, ok: false, fatal: !!e.fatal, error: String(e.message || e).split('\n')[0],
             wallS: +((Date.now() - t0) / 1000).toFixed(1) };
  } finally {
    await browser.close();
  }
}

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const median = a => { const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length ? (b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2) : 0; };
const stdev = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const f = (n, d = 0) => Number(n).toFixed(d);

console.log(`Lagos Run benchmark — players: ${PLAYERS.join(' vs ')} | ${RUNS} runs each | cap ${RUN_CAP}s | spare-tyre ${USE_SAVE ? 'ON' : 'OFF'}`);
const results = [];
for (let i = 0; i < RUNS; i++) {
  for (const name of PLAYERS) {
    const r = await playOne(REGISTRY[name], i);
    results.push(r);
    console.log(r.ok
      ? `[${stamp()}] ${name.padEnd(9)} run ${r.run}/${RUNS}  score=${String(r.score).padStart(6)}  dist=${String(r.dist).padStart(5)}m  coins=${String(r.coins).padStart(3)}  alive=${f(r.survivedS, 1)}s${r.capped ? '  (hit cap)' : ''}`
      : `[${stamp()}] ${name.padEnd(9)} run ${r.run}/${RUNS}  FAILED: ${r.error}`);
    if (r.fatal) { console.error('Fatal player error — aborting benchmark.'); process.exit(1); }
  }
}

// ---- summary ----
const rows = PLAYERS.map(name => {
  const rs = results.filter(r => r.player === name && r.ok);
  const sc = rs.map(r => r.score);
  return {
    player: name, runs: rs.length, failed: results.filter(r => r.player === name && !r.ok).length,
    score: { mean: mean(sc), median: median(sc), best: Math.max(0, ...sc), worst: sc.length ? Math.min(...sc) : 0, stdev: stdev(sc) },
    dist: { mean: mean(rs.map(r => r.dist)), best: Math.max(0, ...rs.map(r => r.dist)) },
    coins: { mean: mean(rs.map(r => r.coins)) },
    survivedS: { mean: mean(rs.map(r => r.survivedS)), best: Math.max(0, ...rs.map(r => r.survivedS)) },
    capped: rs.filter(r => r.capped).length,
    ai: rs.some(r => r.ai) ? {
      calls: rs.reduce((n, r) => n + (r.ai?.apiCalls || 0), 0),
      errors: rs.reduce((n, r) => n + (r.ai?.apiErrors || 0), 0),
      meanLatencyMs: mean(rs.filter(r => r.ai).map(r => r.ai.meanLatencyMs)),
      p95LatencyMs: Math.max(0, ...rs.filter(r => r.ai).map(r => r.ai.p95LatencyMs)),
      costUsd: rs.reduce((n, r) => n + (r.ai?.costUsd || 0), 0),
      decisionsPerSec: rs.reduce((n, r) => n + (r.ai?.apiCalls || 0), 0) / (rs.reduce((n, r) => n + r.survivedS, 0) || 1),
    } : null,
  };
});

console.log('\n=== RESULTS ===');
const cols = ['player', 'runs', 'score mean', 'median', 'best', 'worst', 'stdev', 'dist mean', 'coins', 'alive s', 'capped'];
const table = rows.map(r => [r.player, r.runs, f(r.score.mean), f(r.score.median), r.score.best, r.score.worst, f(r.score.stdev),
  f(r.dist.mean) + 'm', f(r.coins.mean, 1), f(r.survivedS.mean, 1), `${r.capped}/${r.runs}`]);
const w = cols.map((c, i) => Math.max(c.length, ...table.map(t => String(t[i]).length)));
const line = a => a.map((c, i) => String(c).padEnd(w[i])).join('  ');
console.log(line(cols)); console.log(w.map(n => '-'.repeat(n)).join('  ')); table.forEach(t => console.log(line(t)));

for (const r of rows) if (r.ai) console.log(`\n${r.player} API: ${r.ai.calls} calls (${r.ai.errors} errors), ` +
  `latency mean ${f(r.ai.meanLatencyMs)}ms / worst-run p95 ${f(r.ai.p95LatencyMs)}ms, ${f(r.ai.decisionsPerSec, 1)} decisions/s of game time, cost $${r.ai.costUsd.toFixed(4)}`);

if (rows.length === 2 && rows.every(r => r.runs)) {
  const [a, b] = rows;
  const ratio = b.score.mean > 0 ? a.score.mean / b.score.mean : Infinity;
  console.log(`\n${a.player} vs ${b.player}: mean score ${f(a.score.mean)} vs ${f(b.score.mean)} (${Number.isFinite(ratio) ? f(ratio, 1) + '×' : '∞×'}), ` +
    `mean distance ${f(a.dist.mean)}m vs ${f(b.dist.mean)}m`);
}

mkdirSync('results', { recursive: true });
const out = `results/bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(out, JSON.stringify({ config: { RUNS, RUN_CAP, PLAYERS, USE_SAVE, TICK_MS }, summary: rows, runs: results }, null, 2));
console.log(`\nSaved ${out}`);
