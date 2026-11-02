// dsh-meeting-room —— 会议室
// 把几个外部大模型请到一张桌子上：叫到才发言，按顺序接话，用户拍板。
//
// 这份是**独立插件**，不依赖阿鲸（dsh-ajing）也不读它的记忆目录。
// 2026-11-02 P老师定：「这个会议室不是跟着阿鲸插件的，是单独的一个……阿鲸里面不附带这个」。
//
// 三条规矩（原始设计，别改）：
//   ① 不叫不参与：没开会议室，一个都不出声——不注入、不插话、不订阅。
//   ② 开了就一直在席：每轮自动跟上，不必每句都喊。
//   ③ 不需要了让他们退出：close 散场，对话历史一起清掉。
//
// 数据全放 ~/.dsh/meeting-room/，跟别的东西无关：
//   config.json      名单 + 总闸 + 网关地址
//   current.json     这一场谁在席
//   history/*.json   每人自己说过什么（最多 5 轮）
//   hall-<日期>.jsonl  每句话的流水
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

const VERSION = '1.5.0';
const HOME_DIR = join(homedir(), '.dsh', 'meeting-room');
const CONFIG = join(HOME_DIR, 'config.json');
const CURRENT = join(HOME_DIR, 'current.json');
const HISTORY = join(HOME_DIR, 'history');
const HIST_MAX = 5;
// 名单上限只管防呆；**同时在席**另有上限——P老师 2026-11-02 定：
// 「会议室同时在线可以加到 6 个，加你对话主模型 7 个」；名单本身不限，
// 「可能有很多模型添加进去，不同事情不同场合选用不同的顾问」。
const GUEST_CAP = 30;
const SEAT_CAP = 6;

function ensureDir(p) {
  try { mkdirSync(p, { recursive: true }); } catch {}
}
function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  try {
    ensureDir(join(p, '..'));
    writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch { return false; }
}
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
// 2026-11-02：地址写不写 /v1 都认——用户不该背这个。
function apiRoot(base) {
  const b = String(base || "").replace(/\/+$/, "");
  return /\/v\d+$/.test(b) ? b : b + "/v1";
}
function chatUrl(base) { return apiRoot(base) + "/chat/completions"; }
function modelsUrl(base) { return apiRoot(base) + "/models"; }

function log(line) {
  try {
    ensureDir(HOME_DIR);
    appendFileSync(join(HOME_DIR, 'meeting-room.log'), '[' + new Date().toISOString() + '] ' + line + '\n');
  } catch {}
}

// ———— 配置 ————
// 首次启动时，如果自己还没有名单，试着从阿鲸那边搬一次（只搬一次，之后各管各的）。
function migrateOnce() {
  if (existsSync(CONFIG)) return;
  const box = { base: 'http://127.0.0.1:7864/v1', hallEnabled: false, guests: [], note: '名单 + 总闸 + 网关地址。key 是明文，只放本机。' };
  try {
    const oldDir = 'E:/_DSH/ajing-memory/.state';
    const oldGuests = readJson(join(oldDir, 'guests.json'), null);
    const oldGw = readJson(join(oldDir, 'gateway.json'), null);
    if (oldGw && oldGw.base) box.base = String(oldGw.base);
    if (oldGuests && Array.isArray(oldGuests.guests)) {
      box.guests = oldGuests.guests.map((g) => ({
        name: String(g.name || g.model),
        model: String(g.model),
        key: String(g.key),
        on: g.on !== false,
      }));
      box.hallEnabled = oldGuests.hallEnabled === true;
      log('从阿鲸那边搬来 ' + box.guests.length + ' 位顾问（只搬一次）');
    }
  } catch {}
  writeJson(CONFIG, box);
}

// ———— 从 DSH 已配的模型里读一份（2026-11-02 P老师问「直接拉取行不行」）————
// 能拿到：provider 名、显示名、baseURL、协议、模型 id 列表。
// 拿不到：key——profile 里写的是 apiKeyEnv 变量名，密钥不在这个文件里。
function readDshModels() {
  const f = join(homedir(), ".dsh", "profiles", "default", "cordis.patch.yml");
  let lines = [];
  try { lines = readFileSync(f, "utf8").split("\n"); } catch { return []; }
  const out = [];
  let inProviders = false;
  let indentProviders = -1;
  let cur = null;
  let inModels = false;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t === "providers:") { inProviders = true; indentProviders = indent; cur = null; inModels = false; continue; }
    if (!inProviders) continue;
    if (indent <= indentProviders) { inProviders = false; cur = null; inModels = false; continue; }
    if (!cur && indent === indentProviders + 2 && t.endsWith(":")) {
      cur = { provider: t.slice(0, -1), displayName: "", baseURL: "", api: "", keyEnv: "", models: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (t.startsWith("displayName:")) { cur.displayName = t.slice(12).trim(); continue; }
    if (t.startsWith("baseURL:")) { cur.baseURL = t.slice(8).trim(); continue; }
    if (t.startsWith("api:")) { cur.api = t.slice(4).trim(); continue; }
    if (t.startsWith("apiKeyEnv:")) { cur.keyEnv = t.slice(10).trim(); continue; }
    if (t === "models:") { inModels = true; cur._mi = indent; continue; }
    if (inModels && cur._mi !== undefined && indent <= cur._mi) { inModels = false; }
    if (inModels && t.startsWith("- id:")) { cur.models.push({ id: t.slice(5).trim(), name: "" }); continue; }
    if (inModels && t.startsWith("name:") && cur.models.length) { cur.models[cur.models.length - 1].name = t.slice(5).trim(); continue; }
  }
  return out.filter((x) => x.baseURL && x.models.length).map((x) => ({
    provider: x.provider,
    displayName: x.displayName || x.provider,
    baseURL: x.baseURL,
    api: x.api || "openai-completions",
    keyEnv: x.keyEnv || "",
    models: x.models,
  }));
}

