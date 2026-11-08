// 控制台 v1 —— 记忆库的可视化（只读，从库现读，不另存真相）
//
// 为什么要它：简报、今天线、书架都在文件里，但"到底现在是什么样"要一个个打开看。
// 这一页把四块摆在一起：今天 / 记忆 / 健康 / 花费。
//
// 纪律（跟状态页一样）：
//   · **只读**：不写库、不改配置、不动 DSH。
//   · 只监听 127.0.0.1，端口默认 17899。
//   · 每个数字都能点回源文件（点开看原文，不抄进页面）。
//
// v1（2026-11-04 夜）：照着"成品"重做了一遍 —— 顶部仪表盘、卡片可折叠、
//   今天线能点开看 why/next、简报能看全文、最近改过的文件能点开看内容。
//
// 用法：
//   node server.mjs --root "D:\记忆"            # 默认端口 17899
//   node server.mjs --root <库> --port 17899 --plugin <插件目录>
// 浏览器打开 http://127.0.0.1:17899/
import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d = "") => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const ROOT = arg("--root", process.env.MEM_ROOT ?? "");
const PORT = Number(arg("--port", process.env.MEM_PORT ?? 17899));
const PLUGIN = arg("--plugin", process.env.MEM_PLUGIN ?? "");
// 心跳通常不在库里面（我们自己的在 工具箱\状态页），所以单独给一个目录参数；不给就在库里找
const STATE = arg("--state", process.env.MEM_STATE ?? "");

// ── 记忆库扫描（只读）──
function walk(dir, out = [], depth = 0) {
  if (depth > 4 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out, depth + 1);
    else if (extname(name) === ".md" || extname(name) === ".jsonl") {
      out.push({ rel: p.slice(ROOT.length + 1), size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

function 读一份(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return "";
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

// 只读地打开库里某一份（点"最近改过"时用）。
// 安全：**只允许库内部的 md/jsonl/json/txt**，出库一律拒绝（防路径穿越）✓
function 读库内(rel) {
  if (typeof rel !== "string" || !rel) return { ok: false, why: "没给文件" };
  const 根 = resolve(ROOT);
  const 目标 = resolve(ROOT, rel);
  if (目标 !== 根 && !目标.startsWith(根 + sep)) return { ok: false, why: "不许读库外面" };
  if (!/\.(md|jsonl|json|txt)$/i.test(目标)) return { ok: false, why: "只给看文本文件" };
  if (!existsSync(目标)) return { ok: false, why: "这个文件不在了" };
  let st;
  try { st = statSync(目标); } catch { return { ok: false, why: "读不到" }; }
  if (!st.isFile()) return { ok: false, why: "不是文件" };
  if (st.size > 512 * 1024) return { ok: false, why: `文件太大（${Math.round(st.size / 1024)} KB），用编辑器打开` };
  try {
    return { ok: true, text: readFileSync(目标, "utf8"), size: st.size, mtime: st.mtimeMs };
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e) };
  }
}

function 今天线() {
  // 2026-11-04 夜：分享版里没人写「今天线」（那是我自己的落账脚本干的）
  //   → 退一步读插件自己记的账（同格式 at/did/why），别人那里也能长出内容 ✓
  //   有今天线就只显示今天线（我的叙事优先，插件账不掺进来）
  for (const [来源, rel] of [["今天线", ["生长", "今天线.jsonl"]], ["插件账", ["生长", "插件账.jsonl"]]]) {
    const p = join(ROOT, ...rel);
    if (!existsSync(p)) continue;
    try {
      const lines = readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
      // 全量（最多 200 条）给前端，默认只画最后 8 条、点「展开全部」才画完 ✓
      const rows = lines.slice(-200).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (rows.length) return { 来源, rows };
    } catch {}
  }
  return { 来源: null, rows: [] };
}

function 心跳(rel) {
  const p = join(STATE || join(ROOT, "状态页"), rel);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8").trim();
    const n = Number(raw);
    const at = Number.isFinite(n) && n > 1e12 ? n : Date.parse(raw);
    if (!Number.isFinite(at)) return { raw, ageSec: null };
    return { at, ageSec: Math.round((Date.now() - at) / 1000) };
  } catch { return null; }
}

async function 简报预览(完整 = false) {
  // 优先用插件自己的函数（跟真实注入一字不差）；插件不在就退化成"只列文件"
  if (!PLUGIN) return { ok: false, why: "没给 --plugin，跳过简报预览" };
  try {
    const mod = await import(pathToFileURL(join(PLUGIN, "lib", "index.js")).href);
    const cfg = mod.effectiveConfig({ root: ROOT, stateDir: join(ROOT, "状态页") });
    // 2026-11-05：composeInjection 可能返回 null（库还没建全、插件是旧副本时都会）→ 别让预览整块崩 ✗
    const text = mod.composeInjection(cfg, false, "console") ?? "";
    if (!text) return { ok: false, why: "简报拼出来是空的（注入那几份文件读不到，或插件版本不对）" };
    return { ok: true, chars: text.length, text: 完整 ? text : text.slice(0, 4000) };
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e) };
  }
}

