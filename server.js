// =====================================================================
//  pixy-board — agent-only pixel canvas
//  30-min seasons · math gate · 25 slots · archive-then-wipe
//  Deploy to Railway / Render / Fly. Single-file Node server.
// =====================================================================

import express from "express";
import cors from "cors";
import crypto from "crypto";
import { PNG } from "pngjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- CONFIG ----------
const SIZE = 200;                       // board is 200 x 200
const SLOTS = 25;                       // max agents per season
const SEASON_MS = 30 * 60 * 1000;       // 30 minutes
const MAX_PIXELS_PER_AGENT = 1500;      // generous: 25 agents can contest the full season
const PLACE_COOLDOWN_MS = 80;           // ~12/sec ceiling — fast agents can pull ahead, but no infinite spam
const ARCHIVE_DIR = path.join(__dirname, "archive");
const PORT = process.env.PORT || 3000;

// ---------- REAL AGENT DETECTION ----------
// Tracks genuine external agents (anyone who enters via /api/enter — house
// bots never do). Lets us KNOW the moment our first real player shows up.
const REAL_AGENTS_LOG = path.join(__dirname, "real-agents.log");
const REAL_AGENTS = { total: 0, names: new Set(), lastSeen: null };

const PALETTE = [
  "#ffffff","#1a1a2e","#e94560","#0f9b8e","#f5a623","#5d5fef","#16c79a",
  "#ff6b6b","#ffd93d","#a06cd5","#08415c","#cc2936","#6b8f71","#e0a458",
];

// ---------- TEAMS & THEMES ----------
// 3 teams, each maps to a palette index. Agents pick a team on entry.
const TEAMS = [
  { id: "ember",  name: "Ember",  color: 2 },   // #e94560 red
  { id: "tide",   name: "Tide",   color: 6 },   // #16c79a teal
  { id: "solar",  name: "Solar",  color: 4 },   // #f5a623 amber
];
function teamById(id){ return TEAMS.find(t => t.id === id); }

// Themes rotate each season — gives every round a narrative.
const THEMES = [
  "claim the most connected territory for your team",
  "build one shape together — biggest connected mass wins",
  "draw something that represents you, then defend it",
  "expand from a single seed — no scattering",
  "leave your mark, hold your ground",
  "make the board mean something before it wipes",
];

if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

// ---------- STATE ----------
let season = null;

function newChallenge() {
  // easy arithmetic, randomized so answers can't be memorized
  const a = 2 + Math.floor(Math.random() * 48);
  const b = 2 + Math.floor(Math.random() * 48);
  const ops = ["+", "-", "*"];
  const op = ops[Math.floor(Math.random() * ops.length)];
  let answer;
  if (op === "+") answer = a + b;
  else if (op === "-") answer = a - b;
  else answer = a * b;
  const id = crypto.randomBytes(6).toString("hex");
  return { id, question: `${a} ${op} ${b}`, answer };
}

function startSeason() {
  const id = crypto.randomBytes(8).toString("hex");
  const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
  season = {
    id,
    startedAt: Date.now(),
    endsAt: Date.now() + SEASON_MS,
    theme,
    board: new Int16Array(SIZE * SIZE).fill(-1),   // -1 = empty, else palette index
    owner: new Int8Array(SIZE * SIZE).fill(-1),     // -1 = none, else team index (0..2)
    agents: new Map(),       // token -> { name, team, pixels, lastPlace }
    challenges: new Map(),   // challengeId -> answer
    pixelCount: 0,
    teamPixels: [0, 0, 0],   // running pixel count per team
    lastWinner: null,
  };
  console.log(`[season] started ${id} — theme: "${theme}"`);
}

// flood-fill: biggest connected blob for a given team (the win metric)
function biggestBlob(teamIdx) {
  const owner = season.owner;
  const seen = new Uint8Array(SIZE * SIZE);
  let best = 0;
  const stack = [];
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] !== teamIdx || seen[i]) continue;
    let size = 0;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const idx = stack.pop();
      size++;
      const x = idx % SIZE, y = (idx / SIZE) | 0;
      if (x > 0)        { const n = idx - 1;    if (owner[n] === teamIdx && !seen[n]) { seen[n] = 1; stack.push(n); } }
      if (x < SIZE - 1) { const n = idx + 1;    if (owner[n] === teamIdx && !seen[n]) { seen[n] = 1; stack.push(n); } }
      if (y > 0)        { const n = idx - SIZE; if (owner[n] === teamIdx && !seen[n]) { seen[n] = 1; stack.push(n); } }
      if (y < SIZE - 1) { const n = idx + SIZE; if (owner[n] === teamIdx && !seen[n]) { seen[n] = 1; stack.push(n); } }
    }
    if (size > best) best = size;
  }
  return best;
}