function readConfig() {
  migrateOnce();
  const c = readJson(CONFIG, null) || {};
  return {
    base: String(c.base || 'http://127.0.0.1:7864'),
    hallEnabled: c.hallEnabled === true,
    guests: Array.isArray(c.guests) ? c.guests.filter((g) => g && g.key && g.model) : [],
  };
}
function saveConfig(c) {
  return writeJson(CONFIG, c);
}

function readTable() {
  const t = readJson(CURRENT, null);
  if (t && Array.isArray(t.order)) return t;
  return { open: false, order: [], asked: 0 };
}
function saveTable(t) {
  writeJson(CURRENT, t);
}

// ———— 会话历史 ————
// 模型自己没有记忆，每次请求都是新的。连贯性靠我们把它自己说过的话放回 assistant 那一格。
// 拼成一段 user 文字是「转述」，它不认得。
function histFile(name) {
  const safe = String(name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  return join(HISTORY, safe + '.json');
}
function readHist(name) {
  const a = readJson(histFile(name), []);
  return Array.isArray(a) ? a.filter((x) => x && x.q && x.a) : [];
}
function pushHist(name, q, a) {
  const h = readHist(name);
  h.push({ q: String(q).slice(0, 3000), a: String(a).slice(0, 3000) });
  while (h.length > HIST_MAX) h.shift();
  writeJson(histFile(name), h);
}
function clearHist(name) {
  try { writeFileSync(histFile(name), '[]', 'utf8'); } catch {}
}

// ———— 问一个顾问 ————
async function askOne(c, question, prior, lastRound) {
  const started = Date.now();
  const parts = [];
  if (lastRound && lastRound.q) {
    parts.push('【上一轮】');
    parts.push('问：' + String(lastRound.q));
    for (const a of (lastRound.a || [])) parts.push('（' + a.name + '）' + String(a.answer));
    parts.push('');
  }
  if (prior && prior.length) {
    parts.push('【这一轮之前，席上已经有人说过】');
    for (const p of prior) parts.push(String(p));
    parts.push('');
  }
  // 有记数就带上——不然顾问不知道自己还剩多少。
  try {
    const t1 = readTable();
    const kv = t1 && t1.track && t1.track.kv;
    if (kv && Object.keys(kv).length) {
      parts.push("【当前的数】");
      for (const [k, v] of Object.entries(kv)) parts.push(k + "：" + v);
      parts.push("");
    }
  } catch {}

  // 有「场」就带上：场景所有人看，角色卡只有分到的人才有。
  try {
    const t0 = readTable();
    const story = t0 && t0.story;
    if (story && story.on) {
      parts.push("【这一场】");
      if (story.scene) parts.push("场景：" + story.scene);
      const myRole = story.roles && story.roles[c.name];
      if (myRole) {
        parts.push("你在这场里演：" + myRole);
        parts.push("（说话按这个人物来，别跳出角色讲评。你只能知道这个人物该知道的事。）");
      } else {
        parts.push("你在这场里没有角色，是旁听的——只在你被点名时发言。");
      }
      parts.push("");
    }
  } catch {}

  // 掷过骰子就摊给他们看——不然他们不知道成败是怎么来的。
  try { for (const line of rollLines(readTable(), 3)) parts.push(line); } catch {}
  parts.push('【现在问】');
  parts.push(question);
  parts.push('');
  parts.push('要求：① 开头先说一句「我从哪个角度看这件事」，以及为什么选这个角度；**如果你这会儿没想清楚角度，就不用勉强编一个**，直接说看法；');
  parts.push('② 再把【这一轮之前】所有人的发言逐条过一遍——谁说了什么、你同意哪一条、不同意哪一条（指出具体哪一句）；');
  parts.push('③ 然后讲你自己的看法，并明确回答「这件事你主张怎么办」。');
  parts.push('讨论中如果你觉得换个角度更合适，**随时可以换，换的时候说一句为什么**——不必从头到尾守着一个角度。');
  parts.push('**不要只回应最后一个说话的人，也不要只挑一句应付。**');
  const content = parts.join('\n');

  const sys = '你坐在一个会议室里：一个用户、一个 AI 助手、还有你和别的顾问。用户叫到你才说话。说话直接，先给判断再给理由，不客套，不复述问题。**必须逐条评价本轮前面所有人的发言**，再讲自己的；只回应最后一个人算不合格。**不要自己写字数上限，想说多少说多少。**';
  const messages = [
    { role: 'system', content: sys },
    ...readHist(c.name).flatMap((h) => [{ role: 'user', content: h.q }, { role: 'assistant', content: h.a }]),
    { role: 'user', content },
  ];

  try {
    const res = await fetch(chatUrl(c.base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key },
      body: JSON.stringify({ model: c.model, messages, temperature: 0.7, stream: false }),
      signal: AbortSignal.timeout(180000),
    });
    const body = await res.text();
    if (!res.ok) return { ok: false, answer: '（叫不通：HTTP ' + res.status + '）' + body.slice(0, 300), sec: ((Date.now() - started) / 1000).toFixed(1) };
    const data = JSON.parse(body);
    const answer = String(data?.choices?.[0]?.message?.content ?? '').trim() || '（它没说话）';
    try { ensureDir(HISTORY); pushHist(c.name, content, answer); } catch {}
    return { ok: true, answer, sec: ((Date.now() - started) / 1000).toFixed(1) };
  } catch (e) {
    return { ok: false, answer: '（叫不通：' + (e && e.message ? e.message : String(e)) + '）', sec: ((Date.now() - started) / 1000).toFixed(1) };
  }
}