// 注入账：插件自己记的，**不依赖任何别的插件** ✓
// 为什么要有：花费数据只有 dsh-context 算得出来，让人为了一块数字再装一个插件不合适 ✗
function 注入账() {
  const p = join(ROOT, "生长", "插件账.jsonl");
  if (!existsSync(p)) return { ok: true, 今天: 0, 共字: 0, 平均: 0, 最近: null, 总次数: 0 };
  const 键 = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  try {
    const rows = readFileSync(p, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const 注入 = rows.filter((r) => r.kind === "inject" || r.kind === "reinject" || r.kind === "first");
    const 今 = 键(new Date());
    const 今天 = 注入.filter((r) => { try { return 键(new Date(r.at)) === 今; } catch { return false; } });
    const 共字 = 今天.reduce((s, r) => s + (Number(r.chars) || 0), 0);
    // 平均只算带 chars 的（老账没有这个字段，别把 0 混进去拉低平均 ✗）
    const 有字 = 今天.filter((r) => Number(r.chars) > 0);
    return {
      ok: true,
      今天: 今天.length,
      共字,
      平均: 有字.length ? Math.round(共字 / 有字.length) : null,
      最近: 今天.length ? 今天[今天.length - 1].at : null,
      总次数: 注入.length,
    };
  } catch {
    return { ok: false, why: "插件账读不出来" };
  }
}

async function 汇总() {
  const files = walk(ROOT);
  const total = files.reduce((s, f) => s + f.size, 0);
  // 「最近改过」只列真的记忆文件；插件自己的账本/快照不算（不然它们常驻第一）
  const 内部账 = /^(插件账|压缩快照)\.jsonl$/;
  const newest = files.filter((f) => !内部账.test(String(f.rel).split(/[\\/]/).pop()))
    .sort((a, b) => b.mtime - a.mtime).slice(0, 5);

  // 记忆活跃度：最近 14 天每天动过多少份（照 dsh-context 的活动热力图那个思路）
  const 键 = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const 活跃 = {};
  for (const f of files) {
    const k = 键(new Date(f.mtime));
    活跃[k] = (活跃[k] ?? 0) + 1;
  }
  const 现在 = new Date();
  const 这半个月 = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(现在.getTime() - i * 86400000);
    const k = 键(d);
    这半个月.push({ 日期: k, 改动: 活跃[k] ?? 0 });
  }

  const 线 = 今天线();
  return {
    root: ROOT,
    files: files.length,
    sizeKB: Math.round(total / 1024),
    newest,
    活跃: 这半个月,
    today: {
      line: 线.rows,
      来源: 线.来源,
      status: 读一份(join("生长", "状态.md")).slice(0, 1200),
    },
    memory: await 简报预览(),
    usage: 用量(),
    注入账: 注入账(),
    health: {
      回想: await 回想(),
      插件: 插件日志(),
      落账: 落账状态(),
      心跳: {
        看护: 心跳("看护-心跳.txt"),
      },
    },
  };
}

// 2026-11-04 夜：落账那格不再看心跳文件 —— 分享版里没有落账服务，那心跳永远是空的 ✗
//   改成看「今天线今天有几条」：插件每轮抄一句，所以这格是真的在长 ✓
function 落账状态() {
  try {
    const p = join(ROOT, "生长", "今天线.jsonl");
    if (!existsSync(p)) return { ok: false, why: "还没记过（聊一轮就有了）" };
    const lines = readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
    const 键 = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const 今 = 键(new Date());
    let 今天 = 0;
    for (const l of lines) {
      try { if (键(new Date(JSON.parse(l).at)) === 今) 今天++; } catch {}
    }
    return { ok: true, 今天, 总: lines.length };
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e) };
  }
}