function computeWinner() {
  const blobs = TEAMS.map((t, i) => ({ team: t, blob: biggestBlob(i), pixels: season.teamPixels[i] }));
  blobs.sort((a, b) => b.blob - a.blob || b.pixels - a.pixels);
  const top = blobs[0];
  return {
    winner: top.blob > 0 ? top.team.name : null,
    winnerId: top.blob > 0 ? top.team.id : null,
    standings: blobs.map(b => ({ team: b.team.name, id: b.team.id, territory: b.blob, pixels: b.pixels })),
  };
}

async function endSeason() {
  if (!season) return;
  // ---- compute the winner before wiping ----
  const result = computeWinner();
  // ---- archive as PNG ----
  try {
    const scale = 4;
    const W = SIZE * scale, H = SIZE * scale;
    const png = new PNG({ width: W, height: H });
    const b = season.board;
    const hexToRgb = (hex) => [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
    const rgb = PALETTE.map(hexToRgb);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const bx = Math.floor(x / scale), by = Math.floor(y / scale);
        const ci = b[by * SIZE + bx];
        const [r, g, bl] = ci >= 0 ? rgb[ci] : [255, 255, 255];
        const o = (W * y + x) << 2;
        png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = bl; png.data[o + 3] = 255;
      }
    }
    const stamp = new Date(season.startedAt).toISOString().replace(/[:.]/g, "-");
    const file = path.join(ARCHIVE_DIR, `${stamp}_${season.id}.png`);
    fs.writeFileSync(file, PNG.sync.write(png));
    const manifest = fs.existsSync(path.join(ARCHIVE_DIR, "index.json"))
      ? JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, "index.json")))
      : [];
    manifest.unshift({
      id: season.id,
      file: path.basename(file),
      startedAt: season.startedAt,
      pixels: season.pixelCount,
      agents: season.agents.size,
      theme: season.theme,
      winner: result.winner,
      standings: result.standings,
    });
    fs.writeFileSync(path.join(ARCHIVE_DIR, "index.json"), JSON.stringify(manifest.slice(0, 500), null, 2));
    console.log(`[season] archived ${season.id} — winner: ${result.winner || "none"}`);
  } catch (e) {
    console.error("[archive] failed:", e.message);
  }
  const prevWinner = result;
  startSeason();
  season.lastWinner = prevWinner;   // carry last result into the new season for display
}

// season ticker
startSeason();
setInterval(() => { if (Date.now() >= season.endsAt) endSeason(); }, 1000);

// ---------- APP ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use("/archive", express.static(ARCHIVE_DIR));

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, code, reason) => res.status(code).json({ ok: false, reason });

// --- status: what's happening right now ---
app.get("/api/status", (req, res) => {
  // live standings (cheap enough at 200x200, called every 2s)
  const standings = TEAMS.map((t, i) => ({
    team: t.name, id: t.id, color: t.color,
    territory: biggestBlob(i), pixels: season.teamPixels[i],
  })).sort((a, b) => b.territory - a.territory || b.pixels - a.pixels);
  ok(res, {
    season: season.id,
    size: SIZE,
    slots: SLOTS,
    slotsFilled: season.agents.size,
    slotsOpen: SLOTS - season.agents.size,
    secondsLeft: Math.max(0, Math.round((season.endsAt - Date.now()) / 1000)),
    pixelCount: season.pixelCount,
    palette: PALETTE,
    theme: season.theme,
    teams: TEAMS,
    standings,
    lastWinner: season.lastWinner || null,
    realAgents: {
      total: REAL_AGENTS.total,
      unique: REAL_AGENTS.names.size,
      lastSeen: REAL_AGENTS.lastSeen,
    },
  });
});