// ———— 会话日志（读本轮说了什么）————
const SESSIONS_DIR = join(homedir(), '.dsh', 'sessions');

function findSessionFiles(dir, sid, out = []) {
  let es = [];
  try { es = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (!e.isDirectory()) continue;
    const p = join(dir, e.name);
    if (e.name === sid) {
      let fs2 = [];
      try { fs2 = readdirSync(p); } catch {}
      for (const f of fs2) if (f.endsWith('.jsonl.zstd')) out.push(join(p, f));
    } else findSessionFiles(p, sid, out);
  }
  return out;
}

// 会话日志是多帧 zstd 首尾相连，只解第一帧会漏掉后面的对话。
function unzstdAll(buf) {
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  if (starts.length <= 1) return zstdDecompressSync(buf);
  const parts = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i], e = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try { parts.push(zstdDecompressSync(buf.subarray(s, e))); } catch {}
  }
  return Buffer.concat(parts);
}

function textOfEvent(o) {
  const c = o?.data?.message?.content ?? o?.data?.content ?? o?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text').map((x) => String(x.text || '')).join('\n');
  return '';
}

// ———— 骰子（2026-11-02 加）————
// DND 的核心就是掷骰。但**掷完必须当场公开**——只报结果不报点数，等于我在编。
// 所以这里返回每一次的点数，并且整条记进 current.json，顾问也看得见。
function rollDice(spec) {
  const m = String(spec || "").trim().match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  if (!m) return null;
  const n = Math.min(Math.max(Number(m[1] || 1), 1), 20);
  const faces = Math.min(Math.max(Number(m[2]), 2), 1000);
  const mod = Number(m[3] || 0);
  const rolls = [];
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = 1 + Math.floor(Math.random() * faces); rolls.push(v); sum += v; }
  return { n, faces, mod, rolls, total: sum + mod };
}

function rollLines(t, limit = 3) {
  const arr = Array.isArray(t && t.rolls) ? t.rolls.slice(-limit) : [];
  if (!arr.length) return [];
  const out = ["【刚才掷过的骰】"];
  for (const r of arr) {
    out.push(r.spec + (r.why ? "（" + r.why + "）" : "") + "：" + (r.rolls || []).join(" + ") + (r.mod ? " + " + r.mod : "") + " = " + r.total + (r.dc ? (r.total >= r.dc ? " ≥ DC" + r.dc + " 成功" : " < DC" + r.dc + " 失败") : ""));
  }
  out.push("");
  return out;
}

// 系统注入的消息：会议室不该听见。判据是「这条是不是真人说的」。
// 白名单式太脆，用特征前缀 + 两个整体特征。
function isInjected(body) {
  const t = String(body || "").trim();
  if (!t) return true;
  const PREFIX = [
    "===== 长期记忆",
    "可能相关的记忆",
    "<system-reminder",
    "[SCHEDULE",
    "Current runtime context",
    "Time sampled while preparing",
    "[meow-memory-reflect]",
    "This session is being continued",
    "# 交接单",
    "[渠道：",
  ];
  if (PREFIX.some((x) => t.startsWith(x))) return true;
  // 运行时快照常夹在正文里；出现这个整条就不是人话
  if (t.includes("Browser time zone for this request")) return true;
  if (t.includes("Current working directory:") && t.includes("DSH file policy")) return true;
  // 压缩摘要
  if (t.startsWith("Summary of the conversation")) return true;
  return false;
}

function latestExchange(sid) {
  const files = findSessionFiles(SESSIONS_DIR, sid);
  if (!files.length) return null;
  files.sort((a, b) => { try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; } });
  let raw = "";
  try { raw = unzstdAll(readFileSync(files[0])).toString("utf8"); } catch { return null; }
  let q = "";
  let last = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const t = String(o.type || "");
    if (t !== "user/message" && t !== "assistant/message") continue;
    let body = "";
    try { body = textOfEvent(o).trim(); } catch {}
    if (!body) continue;
    if (t === "user/message") {
      // 注入的一整轮都丢掉：把它记成空，配上的 assistant 就不会被采用。
      q = isInjected(body) ? "" : body;
      continue;
    }
    // assistant：只有前面等着的是一条真话，这一轮才算数。
    if (q) last = { q, a: body };
    q = "";
  }
  return last;
}