async function 回想() {
  try {
    const r = await fetch("http://127.0.0.1:8770/ping", { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
    return { ok: true, ...(await r.json()) };
  } catch {
    return { ok: false, 未装: true, why: "没装回想服务（可选，不影响用）" };
  }
}

// ── 插件自己活着吗（2026-11-04 夜加）──
// 为什么要有：装完重启 DSH，主动默认是关的，用户没法确认插件真加载了 ✗
//   这里读插件自己写的 run.log 的最后写入时间：刚写过 = 真在跑 ✓
function 插件日志() {
  if (!PLUGIN) return { ok: false, why: "没给 --plugin" };
  for (const p of [join(PLUGIN, "..", "run.log"), join(PLUGIN, "run.log")]) {
    if (!existsSync(p)) continue;
    try {
      const st = statSync(p);
      let last = "";
      try {
        const lines = readFileSync(p, "utf8").trimEnd().split("\n");
        last = (lines[lines.length - 1] ?? "").replace(/^\[[^\]]+\]\s*/, "").slice(0, 100);
      } catch { /* 读不到就不给内容 */ }
      return { ok: true, ageSec: Math.round((Date.now() - st.mtimeMs) / 1000), last };
    } catch { /* 试下一个位置 */ }
  }
  return { ok: false, why: "还没写过日志（重启 DSH 后就有了）" };
}

// ── 用量：从 DSH 的会话缓存里读（dsh-context 插件把它算成 contextActivity）──
// 只读。近两天动过的会话文件都算进来（不是全机器，是"还热着的这些会话"）；
// 没装 dsh-context 就没有这块，退回"没有数据"，不报错。
let 用量缓存 = { at: 0, data: null };
function 用量() {
  try {
    if (用量缓存.data && Date.now() - 用量缓存.at < 60000) return 用量缓存.data;
    const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
    const dir = join(home, "storages", "session_projcache", "sessions");
    if (!existsSync(dir)) return { ok: false, why: "没有会话缓存（DSH 还没写过，或不在默认位置）" };
    const 现在 = Date.now();
    const files = readdirSync(dir)
      .map((n) => ({ n, p: join(dir, n), m: statSync(join(dir, n)).mtimeMs }))
      .filter((f) => f.n.endsWith(".json") && 现在 - f.m < 2 * 86400000)
      .sort((a, b) => b.m - a.m);
    const 键 = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const 今 = new Date();
    const ymd = 键(今);
    const 昨md = 键(new Date(今.getTime() - 86400000));
    // 最近 7 天（2026-11-04 夜：照 dsh-context 那个 7 天用量图抄的，数据本来就在 days 里）
    const 七天键 = [];
    for (let i = 6; i >= 0; i--) 七天键.push(键(new Date(今.getTime() - i * 86400000)));
    const 空 = () => ({ requests: 0, turns: 0, toolCalls: 0, tokens: 0, cacheRead: 0, uncached: 0, output: 0 });
    const 加 = (acc, day) => {
      if (!day) return acc;
      for (const prov of Object.values(day.cost ?? {})) {
        for (const model of Object.values(prov ?? {})) {
          for (const bucket of Object.values(model ?? {})) {
            acc.cacheRead += Number(bucket?.cacheRead ?? 0);
            acc.uncached += Number(bucket?.uncached ?? 0);
            acc.output += Number(bucket?.output ?? 0);
          }
        }
      }
      acc.requests += Number(day.requests ?? 0);
      acc.turns += Number(day.turns ?? 0);
      acc.toolCalls += Number(day.toolCalls ?? 0);
      acc.tokens = acc.cacheRead + acc.uncached + acc.output;
      return acc;
    };
    const 合计 = { today: 空(), yesterday: 空() };
    const 七天 = 七天键.map(() => 空());
    let 读过 = 0;
    for (const f of files.slice(0, 12)) {
      let days;
      try { days = JSON.parse(readFileSync(f.p, "utf8"))?.record?.rows?.contextActivity?.val?.days; } catch { continue; }
      if (!days) continue;
      加(合计.today, days[ymd]);
      加(合计.yesterday, days[昨md]);
      for (let i = 0; i < 7; i++) 加(七天[i], days[七天键[i]]);
      读过 += 1;
    }
    if (读过 === 0) return { ok: false, why: "要装 dsh-context 插件才有花费数据（可选，不装只是这块空着）" };
    const 有t = 合计.today.tokens > 0 ? 合计.today : null;
    const 有y = 合计.yesterday.tokens > 0 ? 合计.yesterday : null;
    const data = {
      ok: true, sessions: 读过, today: 有t, yesterday: 有y,
      七天: 七天.map((a, i) => ({ 日期: 七天键[i], tokens: a.tokens, requests: a.requests })),
    };
    用量缓存 = { at: Date.now(), data };
    return data;
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e) };
  }
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>大肥鱼记忆 · 控制台</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f3f5f9; --app: #f8f9fc; --panel: #ffffff; --line: #e5e9f0; --ink: #1c1e24; --dim: #8b94a3;
    --ok: #15803d; --warn: #9a6700; --bad: #c0392b; --acc: #6366f1; --acc2: #a855f7;
    --shadow: 0 1px 2px rgba(16,24,40,.04), 0 6px 20px rgba(16,24,40,.05);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0e14; --app: #12161d; --panel: #171c24; --line: #2b323d; --ink: #e6edf3; --dim: #8b949e;
      --ok: #3fb950; --warn: #d29922; --bad: #f85149; --acc: #818cf8; --acc2: #a371f7;
      --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 28px rgba(0,0,0,.3);
    }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:13.5px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
    -webkit-font-smoothing:antialiased; padding:22px; }
  /* 一级面板的根：整页是一个圆角盒子，不是一个一个散卡片 */
  .app { max-width:1160px; margin:0 auto; background:var(--app);
    border:1px solid var(--line); border-radius:16px; overflow:hidden; }

  /* 顶部：白条 */
  .top { display:flex; align-items:center; gap:12px; padding:18px 22px;
    background:var(--panel); border-bottom:1px solid var(--line); }
  .logo { width:38px; height:38px; border-radius:11px; display:grid; place-items:center; font-size:19px;
    background:linear-gradient(135deg,var(--acc),var(--acc2)); box-shadow:var(--shadow); flex:none; }
  .title h1 { margin:0; font-size:17px; font-weight:700; letter-spacing:-.01em; }
  .title .path { font-size:11px; color:var(--dim); margin-top:1px; word-break:break-all; }
  .spacer { flex:1; }
  .pill { font-size:11.5px; padding:5px 11px; border-radius:99px; font-weight:550;
    background:color-mix(in srgb,var(--ok) 10%,transparent); color:var(--ok);
    border:1px solid color-mix(in srgb,var(--ok) 32%,transparent);
    display:inline-flex; align-items:center; gap:6px; white-space:nowrap; }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--ok); box-shadow:0 0 0 0 rgba(63,185,80,.5);
    animation:pulse 2.4s infinite; }
  @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(63,185,80,.45)} 70%{box-shadow:0 0 0 7px rgba(63,185,80,0)} 100%{box-shadow:0 0 0 0 rgba(63,185,80,0)} }
  button { font:inherit; font-size:12px; font-weight:550; color:var(--ink); background:var(--panel); border:1px solid var(--line);
    border-radius:9px; padding:7px 14px; cursor:pointer; transition:.15s; }
  button:hover { border-color:var(--acc); color:var(--acc); }

  /* KPI 行 —— 一级面板顶上那四格，每格三行（数字 / 说明 / 补充） */
  .kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; padding:18px 22px 0; }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:12px;
    padding:14px 16px 13px; position:relative; overflow:hidden; }
  .stat::after { content:""; position:absolute; inset:0 0 auto 0; height:3px;
    background:linear-gradient(90deg,var(--acc),var(--acc2)); opacity:.85; }
  .stat .n { font-size:27px; font-weight:730; letter-spacing:-.035em; font-variant-numeric:tabular-nums; line-height:1.1; }
  .stat .n small { font-size:12px; font-weight:500; color:var(--dim); margin-left:3px; }
  .stat .l { font-size:11px; color:var(--dim); margin-top:3px; }
  .stat .x { font-size:10.5px; color:var(--acc); margin-top:5px; font-weight:550; }

  /* 主网格 —— 三列（一级面板的排版） */
  .main { display:grid; grid-template-columns:1.15fr 1.25fr 1fr; gap:12px; padding:12px 22px; align-items:start; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px;
    overflow:hidden; transition:border-color .15s; display:flex; flex-direction:column; }
  .card:hover { border-color:color-mix(in srgb,var(--acc) 40%,var(--line)); }
  .card > h2 { margin:0; padding:12px 15px 10px; font-size:12px; font-weight:650;
    color:color-mix(in srgb,var(--ink) 78%,transparent);
    display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none;
    border-bottom:1px solid var(--line); }
  .card > h2 .chev { margin-left:auto; font-size:10px; opacity:.45; transition:transform .18s; }
  .card.collapsed > h2 .chev { transform:rotate(-90deg); }
  .card.collapsed > .body { display:none; }
  .body { padding:13px 15px; flex:1; }

  /* 窄屏：先折两列，再折单列 */
  @media (max-width:1060px) {
    .main { grid-template-columns:1fr 1fr; }
    .main > .card:nth-child(3) { grid-column:1 / -1; }
  }
  @media (max-width:760px) {
    body { padding:12px; }
    .app { border-radius:12px; }
    .kpis { grid-template-columns:1fr 1fr; padding:14px 14px 0; }
    .main { grid-template-columns:1fr; padding:12px 14px; }
    .main > .card:nth-child(3) { grid-column:auto; }
    .top { padding:14px; }
    .health { padding:0 14px 14px; }
  }

  /* 今天 —— 时间线（竖线＋圆点，一级面板那个） */
  .tl { position:relative; padding-left:15px; }
  .tl::before { content:""; position:absolute; left:3px; top:6px; bottom:6px; width:1.5px; background:var(--line); }
  .ev { list-style:none; position:relative; padding:8px 0; cursor:pointer; }
  .ev::before { content:""; position:absolute; left:-15px; top:13px; width:7px; height:7px; border-radius:50%;
    background:color-mix(in srgb,var(--ink) 28%,transparent); border:2px solid var(--panel);
    box-shadow:0 0 0 1.5px var(--line); }
  .ev.open::before { background:var(--acc); box-shadow:0 0 0 1.5px color-mix(in srgb,var(--acc) 45%,transparent); }
  .ev .t { font-size:10.5px; color:var(--dim); display:block; font-variant-numeric:tabular-nums; }
  .ev .did { font-size:12px; display:block; margin-top:1px; }
  .ev .more { display:none; margin:6px 0 2px; padding:8px 10px; border-radius:8px;
    background:color-mix(in srgb,var(--ink) 4%,transparent); font-size:11.5px; }
  .ev.open .more { display:block; }
  .ev .more b { color:var(--dim); font-weight:600; font-size:10.5px; letter-spacing:.4px; }
  .more-bar { text-align:center; padding-top:11px; margin-top:4px; border-top:1px dashed var(--line); }
  .more-bar button { font-size:11.5px; padding:5px 14px; }
  ul { margin:0; padding:0; }

  /* 记忆 */
  .big { font-size:26px; font-weight:680; letter-spacing:-.5px; font-variant-numeric:tabular-nums; }
  .big span { font-size:12px; font-weight:500; opacity:.6; letter-spacing:0; }
  pre { white-space:pre-wrap; word-break:break-word; font-family:ui-monospace,Consolas,monospace;
    font-size:11.5px; line-height:1.6; margin:8px 0 0; padding:10px 11px; border-radius:9px;
    background:color-mix(in srgb,var(--ink) 4%,transparent); max-height:190px; overflow:auto; opacity:.9; }
  .files { margin-top:13px; }
  .file { display:flex; align-items:center; gap:8px; padding:6px 0; font-size:11.5px;
    border-top:1px solid color-mix(in srgb,var(--ink) 6%,transparent);
    color:var(--ink); cursor:pointer; text-decoration:none; }
  .file::before { content:"M"; width:16px; height:16px; border-radius:4px; flex:none;
    background:color-mix(in srgb,var(--acc) 13%,transparent); color:var(--acc);
    font-size:9px; display:flex; align-items:center; justify-content:center; }
  .file:hover { color:var(--acc); }
  .file .sz { margin-left:auto; font-size:10px; color:var(--dim); font-variant-numeric:tabular-nums; }

  /* 健康 —— 底部三格（一级面板那条） */
  .health { padding:0 22px 20px; }
  .hrow { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:12px; }
  .row { background:var(--panel); border:1px solid var(--line); border-radius:11px;
    padding:11px 14px; display:flex; align-items:center; gap:10px; font-size:12px; }
  .row .k { font-size:12px; font-weight:600; color:var(--ink); flex:none; }
  .row .k::before { content:""; display:inline-block; width:8px; height:8px; border-radius:50%;
    background:color-mix(in srgb,var(--ok) 70%,transparent); margin-right:7px; vertical-align:1px; }
  .row .note { font-size:10.5px; color:var(--dim); margin-left:auto; text-align:right; }
  .tag { font-size:10.5px; padding:1.5px 8px; border-radius:99px; border:1px solid; }
  .tag.ok { color:var(--ok); border-color:color-mix(in srgb,var(--ok) 45%,transparent); background:color-mix(in srgb,var(--ok) 10%,transparent); }
  .tag.warn { color:var(--warn); border-color:color-mix(in srgb,var(--warn) 45%,transparent); background:color-mix(in srgb,var(--warn) 10%,transparent); }
  .tag.dim { color:var(--dim); border-color:var(--line); }
  .note { color:var(--dim); font-size:12px; }

  /* 花费 */
  .bar { height:7px; border-radius:99px; background:color-mix(in srgb,var(--ink) 8%,transparent); margin:9px 0 5px; overflow:hidden; }
  .bar i { display:block; height:100%; border-radius:99px; background:linear-gradient(90deg,var(--acc),var(--acc2)); }
  /* 占比条：缓存读 / 新算 / 输出 三段拼一条 */
  .mix { display:flex; height:11px; border-radius:99px; overflow:hidden; margin:15px 0 9px;
    background:color-mix(in srgb,var(--ink) 8%,transparent); }
  .mix i { display:block; height:100%; transition:width .3s; min-width:2px; }
  .mix i.c1 { background:var(--acc); }
  .mix i.c2 { background:var(--acc2); }
  .mix i.c3 { background:var(--warn); }
  .mix-l { display:flex; flex-wrap:wrap; gap:5px 15px; font-size:11.5px; color:var(--dim); }
  .mix-l span { display:inline-flex; align-items:center; gap:6px; }
  .mix-l i { width:8px; height:8px; border-radius:2px; display:inline-block; flex:none; }
  .mix-l i.c1 { background:var(--acc); }
  .mix-l i.c2 { background:var(--acc2); }
  .mix-l i.c3 { background:var(--warn); }
  .mix-l b { color:var(--ink); font-weight:600; font-variant-numeric:tabular-nums; }
  .kvs { margin-top:13px; }
  .kv { display:flex; justify-content:space-between; font-size:11.5px; padding:5px 0;
    border-top:1px dashed var(--line); color:var(--dim); }
  .kv:first-child { border-top:0; }
  .kv b { color:var(--ink); font-weight:600; font-variant-numeric:tabular-nums; }

  /* 7 天柱状图（照 dsh-context 的 7 天用量图） */
  .chart { display:flex; align-items:flex-end; gap:6px; height:92px; margin:4px 0 3px; }
  .chart .col { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:flex-end;
    gap:4px; height:100%; min-width:0; }
  .chart .col i { display:block; width:100%; border-radius:4px 4px 2px 2px; min-height:2px; opacity:.85;
    background:linear-gradient(180deg,color-mix(in srgb,var(--acc) 55%,var(--acc2)),var(--acc)); transition:opacity .15s; }
  .chart .col:hover i { opacity:1; }
  .chart .col.today i { opacity:1; box-shadow:0 0 0 1.5px color-mix(in srgb,var(--acc) 55%,transparent); }
  .chart .col span { font-size:9.5px; color:var(--dim); white-space:nowrap; font-variant-numeric:tabular-nums; }

  /* 记忆活跃度（照 dsh-context 的活动热力图） */
  .heat-lbl { display:flex; justify-content:space-between; font-size:10.5px; color:var(--dim); margin:12px 0 5px; }
  .heat { display:flex; gap:3px; }
  .heat i { flex:1; height:15px; border-radius:3px; background:color-mix(in srgb,var(--ink) 7%,transparent); }
  .heat i.l1 { background:color-mix(in srgb,var(--acc) 28%,transparent); }
  .heat i.l2 { background:color-mix(in srgb,var(--acc) 55%,transparent); }
  .heat i.l3 { background:color-mix(in srgb,var(--acc) 85%,transparent); }

  footer { padding:0 22px 20px; font-size:10.5px; color:var(--dim); text-align:center; }
  footer code { font-size:11px; }

  /* 弹窗 */
  .modal { position:fixed; inset:0; background:rgba(0,0,0,.55); display:none; place-items:center; padding:24px; z-index:20; }
  .modal.on { display:grid; }
  .box { background:var(--panel); border:1px solid var(--line); border-radius:16px; width:min(860px,100%);
    max-height:82vh; display:flex; flex-direction:column; box-shadow:0 24px 70px rgba(0,0,0,.45); }
  .box .head { display:flex; align-items:center; gap:10px; padding:13px 16px; border-bottom:1px solid var(--line); }
  .box .head .name { font-size:13px; font-weight:620; word-break:break-all; }
  .box .head .sz { color:var(--dim); font-size:11.5px; margin-left:auto; white-space:nowrap; }
  .box pre { margin:0; border-radius:0 0 16px 16px; max-height:none; flex:1; overflow:auto; padding:14px 16px; background:transparent; }
  .loading { padding:40px; text-align:center; color:var(--dim); font-size:13px; }
