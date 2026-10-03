// Page-side hooks injected before the game loads: capture game state (__N) and the Three.js scene (__scene).
export const initScript = /* js */ `
  const hookToasts = () => new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
      const t = n.textContent && n.textContent.trim();
      if (t) (window.__botToasts = window.__botToasts || []).push(t.replace(/\\s+/g, ' ').slice(0, 50));
    }
  }).observe(document.body, { childList: true, subtree: true });
  if (document.body) hookToasts();
  else { var iv = setInterval(() => { if (document.body) { clearInterval(iv); hookToasts(); } }, 50); }
  const _assign = Object.assign;
  Object.assign = function (t, ...a) {
    const r = _assign(t, ...a);
    if (a[0] && 'coinStreak' in a[0]) window.__N = t;
    return r;
  };
  window.__THREE_DEVTOOLS__ = {
    dispatchEvent(e) {
      if (!e || (e.type !== 'observe' && e.type !== 'register')) return;
      const o = e.detail;
      if (!o || typeof o !== 'object') return;
      if (o.isScene) { window.__scene = o; return; }
      if (typeof o.render === 'function') {
        window.__renderer = o;
        const orig = o.render.bind(o);
        o.render = (sc, cam) => { if (sc && sc.isScene) window.__scene = sc; return orig(sc, cam); };
      }
    },
  };
`;
