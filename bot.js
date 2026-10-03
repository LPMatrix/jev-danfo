// Heuristic bot (rule-based, no AI) plays Lagos Run (danfo.horpey.dev)
// Usage:
//   node bot.js                    run 1 game until death
//   RUNS=3 node bot.js             3 runs
//   RUN_TIME=120 node bot.js       time-bounded session (seconds)
//   HEADED=1 node bot.js           watch it live
import { chromium } from 'playwright';
import { initScript } from './lib/init.js';
import { script as botScript } from './players/heuristic.js';

const MAX_RUNS = Number(process.env.RUNS || 1);
const RUN_TIME = Number(process.env.RUN_TIME || 0);
const HEADED = !!process.env.HEADED;


const browser = await chromium.launch({ headless: !HEADED });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(initScript);
await page.goto('https://danfo.horpey.dev/', { waitUntil: 'domcontentloaded' });
await page.evaluate(botScript);
await page.waitForFunction('window.__botReady && window.__N && window.__scene', null, { timeout: 90000 });

const stamp = () => new Date().toLocaleTimeString();
let best = 0;
let run = 0;
let lastLog = 0;
let restartAt = 0;
let restarting = false;

// kick off first run
await page.waitForTimeout(1200);
await page.evaluate(() => window.__botRestart());

const deadline = Date.now() + (RUN_TIME ? RUN_TIME * 1000 : Infinity);
let deathDump = 0;
const timer = setInterval(async () => {
  if (Date.now() > deadline) {
    console.log(`Done. RUNS=${run} BEST_SCORE=${best}`);
    clearInterval(timer);
    await browser.close();
    process.exit(0);
  }
  try {
    await page.evaluate(() => window.__botRun());
    // dismiss modal overlays that steal input or masquerade as death
    const modal = await page.evaluate(() => {
      const sv = document.querySelector('#saveme');
      if (sv && sv.offsetParent !== null) { document.querySelector('#save-use')?.click(); return 'spare-tyre'; }
      const st = document.querySelector('#streak-screen');
      if (st && st.offsetParent !== null) {
        (document.querySelector('#streak-go') || st.querySelector('button')).click();
        return 'streak-continue';
      }
      const cBin = document.querySelectorAll('#consent-yes, #consent-no');
      for (const b of cBin) if (b.offsetParent !== null) { b.click(); return 'consent'; }
      const c = document.querySelector('#resume');
      if (c && c.offsetParent !== null) { c.click(); return 'resume'; }
      return null;
    });
    if (modal === 'streak-continue') console.log(`[${stamp()}] streak modal → continued same run`);
    else if (modal) {
      lastLog = Date.now();
      console.log(`[${stamp()}] dismissed: ${modal}`);
    }
    const s = await page.evaluate(() => window.__botState());

    if (s.mode === 'play') {
      if (restarting) { run++; restarting = false; console.log(`[${stamp()}] run ${run + 1} started`); }
      if (s.score > best) best = s.score;
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        console.log(`[${stamp()}] run ${run + 1} score=${s.score} dist=${s.dist}m coins=${s.coins} v=${s.speed} gas=${s.gas} brk=${s.brk} base=${s.base} best=${best}`);
      }
      return;
    }

    // not playing: death / save / menu
    if ((s.mode === 'dead' || s.mode === 'save') && Date.now() - deathDump > 5000) {
      deathDump = Date.now();
      const dump = await page.evaluate(() => ({ raw: window.__botRaw(), toasts: (window.__botToasts || []).slice(-20) }));
      console.log('--- toasts around death ---');
      for (const t of dump.toasts) console.log(t);
      console.log('--- RAW near player at death ---');
      for (const l of dump.raw) console.log(l);
      await page.screenshot({ path: `death-${Date.now() % 100000}.png` });
      const ring = await page.evaluate(() => window.__botRing.slice(-14));
      console.log('--- last ticks ---');
      for (const l of ring) console.log(l);
    }
if (restarting && Date.now() - restartAt < 300) return;
    if (Date.now() - restartAt > 400) {
      restartAt = Date.now();
      restarting = true;
      await page.evaluate(() => window.__botRestart());
      if (Date.now() - lastLog > 2000) {
        console.log(`[${stamp()}] ${s.mode} (score ${s.score}, dist ${s.dist}m, best ${best}) → restarting`);
      }
      // also try clicking the obvious retry buttons
      await page.evaluate(() => {
        for (const sel of ['#again', '#go', '#resume']) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) { el.click(); break; }
        }
      });
    }
  } catch (e) {}
}, 80);