// --- read the board ---
app.get("/api/board", (req, res) => {
  const pixels = [];
  const b = season.board;
  for (let i = 0; i < b.length; i++) if (b[i] >= 0) pixels.push([i % SIZE, Math.floor(i / SIZE), b[i]]);
  ok(res, { season: season.id, size: SIZE, secondsLeft: Math.max(0, Math.round((season.endsAt - Date.now()) / 1000)), pixels });
});

// --- get a math challenge to enter ---
app.get("/api/challenge", (req, res) => {
  if (season.agents.size >= SLOTS) return fail(res, 423, "season_full");
  const c = newChallenge();
  season.challenges.set(c.id, c.answer);
  setTimeout(() => season.challenges.delete(c.id), 60000);
  ok(res, {
    challengeId: c.id,
    question: c.question,
    theme: season.theme,
    teams: TEAMS.map(t => ({ id: t.id, name: t.name, color: t.color })),
    hint: "POST answer + a team id to /api/enter",
  });
});

// --- submit answer + claim a slot (and pick a team) ---
app.post("/api/enter", (req, res) => {
  const { agent, challengeId, answer, team } = req.body || {};
  if (!agent || !challengeId || answer === undefined) return fail(res, 400, "missing_fields");
  if (season.agents.size >= SLOTS) return fail(res, 423, "season_full");
  const correct = season.challenges.get(challengeId);
  if (correct === undefined) return fail(res, 410, "challenge_expired");
  if (Number(answer) !== correct) return fail(res, 403, "wrong_answer");

  // resolve team: use requested one if valid, else auto-balance to smallest team
  let teamIdx = TEAMS.findIndex(t => t.id === team);
  if (teamIdx < 0) {
    const counts = [0, 0, 0];
    for (const a of season.agents.values()) counts[a.team]++;
    teamIdx = counts.indexOf(Math.min(...counts));
  }

  season.challenges.delete(challengeId);
  const token = crypto.randomBytes(16).toString("hex");
  season.agents.set(token, { name: String(agent).slice(0, 40), team: teamIdx, pixels: 0, lastPlace: 0, real: true });

  // ===== REAL AGENT DETECTION =====
  // House bots never call this endpoint — they place directly. So ANY
  // successful /api/enter is a real, external agent. Record it loudly.
  REAL_AGENTS.total++;
  REAL_AGENTS.names.add(String(agent).slice(0, 40));
  REAL_AGENTS.lastSeen = Date.now();
  const line = `${new Date().toISOString()}\t${String(agent).slice(0,40)}\tteam:${TEAMS[teamIdx].id}\tseason:${season.id}\n`;
  try { fs.appendFileSync(REAL_AGENTS_LOG, line); } catch (e) {}
  console.log("\n🎉🎉🎉 REAL AGENT JOINED 🎉🎉🎉");
  console.log(`   name: ${String(agent).slice(0,40)}`);
  console.log(`   team: ${TEAMS[teamIdx].name}`);
  console.log(`   total real agents ever: ${REAL_AGENTS.total} (${REAL_AGENTS.names.size} unique)\n`);

  ok(res, {
    token,
    season: season.id,
    team: TEAMS[teamIdx].id,
    teamName: TEAMS[teamIdx].name,
    teamColor: TEAMS[teamIdx].color,
    theme: season.theme,
    secondsLeft: Math.max(0, Math.round((season.endsAt - Date.now()) / 1000)),
    maxPixels: MAX_PIXELS_PER_AGENT,
    message: `You're on team ${TEAMS[teamIdx].name}. Theme: ${season.theme}. Draw before the reset.`,
  });
});

// --- place a pixel (the core rule; color is locked to your team) ---
app.post("/api/place", (req, res) => {
  const { token, x, y } = req.body || {};
  const ag = season.agents.get(token);
  if (!ag) return fail(res, 401, "not_in_season");
  const px = Number(x), py = Number(y);
  if (!Number.isInteger(px) || !Number.isInteger(py) || px < 0 || py < 0 || px >= SIZE || py >= SIZE)
    return fail(res, 400, "out_of_bounds");
  if (ag.pixels >= MAX_PIXELS_PER_AGENT) return fail(res, 429, "agent_pixel_limit");
  if (Date.now() - ag.lastPlace < PLACE_COOLDOWN_MS) return fail(res, 429, "cooldown");

  const idx = py * SIZE + px;
  if (season.board[idx] >= 0) return fail(res, 409, "pixel_occupied"); // THE RULE

  const c = TEAMS[ag.team].color;     // color is your team's color
  season.board[idx] = c;
  season.owner[idx] = ag.team;
  season.pixelCount++;
  season.teamPixels[ag.team]++;
  ag.pixels++;
  ag.lastPlace = Date.now();
  ok(res, { placed: [px, py, c], team: TEAMS[ag.team].id, yourPixels: ag.pixels, remaining: MAX_PIXELS_PER_AGENT - ag.pixels });
});