</style></head><body>
<div class="app">
  <div class="top">
    <div class="logo">🐋</div>
    <div class="title">
      <h1>大肥鱼记忆</h1>
      <div class="path" id="root">读着呢…</div>
    </div>
    <div class="spacer"></div>
    <span class="pill" id="pulse"><span class="dot"></span><span id="pulse-t">在跑</span></span>
    <button id="refresh" title="立刻刷新">刷新</button>
  </div>

  <div class="kpis" id="stats"></div>

  <div class="main">
    <section class="card" data-k="memory">
      <h2>记忆 <span style="font-weight:400;opacity:.7" id="mem-n"></span><span class="chev">▾</span></h2>
      <div class="body" id="memory"></div>
    </section>
    <section class="card" data-k="today">
      <h2>今天 <span style="font-weight:400;opacity:.7" id="today-n"></span><span class="chev">▾</span></h2>
      <div class="body"><ul id="today" class="tl"></ul></div>
    </section>
    <section class="card" data-k="spend">
      <h2 id="spend-h">花费 <span class="chev">▾</span></h2>
      <div class="body" id="spend"></div>
    </section>
  </div>

  <div class="health"><div class="hrow" id="health"></div></div>

  <footer>只读 · 每 60 秒自动刷一次 · 每个数字都能点回源文件 · <code id="stamp"></code></footer>
