// Heuristic — hand-written rules, no AI. Reads the live Three.js scene, steers, brakes, hops and serves bus stops.
export const name = 'heuristic';
export const tick = 'window.__botRun()';
export const script = /* js */ `
  const LANE_X = 3.4;
  const SPEED_CAP = 22; // m/s: above this we tap the brake to descend the base ramp
  const FOLLOW_GAS = 21; // m/s: below this we keep gassing while following traffic
  const JUMP_V = 9.2, GRAV = 27; // game jump physics (apex 9.2² / (2·27) ≈ 1.57 m)
  const CLEAR_MARGIN = 0.15; // game clears an obstacle while p.y > h - 0.15
  const HALF_US = 1.5; // contact starts at d ≈ it.l/2 + 0.8–1.6 (measured from scrapes); take the conservative end
  const TICK_DT = 0.1; // worst-case game seconds between two decide ticks; jump window needs this much spare
  const HOP_LOCK = 0.8; // game seconds after launch (airtime ≈ 0.68): no second Space press, no wall/lane-change
  const LAP = 4300; // metres per lap; STOPS are hardcoded offsets within it — update both if the course changes
  const STOPS = [230, 500, 890, 1230, 1660, 2060, 2620, 2980, 3480, 3790, 4150];

  const st = {
    lane: 0,
    stopBot: null,
    keyState: {},
    lastPress: {},
  };

  function press(code, force) {
    const now = performance.now();
    if (!force && now - (st.lastPress[code] || 0) < 350) return false; // force: emergency dodge skips the debounce
    st.lastPress[code] = now;
    const key = code === 'Space' ? ' ' : code;
    window.dispatchEvent(new KeyboardEvent('keydown', { code, key, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code, key, bubbles: true }));
    return true;
  }

  function hold(code, on) {
    // braking mid-air cancels the jump instantly (measured: y 1.29 → 0 in one tick), so never brake while airborne
    if (code === 'ArrowDown' && on && (hopCommitted() || (window.__botPY || 0) > 0.12)) on = false;
    if (st.keyState[code] === on) return;
    st.keyState[code] = on;
    window.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code, key: code, bubbles: true }));
  }

  function realLane() {
    const px = window.__botPX;
    if (px == null) return st.lane;
    return Math.max(-1, Math.min(1, Math.round(px / LANE_X))); // mid-change x can read out of range
  }

  function steerTo(lane, force) {
    const cur = realLane();
    st.lane = lane; // intended
    if (cur === lane) return; // confirmed there
    const dir = lane > cur ? 'ArrowRight' : 'ArrowLeft';
    press(dir, force);
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
      const rec = seen.get(o) || { D, close: 0, t: N.runT }; // unseen: assume static
      let close = rec.close; // world-frame approach speed (+ toward us, − same direction); reuse last trusted value
      const dt = N.runT - rec.t;
      const dD = rec.D - D;
      if (dt > 0.02 && Math.abs(dD) < 14) close = Math.max(-40, Math.min(70, dD / dt)); // teleport/recycle → distrust
      rec.close = close; rec.D = D; rec.t = N.runT;
      seen.set(o, rec);
      const px = v.x, pz = v.z;
      const isPlayer = Math.abs(pz) < 2.6 && Math.abs(px % LANE_X) < 0.35;
      if (isPlayer) { window.__botPX = px; window.__botPY = v.y; }
      items.push({
        kind: ud.kind, type: ud.type, lane: ud.lane,
        x: px, y: v.y, z: pz,
        h: ud.dims.h, w: ud.dims.w, l: ud.dims.l, close, rel: N.speed + close, player: isPlayer, // rel = true closing speed
      });
    });
    if (seen.size > 400) seen.clear();
    return { N, items };
  }

  function nextStop(N) {
    const lap = Math.floor(N.dist / LAP);
    for (const s of STOPS) {
      const at = lap * LAP + s;
      if (at - N.dist > 190) return at;
    }
    return null;
  }

  // Seconds (after launch) during which the jump is above h - CLEAR_MARGIN: [t1, t2].
  function clearWindow(h) {
    const y = Math.max(0, h - CLEAR_MARGIN);
    const disc = JUMP_V * JUMP_V - 2 * GRAV * y; // roots of V·t − G/2·t² = y
    if (disc <= 0) return null; // can't reach that height
    const r = Math.sqrt(disc);
    return [(JUMP_V - r) / GRAV, (JUMP_V + r) / GRAV];
  }
  // hop-able only if we stay above the obstacle for its whole length at current speed
  function isHoppable(it) {
    const w = clearWindow(it.h);
    if (!w) return false;
    return (w[1] - w[0]) * Math.max(it.rel, 6) >= it.l + 2 * HALF_US + Math.max(it.rel, 6) * TICK_DT;
  }

  // mid-jump (or just launched): the hop is committed — don't re-press, swerve, or treat the target as a wall
  function hopCommitted() {
    const N = window.__N;
    return !!(st.hopT && N && N.runT - st.hopT < HOP_LOCK && N.runT >= st.hopT);
  }

  // block decision on top of the game's collision test: slow-closing traffic in our lane
  // auto-matches our speed → followable tailgate; hoppable stuff is only a wall when too late to hop
  function isBlockNow(it, d) {
    if (isHoppable(it)) {
      if (!hopCommitted() && d < 3.5 && it.rel > 1) return true; // too late to hop, hard wall now
      return false; // we'll hop it
    }
    if (it.rel < 0.6) return false; // outpacing/stationary-relative: not urgent
    const ttc = d / it.rel;
    return ttc < 2.2 || d < 9;
  }

  function laneBlocked(threats, lane, within) {
    for (const t of threats[lane + 1]) {
      if (t.d > within) break;
      if (isBlockNow(t.it, t.d)) return true;
    }
    return false;
  }

  function hopAt(threats, lane, N) {
    if (hopCommitted()) return; // one press per jump (the debounce is wall-clock, the game runs slower)
    for (const t of threats[lane + 1]) {
      if (!isHoppable(t.it)) continue;
      // launch so the above-obstacle window opens as the obstacle reaches us
      const w = clearWindow(t.it.h);
      // ideal launch distance: the jump window opens exactly as contact starts (d = l/2 + HALF_US)
      // launching up to spare metres earlier is fine (the window just opens before contact)
      const rel = Math.max(t.it.rel, 6);
      const c = rel * w[0] + t.it.l / 2 + HALF_US;
      const spare = (w[1] - w[0]) * rel - (t.it.l + 2 * HALF_US);
      if (t.d <= c + spare && t.d > c - 0.3) {
        hold('ArrowDown', false); // release the brake first or the jump is cut short
        if (press('Space')) {
          st.hopT = N.runT;
          (window.__botTrace || (window.__botTrace = [])).push('HOP-PRESS t=' + N.runT.toFixed(2) + ' d=' + t.d.toFixed(1) + ' c=' + c.toFixed(1) + ' spare=' + spare.toFixed(1) + ' h=' + t.it.h + ' l=' + t.it.l + ' rel=' + rel.toFixed(1));
        }
        break;
      }
    }
  }

  // build a printable threat summary each decide tick (single source of truth)
  function summary(N, threats) {
    return threats.map(a => a.map(t => (isHoppable(t.it) ? '' : '!h' + t.it.h) + '@' + t.d.toFixed(0) + 'r' + t.it.rel.toFixed(1)).join(',') || '-').join(' | ');
  }

  window.__botRun = () => {
    if (window.__N && window.__N.mode !== 'play') {
      st.keyState = {}; // fresh hold state each run
      st.stopBot = null; st.brakeUntil = 0; st.changeUntil = 0;
      st.cautious = 0; st.stuckSince = 0; st.bayDone = false; st.hopT = 0; st.stopTarget = null; st.stopHold = 0;
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

    const lookahead = Math.min(46, N.speed * 2.2 + 12);

    // lane score: TTC to the first hard obstacle, plus credit for the time gap before the second
    // (so we don't dodge into a lane whose next obstacle is right behind the first)
    const laneScore = lane => {
      const hard = [];
      for (const t of threats[lane + 1]) {
        if (t.d > lookahead) break;
        if (!isHoppable(t.it)) { hard.push(t); if (hard.length === 2) break; }
      }
      if (!hard.length) return 99;
      const f = hard[0];
      const ttc = f.d / Math.max(f.it.rel, 0.35);
      const gap = hard.length > 1 ? (hard[1].d - f.d) / Math.max(N.speed, 8) : 3;
      let sc = ttc + 0.4 * Math.min(gap, 3);
      // two-lane moves cross the middle lane: penalise if it's occupied nearby
      if (Math.abs(lane - realLane()) === 2 && laneBlocked(threats, 0, 14)) sc -= 3;
      return sc;
    };

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
      // over to the right lane (bay) well ahead of the stop; fall back to a free lane if it's blocked
      const look = Math.min(46, N.speed * 1.0 + 8);
      // prefer the bay lane, then stay put, then the others. Slow traffic ahead that we're catching
      // up to makes a lane "occupied"; far from the bay we avoid those so we don't step back into
      // a lane we just left (flip-flop), near the bay we only refuse lanes that are an imminent hazard.
      const cur = realLane();
      // a lane change moves one lane per press, so every lane we pass through must be clear too
      const pathClear = L => {
        for (let k = cur; k !== L; ) { k += Math.sign(L - k); if (laneBlocked(threats, k, look)) return false; }
        return true;
      };
      const occupied = L => {
        for (const t of threats[L + 1]) {
          if (t.d > look) break;
          if (!isHoppable(t.it) && t.it.rel > 0.6) return true;
        }
        return false;
      };
      const free = L => !laneBlocked(threats, L, look) && (d < 60 || !occupied(L));
      let lane = cur;
      const holding = st.stopHold && N.runT < st.stopHold && st.stopTarget != null && !laneBlocked(threats, st.stopTarget, 16);
      if (holding) {
        lane = st.stopTarget; // dwell: don't re-decide right after a lane decision
      } else {
        let picked = null;
        for (const L of [1, cur, 0, -1]) {
          if (pathClear(L) && free(L)) { picked = L; break; }
        }
        if (picked === null) { // every lane is occupied: take the most open reachable one, mild stay bias
          let best = -Infinity;
          for (const L of [1, cur, 0, -1]) {
            if (!pathClear(L)) continue;
            const sc = laneScore(L) + (L === cur ? 0.5 : 0);
            if (sc > best) { best = sc; picked = L; }
          }
        }
        if (picked !== null) lane = picked;
        if (lane !== st.stopTarget) { st.stopTarget = lane; st.stopHold = N.runT + 0.8; window.__botStopChanges = (window.__botStopChanges || 0) + 1; }
      }
      if (hopCommitted()) lane = realLane();
      st.lane = lane;
      steerTo(lane);

      // read the loading cue: green = loaded, go!
      const busEl = document.querySelector('#bus');
      const q = sel => { const el = document.querySelector(sel); return el ? (el.textContent || '').trim().slice(0, 40) : null; };
      const loaded = busEl && busEl.classList.contains('cue-good');
      if (d < 80) window.__botRing.push('BAY d=' + d.toFixed(0) + ' v=' + N.speed.toFixed(1) + ' lane=' + realLane() + ' cls=' + (busEl ? busEl.className : '-') + ' seats=' + q('#bus .seats') + ' cue=' + q('#bus-cue'));
      if (window.__botRing.length > 40) window.__botRing.shift();

      // something solid in our lane: brake for it; if impact is imminent and the bay is still
      // far, abandon this stop and dodge rather than plow into it
      let blocker = null;
      for (const t of threats[realLane() + 1]) {
        if (t.d > 30) break;
        if (!isHoppable(t.it) && isBlockNow(t.it, t.d)) { blocker = t; break; }
      }
      if (blocker && d > 12 && blocker.d / Math.max(blocker.it.rel, 0.35) < 1.5) {
        for (const L of [0, -1, 1]) {
          if (Math.abs(L - realLane()) === 1 && !laneBlocked(threats, L, 24)) { st.stopBot = null; steerTo(L, true); break; } // nextStop skips stops <190 m ahead
        }
      }

      (window.__botTrace || (window.__botTrace = [])).push('t=' + N.runT.toFixed(2) + ' dist=' + N.dist.toFixed(0) + ' bay=' + d.toFixed(0) + ' v=' + N.speed.toFixed(1) + ' rlane=' + realLane() + ' y=' + (window.__botPY ?? 0).toFixed(2) + ' want=' + lane + ' blocker=' + (blocker ? blocker.d.toFixed(0) + 'm/r' + blocker.it.rel.toFixed(1) + '/h' + blocker.it.h : '-') + ' | ' + summary(N, threats));
      if (window.__botTrace.length > 80) window.__botTrace.shift();

      if (d > 34) {
        // approach fast; brake only for speed control
        const targetV = Math.min(SPEED_CAP, Math.max(9, d * 0.5));
        const brk = blocker ? true : N.speed > targetV + 1.5;
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
          hold('ArrowDown', blocker ? true : N.speed > 1.5);
        }
      }
      hopAt(threats, lane, N);
      return;
    }
    st.bayDone = false;

    // ---- normal driving (TTC-based, with hysteresis) ----
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
      const c = Math.max(f.it.rel, 0.35);
      const ttc = f.d / c;
      // hopped obstacles ~free; right lane bias for upcoming stops
      return ttc + (isHoppable(f.it) ? 3 : 0) + (lane === 1 ? 0.7 : 0);
    };

    let desired = st.lane;
    const caution = st.cautious && N.runT < st.cautious;
    const midChange = (st.changeUntil && N.runT < st.changeUntil) || hopCommitted();
    const curTtc = laneTtc(st.lane);
    const fg = firstHard(st.lane);

    // stuck tracking: crawling or blocked too long risks "Jammed" death
    const slow = N.speed < 15;
    st.stuckSince = slow ? (st.stuckSince || N.runT) : 0;
    const stuckFor = slow && st.stuckSince ? N.runT - st.stuckSince : 0;

    if (!caution && !midChange && curTtc < 2.0) {
      // escape lane
      let bestSc = -1, bestLane = st.lane;
      for (const L of [-1, 0, 1]) {
        const t = laneScore(L) + (L === st.lane ? 0.5 : 0); // mild stay bias
        if (t > bestSc) { bestSc = t; bestLane = L; }
      }
      desired = bestLane;
    } else if (!midChange && fg && (stuckFor > 1.6 || fg.d < 26)) {
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
        const c = Math.max(f.it.rel, 0.3);
        const ttc = f.d / c;
        if (st.brakeUntil && N.runT < st.brakeUntil) brake = true;
        else if (ttc < 2.6 || f.d < 10) { brake = true; st.brakeUntil = N.runT + 0.4; }
        else gas = N.speed < FOLLOW_GAS;
      } else {
        if (st.brakeUntil && N.runT < st.brakeUntil) brake = true;
        else if (N.speed > SPEED_CAP) { brake = true; st.brakeUntil = N.runT + 0.25; } // brake tap to descend the base ramp
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
