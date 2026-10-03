# jev-danfo

Benchmarks two players of [Lagos Run](https://danfo.horpey.dev/) head to head:

- **heuristic** — `bot.js` / `players/heuristic.js`: hand-written rules, **no AI**.
- **jev** — `players/jev.js`: [Jev by TypeSafe AI](https://vercel.com/docs/ai-gateway/modalities/evaluation), a decision model called through Vercel AI Gateway. It gets a compact scene snapshot and answers three typed questions (lane, pedal, hop).

```bash
export AI_GATEWAY_API_KEY=...          # only needed for jev
RUNS=10 node bench.js                  # alternating heuristic/jev runs, results/bench-*.json
PLAYERS=heuristic node bench.js        # no key needed
```

The rest of this file describes the heuristic bot's internals.

The heuristic bot plays [Lagos Run](https://danfo.horpey.dev/) — the Lagos danfo-bus
browser game — live in a headless (or headed) Chromium via Playwright, reading the game's actual
Three.js scene state and driving the danfo with synthetic keyboard events.

## Contents

- `bot.js` — the bot. Hooks into the live game state, scans the Three.js scene for traffic /
hazards / coins, then steers, brakes, hops and honks to maximize score.
- `probe.js` — small utilities for poking at the game's scene while it's running.
- `death-*.png` — crash-moment screenshots from past runs (debugging artifacts).
- `runs/notes.md` — tuning notes from debugging sessions.



## How it works

Lagos Run is a Three.js game with everything closure-scoped — no public `window.game`. The bot
gets at it with two hooks injected before the page loads:

1. **Game-state object** `N` — captured via an `Object.assign` hook that watches for the call
  that adds `coinStreak` (a field unique to the state object). Gives `mode`, `score`, `dist`,
   `speed`, `gas`, `brake`, `slow` (scrape indicator), `invuln`, etc.
2. **Three.js scene** — the bundle exposes a `__THREE_DEVTOOLS__` global to dispatch custom
  events to; both the `Scene` and `WebGLRenderer` constructors announce themselves on it.
   The bot wraps `renderer.render` to grab the current scene each frame.

Every ~80 ms the bot:

- traverses the scene and records, per mesh, its world position + measured closure speed
(via per-object distance deltas) — this distinguishes parked cars, oncoming traffic and
sliding obstacles;
- classifies lanes as blocked / followable / hop-able using the game's own collision math
(`|Δx| < w*0.46 + 0.85` and jump apex `9.2² / (2·27) ≈ 1.57 m`, so anything with
`h ≤ 1.6` can be hopped);
- serves bus stops: over to the right lane well in advance, brake into the yellow box
(`BRIS` stop schedule inside `bot.js`), hold there to load passengers;
- drives the game via synthetic `KeyboardEvent` dispatch on `window` (the game listens on
`window` keydown/keyup), with debouncing and hold-state tracking so gas / brake / steer /
Space / horn behave like real keys.

After death it restarts via `Enter` (the game's universal `Te.go()` handler) and keeps a
`best` score across runs.

## Usage

```bash
npm install                # installs playwright
npx playwright install chromium   # once, to fetch the browser

node bot.js                # one run, headless, until death
RUNS=3 node bot.js         # 3 runs
RUN_TIME=180 node bot.js   # cap a whole session at 3 minutes
HEADED=1 node bot.js       # watch it play in a real window
```

Observability is built in: score progression logs every 5 s, crash-moment screenshots
(`death-*.png`), a ring-buffer of recent ticks dumped on death, a toast capture of in-game
messages (`__jevToasts`), and raw near-player scene dumps.

## Debuggables

Everything lives in the page-side scripts (`initScript` / `botScript` inside `bot.js`):

- `window.__N` — game state
- `window.__scene` — live Three.js scene
- `window.__botRun()` — one bot decision tick (drives input)
- `window.__botState()` — current bot-visible state
- `window.__botRestart()` — synthetic `Enter`
- `window.__botRing` — rolling decision log (last 40 ticks)



## Notes & gotchas discovered the hard way

- The game pauses on window blur (`we(true)`); keep the Playwright page focused.
- Restarting from death is guarded (`N.deadT > .9`), so the restart helper just pounds `Enter`
until a new run begins — that's intentional.
- A second scrape within `stumbleWindow = 4 s` is fatal; the bot enters a brief "cautious mode"
(no lane changes) after any bump so a pothole + scrape chain doesn't kill a run.
- The game silently slows traffic in your own lane to your speed, so slow-approach traffic is
a follow, not a dodge.
- The bus stop must actually be *entered* (stop within the yellow box, right lane) — braking
to a full stop short of the bay stalls the run.