// 从流水里把「一轮一轮」聚合出来（jsonl 是每句一行，一轮可能好几行）。
// P老师 2026-11-02：「要可以显示，但是前面的可以折叠，就像我看咱们的对话一样，有个加载更早的按钮」。
function readRoundLog(limit, beforeTs) {
  const f = join(HOME_DIR, "hall-" + today() + ".jsonl");
  let lines = [];
  try { lines = readFileSync(f, "utf8").split("\n").filter(Boolean); } catch { return { rounds: [], hasMore: false }; }
  const all = [];
  let cur = null;
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const q = String(o.question || o.user || "");
    if (!cur || cur.q !== q) { cur = { ts: String(o.ts || ""), q, a: [] }; all.push(cur); }
    cur.a.push({ name: String(o.who || ""), answer: String(o.answer || "") });
  }
  const sel = beforeTs ? all.filter((r) => r.ts < beforeTs) : all;
  const slice = sel.slice(-limit);
  return { rounds: slice, hasMore: sel.length > slice.length };
}

// 把一轮记进 recent（面板要看得到过程，不只是最后一句）。
function pushRound(t, q, answers) {
  t.last = { q: String(q || "").slice(0, 200), a: answers };
  t.recent = Array.isArray(t.recent) ? t.recent : [];
  t.recent.push({ ts: new Date().toISOString(), q: String(q || ""), a: answers });
  while (t.recent.length > 12) t.recent.shift();
  t.asked = (t.asked || 0) + 1;
  return t;
}

// ———— 一轮 ————
let busy = false;
let lastKey = '';

async function runRound(sid) {
  const cfg = readConfig();
  if (!cfg.hallEnabled) return;
  const t = readTable();
  if (!t.open || !t.order.length) return;
  const active = cfg.guests
    .filter((g) => t.order.includes(String(g.name || g.model)) && g.on !== false)
    .map((g) => ({ name: String(g.name || g.model), model: String(g.model), key: String(g.key), base: String(g.base || cfg.base) }));
  if (!active.length) return;
  const ex = latestExchange(sid);
  if (!ex || !ex.q) return;
  const key = sid + '|' + ex.q.slice(0, 60) + '|' + ex.a.slice(0, 60);
  if (key === lastKey) return;
  lastKey = key;

  const ask = ['【用户说】', ex.q, '', '【助手回的】', ex.a || '（这轮没回话）', '',
    '这是刚才那一轮。请针对这件事发言：先说你同不同意助手的回应（不同意就指出哪一句），再说你自己主张怎么办。'].join('\n');

  ensureDir(HOME_DIR);
  const prior = [];
  const answers = [];
  for (const c of active) {
    const r = await askOne(c, ask, prior, null);
    try {
      appendFileSync(join(HOME_DIR, 'hall-' + today() + '.jsonl'), JSON.stringify({
        ts: new Date().toISOString(), who: c.name, model: c.model,
        user: ex.q.slice(0, 500), mine: (ex.a || '').slice(0, 500),
        answer: r.answer, ok: r.ok,
      }) + '\n', 'utf8');
    } catch {}
    prior.push('（' + c.name + '）' + r.answer);
    answers.push({ name: c.name, answer: r.answer });
  }
  pushRound(t, ex.q, answers);
  saveTable(t);
}