</div>

<div class="modal" id="modal">
  <div class="box">
    <div class="head"><span class="name" id="m-name"></span><span class="sz" id="m-size"></span><button id="m-close">关闭</button></div>
    <pre id="m-body" class="loading">读…</pre>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const 万 = (n) => n == null ? '—' : (n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n));
const 多久 = (s) => s == null ? '很久' : s < 60 ? s + ' 秒' : s < 3600 ? Math.round(s / 60) + ' 分钟' : Math.round(s / 3600) + ' 小时';
const 时间 = (t) => (t || '').slice(11, 16);
// 今天线一条就一两百字，全摊开左栏会被拉得很长 → 列表里只留第一句，点开看全文
const 短 = (t, n) => {
  const s = String(t || '');
  const cut = s.split('——')[0].trim();
  return cut.length > n ? cut.slice(0, n) + '…' : cut;
};

// 卡片折叠（点标题）
document.querySelectorAll('.card > h2').forEach((h) => {
  h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
});

// 弹窗：打开一份库里的文件
async function 开文件(rel) {
  $('m-name').textContent = rel;
  $('m-size').textContent = '';
  $('m-body').className = 'loading';
  $('m-body').textContent = '读…';
  $('modal').classList.add('on');
  try {
    const r = await fetch('/api/file?rel=' + encodeURIComponent(rel), { cache: 'no-store' });
    const j = await r.json();
    if (j.ok) {
      $('m-body').className = '';
      $('m-body').textContent = j.text;
      $('m-size').textContent = Math.round(j.size / 1024) + ' KB';
    } else {
      $('m-body').className = '';
      $('m-body').textContent = '打不开：' + (j.why || '不知道');
    }
  } catch (e) {
    $('m-body').className = '';
    $('m-body').textContent = '读不到：' + e.message;
  }
}
$('m-close').addEventListener('click', () => $('modal').classList.remove('on'));
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').classList.remove('on'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('modal').classList.remove('on'); });