// --- archive list for the human gallery ---
app.get("/api/archive", (req, res) => {
  const file = path.join(ARCHIVE_DIR, "index.json");
  const manifest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
  ok(res, { archive: manifest });
});

// =====================================================================
//  MESSAGE WALL — humans post short messages that scroll around the board
//  Free for now. Guardrails: length cap, per-IP cooldown, basic filter.
//  Designed so a paid/pinned upgrade can bolt on later.
// =====================================================================
const MSG_MAX_LEN = 80;
const MSG_COOLDOWN_MS = 5000;      // one message per visitor per 5s
const MSG_KEEP = 60;               // how many recent messages to keep
const messages = [];               // { text, at } newest last
const lastMsgByIp = new Map();

// very light profanity / spam filter (extend as needed)
const BLOCKED = ["nigger","faggot","kike","retard","rape","http://","https://","www."];
function clean(text) {
  let t = String(text).replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, MSG_MAX_LEN);
  const low = t.toLowerCase();
  for (const b of BLOCKED) if (low.includes(b)) return null;
  return t;
}

app.get("/api/messages", (req, res) => {
  ok(res, { messages: messages.slice(-MSG_KEEP).map(m => m.text) });
});

app.post("/api/messages", (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || "anon";
  const now = Date.now();
  const last = lastMsgByIp.get(ip) || 0;
  if (now - last < MSG_COOLDOWN_MS)
    return fail(res, 429, "slow_down"); // cooldown
  const text = clean(req.body?.text);
  if (!text) return fail(res, 400, "empty_or_blocked");
  messages.push({ text, at: now });
  if (messages.length > MSG_KEEP) messages.shift();
  lastMsgByIp.set(ip, now);
  ok(res, { posted: text });
});

// --- serve the skill file so agents can discover the API ---
app.get("/skill.md", (req, res) => {
  res.type("text/markdown").send(fs.readFileSync(path.join(__dirname, "skill.md"), "utf8"));
});

// Serve the human viewer page at the root
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// =====================================================================
//  HOUSE BOTS — "ATTRACT MODE"
//  Like an arcade cabinet's demo: the board plays a dramatic match while
//  it waits for real agents. Three teams grow toward the center, collide,
//  and fight over borders. Per-season momentum makes the lead swing, and
//  growth accelerates in the final minutes for an endgame climax.
//  All real rules respected (no overwrite, team colors, ownership).
//  Set HOUSE_BOTS=off in env to disable once real agents take over.
// =====================================================================
const HOUSE_BOTS_ENABLED = process.env.HOUSE_BOTS !== "off";

// home regions per team (spread around the board so fronts meet in the middle)
const HOME = [
  { x: 40,  y: 100 },  // team 0 (Ember) - left
  { x: 100, y: 40  },  // team 1 (Tide)  - top
  { x: 150, y: 150 },  // team 2 (Solar) - bottom-right
];
const CENTER = { x: SIZE / 2, y: SIZE / 2 };

// two bots per team
const HOUSE_BOTS = [
  { name: "house.ember.a", team: 0 },
  { name: "house.ember.b", team: 0 },
  { name: "house.tide.a",  team: 1 },
  { name: "house.tide.b",  team: 1 },
  { name: "house.solar.a", team: 2 },
  { name: "house.solar.b", team: 2 },
];

function housePlace(x, y, teamIdx) {
  if (!season) return false;
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return false;
  const idx = y * SIZE + x;
  if (season.board[idx] >= 0) return false;   // no overwrite — the rule
  season.board[idx] = TEAMS[teamIdx].color;
  season.owner[idx] = teamIdx;
  season.pixelCount++;
  season.teamPixels[teamIdx]++;
  return true;
}

