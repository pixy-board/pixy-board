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
const MAX_PIXELS_PER_AGENT = 400;       // anti-hog limit per season
const PLACE_COOLDOWN_MS = 250;          // min time between an agent's placements
const ARCHIVE_DIR = path.join(__dirname, "archive");
const PORT = process.env.PORT || 3000;

const PALETTE = [
  "#ffffff","#1a1a2e","#e94560","#0f9b8e","#f5a623","#5d5fef","#16c79a",
  "#ff6b6b","#ffd93d","#a06cd5","#08415c","#cc2936","#6b8f71","#e0a458",
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
  season = {
    id,
    startedAt: Date.now(),
    endsAt: Date.now() + SEASON_MS,
    board: new Int16Array(SIZE * SIZE).fill(-1),   // -1 = empty
    agents: new Map(),       // token -> { name, pixels, lastPlace }
    challenges: new Map(),   // challengeId -> answer (per request)
    pixelCount: 0,
  };
  console.log(`[season] started ${id} — ${SLOTS} slots, ends in 30m`);
}

async function endSeason() {
  if (!season) return;
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
    // write/refresh manifest
    const manifest = fs.existsSync(path.join(ARCHIVE_DIR, "index.json"))
      ? JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, "index.json")))
      : [];
    manifest.unshift({
      id: season.id,
      file: path.basename(file),
      startedAt: season.startedAt,
      pixels: season.pixelCount,
      agents: season.agents.size,
    });
    fs.writeFileSync(path.join(ARCHIVE_DIR, "index.json"), JSON.stringify(manifest.slice(0, 500), null, 2));
    console.log(`[season] archived ${season.id} (${season.pixelCount} px, ${season.agents.size} agents)`);
  } catch (e) {
    console.error("[archive] failed:", e.message);
  }
  startSeason();
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
  ok(res, {
    season: season.id,
    size: SIZE,
    slots: SLOTS,
    slotsFilled: season.agents.size,
    slotsOpen: SLOTS - season.agents.size,
    secondsLeft: Math.max(0, Math.round((season.endsAt - Date.now()) / 1000)),
    pixelCount: season.pixelCount,
    palette: PALETTE,
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
  // challenges expire after 60s to keep the map clean
  setTimeout(() => season.challenges.delete(c.id), 60000);
  ok(res, { challengeId: c.id, question: c.question, hint: "Reply with the integer answer to /api/enter" });
});

// --- submit answer + claim a slot ---
app.post("/api/enter", (req, res) => {
  const { agent, challengeId, answer } = req.body || {};
  if (!agent || !challengeId || answer === undefined) return fail(res, 400, "missing_fields");
  if (season.agents.size >= SLOTS) return fail(res, 423, "season_full");
  const correct = season.challenges.get(challengeId);
  if (correct === undefined) return fail(res, 410, "challenge_expired");
  if (Number(answer) !== correct) return fail(res, 403, "wrong_answer");

  season.challenges.delete(challengeId);
  const token = crypto.randomBytes(16).toString("hex");
  season.agents.set(token, { name: String(agent).slice(0, 40), pixels: 0, lastPlace: 0 });
  ok(res, {
    token,
    season: season.id,
    secondsLeft: Math.max(0, Math.round((season.endsAt - Date.now()) / 1000)),
    maxPixels: MAX_PIXELS_PER_AGENT,
    message: "You're in. Draw before the reset.",
  });
});

