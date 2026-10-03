// Jev — TypeSafe AI's "System One" decision model (https://vercel.com/docs/ai-gateway/modalities/evaluation).
// The page side only perceives (compact scene snapshot) and actuates (keys). Every decision is made by
// the Jev API: each cycle it gets the snapshot as `state` plus three typed questions — lane, pedal, hop —
// and the answers are applied as key presses. No driving rules live in this file besides the prompts.
//
// Needs AI_GATEWAY_API_KEY (Vercel AI Gateway). Optional: JEV_MODEL (default typesafe-ai/jev).
export const name = 'jev';
export const tick = ''; // nothing page-side per tick; decisions arrive through attach().onTick

const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/evaluate';
const MODEL = process.env.JEV_MODEL || 'typesafe-ai/jev';

export const script = /* js */ `
  const LANE_X = 3.4;
  const STOPS = [230, 500, 890, 1230, 1660, 2060, 2620, 2980, 3480, 3790, 4150];
  let keyState = {};
  const lastPress = {};
  const seen = new Map();
  let vec = null, playerX = null;

  const fire = (type, code) =>
    window.dispatchEvent(new KeyboardEvent(type, { code, key: code === 'Space' ? ' ' : code, bubbles: true }));
  const press = code => {
    const now = performance.now();
    if (now - (lastPress[code] || 0) < 350) return;
    lastPress[code] = now; fire('keydown', code); fire('keyup', code);
  };
  const hold = (code, on) => {
    if (keyState[code] === on) return;
    keyState[code] = on; fire(on ? 'keydown' : 'keyup', code);
  };
  const curLane = () => (playerX == null ? 0 : Math.max(-1, Math.min(1, Math.round(playerX / LANE_X))));
  const LANE_NAMES = ['left', 'center', 'right'];

  function nextStopAhead(N) {
    const lap = Math.floor(N.dist / 4300);
    for (const s of STOPS) { const at = lap * 4300 + s; if (at - N.dist > -10) return at - N.dist; }
    return null;
  }

  // Compact snapshot of what is on the road. Closing speed is measured per object from distance deltas.
  window.__perceive = () => {
    const scene = window.__scene, N = window.__N;
    if (!scene || !N) return null;
    if (N.mode !== 'play') { keyState = {}; return { mode: N.mode }; }
    scene.updateMatrixWorld();
    const lanes = [[], [], []];
    scene.traverse(o => {
      const ud = o.userData;
      if (!ud || !ud.dims) return;
      if (!vec) vec = o.position.clone();
      o.getWorldPosition(vec);
      const D = N.dist - vec.z;
      const rec = seen.get(o) || { D, close: 15, t: N.runT };
      const dt = N.runT - rec.t, dD = rec.D - D;
      if (dt > 0.02 && Math.abs(dD) < 14) rec.close = Math.max(-2, Math.min(70, dD / dt));
      rec.D = D; rec.t = N.runT; seen.set(o, rec);
      const { h, w, l } = ud.dims;
      if (Math.abs(vec.z) < 2.6 && Math.abs(vec.x % LANE_X) < 0.35) { playerX = vec.x; return; } // our own danfo
      const d = -vec.z;
      if (d < 2.5 || d > 60) return;
      if (w < 1.2 && l < 1.2 && h < 1.2) return; // coin / pickup
      for (const L of [-1, 0, 1]) {
        if (Math.abs(vec.x - L * LANE_X) < w * 0.46 + 0.85)
          lanes[L + 1].push({ aheadM: Math.round(d), heightM: +h.toFixed(1), hopable: h <= 1.6 && l <= 14, closingMps: +rec.close.toFixed(1) });
      }
    });
    if (seen.size > 400) seen.clear();
    for (const a of lanes) a.sort((x, y) => x.aheadM - y.aheadM);
    const stopAhead = nextStopAhead(N);
    const bus = document.querySelector('#bus');
    return {
      mode: 'play',
      you: { lane: LANE_NAMES[curLane() + 1], speedMps: Math.round(N.speed), scrapedRecently: (N.slow ?? 1) < 0.8 },
      road: { left: lanes[0].slice(0, 4), center: lanes[1].slice(0, 4), right: lanes[2].slice(0, 4) },
      busStop: stopAhead !== null && stopAhead < 200
        ? { aheadM: Math.round(stopAhead), passengersLoaded: !!(bus && bus.classList.contains('cue-good')) }
        : null,
    };
  };

  // answers: { lane: 'left'|'stay'|'right', pedal: 'gas'|'coast'|'brake', hop: boolean }
  window.__act = a => {
    const N = window.__N;
    if (!N || N.mode !== 'play') return;
    const cur = curLane();
    const target = Math.max(-1, Math.min(1, cur + (a.lane === 'left' ? -1 : a.lane === 'right' ? 1 : 0)));
    if (target !== cur) press(target > cur ? 'ArrowRight' : 'ArrowLeft');
    hold('ArrowUp', a.pedal === 'gas');
    hold('ArrowDown', a.pedal === 'brake');
    if (a.hop) press('Space');
  };
  window.__botRestart = () => { fire('keydown', 'Enter'); fire('keyup', 'Enter'); };
  window.__botReady = true;
`;