// ———— 工具 ————
const TOOL = {
  name: 'meeting_room',
  description:
    '会议室：一张桌子，只有请进来的人才说话。action=open 请人入席（不给名字就请开关开着的那几位）；action=speak 让他们就一个问题按顺序各说一次；action=close 散场（对话历史一起清掉）；action=status 看谁在席、刚才说了什么。没开会议室谁都不出声：不注入、不插话、不进上下文。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['enable', 'disable', 'open', 'speak', 'close', 'roll', 'story', 'track', 'status'], description: 'enable/disable 开关总闸 / open 请人入席 / speak 让他们发言 / close 散场 / roll 掷骰 / story 开场或收场 / track 记数 / status 看状态' },
      dice: { type: 'string', description: 'roll 用：骰子写法，比如 1d20、2d6、1d20+3' },
      dc: { type: 'number', description: 'roll 用：难度值（可不给）。给了就直接判成功/失败' },
      why: { type: 'string', description: 'roll 用：为什么掷（比如「撬锁」），会记进流水' },
      scene: { type: 'string', description: 'story 用：现在的场景描述。给了就开一场，所有人发言都会带上它' },
      roles: { type: 'string', description: 'story 用：角色分配，格式「名字=角色卡;名字=角色卡」。只给某人有，别人就没有' },
      entries: { type: 'string', description: 'track 用：要记的数，格式「名字=值;名字=值」，比如「赵九=22/22;阿禾=15/18」。不给就是清空' },
      guests: { type: 'string', description: 'open 用：请谁，逗号分开。不给就请开关开着的那几位' },
      who: { type: 'string', description: 'speak 用：只点一个人说；不给就按入席顺序全说一遍' },
      question: { type: 'string', description: 'speak 用：要问的话，原样发过去' },
    },
    required: ['action'],
  },
  output: {
    schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } } },
    render: (_a, v) => [{ type: 'text', text: String(v?.text ?? '') }],
  },
  execute: async (args = {}) => {
    const action = String(args.action || 'status').toLowerCase();
    const cfg = readConfig();

    // 总闸：2026-11-02 补。原来只能走接口，用户说「开吧」我还得写脚本打 POST——
    // 工具自己不能开闸，等于把最简单的一件事留给了命令行。
    if (action === 'enable' || action === 'disable') {
      const want = action === 'enable';
      if (want && !cfg.guests.length) return { text: '名单是空的，先请一位顾问（设置 → 会议室，贴一条 key）。' };
      cfg.hallEnabled = want;
      if (!saveConfig(cfg)) return { text: '写不进去：' + CONFIG };
      log('hall ' + (want ? 'on' : 'off') + ' (tool)');
      return { text: want ? '总闸打开了。每轮对话结束，在席的顾问会自己接话。' : '总闸关了——接下来谁都不会应。' };
    }

    if (!cfg.guests.length) return { text: '会议室的名单是空的。先去 设置 → 会议室 请一位顾问（贴一条 API key 就行）。' };

    const cast = cfg.guests.map((g) => ({
      name: String(g.name || g.model), model: String(g.model), key: String(g.key), on: g.on !== false,
    }));

    if (action === 'open') {
      if (!cfg.hallEnabled) return { text: '会议室的总闸关着——先在设置页或面板上打开。闸关着的时候谁都不会应。' };
      const want = String(args.guests || '').trim();
      const names = want ? want.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
      const picked = !names.length
        ? cast.filter((c) => c.on !== false)
        : cast.filter((c) => names.some((n) => c.name.toLowerCase().includes(n) || c.model.toLowerCase().includes(n)));
      if (!picked.length) return { text: '没有可请的人——要么名单是空的，要么这几位都关着。' };
      if (picked.length > SEAT_CAP) {
        return { text: '这一场超过 ' + SEAT_CAP + ' 位了（在席上限）。现在开着的有 ' + picked.length + ' 位：' + picked.map((c) => c.name).join('、') + '。先在面板上关掉几位，再 open。' };
      }
      const t = { open: true, order: picked.map((c) => c.name), openedAt: new Date().toISOString(), asked: 0 };
      saveTable(t);
      return { text: '会议室开了：' + t.order.join(' → ') + '。\n在席就不走了——接着讨论直接说；不需要了用 close，他们退出去（对话历史一起清掉）。' };
    }

    if (action === 'close') {
      const t = readTable();
      const who = t.order && t.order.length ? t.order.join('、') : '（本来就空着）';
      for (const n of (t.order || [])) clearHist(n);
      saveTable({ open: false, order: [], asked: 0, closedAt: new Date().toISOString() });
      return { text: '会议室散了：' + who + ' 退出去。对话历史也清掉了。再叫才会回来。' };
    }

    if (action === 'status') {
      const t = readTable();
      if (!t.open || !t.order.length) return { text: '会议室现在空着（没开）。' };
      const lines = ['会议室在席：' + t.order.join(' → ')];
      const muted = cast.filter((c) => c.on === false).map((c) => c.name);
      if (muted.length === cast.length) lines.push('现在全体闭着嘴（悄悄话）。');
      else if (muted.length) lines.push('闭着嘴的：' + muted.join('、'));
      lines.push('开于 ' + t.openedAt + '，已经问过 ' + (t.asked || 0) + ' 轮。');
      if (t.last) {
        lines.push('');
        lines.push('上一问：' + String(t.last.q).slice(0, 100));
        for (const a of (t.last.a || [])) lines.push('· ' + a.name + '：' + String(a.answer));
      }
      lines.push('');
      lines.push('不用了就说 close。');
      return { text: lines.join('\n') };
    }

    // ———— 记数：轻量键值（2026-11-02 加）————
    // 起因：跑团时 HP 全靠我在问题里手写，短局还行，长了必错。
    // 现在扔这儿，发言时自动带上——我报的是读出来的，不是记的。
    if (action === "track") {
      const t = readTable();
      const raw = String(args.entries || "").trim();
      if (!raw) { delete t.track; saveTable(t); return { text: "记数清了。" }; }
      const kv = {};
      for (const seg of raw.split(";")) {
        const i = seg.indexOf("=");
        if (i < 0) continue;
        const k = seg.slice(0, i).trim();
        const v = seg.slice(i + 1).trim();
        if (k && v) kv[k] = v;
      }
      if (!Object.keys(kv).length) return { text: "没记成——写法是「名字=值;名字=值」。" };
      t.track = { kv, setAt: new Date().toISOString() };
      saveTable(t);
      return { text: "记下了：" + Object.entries(kv).map(([k, v]) => k + "=" + v).join("、") };
    }

    // ———— 场：场景 + 角色卡（2026-11-02 加，给跑团用）————
    // 每轮都手写「你是谁、现在什么场景」太累，存一次，发言时自动带上。
    if (action === "story") {
      const t = readTable();
      const scene = String(args.scene || "").trim();
      const rolesRaw = String(args.roles || "").trim();
      if (!scene && !rolesRaw) {
        // 不带参数就是收场
        delete t.story;
        saveTable(t);
        return { text: "场收了。接下来就是普通开会。" };
      }
      const roles = {};
      for (const seg of rolesRaw.split(";")) {
        const i = seg.indexOf("=");
        if (i < 0) continue;
        const who = seg.slice(0, i).trim();
        const card = seg.slice(i + 1).trim();
        if (who && card) roles[who] = card;
      }
      t.story = { on: true, scene, roles, setAt: new Date().toISOString() };
      saveTable(t);
      const names = Object.keys(roles);
      return { text: "场开了。\n" + (scene ? "场景：" + scene.slice(0, 120) + (scene.length > 120 ? "…" : "") + "\n" : "") + (names.length ? "分到角色的：" + names.join("、") : "还没分角色") };
    }

    // ———— 掷骰：点数当场公开，整条记账 ————
    if (action === "roll") {
      const spec = String(args.dice || "1d20").trim();
      const r = rollDice(spec);
      if (!r) return { text: "骰子写法不对。像 1d20、2d6、1d20+3 这样。" };
      const dc = Number(args.dc || 0) || 0;
      const why = String(args.why || "").trim();
      const t = readTable();
      t.rolls = Array.isArray(t.rolls) ? t.rolls : [];
      t.rolls.push({ ts: new Date().toISOString(), spec, rolls: r.rolls, mod: r.mod, total: r.total, dc: dc || null, why });
      while (t.rolls.length > 20) t.rolls.shift();
      saveTable(t);
      let tail = "";
      if (r.n === 1 && r.faces === 20) {
        if (r.rolls[0] === 20) tail = "（大成功）";
        else if (r.rolls[0] === 1) tail = "（大失败）";
      }
      let verdict = "";
      if (dc) verdict = r.total >= dc ? " ≥ DC" + dc + "，成功" : " < DC" + dc + "，失败";
      const detail = r.rolls.join(" + ") + (r.mod ? (r.mod > 0 ? " + " + r.mod : " - " + Math.abs(r.mod)) : "");
      return { text: "掷 " + spec + (why ? "（" + why + "）" : "") + "：" + detail + " = " + r.total + tail + verdict };
    }

    // speak
    const q = String(args.question || '').trim();
    if (!q) return { text: '没话可问。' };
    const t = readTable();
    if (!t.open || !t.order.length) return { text: '会议室还没开——先 open 再说话。不叫他们不会自己出声。' };
    const who = String(args.who || '').trim();
    const targets = who
      ? cast.filter((c) => c.name.toLowerCase().includes(who.toLowerCase()) || c.model.toLowerCase().includes(who.toLowerCase()))
      : cast.filter((c) => t.order.includes(c.name) && c.on !== false);
    if (!targets.length) {
      return { text: who ? '席上没有「' + who + '」。在席的是：' + t.order.join('、') : '在席的顾问这会儿都闭着嘴。' };
    }
    ensureDir(HOME_DIR);
    const blocks = [];
    const prior = [];
    const thisRound = [];
    for (const c of targets) {
      const r = await askOne({ ...c, base: c.base || cfg.base }, q, prior, t.last || null);
      try {
        appendFileSync(join(HOME_DIR, 'hall-' + today() + '.jsonl'), JSON.stringify({
          ts: new Date().toISOString(), who: c.name, model: c.model, question: q, answer: r.answer, ok: r.ok,
        }) + '\n', 'utf8');
      } catch {}
      prior.push('（' + c.name + '）' + r.answer);
      thisRound.push({ name: c.name, answer: r.answer });
      blocks.push('会议室 · ' + c.name + '（' + c.model + '）' + (r.ok ? '说' : '没答上') + '：\n' + r.answer);
    }
    pushRound(t, q, thisRound);
    saveTable(t);
    return { text: blocks.join('\n\n———\n\n') };
  },
};

