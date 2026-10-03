import { chromium } from 'playwright';
const initScript = `
  const _assign = Object.assign;
  Object.assign = function (t, ...a) {
    const r = _assign(t, ...a);
    if (a[0] && 'coinStreak' in a[0]) window.__N = t;
    return r;
  };
  window.__THREE_DEVTOOLS__ = {
    dispatchEvent(e) {
      const o = e?.detail;
      if (o && o.isScene) window.__scene = o;
    },
  };
`;
const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(initScript);
await page.addInitScript(() => {
  new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
      const t = n.textContent && n.textContent.trim();
      if (t) (window.__t = window.__t || []).push(+window.__N?.dist?.toFixed?.(0) + ':' + t.replace(/\s+/g, ' ').slice(0, 40));
    }
  }).observe(document.body, { childList: true, subtree: true });
});
await page.goto('https://danfo.horpey.dev/');
await page.waitForFunction('window.__scene && window.__N', null, { timeout: 60000 });
await page.waitForTimeout(1500);
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true })));
await page.waitForTimeout(500);
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', key: 'ArrowUp', bubbles: true })));
for (let i = 0; i < 90; i++) {
  const s = await page.evaluate(() => ({ mode: window.__N.mode, dist: Math.round(window.__N.dist) }));
  if (s.mode !== 'play') {
    console.log('DEAD at dist', s.dist);
    console.log('TOASTS:');
    await page.evaluate(() => (window.__t || []).slice(-25)).then(ts => ts.forEach(t => console.log(' ', t)));
    await page.screenshot({ path: 'crash-frame.png' });
    break;
  }
  await page.waitForTimeout(400);
}
await browser.close();
