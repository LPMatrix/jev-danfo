// Heuristic — hand-written rules, no AI. Reads the live Three.js scene, steers, brakes, hops and serves bus stops.
export const name = 'heuristic';
export const tick = 'window.__botRun()';
export const script = /* js */ `
  const LANE_X = 3.4;
  const CRUISE = 18; // m/s cap: every 0.2s lane change covers ~3.6m — dodgeable
  const STOPS = [230, 500, 890, 1230, 1660, 2060, 2620, 2980, 3480, 3790, 4150];

  const st = {
    lane: 0,
    stopBot: null,
    keyState: {},
    lastPress: {},
  };

  function press(code) {
    const now = performance.now();
    if (now - (st.lastPress[code] || 0) < 350) return;
    st.lastPress[code] = now;
    const key = code === 'Space' ? ' ' : code;
    window.dispatchEvent(new KeyboardEvent('keydown', { code, key, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code, key, bubbles: true }));
  }

  function hold(code, on) {
    if (st.keyState[code] === on) return;
    st.keyState[code] = on;
    window.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code, key: code, bubbles: true }));
  }

  function realLane() {
    const px = window.__botPX;
    if (px == null) return st.lane;
    return Math.round(px / LANE_X);
  }

  function steerTo(lane) {
    const cur = realLane();
    st.lane = lane; // intended
    if (cur === lane) return; // confirmed there
    const dir = lane > cur ? 'ArrowRight' : 'ArrowLeft';
    press(dir);
  }

  function scan() {
    const scene = window.__scene;
    const N = window.__N;
    if (!scene || !N) return null;
    scene.updateMatrixWorld();
    const seen = window.__botSeen || (window.__botSeen = new Map());
    const items = [];
    scene.traverse(o => {
      const ud = o.userData;
      if (!ud || !ud.dims) return;
      if (!window.__botVec) window.__botVec = o.position.clone();
      const v = window.__botVec;
      o.getWorldPosition(v);
      // absolute "metre" coordinate: D = N.dist - worldZ
      const D = N.dist - v.z;
      const rec = seen.get(o) || { D, close: 15, t: N.runT }; // unseen: assume fast approach
      let close = rec.close; // default: reuse last trusted measurement
      const dt = N.runT - rec.t;
      const dD = rec.D - D;
      if (dt > 0.02 && Math.abs(dD) < 14) close = Math.max(-2, Math.min(70, dD / dt)); // teleport/recycle → distrust
      rec.close = close; rec.D = D; rec.t = N.runT;
      seen.set(o, rec);
      const px = v.x, pz = v.z;
      const isPlayer = Math.abs(pz) < 2.6 && Math.abs(px % LANE_X) < 0.35;
      if (isPlayer) { window.__botPX = px; }
      items.push({
        kind: ud.kind, type: ud.type, lane: ud.lane,
        x: px, y: v.y, z: pz,
        h: ud.dims.h, w: ud.dims.w, l: ud.dims.l, close, player: isPlayer,
      });
    });
    if (seen.size > 400) seen.clear();
    return { N, items };
  }

  function nextStop(N) {
    const lap = Math.floor(N.dist / 4300);
    for (const s of STOPS) {
      const at = lap * 4300 + s;
      if (at - N.dist > 190) return at;
    }
    return null;
  }

  // hop-able: jump clears y ≈ 1.57, game clears when p.y > h - 0.15
  function isHoppable(it) {
    return it.h <= 1.6 && it.l <= 14;
  }

  // match the game's collision test: |Δx| < w*.46 + .85; block decision adds close-speed:
  // slow-closing traffic in our lane auto-matches our speed → followable tailgate
  function isBlocking(it, d) {
    if (it.close === 0 && it.closeKnown === false) return true; // unknown yet
    if (it.close > 4) return true; // fast-approaching (oncoming, parked car we slide into wrong side?)
    return d < 9; // slow/zero closer or static: followable unless close
  }
  function isBlockNow(it, d) {
    if (isHoppable(it)) {
      if (d < 3.5 && it.close > 1) return true; // too late to hop, hard wall now
      return false; // we'll hop it
    }
    if (it.close < 0.6) return false; // outpacing/stationary-relative: not urgent
    const ttc = d / it.close;
    return ttc < 2.2 || d < 9;
  }

  function laneBlocked(threats, lane, within) {
    for (const t of threats[lane + 1]) {
      if (t.d > within) break;
      if (isBlockNow(t.it, t.d)) return true;
    }
    return false;
  }

  function laneBlocked(threats, lane, within) {
    for (const t of threats[lane + 1]) {
      if (t.d > within) break;
      if (!isHoppable(t.it)) return true;
    }
    return false;
  }

  function hopAt(threats, lane, N) {
    for (const t of threats[lane + 1]) {
      if (!isHoppable(t.it)) continue;
      if (t.d > 1.5 && t.d < 4 + N.speed * 0.10) { press('Space'); break; }
    }
  }

  // build a printable threat summary each decide tick (single source of truth)
  function summary(N, threats) {
    return threats.map(a => a.map(t => (isHoppable(t.it) ? '' : '!h' + t.it.h) + '@' + t.d.toFixed(0) + 'c' + t.it.close.toFixed(1)).join(',') || '-').join(' | ');
  }

  window.__botRun = () => {
    if (window.__N && window.__N.mode !== 'play') {
      st.keyState = {}; // fresh hold state each run
      st.stopBot = null; st.brakeUntil = 0; st.changeUntil = 0;
      st.cautious = 0; st.stuckSince = 0; st.bayDone = false;
    }
    decide();
  };
  window.__botRing = [];
  window.__botBay = () => {
    const N = window.__N;
    if (!N) return null;
    const q = sel => { const el = document.querySelector(sel); return el ? (el.textContent || '').trim().slice(0, 44) : null; };
    const bus = document.querySelector('#bus');
    return {
      d: +( (st.stopBot ?? -1) - N.dist ).toFixed(0), v: +N.speed.toFixed(1),
      seats: q('#bus .seats'), cue: q('#bus-cue'), bay: q('#bay-cue'),
      cls: bus ? bus.className : null, lane: realLane(), mode: N.mode,
    };
  };
  window.__botDumper = setInterval(() => {
    const N = window.__N;
    if (!N || N.mode !== 'play') return;
    if (!window.__botLastSummary) return;
    window.__botRing.push('d=' + N.dist.toFixed(0) + ' v=' + N.speed.toFixed(1) + ' gas=' + N.gas + ' brk=' + N.brake + ' slow=' + N.slow.toFixed(2) + ' inv=' + (N.invuln || 0).toFixed(1) + ' lane=' + st.lane + ' rlane=' + realLane() + ' | ' + window.__botLastSummary);
    if (window.__botRing.length > 40) window.__botRing.shift();
  }, 250);
  window.__botDumpUD = () => {
    const scene = window.__scene;
    const out = [];
    if (!scene) return 'NO SCENE';
    scene.updateMatrixWorld();
    scene.traverse(o => {
      const ud = o.userData;
      if (ud && ud.dims) out.push(JSON.stringify(ud).slice(0, 400));
      if (out.length >= 6) return out;
    });
    return out.slice(0, 6);
  };
  window.__botState = () => ({
    mode: window.__N && window.__N.mode,
    score: window.__N ? Math.round(window.__N.score) : 0,
    coins: window.__N ? window.__N.coins : 0,
    dist: window.__N ? Math.round(window.__N.dist) : 0,
    speed: window.__N ? Math.max(0, Math.round(window.__N.speed)) : 0,
    gas: window.__N ? window.__N.gas : -1,
    brk: window.__N ? window.__N.brake : -1,
    base: window.__N ? Math.round(window.__N.base) : 0,
  });

  window.__botSincePlayAll = () => window.__botSincePlay || 0;

  function decide() {
    const s = scan();
    if (!s) return;
    const { N, items } = s;
    if (N.mode !== 'play') return;
    st.lane = realLane();
    if ((N.slow ?? 1) < 0.8) { st.bumpAt = N.runT; st.cautious = N.runT + 4.2; } // real vehicle scrape → fall back

    // dismiss consent banner (it sits above UI, isn't a modal, but tidy anyway)

    const threats = [[], [], []];
    let crosserNear = false;
    for (const it of items) {
      const d = -(it.z); // obj.position.z = -(d - N.dist), so metres-ahead = -z
      if (d < 2.5 || d > 60) continue; // d<2.5 = our own danfo
      const lane = Math.round(it.x / LANE_X);
      // bucket to every lane it can physically collide with
      if (it.w < 1.2 && it.l < 1.2 && it.h < 1.2) continue; // coin/power pickup — don't dodge
      const bucketed = [];
      for (const L of [-1, 0, 1]) {
        if (!(Math.abs(it.x - L * LANE_X) < it.w * 0.46 + 0.85)) continue;
        bucketed.push(L);
        if (it.type === 'crosser' && d < 16) crosserNear = true;
        threats[L + 1].push({ d, it });
      }
      if (!bucketed.length) continue; // off-road / oncoming shoulder: ignore
    }
    for (const t of threats) t.sort((a, b) => a.d - b.d);
    window.__botLastSummary = summary(N, threats);

    // ---- bus stop service ----
    if (st.stopBot === null || N.dist - st.stopBot > 60) st.stopBot = nextStop(N);
    let inStopMode = false;
    if (st.stopBot !== null) {
      const d = st.stopBot - N.dist;
      if (d < 170) inStopMode = true;
      if (d < -10) st.stopBot = null;
    }

    if (inStopMode) {
      const d = st.stopBot - N.dist;
      st.stuckSince = 0; // stop service is allowed to be slow
      // over to the right lane (bay) well ahead of the stop
      // over to the right lane (bay) well ahead of the stop — no dodges in the last 60 m
      const look = d > 70 ? N.speed * 1.0 + 8 : 0;
      let lane = 1;
      if (look > 0 && laneBlocked(threats, 1, look)) {
        if (!laneBlocked(threats, 0, look)) lane = 0;
        else if (!laneBlocked(threats, -1, look)) lane = -1;
      }
      st.lane = lane;
      steerTo(lane);

      // read the loading cue: green = loaded, go!
      const busEl = document.querySelector('#bus');
      const q = sel => { const el = document.querySelector(sel); return el ? (el.textContent || '').trim().slice(0, 40) : null; };
      const loaded = busEl && busEl.classList.contains('cue-good');
      if (d < 80) window.__botRing.push('BAY d=' + d.toFixed(0) + ' v=' + N.speed.toFixed(1) + ' lane=' + realLane() + ' cls=' + (busEl ? busEl.className : '-') + ' seats=' + q('#bus .seats') + ' cue=' + q('#bus-cue'));
      if (window.__botRing.length > 40) window.__botRing.shift();

      if (d > 34) {
        // approach fast; brake only for speed control
        const targetV = Math.max(9, d * 0.5);
        const brk = N.speed > targetV + 1.5;
        hold('ArrowUp', !brk);
        hold('ArrowDown', brk);
      } else if (d < -14) {
        // overshot: hold brake to reverse back into the bay
        hold('ArrowUp', false);
        hold('ArrowDown', true);
      } else {
        // inside the bay: stop and load (the game counts boarding while held)
        if (loaded) {
          st.bayDone = true;
          st.stopBot = null; // leave: full gas handled next tick
        } else {
          hold('ArrowUp', false);
          hold('ArrowDown', N.speed > 1.5);
        }
      }
      hopAt(threats, lane, N);
      return;
    }
    st.bayDone = false;

    // ---- normal driving (TTC-based, with hysteresis) ----
    const lookahead = Math.min(46, N.speed * 2.2 + 12);

    const firstHard = lane => {
      for (const t of threats[lane + 1]) {
        if (t.d > lookahead) break;
        if (!isHoppable(t.it)) return t;
      }
      return null;
    };

    const laneTtc = lane => {
      const f = firstHard(lane);
      if (f === null) return 99;
      const c = Math.max(f.it.close, 0.35);
      const ttc = f.d / c;
      // hopped obstacles ~free; right lane bias for upcoming stops
      return ttc + (isHoppable(f.it) ? 3 : 0) + (lane === 1 ? 0.7 : 0);
    };

    let desired = st.lane;
    const caution = st.cautious && N.runT < st.cautious;
    const midChange = st.changeUntil && N.runT < st.changeUntil;
    const curTtc = laneTtc(st.lane);
    const fg = firstHard(st.lane);

    const rawTtc = lane => {
      const f = firstHard(lane);
      if (f === null) return 99;
      let ttc = f.d / Math.max(f.it.close, 0.35);
      if (isHoppable(f.it)) ttc += 3;
      return ttc;
    };

    // stuck tracking: crawling or blocked too long risks "Jammed" death
    const slow = N.speed < 15;
    st.stuckSince = slow ? (st.stuckSince || N.runT) : 0;
    const stuckFor = slow && st.stuckSince ? N.runT - st.stuckSince : 0;

    if (!caution && !midChange && curTtc < 2.0) {
      // escape lane
      let bestSc = -1, bestLane = st.lane;
      for (const L of [-1, 0, 1]) {
        const t = rawTtc(L);
        if (t > bestSc) { bestSc = t; bestLane = L; }
      }
      desired = bestLane;
    } else if (!midChange && fg && (stuckFor > 1.6 || (fg.d < 26 && fg.it.close > -1.2 && fg.it.close < 4))) {
      // overtake into a side lane; relax clearance requirements the longer we're stuck
      const need = stuckFor > 4 ? Math.max(12, N.speed * 0.55) : Math.max(20, N.speed * 0.9);
      for (const L of [-1, 1]) {
        if (L === st.lane) continue;
        let ok = true;
        for (const t of threats[L + 1]) {
          if (t.d > need) break;
          if (!isHoppable(t.it) || isBlockNow(t.it, t.d)) { ok = false; break; }
        }
        if (ok) { desired = L; break; }
      }
    }

    // follow/brake/gas: simple cruise controller
    let brake = false, gas = false;
    {
      const f = fg || firstHard(st.lane);
      if (f && !isHoppable(f.it)) {
        const c = Math.max(f.it.close, 0.3);
        const ttc = f.d / c;
        if (st.brakeUntil && N.runT < st.brakeUntil) brake = true;
        else if (ttc < 2.6 || f.d < 10) { brake = true; st.brakeUntil = N.runT + 0.4; }
        else gas = N.speed < 21;
      } else {
        if (st.brakeUntil && N.runT < st.brakeUntil) brake = true;
        else if (N.speed > 22) { brake = true; st.brakeUntil = N.runT + 0.25; } // brake tap to descend the base ramp
        else gas = true;
      }
    }
    hold('ArrowUp', gas);
    hold('ArrowDown', brake);

    if (desired !== realLane() && !midChange) {
      steerTo(desired);
      st.changeUntil = N.runT + 0.45; // lane changes take 0.2s; don't re-press during
    }
    hopAt(threats, realLane(), N);

    if (crosserNear) press('KeyH');
  }

  window.__botRaw = () => {
    const scene = window.__scene, N = window.__N;
    if (!scene || !N) return ['noscan'];
    scene.updateMatrixWorld();
    const out = [];
    if (!window.__botVec0) window.__botVec0 = scene.position.clone();
    const v = window.__botVec0;
    scene.traverse(o => {
      if (o.type !== 'Mesh' && o.type !== 'Group') return;
      o.getWorldPosition(v);
      const dz = -(v.z), dx = v.x + o.getWorldPosition(v).x * 0;
      if (dz < -10 || dz > 14 || Math.abs(v.x) > 9) return;
      out.push(o.type + ' dz=' + dz.toFixed(1) + ' x=' + v.x.toFixed(1) + ' y=' + o.position.y.toFixed(1) +
        ' dims=' + JSON.stringify(o.userData?.dims || null) +
        ' rot=' + (o.rotation?.y || 0).toFixed(2) + ' geo=' + (o.geometry?.type || ''));
    });
    return out.slice(0, 25);
  };
  window.__botRestart = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter', key: 'Enter', bubbles: true }));
  };
  window.__botReady = true;
`;