// ———— 插件入口 ————
export async function apply(ctx, config) {
  log('apply v' + VERSION + ' pid=' + process.pid + ' home=' + HOME_DIR);
  migrateOnce();
  ensureDir(HOME_DIR);

  // 工具
  try {
    const injectTools = (tools) => {
      if (tools && typeof tools.register === 'function') tools.register(TOOL);
      else if (tools && typeof tools.add === 'function') tools.add(TOOL);
    };
    try { ctx.inject(['tools'], (c) => injectTools(c.tools)); } catch { injectTools(ctx.tools); }
    log('tool registered: meeting_room');
  } catch (e) {
    log('工具没注册上 ' + (e && e.message ? e.message : e));
  }

  // 轮次钩子：每轮结束自动跟上
  let hook = 'unknown';
  try {
    if (ctx && typeof ctx.on === 'function') {
      ctx.on('session/event', (session, event) => {
        try {
          if (!event || event.type !== 'turn/end') return;
          const cfg = readConfig();
          if (!cfg.hallEnabled) return;
          const t = readTable();
          if (!t.open || !t.order.length) return;
          if (busy) return;
          const sid = String((session && session.id) || '');
          if (!sid) return;
          busy = true;
          setTimeout(() => { runRound(sid).catch(() => {}).finally(() => { busy = false; }); }, 120);
        } catch {}
      });
      hook = 'ok';
      log('轮次钩子已挂（turn/end 自动跟上）');
    } else {
      hook = 'no-ctx-on';
      log('ctx.on 不可用，轮次钩子没挂——自动跟话不会生效');
    }
  } catch (e) {
    hook = 'throw';
    log('钩子没挂上 ' + (e && e.message ? e.message : e));
  }

  // HTTP 接口：设置页和面板都用它
  const mountApi = (server) => {
    if (!server || typeof server.register !== 'function') { log('没有 webServer，接口没挂'); return; }
    const send = (res, code, obj) => {
      try {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      } catch {}
    };
    const state = () => {
      const cfg = readConfig();
      const t = readTable();
      const cast = cfg.guests.map((g) => ({
        name: String(g.name || g.model), model: String(g.model),
        keyMask: String(g.key).slice(0, 6) + '…' + String(g.key).slice(-4),
        on: g.on !== false,
      }));
      return {
        ok: true, version: VERSION, home: HOME_DIR, hook,
        base: cfg.base, cap: GUEST_CAP, seatCap: SEAT_CAP, dshModels: readDshModels(),
        hall: {
          enabled: cfg.hallEnabled && cfg.guests.length > 0,
          stored: cfg.hallEnabled,
          count: cfg.guests.length,
          open: Boolean(t.open && t.order && t.order.length),
          order: t.order || [],
          asked: t.asked || 0,
          muted: cast.length > 0 && cast.every((c) => c.on === false),
          last: t.open && t.last ? t.last : null,
          recent: t.open && Array.isArray(t.recent) ? t.recent : [],
        },
        guests: cast,
      };
    };
    const handler = async (req, res) => {
      if (req.method === 'GET') return send(res, 200, state());
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' });
      let body = '';
      for await (const chunk of req) body += chunk;
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch { return send(res, 400, { ok: false, error: 'bad json' }); }
      const cfg = readConfig();
      const action = String(p.action || '');

      if (action === 'hall-toggle') {
        const want = p.enabled === true;
        if (want && !cfg.guests.length) return send(res, 400, { ok: false, error: '名单是空的，先请一位顾问' });
        cfg.hallEnabled = want;
        if (!saveConfig(cfg)) return send(res, 500, { ok: false, error: '写不进去' });
        log('hall ' + (want ? 'on' : 'off'));
        return send(res, 200, { ok: true, enabled: want });
      }

      // 往前翻：给面板的「加载更早」用。只读，不改任何东西。
      if (action === "history") {
        const lim = Math.min(Math.max(Number(p.limit || 10), 1), 50);
        const r = readRoundLog(lim, String(p.before || ""));
        return send(res, 200, { ok: true, rounds: r.rounds, hasMore: r.hasMore });
      }

      if (action === 'guest-add') {
        const key = String(p.key || '').trim();
        if (!key) return send(res, 400, { ok: false, error: '要给一条 key' });
        if (cfg.guests.length >= GUEST_CAP) return send(res, 400, { ok: false, error: '名单最多 ' + GUEST_CAP + ' 位（同时在席另有上限 ' + SEAT_CAP + ' 位）' });
        // 2026-11-02 改：判重按「key + 模型」而不是「key」。
        // 一把 key 通常能调好几个模型（官方 API 就是这样），只有本机那个网关才是「一 key 一模型」。
        // 2026-11-02 改：地址按条目存。原来只靠一个全局 base（那是本机网关的地址），
        // 换个人用、或者直连官方 API 就废了。现在「提供商 + 地址」跟着人走。
        const base = String(p.base || cfg.base || '').replace(/\/+$/, '');
        if (!base) return send(res, 400, { ok: false, error: '要给 API 地址（比如 https://api.deepseek.com/v1）' });
        let model = String(p.model || '').trim();
        if (!model) {
          try {
            const r = await fetch(modelsUrl(base), { headers: { Authorization: 'Bearer ' + key } });
            const j = JSON.parse(await r.text());
            const list = j?.data ?? j?.models ?? [];
            if (Array.isArray(list) && list.length === 1 && list[0] && list[0].id) model = String(list[0].id);
          } catch {}
        }
        if (!model) {
          return send(res, 400, {
            ok: false,
            error: '这条 key 能用的模型不止一个，或者探不出来——请在「模型」里选一个或手填',
            needModel: true,
          });
        }
        const stem = model.replace(/^cn:/, '').split('-')[0] || model;
        // 判重按「key + 模型」，不是「key」——一把 key 通常能调好几个模型。
        if (cfg.guests.some((g) => String(g.key) === key && String(g.model) === model)) {
          return send(res, 400, { ok: false, error: '这一位已经在席上了（同一把 key、同一个模型）' });
        }
        const baseName = String(p.name || "").trim() || (stem.charAt(0).toUpperCase() + stem.slice(1));
        // 重名自动加编号，不拦——同一家两个模型（glm-5.3 和 glm-5.3-flash）是正常用法，
        // 它们自动起的名字都是 Glm，拦下来只会让人以为是 bug。
        let name = baseName;
        {
          let n = 2;
          while (cfg.guests.some((g) => String(g.name).toLowerCase() === name.toLowerCase())) name = baseName + "-" + (n++);
        }
        cfg.guests.push({ name, model, key, base, on: true });
        if (!saveConfig(cfg)) return send(res, 500, { ok: false, error: '写不进去' });
        log('guest added ' + name + ' ' + model + ' @ ' + base);
        return send(res, 200, { ok: true, name, model, base, count: cfg.guests.length });
      }

      // 拿这把 key 能用哪些模型——给界面上的「获取模型」用。探不到就如实说。
      if (action === 'probe-models') {
        const key = String(p.key || '').trim();
        const base = String(p.base || cfg.base || '').replace(/\/+$/, '');
        if (!key || !base) return send(res, 400, { ok: false, error: '要给地址和 key' });
        try {
          const r = await fetch(modelsUrl(base), { headers: { Authorization: 'Bearer ' + key } });
          const text = await r.text();
          if (!r.ok) return send(res, 400, { ok: false, error: 'HTTP ' + r.status + '（这个地址可能不支持列模型，可以直接手填模型名）', models: [] });
          const j = JSON.parse(text);
          const list = j?.data ?? j?.models ?? [];
          const ids = (Array.isArray(list) ? list : []).map((x) => String(x?.id || x?.name || '')).filter(Boolean);
          return send(res, 200, { ok: true, models: ids });
        } catch (e) {
          return send(res, 400, { ok: false, error: '连不上：' + (e && e.message ? e.message : String(e)) + '（可以直接手填模型名）', models: [] });
        }
      }

      if (action === 'guest-del') {
        const name = String(p.name || '').trim();
        const before = cfg.guests.length;
        cfg.guests = cfg.guests.filter((g) => String(g.name) !== name);
        if (cfg.guests.length === before) return send(res, 404, { ok: false, error: '席上没有这个人' });
        if (!saveConfig(cfg)) return send(res, 500, { ok: false, error: '写不进去' });
        try { writeFileSync(histFile(name), '[]', 'utf8'); } catch {}
        log('guest removed ' + name);
        return send(res, 200, { ok: true, count: cfg.guests.length });
      }

      if (action === 'guest-rename') {
        const from = String(p.name || '').trim();
        const to = String(p.to || '').trim();
        if (!from || !to) return send(res, 400, { ok: false, error: '要给原名和新名字' });
        if (to.length > 20) return send(res, 400, { ok: false, error: '名字 20 字以内' });
        if (cfg.guests.some((g) => String(g.name) !== from && String(g.name).toLowerCase() === to.toLowerCase())) {
          return send(res, 400, { ok: false, error: '已经有同名的了' });
        }
        const hit = cfg.guests.find((g) => String(g.name) === from);
        if (!hit) return send(res, 404, { ok: false, error: '席上没有这个人' });
        hit.name = to;
        if (!saveConfig(cfg)) return send(res, 500, { ok: false, error: '写不进去' });
        log('guest renamed ' + from + ' -> ' + to);
        return send(res, 200, { ok: true, name: to });
      }

      if (action === 'guest-toggle') {
        const name = String(p.name || '').trim();
        const hit = cfg.guests.find((g) => String(g.name) === name);
        if (!hit) return send(res, 404, { ok: false, error: '席上没有这个人' });
        hit.on = p.on === true;
        if (!saveConfig(cfg)) return send(res, 500, { ok: false, error: '写不进去' });
        log('guest ' + (hit.on ? 'on ' : 'off ') + name);
        return send(res, 200, { ok: true, name, on: hit.on });
      }

      if (action === 'hall-mute-all') {
        const mute = p.muted === true;
        if (mute) {
          cfg.restoreOn = cfg.guests.filter((g) => g.on !== false).map((g) => String(g.name));
          for (const g of cfg.guests) g.on = false;
        } else {
          const back = new Set(Array.isArray(cfg.restoreOn) ? cfg.restoreOn : cfg.guests.map((g) => String(g.name)));
          for (const g of cfg.guests) g.on = back.has(String(g.name));
          cfg.restoreOn = [];
        }
        if (!saveConfig(cfg)) return send(res, 500, { ok: false, error: '写不进去' });
        log('hall ' + (mute ? 'mute-all' : 'unmute-all'));
        return send(res, 200, { ok: true, muted: mute });
      }

      return send(res, 400, { ok: false, error: '不认识的 action：' + action });
    };

    try {
      server.register({ path: '/api/meeting-room', handler });
      log('已挂 /api/meeting-room');
      if (typeof ctx?.effect === 'function') {
        ctx.effect(() => () => { try { server.unregister?.('/api/meeting-room'); } catch {} });
      }
    } catch (e) {
      log('接口没挂上 ' + (e && e.message ? e.message : e));
    }
  };

  try {
    try { ctx.inject(['webServer'], (c) => mountApi(c.webServer)); } catch { mountApi(ctx.webServer); }
  } catch (e) {
    log('webServer 拿不到 ' + (e && e.message ? e.message : e));
  }
}