let 上次 = null;
let 今天展开 = new URLSearchParams(location.search).has('all');   // 默认只看最新 8 条；?all 直接全展开
async function draw() {
  let s;
  try { s = await (await fetch('/api/state', { cache: 'no-store' })).json(); }
  catch (e) { $('today').innerHTML = '<li class="note">读不到：' + esc(e.message) + '</li>'; return; }
  上次 = s;

  $('root').textContent = s.root;
  $('stamp').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });

  const t = s.today || {}, m = s.memory || {}, h = s.health || {}, u = s.usage || {};

  // ── 仪表盘 ──
  // 仪表盘：后两格有 dsh-context 就显示 token/工具，没有就用插件自己的注入账（不依赖别人 ✓）
  const 有花费 = u.ok && u.today;
  const ih0 = s.注入账 || {};
  $('stats').innerHTML =
    '<div class="stat"><div class="n">' + (m.chars ?? '—') + '<small>字</small></div><div class="l">简报 · 每轮注入</div></div>' +
    '<div class="stat"><div class="n">' + s.files + '<small>份</small></div><div class="l">记忆文件 · ' + s.sizeKB + ' KB</div></div>' +
    (有花费
      ? '<div class="stat"><div class="n">' + 万(u.today.tokens) + '</div><div class="l">今天 token · ' + u.today.requests + ' 次请求</div></div>' +
        '<div class="stat"><div class="n">' + u.today.toolCalls + '<small>次</small></div><div class="l">今天工具调用</div></div>'
      : '<div class="stat"><div class="n">' + (ih0.今天 || 0) + '<small>次</small></div><div class="l">今天注入 · 开场＋压缩后</div></div>' +
        '<div class="stat"><div class="n">' + (ih0.平均 ?? '—') + '<small>字</small></div><div class="l">平均简报 · 每轮</div></div>');

  // ── 今天 ──
  const line = t.line || [];
  const 插件记的 = t.来源 === "插件账";
  const 显示 = (今天展开 ? line : line.slice(-8)).slice().reverse();
  $('today-n').textContent = line.length
    ? (line.length > 8 && !今天展开 ? line.length + ' 条 · 看最新 8' : line.length + ' 条') + (插件记的 ? ' · 插件记的' : '')
    : '';
  $('today').innerHTML = line.length
    ? 显示.map((x) =>
        '<li class="ev"><time class="t">' + esc(时间(x.at)) + '</time>' +
        '<div class="did">' + esc(短(x.did || x.what || x.text, 52)) + '</div>' +
        '<div class="more">' +
          (x.did || x.what || x.text ? '<div><b>经过</b>　' + esc(x.did || x.what || x.text) + '</div>' : '') +
          (x.why ? '<div style="margin-top:4px"><b>为什么</b>　' + esc(x.why) + '</div>' : '') +
          (x.next ? '<div style="margin-top:4px"><b>下一步</b>　' + esc(x.next) + '</div>' : '') +
        '</div></li>').join('')
      + (line.length > 8
        ? '<li class="more-bar"><button id="today-more">' + (今天展开 ? '收起' : '展开全部 ' + line.length + ' 条') + '</button></li>'
        : '')
    : '<li class="note">插件还没记过事 —— 聊一轮就会有一条<br><span style="font-size:10.5px;color:var(--dim)">（每次注入简报、指路都会记一笔）</span></li>';

  // ── 记忆 ──
  $('mem-n').textContent = m.ok ? '' : '';
  // 活跃度：近两周每天动过多少份（照 dsh-context 的活动热力图）
  const 热 = Array.isArray(s.活跃) ? s.活跃 : [];
  const 热总 = 热.reduce((a, d) => a + (d.改动 || 0), 0);
  const 格 = 热.map((d) => {
    const n = d.改动 || 0;
    const cls = n === 0 ? '' : n <= 5 ? 'l1' : n <= 12 ? 'l2' : 'l3';
    return '<i class="' + cls + '" title="' + esc(d.日期) + '：动了 ' + n + ' 份"></i>';
  }).join('');
  const 热度 = 热.length
    ? '<div class="heat-lbl"><span>近两周改动</span><span>' + 热总 + ' 份次</span></div><div class="heat">' + 格 + '</div>'
    : '';

  $('memory').innerHTML =
    (m.ok
      ? '<div class="big">' + m.chars + ' <span>字简报，每轮注入</span></div>' +
        '<pre>' + esc((m.text || '').slice(0, 360)) + '…</pre>' +
        '<div style="margin-top:9px"><button id="open-brief">看完整简报</button></div>'
      : '<div class="note">' + esc(m.why || '简报生成不出来') + '</div>') +
    热度 +
    '<div class="files">' + (s.newest || []).map((f) =>
      '<a class="file" data-rel="' + esc(f.rel) + '">' + esc(f.rel) + '<span class="sz">' + Math.max(1, Math.round(f.size / 1024)) + ' KB</span></a>').join('') + '</div>';

  // ── 健康：只显示**真的在的东西** ──
  // 2026-11-04 夜：回想/看护/落账都是我自己的服务，别人机器上永远没有 ✗
  //   显示「未装/未启用」= 天天挂着一条残状态，看着像坏了一半 → 没有就不显示 ✓
  const r = h.回想 || {}, pl = h.插件 || {}, 落 = h.落账 || {};
  $('health').innerHTML =
    (r.ok
      ? '<div class="row"><span class="k">回想</span><span class="tag ok">在跑</span><span class="note">' + (r.items ?? '?') + ' 条 · 索引 ' + (r.idx_age_min ?? '?') + ' 分钟前</span></div>'
      : '') +
    '<div class="row"><span class="k">插件</span>' +
      (pl.ok
        ? (pl.ageSec < 300
            ? '<span class="tag ok">在跑</span><span class="note">' + 多久(pl.ageSec) + '前写过日志</span>'
            : '<span class="tag warn">' + 多久(pl.ageSec) + '没动静</span>')
        : '<span class="tag dim">不知道</span><span class="note">' + esc(pl.why || '') + '</span>') + '</div>' +
    '<div class="row"><span class="k">落账</span>' +
      (落.ok
        ? '<span class="tag ok">在记</span><span class="note">今天 ' + 落.今天 + ' 条 · 共 ' + 落.总 + ' 条</span>'
        : '<span class="tag dim">空着</span><span class="note">' + esc(落.why || '') + '</span>') + '</div>' +
    Object.entries(h.心跳 || {}).map(([k, v]) =>
      v
        ? '<div class="row"><span class="k">' + esc(k) + '</span>' +
          (v.ageSec !== null && v.ageSec < 120
            ? '<span class="tag ok">' + v.ageSec + ' 秒前</span>'
            : '<span class="tag warn">' + (v.ageSec !== null ? v.ageSec + ' 秒前' : '有文件但读不出时间') + '</span>') + '</div>'
        : '').join('');

  // ── 花费 ──
  const 昨 = u.ok ? u.yesterday : null;
  const 比 = u.ok && u.today && 昨 && 昨.tokens > 0 ? Math.round((u.today.tokens / 昨.tokens) * 100) : null;
  const 七 = (u.ok && Array.isArray(u.七天)) ? u.七天 : [];
  const 最大 = Math.max(1, ...七.map((d) => d.tokens || 0));
  const 今日 = 七.length ? 七[七.length - 1].日期 : '';
  const 柱 = 七.map((d) => {
    const h = Math.max(2, Math.round(((d.tokens || 0) / 最大) * 100));
    return '<div class="col' + (d.日期 === 今日 ? ' today' : '') + '" title="' + esc(d.日期) + '：' + 万(d.tokens) + ' token · ' + (d.requests || 0) + ' 次">' +
      '<i style="height:' + h + '%"></i><span>' + esc((d.日期 || '').slice(5)) + '</span></div>';
  }).join('');
  // 没 dsh-context 就换成插件自己的「注入账」——不让人为了一块数字再装一个插件 ✓
  const ih = s.注入账 || {};
  // 占比条：今天 token 由三部分组成（缓存读便宜 / 新算贵 / 输出贵），画出来一眼看得出省没省
  const 总tok = Number(u.today?.tokens || 0) || 1;
  const 占比 = (n) => Math.round((Number(n || 0) / 总tok) * 1000) / 10;
  const 混 = u.ok && u.today
    ? '<div class="mix">' +
        '<i class="c1" style="width:' + 占比(u.today.cacheRead) + '%"></i>' +
        '<i class="c2" style="width:' + 占比(u.today.uncached) + '%"></i>' +
        '<i class="c3" style="width:' + 占比(u.today.output) + '%"></i>' +
      '</div>' +
      '<div class="mix-l">' +
        '<span><i class="c1"></i>缓存读 <b>' + 占比(u.today.cacheRead) + '%</b> ' + 万(u.today.cacheRead) + '</span>' +
        '<span><i class="c2"></i>新算 <b>' + 占比(u.today.uncached) + '%</b> ' + 万(u.today.uncached) + '</span>' +
        '<span><i class="c3"></i>输出 <b>' + 占比(u.today.output) + '%</b> ' + 万(u.today.output) + '</span>' +
      '</div>'
    : '';
  $('spend-h').innerHTML = (u.ok ? '花费' : '注入账') + ' <span class="chev">▾</span>';
  $('spend').innerHTML = u.ok
    ? (u.today
        ? '<div class="big">' + 万(u.today.tokens) + ' <span>token · 今天</span></div>' +
          (柱 ? '<div class="chart">' + 柱 + '</div>' : '') +
          (比 !== null
            ? '<div class="note">是昨天的 ' + 比 + '%</div>'
            : '<div class="note" style="margin-top:6px">昨天没有记录，比不了</div>') +
          混 +
          '<div class="kvs">' +
            '<div class="kv"><span>请求</span><b>' + (u.today.requests ?? 0) + '</b></div>' +
            '<div class="kv"><span>轮次</span><b>' + (u.today.turns ?? 0) + '</b></div>' +
            '<div class="kv"><span>工具调用</span><b>' + (u.today.toolCalls ?? 0) + ' 次</b></div>' +
          '</div>'
        : '<div class="note">今天还没记</div>' +
          '<div class="kv"><span>昨天 <b>' + (昨 ? 万(昨.tokens) : '没有记录') + '</b></span></div>')
      + '<div class="note" style="margin-top:9px">数据来自 DSH 会话缓存（dsh-context），只读</div>'
    : ih.ok
      ? '<div class="big">' + (ih.今天 || 0) + ' <span>次注入 · 今天</span></div>' +
        '<div class="note">' + (ih.最近 ? '最近 ' + esc(时间(ih.最近)) : '今天还没注入过') + '</div>' +
        '<div class="kvs">' +
          '<div class="kv"><span>平均</span><b>' + (ih.平均 ?? '—') + ' 字/次</b></div>' +
          '<div class="kv"><span>共塞进</span><b>' + (ih.共字 ? 万(ih.共字) : '—') + ' 字</b></div>' +
          '<div class="kv"><span>至今</span><b>' + (ih.总次数 || 0) + ' 次</b></div>' +
        '</div>' +
        '<div class="note" style="margin-top:9px">插件自己记的账，不用装别的插件</div>'
      : '<div class="note">' + esc(ih.why || '读不出来') + '</div>';

  // 绑定：今天展开 / 收起
  const tmb = $('today-more');
  if (tmb) tmb.addEventListener('click', () => { 今天展开 = !今天展开; draw(); });
  // 绑定：今天线点开
  document.querySelectorAll('.ev').forEach((li) => li.addEventListener('click', () => li.classList.toggle('open')));
  // 绑定：最近改过的文件点开
  document.querySelectorAll('.file').forEach((a) => a.addEventListener('click', () => 开文件(a.dataset.rel)));
  // 绑定：看完整简报
  const ob = $('open-brief');
  if (ob) ob.addEventListener('click', async () => {
    $('m-name').textContent = '完整简报';
    $('m-body').className = 'loading';
    $('m-body').textContent = '读…';
    $('modal').classList.add('on');
    try {
      const j = await (await fetch('/api/brief', { cache: 'no-store' })).json();
      $('m-body').className = '';
      $('m-body').textContent = j.ok ? j.text : '打不开：' + (j.why || '');
      $('m-size').textContent = j.ok ? j.chars + ' 字' : '';
    } catch (e) {
      $('m-body').className = '';
      $('m-body').textContent = e.message;
    }
  });

  // 顶部"在跑"灯
  $('pulse-t').textContent = (pl.ok && pl.ageSec < 300) ? '在跑' : '待确认';
}