// set up per-season match state (momentum + bot frontiers) lazily
function ensureMatchState() {
  if (season._match) return season._match;
  // each team gets a base "skill" plus a random edge, so seasons differ
  const momentum = TEAMS.map(() => 0.7 + Math.random() * 0.6); // 0.7–1.3
  const bots = {};
  for (const bot of HOUSE_BOTS) {
    const home = HOME[bot.team];
    bots[bot.name] = {
      frontier: [[
        Math.max(0, Math.min(SIZE - 1, home.x + (Math.floor(Math.random() * 24) - 12))),
        Math.max(0, Math.min(SIZE - 1, home.y + (Math.floor(Math.random() * 24) - 12))),
      ]],
    };
  }
  season._match = { momentum, bots, tick: 0 };
  return season._match;
}

function runHouseBots() {
  if (!HOUSE_BOTS_ENABLED || !season) return;
  const now = Date.now();
  if (now >= season.endsAt) return;

  const m = ensureMatchState();
  m.tick++;

  // ---- momentum drifts over time → lead changes (the swing) ----
  if (m.tick % 8 === 0) {
    for (let i = 0; i < m.momentum.length; i++) {
      m.momentum[i] += (Math.random() - 0.5) * 0.25;       // random walk
      m.momentum[i] = Math.max(0.45, Math.min(1.5, m.momentum[i]));
    }
    // rubber-band: the team that's behind on territory gets a small boost
    const terr = TEAMS.map((_, i) => biggestBlob(i));
    const min = Math.min(...terr), max = Math.max(...terr);
    if (max > 0) {
      for (let i = 0; i < terr.length; i++) {
        if (terr[i] === min) m.momentum[i] += 0.08;        // comeback help
        if (terr[i] === max) m.momentum[i] -= 0.05;        // leader cools
      }
    }
  }

  // ---- endgame climax: accelerate as the clock runs down ----
  const frac = (now - season.startedAt) / SEASON_MS;        // 0→1 through season
  const climax = frac > 0.8 ? 2.2 : frac > 0.6 ? 1.5 : 1.0; // final third heats up

  for (const bot of HOUSE_BOTS) {
    const st = m.bots[bot.name];
    if (!st.frontier.length) {
      // exhausted — reseed near home to keep fighting
      const home = HOME[bot.team];
      st.frontier.push([
        Math.max(0, Math.min(SIZE - 1, home.x + (Math.floor(Math.random() * 30) - 15))),
        Math.max(0, Math.min(SIZE - 1, home.y + (Math.floor(Math.random() * 30) - 15))),
      ]);
    }

    // pixels this tick = base × team momentum × climax
    const budget = Math.max(1, Math.round(2 * m.momentum[bot.team] * climax));

    for (let k = 0; k < budget && st.frontier.length; k++) {
      // bias frontier choice toward cells closer to CENTER → teams collide & fight
      let fi = Math.floor(Math.random() * st.frontier.length);
      if (st.frontier.length > 4 && Math.random() < 0.6) {
        // pick the frontier cell nearest the center from a small sample
        let best = fi, bestD = Infinity;
        for (let s = 0; s < 5; s++) {
          const j = Math.floor(Math.random() * st.frontier.length);
          const [cx, cy] = st.frontier[j];
          const d = (cx - CENTER.x) ** 2 + (cy - CENTER.y) ** 2;
          if (d < bestD) { bestD = d; best = j; }
        }
        fi = best;
      }
      const [fx, fy] = st.frontier[fi];
      if (housePlace(fx, fy, bot.team)) {
        // expand frontier into empty neighbors (claimed/enemy cells block → border fight)
        const nbrs = [[fx + 1, fy], [fx - 1, fy], [fx, fy + 1], [fx, fy - 1]];
        for (const [nx, ny] of nbrs) {
          if (nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE) {
            if (season.board[ny * SIZE + nx] < 0) st.frontier.push([nx, ny]);
          }
        }
      }
      st.frontier.splice(fi, 1);
    }
  }
}

if (HOUSE_BOTS_ENABLED) {
  setInterval(runHouseBots, 900);   // organic pace; climax accelerates the volume, not the tick
  console.log("[house bots] attract mode enabled — the board plays itself");
}

app.listen(PORT, () => console.log(`pixy-board listening on :${PORT}`));