const QUESTIONS = {
  lane: {
    type: 'choice',
    instructions:
      'You drive a danfo bus down a 3-lane road (left, center, right) and must survive. Which lane change should happen now? ' +
      'Obstacles in a lane have aheadM (metres), closingMps (how fast the gap is shrinking; ~0 means it moves with you) and ' +
      'hopable (true = the bus can jump over it, so it is NOT a threat). Leave your lane only if a non-hopable obstacle there is ' +
      'close or closing fast (time to collision under ~2.5 s), and only toward a lane with no such threat; otherwise stay. ' +
      'If busStop is within 170 m, be in the right lane.',
    criteria: { left: 'move one lane left', stay: 'keep the current lane', right: 'move one lane right' },
  },
  pedal: {
    type: 'choice',
    instructions:
      'Which pedal for the next fraction of a second? Cruise around 18-21 m/s. Brake if a non-hopable obstacle in your own ' +
      'lane is under ~12 m ahead or will be reached in under ~2.6 s. Coast if you are above ~22 m/s. Bus stop: approach ' +
      'steadily, slow to a halt when busStop.aheadM is under ~15, stay stopped until passengersLoaded is true, then gas.',
    criteria: { gas: 'accelerate', coast: 'release both pedals', brake: 'brake / slow down' },
  },
  hop: {
    type: 'boolean',
    instructions:
      'Should the bus jump right now? True only if a hopable obstacle in YOUR lane is between about 1.5 m and ' +
      '(4 + 0.1 x speedMps) metres ahead. False otherwise.',
  },
};

/** Node-side controller: polls the page, asks Jev, applies the answers. Never blocks the game loop. */
export function attach(page) {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) throw new Error('Jev needs AI_GATEWAY_API_KEY (Vercel AI Gateway key) in the environment');
  let inflight = false, closed = false, fatal = null;
  const latencies = [];
  let calls = 0, errors = 0, costUsd = 0, inTok = 0;

  async function cycle() {
    const state = await page.evaluate('window.__perceive()');
    if (!state || state.mode !== 'play') return;
    const t0 = Date.now();
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state, questions: QUESTIONS }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      if (res.status === 401 || res.status === 403 || res.status === 404) { fatal = new Error(`Jev API ${res.status}: ${body}`); fatal.fatal = true; }
      throw new Error(`Jev API ${res.status}`);
    }
    const j = await res.json();
    latencies.push(Date.now() - t0); calls++;
    inTok += j.usage?.inputTokens || 0;
    costUsd += Number(j.providerMetadata?.gateway?.cost || 0);
    const a = j.answers || {};
    await page.evaluate(act => window.__act(act), {
      lane: a.lane?.choice ?? 'stay',
      pedal: a.pedal?.choice ?? 'gas',
      hop: (a.hop?.probability ?? 0) >= 0.5,
    });
  }

  return {
    onTick() {
      if (fatal) throw fatal;
      if (inflight || closed) return;
      inflight = true;
      cycle().catch(() => { if (!closed) errors++; }).finally(() => { inflight = false; });
    },
    close() { closed = true; },
    summary() {
      const s = [...latencies].sort((x, y) => x - y);
      return {
        apiCalls: calls, apiErrors: errors,
        meanLatencyMs: s.length ? Math.round(s.reduce((x, y) => x + y, 0) / s.length) : 0,
        p95LatencyMs: s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0,
        inputTokens: inTok, costUsd: +costUsd.toFixed(6),
      };
    },
  };
}