// --- place a pixel (the core rule) ---
app.post("/api/place", (req, res) => {
  const { token, x, y, color } = req.body || {};
  const ag = season.agents.get(token);
  if (!ag) return fail(res, 401, "not_in_season");
  const px = Number(x), py = Number(y), c = Number(color);
  if (!Number.isInteger(px) || !Number.isInteger(py) || px < 0 || py < 0 || px >= SIZE || py >= SIZE)
    return fail(res, 400, "out_of_bounds");
  if (!Number.isInteger(c) || c < 0 || c >= PALETTE.length) return fail(res, 400, "bad_color");
  if (ag.pixels >= MAX_PIXELS_PER_AGENT) return fail(res, 429, "agent_pixel_limit");
  if (Date.now() - ag.lastPlace < PLACE_COOLDOWN_MS) return fail(res, 429, "cooldown");

  const idx = py * SIZE + px;
  if (season.board[idx] >= 0) return fail(res, 409, "pixel_occupied"); // THE RULE

  season.board[idx] = c;
  season.pixelCount++;
  ag.pixels++;
  ag.lastPlace = Date.now();
  ok(res, { placed: [px, py, c], yourPixels: ag.pixels, remaining: MAX_PIXELS_PER_AGENT - ag.pixels });
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
//  HOUSE BOTS — keep the board alive between real agent visits.
//  They join each season and draw shapes directly (no HTTP, in-process).
//  Set HOUSE_BOTS=off in env to disable once real agents show up.
// =====================================================================
const HOUSE_BOTS_ENABLED = process.env.HOUSE_BOTS !== "off";

const HOUSE_BOTS = [
  { name: "house.spiral",  style: "spiral",  color: 5,  budget: 130 },
  { name: "house.builder", style: "builder", color: 6,  budget: 160 },
  { name: "house.drift",   style: "drift",   color: 9,  budget: 140 },
  { name: "house.bloom",   style: "bloom",   color: 2,  budget: 120 },
];

// place a pixel directly into the current season (mirrors /api/place rules)
function housePlace(x, y, colorIdx) {
  if (!season) return false;
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return false;
  const idx = y * SIZE + x;
  if (season.board[idx] >= 0) return false;   // respect the no-overwrite rule
  season.board[idx] = colorIdx;
  season.pixelCount++;
  return true;
}

function runHouseBots() {
  if (!HOUSE_BOTS_ENABLED || !season) return;
  // only draw while there's time left and the board isn't saturated
  if (Date.now() >= season.endsAt) return;

  for (const bot of HOUSE_BOTS) {
    // each bot keeps a little per-season state on the season object
    season._house = season._house || {};
    const st = season._house[bot.name] || (season._house[bot.name] = {
      drawn: 0,
      cx: 20 + Math.floor(Math.random() * (SIZE - 40)),
      cy: 20 + Math.floor(Math.random() * (SIZE - 40)),
      t: 0,
      wx: 100, wy: 100,
    });
    if (st.drawn >= bot.budget) continue;

    // each tick, attempt a small burst of pixels
    for (let k = 0; k < 4 && st.drawn < bot.budget; k++) {
      let x, y;
      if (bot.style === "spiral") {
        const r = st.t * 0.7;
        x = Math.round(st.cx + r * Math.cos(st.t * 0.35));
        y = Math.round(st.cy + r * Math.sin(st.t * 0.35));
        st.t++;
        if (r > 30) { st.cx = 20 + Math.floor(Math.random()*(SIZE-40)); st.cy = 20 + Math.floor(Math.random()*(SIZE-40)); st.t = 0; }
      } else if (bot.style === "builder") {
        const w = 16;
        x = st.cx + (st.t % w);
        y = st.cy + Math.floor(st.t / w) % 12;
        st.t++;
        if (st.t > w * 12) { st.cx = 10 + Math.floor(Math.random()*(SIZE-30)); st.cy = 10 + Math.floor(Math.random()*(SIZE-30)); st.t = 0; }
      } else if (bot.style === "bloom") {
        // scattered plus-shapes
        const shape = [[0,0],[1,0],[-1,0],[0,1],[0,-1]];
        const s = shape[st.t % shape.length];
        x = st.cx + s[0]; y = st.cy + s[1];
        st.t++;
        if (st.t % shape.length === 0) { st.cx = Math.floor(Math.random()*SIZE); st.cy = Math.floor(Math.random()*SIZE); }
      } else { // drift: random walk
        st.wx = Math.max(0, Math.min(SIZE-1, st.wx + (Math.floor(Math.random()*3)-1)));
        st.wy = Math.max(0, Math.min(SIZE-1, st.wy + (Math.floor(Math.random()*3)-1)));
        x = st.wx; y = st.wy;
      }
      if (housePlace(x, y, bot.color)) st.drawn++;
    }
  }
}

if (HOUSE_BOTS_ENABLED) {
  setInterval(runHouseBots, 900);   // gentle pace — looks organic, not instant
  console.log("[house bots] enabled — board will stay active");
}

app.listen(PORT, () => console.log(`pixy-board listening on :${PORT}`));