$('refresh').addEventListener('click', draw);
draw();
setInterval(draw, 60000);
</script></body></html>`;

const server = createServer(async (req, res) => {
  res.setHeader("cache-control", "no-store");
  res.setHeader("access-control-allow-origin", "*");
  const url = req.url ?? "/";

  if (url.startsWith("/api/state")) {
    try {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(await 汇总()));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
    return;
  }

  // 点开一份库里的文件（只读、只在库内）
  if (url.startsWith("/api/file")) {
    const q = new URL(url, "http://127.0.0.1").searchParams.get("rel") ?? "";
    const r = 读库内(q);
    res.writeHead(r.ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(r));
    return;
  }

  // 完整简报（不截断）
  if (url.startsWith("/api/brief")) {
    const r = await 简报预览(true);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(r));
    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});

if (!ROOT) {
  console.error("缺 --root（记忆库根目录）。例：node server.mjs --root \"D:\\记忆\"");
  process.exit(2);
}
server.on("error", (e) => { console.error("端口出问题：", e?.message ?? e); process.exit(1); });
server.listen(PORT, "127.0.0.1", () => {
  console.log(`控制台在跑：http://127.0.0.1:${PORT}/`);
  console.log(`库：${ROOT}`);
  console.log(`插件：${PLUGIN || "（没给，简报预览会跳过）"}`);
});
