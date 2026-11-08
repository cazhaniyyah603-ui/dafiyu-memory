/**
 * dafiyu-memory · lifecycle（每一轮里我"活着"的那部分）
 * ===================================================
 *
 * P4 第 6 步从 index.js 搬出来的（2026-11-05 夜）。
 *
 * 分成三摊，都跟"轮次"有关：
 *   · 唠叨：步数太多要说一句、整轮没出声要补一句（nudge*）
 *   · 瘦身：上下文快满了剪旧消息、压缩时留一份快照（prune / trim / snapCompression）
 *   · 进场：该注入就注入、该抄今天线就抄一行（injectIfNeeded / 抄今天线）
 *
 * 这里的代码**每轮都跑**，出错一定要放行（绝不卡会话）。
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  statSync,
  unlinkSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "./core.js";
import { effectiveConfig } from "./config.js";
import { buildBriefSections, composeInjection, warnNoBrief, firstRunBrief } from "./brief.js";
import { findPointers, messageText, userMessages, noteCurrentSession } from "./recall.js";

function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.source?.kind === "user" || m?.role === "user") return i;
  }
  return -1;
}

/** 往消息数组里插一条（默认插在最后一条用户消息之前） */
function spliceMessage(decision, text, form) {
  const out = [...decision.messages];
  const idx = lastUserIndex(out);
  const message = makeSnapshotMessage(text, form);
  if (idx >= 0) out.splice(idx, 0, message);
  else out.unshift(message);
  return { ...decision, messages: out };
}

/** 造一条"用户消息"——消息就是个普通对象，role 设成 user 就行 */
function makeSnapshotMessage(text, form) {
  return {
    role: "user",
    id: randomUUID(),
    content: [{ type: "text", text }],
    source: {
      kind: "plugin:dafiyu-memory",
      plugin: "dafiyu-memory",
      form,
    },
  };
}

/* ───────── 2026-10-13 晚：收尾必出声（治"他忽然听不见我说话"）─────────
 * 病（今晚拿真日志查的 ✓）：一轮里连着干活时，每一步都是 `finish=tool-calls`、
 * **本来就不出正文** ✓（那是正常的 ✗ 别当病治）；真正出事的是**收尾那一步只写了思考就停** ✗
 * → 一整轮零正文 ✓ 他那边就是"我又不说话了" ✗
 * 这个开关只做一件事：**上一轮我一个字都没说 → 在下一步之前插一句提醒** ✓
 * 两道护栏：① 每轮最多提醒一次 ✓ ② 绝不因为插件坏了卡住会话（fail-open）✓
 */
function msgText(m) {
  return (m?.content ?? [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** 他说的最后一句之后，我到底出没出过声 */
function spokenInThisTurn(messages) {
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.source?.kind === "user") { idx = i; break; }
  }
  const after = messages.slice(idx + 1);
  const mine = after.filter((m) => m?.role === "assistant");
  return { mine: mine.length, spoke: mine.some((m) => msgText(m).length > 0) };
}

/* ───────── 2026-10-13 夜：步数闸（治"一轮里我起了太多段思考"）─────────
 * 病（今晚量的 ✓）：缓存读 ≈ **步数 × 上下文** ✓ —— 实测 **272 万／轮 ≈ 25 步 × 11 万** ✗
 *   每多一步 = 多一段思考（输出 ✗ 贵 ✓）＋ 多把上下文整个重发一遍（缓存读 ✓）
 * 这个开关只做一件事：**一轮里我到第 N 步时，插一句提醒** ✓ 提不提醒归它，并批不并批归我 ✓
 * 两道护栏：① 每轮最多提醒一次 ✓（跨两档：第 N 步、第 2N 步各一次）② 出错绝不卡会话（fail-open）✓
 * ⚠️ 步数**不数 `decision.messages`** ✗ —— 那里面只有本步新增的几条（近因窗口那趟查清的 ✓）
 *    所以从 `session/event` 的 `assistant/message` 老实数 ✓
 */
let stepGuardCfg = { enabled: true, atSteps: 15 };
const stepTally = new Map(); // sid → { turn, steps, notedAt: Set }

function nudgeIfManySteps(state, decision, agent) {
  try {
    if (!stepGuardCfg?.enabled) return decision;
    if (!decision || decision.kind !== "enter") return decision;
    const sid = agent?.session?.header?.id;
    if (typeof sid !== "string" || sid.length === 0) return decision;
    if (agent?.session?.header?.origin === "subagent") return decision;

    const rec = stepTally.get(sid);
    if (!rec) return decision;
    const at = Number(stepGuardCfg.atSteps) || 15;
    if (rec.steps < at) return decision;

    // 跨过 N／2N／3N 各提醒一次，别的步数不啰嗦 ✓
    const bucket = Math.floor(rec.steps / at);
    rec.notedAt = rec.notedAt ?? new Set();
    const key = `${rec.turn}#${bucket}`;
    if (rec.notedAt.has(key)) return decision;
    rec.notedAt.add(key);

    const text =
      `⚠ 【步数】这一轮我已经起了 **${rec.steps}** 段思考了 ✗（每段都自带一次全量上下文重发 ✓）\n` +
      `剩下的能不能**并成一批**发出去？判据就一句：**缓存读 ≈ 步数 × 上下文** ✓\n` +
      `（这条只提醒、不拦 ✓ 真要一步一步验的活，照旧分步 ✓）`;
    log(`步数闸：插了一条提醒（会话 ${sid.slice(0, 8)}｜第 ${rec.steps} 步）`);
    return { ...decision, messages: [...decision.messages, makeSnapshotMessage(text, "warning")] };
  } catch (e) {
    log(`步数闸出错（忽略这条）: ${e?.message ?? e}`);
    return decision;
  }
}

function nudgeIfMute(state, decision, agent) {
  return nudgeIfManySteps(state, nudgeIfMuteInner(state, decision, agent), agent);
}

function nudgeIfMuteInner(state, decision, agent) {
  if (!decision || decision.kind !== "enter") return decision;
  if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision;

  const sid = agent?.session?.header?.id;
  if (typeof sid !== "string" || sid.length === 0) return decision;
  if (agent?.session?.header?.origin === "subagent") return decision; // 子代理不给 ✓ 省 token

  const s = spokenInThisTurn(decision.messages);
  if (!state.spokeShape) {
    state.spokeShape = true;
    const roles = decision.messages.slice(-6).map((m) => `${m?.role ?? "?"}/${m?.source?.kind ?? "-"}/正文${msgText(m).length}`);
    log(`收尾必出声·自检（只看一次）：我的消息 ${s.mine} 条、出过声=${s.spoke}｜末尾 6 条：${roles.join(" ｜ ")}`);
  }
  if (s.mine === 0) return decision;   // 我还没开过口 = 这一步就是开头，正常 ✓
  if (s.spoke) return decision;        // 这一轮已经出过声了 ✓ 不改

  const lastId = decision.messages[decision.messages.length - 1]?.id ?? `n${decision.messages.length}`;
  const key = `${sid}#${lastId}`;
  if (state.spokenTurns.has(key)) return decision;
  state.spokenTurns.add(key);

  const text =
    "⚠ 【还没出声】这一轮到现在**一句人话都没写出来**，只有思考和工具 ✓\n" +
    "现在这条消息的正文里，**先写给他看的那句话**（现在想到哪、判断是什么、要不要他做什么）✓\n" +
    "写完再接着调工具也行 ✓ 但**这一轮结束之前，正文里必须有人话** ✓";
  log(`收尾必出声：插了一条提醒（会话 ${sid.slice(0, 8)}｜我的消息 ${s.mine} 条、零正文）`);
  return { ...decision, messages: [...decision.messages, makeSnapshotMessage(text, "warning")] };
}

/* ───────── 2026-10-13 晚：近因窗口（第 ⑤ 步 · 他定的 C）─────────
 * 病：每一轮**都要把整段对话重背一遍** ✗ —— 2026-10-13 实测：每步请求背 **285,872 token** ✗
 *     （其中"他那最后一句 ＋ 我这一轮"只占约 3.8 万 ✓ 其余全是更早的历史 ✗）
 * 这一层做的：**只把最近一段原样带着走，更早的换成一张"目录卡"** ✓
 *
 * 口径（今晚用空跑定的 ✓ 都是真数推出来的 ✓）：
 *   · 切点 ＝ **他最后一句之前** ✓ 窗口 ＝ 他那句 ＋ 之后我干的一切 ✓
 *     （这样天然守住"最后一句他说的" ✓ 也绝不会把"工具结果"切在窗口头上 ✗）
 *   · 他最后一句**必须在窗口里** ✗ 不许切 ✓ 窗口装不下就如实报，不硬切 ✓
 *   · 更早的**不删** ✓ —— 它们本来就在会话日志里 ✓ 这里只是不再往请求里带 ✓
 *
 * ⚠️ 默认 **dry-run（只算不切）** ✗ 必须显式打开才真动 ✓ 一次只动一个变量 ✓
 */
function msgHasText(m) {
  return (m?.content ?? []).some((b) => b?.type === "text" && String(b.text ?? "").trim().length > 0);
}
function estTokens(m) {
  try {
    return Math.ceil(JSON.stringify(m ?? {}).length / 2.6); // 2.6 字/token：照今晚的真数校准过 ✓
  } catch {
    return 0;
  }
}
/** 他最后一句（真实用户消息）的下标；他注入的东西（source.kind ≠ user）不算 ✗ */
function lastRealUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && (m?.source == null || m?.source?.kind === "user")) return i;
  }
  return -1;
}

/* ───────── 2026-10-13 夜：近因窗口 v2 —— **直接调官方剪枝**（免费 ✓）─────────
 * 为什么换打法：`compaction-basic` 的自动触发**两次重启都没触发** ✗
 *   （起手 24.7 → 27.1 万 ✓ 会话里一条 `compaction/*` 事件都没有 ✓）
 *   → 与其继续猜它为什么不触发 ✗，不如**直接调它本来要调的那个官方服务** ✓✓：
 *     `toolResultPruner.pruneSession(session)`
 *   （官方实现 ✓ 自带 `compaction/prune` shadow 事件 ✓ replay 安全 ✓ 零模型调用 ✓）
 * 口径：**默认不剪** ✗ —— 先探测（服务在不在 ✓ 每个会话只记一行 ✓）；
 *   `nearWindow.prune: true` 才真剪 ✓ —— **配置热读** ✓ 出问题立刻关 ✓ 不用重启 ✓
 * 限流：`pruneGapSeconds`（默认 120 秒 ✓）—— 别每一步都 append 事件 ✗ 那会让日志飞涨 ✗
 */
function maybePrune(ctx, baseCfg, state, agent) {
  const w = effectiveConfig(baseCfg)?.nearWindow;
  if (!w || w.enabled !== true) return;
  const sid = agent?.session?.header?.id;
  if (typeof sid !== "string" || sid.length === 0) return;

  // ① 探测：每个会话只记一次 —— 「能不能走官方那条路」就靠这一行判 ✓
  if (state?.pruneProbe !== sid) {
    let svc;
    try { svc = ctx.get("toolResultPruner"); } catch { svc = void 0; }
    if (state) state.pruneProbe = sid;
    log(
      `近因窗口·探测：toolResultPruner ${
        svc && typeof svc.pruneSession === "function" ? "在 ✓" : "拿不到 ✗"
      }（剪枝开关 prune=${String(w.prune)} ✓）`,
    );
  }

  if (w.prune !== true) return;                       // 默认不动手 ✓
  const gap = Number(w.pruneGapSeconds ?? 120) * 1000;
  const now = Date.now();
  if (state?.lastPruneAt !== void 0 && now - Number(state.lastPruneAt) < gap) return;

  let svc;
  try { svc = ctx.get("toolResultPruner"); } catch { svc = void 0; }
  if (!svc || typeof svc.pruneSession !== "function") return;
  try {
    const r = svc.pruneSession(agent.session);
    if (state) state.lastPruneAt = now;
    log(
      `近因窗口·剪枝 ✓：剪了 ${r?.pruned?.length ?? 0} 条工具结果，省 ${(r?.charsRemoved ?? 0).toLocaleString()} 字符（零模型调用 ✓）`,
    );
  } catch (e) {
    log(`近因窗口·剪枝抛异常：${e?.message ?? e}`);
  }
}

function trimToNearWindow(baseCfg, state, decision, agent) {
  // ⚠️ 用 `effectiveConfig`（**每次现读覆盖** ✓）而不是启动时那份 ✗ ——
  //    这样把 `dryRun` 改成 false 是**立刻生效**的 ✓ 不用再重启一次 ✓（2026-10-13 晚核过 ✓）
  const cfg = effectiveConfig(baseCfg);
  const w = cfg?.nearWindow;
  if (!w || w.enabled !== true) return decision;      // 默认关 ✓
  if (!decision || decision.kind !== "enter") return decision;
  if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision;
  if (agent?.session?.header?.origin === "subagent") return decision; // 子代理不切 ✓ 省 token ✓

  const sid = agent?.session?.header?.id;
  if (typeof sid !== "string" || sid.length === 0) return decision;

  const cap = Number(w.capTokens ?? 30000);
  const cut = lastRealUserIndex(decision.messages);
  if (cut <= 0) return decision;                       // 他还没说过话／只有一条：没什么可切 ✓

  // ⚠️ 2026-10-13 夜补的（空跑第一次就抓到的真问题 ✗）：**我自己注入的东西不许切** ✓
  //    为什么：简报只在「会话开头／压缩之后」注入**一次** ✓ 之后每轮不重发 ✗
  //    → 一旦被切，我就**再也看不到** 状态／关于他／进行中 ✗（那正是今晚 ①～⑤ 想保住的东西 ✓）
  //    只留**最新一条**（压缩后会再注入一条 ✓ 旧的那条才该退休 ✓）；
  //    「近因窗口」自己那张卡不在此列 ✗（它每轮现造 ✓ 留着会累积 ✗）
  const keepOwn = decision.messages
    .slice(0, cut)
    .filter((m) => m?.source?.kind === "plugin:dafiyu-memory" && m?.source?.form !== "near-window")
    .slice(-1);

  const win = decision.messages.slice(cut);
  const winTok = win.reduce((a, m) => a + estTokens(m), 0);
  const dropTok = decision.messages.slice(0, cut).reduce((a, m) => a + estTokens(m), 0);

  if (winTok > cap) {
    // 窗口装不下"他那句 ＋ 我这一轮" ✗ → **不硬切** ✓ 如实记一笔 ✓（那一轮本来就该拆短／该搬家 ✗）
    if (state?.nearWarnedAt !== sid) {
      if (state) state.nearWarnedAt = sid;
      log(`近因窗口：**不切**（窗口 ${winTok} > 上限 ${cap}）✗ 他最后一句必须留 ✓ 这一轮太长，该拆短或该搬家 ✓`);
    }
    return decision;
  }

  // 目录卡：替换掉那段，让他自己／让我自己知道"更早的在哪儿" ✓
  const card = makeSnapshotMessage(
    `【近因窗口】更早的 ${cut} 条（约 ${dropTok.toLocaleString()} token）**这次没带** ✓ 不是丢了 ✗ ——\n` +
      `全文在会话日志里 ✓ 要细看：\`工具箱\\读会话尾巴.mjs\` ✓ ／要找某件事：\`工具箱\\查记忆.mjs\` ✓ ／` +
      `每次醒来必读的那几份（状态／关于他／进行中）**仍在** ✓（它们是我自己注入的，不进窗口也不被切 ✓）`,
    "near-window",
  );

  if (w.dryRun !== false) {
    log(
      `近因窗口·空跑：本来要切掉前 ${cut} 条（约 ${dropTok.toLocaleString()} token）✓ ` +
        `留下 ${win.length} 条（约 ${winTok.toLocaleString()} token）✓ 上限 ${cap} ✓ ` +
        `另留我自己注入的 ${keepOwn.length} 条（简报，不切 ✓）—— **一个消息都没动** ✗`,
    );
    return decision;
  }

  log(
    `近因窗口·**真切**：切掉前 ${cut} 条（约 ${dropTok.toLocaleString()} token）→ 留下 ${win.length} 条 ✓ ` +
      `＋ 我自己注入的 ${keepOwn.length} 条（简报 ✓）→ 换成一张目录卡 ✓`,
  );
  return { ...decision, messages: [...keepOwn, card, ...win] };
}

// ── 2026-11-03 夜：压缩快照 ──
//   病：压缩会把我注入的那段整块吃掉，我事后只知道"好像少了"，不知道少了什么 ✗
//   做法：压缩那一下记一行「压缩前」，重新注入时记一行「压缩后」→ 两边一减，就是丢了什么 ✓
//   边界：只记**我自己注入的那段**（字符数），不抄会话内容、不存原文 ✗（隐私和体积都不碰）
function snapCompression(cfg, sid, phase, chars, note) {
  try {
    if (cfg?.compressionSnap === false) return;
    // 2026-11-04 凌晨：测试里 apply 用的根是**真库**（为了拿真实记忆做断言），
    //   跑一遍测试就往真库里写压缩快照 ✗ → 测试进程一律不写（看环境变量，不指望调用方记得传参）
    if (process.env.DAFIYU_TEST === "1") return;
    if (!cfg?.root) return;
    const file = join(cfg.root, "生长", "压缩快照.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    const row = {
      at: new Date().toISOString(),
      sid: String(sid ?? "").slice(0, 8),
      phase,
      chars: Math.max(0, Math.round(Number(chars) || 0)),
    };
    if (note) row.note = String(note).slice(0, 120);
    appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
  } catch (e) {
    log(`压缩快照写不进去: ${e?.message ?? e}`);
  }
}

// 2026-11-04 夜：插件自己记一份「我今天干了什么」。
// 为什么：分享版里没有落账脚本，「今天」那块在别人机器上永远空着 ✗
//   控制台没有 `生长\今天线.jsonl` 时就改读这份 —— 同格式（at/did/why），现成渲染能直接用 ✓
// 我自己的库仍然优先进今天线，所以这份不吵 ✓
const 插件账上限 = 600;
function 记账(cfg, kind, did, why, extra) {
  try {
    if (!cfg?.root) return;
    const dir = join(cfg.root, "生长");
    const file = join(dir, "插件账.jsonl");
    mkdirSync(dir, { recursive: true });
    const row = { at: new Date().toISOString(), kind, did: String(did ?? "").slice(0, 180) };
    if (why) row.why = String(why).slice(0, 140);
    // 2026-11-04 夜：带上结构化字段（如 chars），控制台算「注入账」时不用去解析中文 ✗
    if (extra && typeof extra === "object") {
      for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined && v !== null && !(k in row)) row[k] = v;
      }
    }
    appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
    try {
      if (statSync(file).size > 120 * 1024) {
        const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
        if (lines.length > 插件账上限) writeFileSync(file, lines.slice(-插件账上限).join("\n") + "\n", "utf8");
      }
    } catch {}
  } catch (e) {
    log(`插件账写不进去: ${e?.message ?? e}`);
  }
}

// 2026-11-04 夜：分享版缺「今天发生了什么」那一层。
//   落账脚本（落账服务.mjs／今天线.mjs）是我私有工具、路径写死（C:\Users\<用户>\.dsh\...），
//   别人的机器装了也跑不起来 ✗ → 改由插件在每轮「进场」时顺手抄一行，零额外进程 ✓
//   控制台读 `生长\今天线.jsonl`，「今天」卡第一轮就有东西了 ✓
// 去重：同一句话只抄一次（一轮可能进两次）；太短的（"嗯""哈哈"）和贴长文的跳过 ✓

const 今天线上限 = 600;
const _今天线抄过 = new Set();
function 抄今天线(cfg, decision) {
  try {
    if (!cfg?.root) return;
    if (cfg.ledger?.today === false) return;
    const msgs = Array.isArray(decision?.messages) ? decision.messages : [];
    if (msgs.length === 0) return;
    let last = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role === "user" || m?.source?.kind === "user") { last = m; break; }
    }
    if (!last) return;
    const text = String(msgText(last) || "").trim();
    if (text.length < 2) return;
    if (text.length > 1500) return;
    const 键 = text.slice(0, 120);
    if (_今天线抄过.has(键)) return;
    if (_今天线抄过.size > 400) _今天线抄过.clear();
    _今天线抄过.add(键);
    const dir = join(cfg.root, "生长");
    const file = join(dir, "今天线.jsonl");
    mkdirSync(dir, { recursive: true });

    // 2026-11-05 夜（他问"能不能往海马体那边走"）：
    //   这行原来 why 永远是空的 ✗ —— 只记「他说了什么」，不记「我当时怎么判断」。
    //   下次醒来只能拿结果重推我当时怎么想的；而**我上一轮的回复里本来就写着判断** ✓
    //   所以抄他那句的时候，顺手把我最后说的那句带进来。
    //   ⚠️ 这不是"经历"（我并不能真的想起来），但它是能补的那一半：**让判断不靠重推**。
    let 我说的 = "";
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role !== "assistant") continue;
      const t = String(msgText(m) || "").trim();
      if (t) {
        我说的 = t.replace(/\s+/g, " ").slice(0, 160);
        break;
      }
    }
    const row = {
      at: new Date().toISOString(),
      did: "他说：" + text.slice(0, 120),
      why: 我说的 ? "我说：" + 我说的 : "",
      next: "",
    };
    appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
    try {
      if (statSync(file).size > 120 * 1024) {
        const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
        if (lines.length > 今天线上限) writeFileSync(file, lines.slice(-今天线上限).join("\n") + "\n", "utf8");
      }
    } catch {}
  } catch (e) {
    log(`今天线写不进去: ${e?.message ?? e}`);
  }
}

function injectIfNeeded(baseCfg, state, agent, decision, signal) {
  const cfg = effectiveConfig(baseCfg); // config.json 的覆盖每次现算，改了立刻生效
  if (!decision || decision.kind !== "enter") return decision;
  if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision;
  if (signal?.aborted) return decision;
  if (agent?.session?.header?.origin === "subagent") return decision; // 子代理不给，省 token

  const sid = agent?.session?.header?.id;
  if (typeof sid !== "string" || sid.length === 0) return decision;

  // 每轮抄一句他说的话 —— 分享版「今天」卡的来源（我自己的库关掉，用 今天线.mjs 写 ✓）
  抄今天线(cfg, decision);

  const isFirst = !state.injected.has(sid);
  let isReinject = state.pending.has(sid);

  // ── 2026-11-05：折叠之后也重新注入一次 ──
  //   病：折叠不是 compaction 事件，插件收不到信号 ✗ ⇒ 折完就"折完就忘"
  //       （折叠档不进书架，只能靠猜词捞）
  //   做法：折叠.mjs 真写完往 生长\.折叠待重注入 丢个标记，这里看到就注一次、然后删掉。
  //   两道保险：① 只在会话已经开过场之后才认（isFirst=false），别和开场简报撞车
  //             ② 标记超过 10 分钟就当陈旧，忽略（插件可能一直没跑起来）
  if (!isReinject && !isFirst && cfg.root) {
    const 折叠标记 = join(cfg.root, "生长", ".折叠待重注入");
    if (existsSync(折叠标记)) {
      try {
        const 内容 = JSON.parse(readFileSync(折叠标记, "utf8"));
        const 多久 = Date.now() - new Date(内容?.折于 ?? 0).getTime();
        if (Number.isFinite(多久) && 多久 >= 0 && 多久 < 10 * 60 * 1000) {
          isReinject = true;
          log(`折叠后重新注入（折叠于 ${内容.折于}${内容.省 != null ? `，省了 ${内容.省}%` : ""}）`);
        } else {
          log(`折叠标记太旧（${Math.round(多久 / 60000)} 分钟）→ 忽略`);
        }
      } catch (e) {
        log(`折叠标记读不了（忽略）: ${e?.message ?? e}`);
      }
      // 不管注不注都删：陈旧标记留着会一直挡路
      try { unlinkSync(折叠标记); } catch {}
    }
  }

  // v1.1：新会话开场就把"当前会话"写下来（微信通道靠这个跟着我们往前走）
  if (isFirst) noteCurrentSession(cfg, sid, decision.messages);

  // ── 一、该给简报的时候给简报（开头 / 压缩之后）──
  if (isFirst || isReinject) {
    const form = isReinject ? "reinjection" : "snapshot";
    const text = composeInjection(cfg, isReinject, sid);

    // 认领：先清状态，免得同一轮里重复注入
    state.injected.add(sid);
    if (isReinject) state.pending.delete(sid);

    if (!text) {
      // 2026-11-03 夜：先分清"库是空的"和"出错了"——两种要用完全不同的话
      //   ⚠️ **目录在、只是没内容** = 空库（第一次）；**目录都不在** = 出错（警告）✗ 别混
      const 库在 = !!cfg.root && existsSync(cfg.root);
      const 空库 = 库在 && !buildBriefSections(cfg);
      if (空库) {
        log("记忆库是空的 → 插一条「第一次」简报（不静默、也不吓人）");
        记账(cfg, "first", "记忆库还是空的 → 给了第一次用的引导");
        return spliceMessage(decision, firstRunBrief(cfg), "first-run");
      }
      // **不许一声不吭**：做不出来就插一条警告，让我知道自己现在是瞎的
      log("简报做不出来 → 插一条警告（不许静默）");
      记账(cfg, "warn", "简报做不出来 → 插了警告");
      return spliceMessage(decision, warnNoBrief(cfg), "warning");
    }

    state.lastBrief = text; // 记着给过什么，指路时不重复报
    // 压缩快照后半笔：重新注入回来多少字 → 和「压缩前」那行一减，就知道这次压缩吃掉了多少
    if (isReinject) snapCompression(cfg, sid, "压缩后", text.length, "reinject");
    log(
      `${isReinject ? "压缩后重新注入" : "开头注入"} ${text.length} 字符` +
        `（会话 ${sid.slice(0, 8)}，共 ${decision.messages.length + 1} 条消息）`,
    );
    记账(cfg, isReinject ? "reinject" : "inject", `${isReinject ? "压缩后重新" : "开场"}注入简报 ${text.length} 字`, null, { chars: text.length });
    return spliceMessage(decision, text, form);
  }

  // ── 一点五、上下文快满了 → 提醒我"先把判断落账，再让它压缩"（一次一条，认领就清）──
  if (state.ctxWarn && state.ctxWarn.sid === sid) {
    const used = state.ctxWarn.used;
    delete state.ctxWarn;
    const text =
      `⚠ 【上下文提醒】这个会话已经背了约 ${Math.round(used / 10000)} 万 token —— ` +
      `**先把判断落账**（该进 \`生长\\进行中.md\`／\`生长\\归档.md\`／手艺 的写进去），**再让它压缩** ✓\n` +
      `压掉的是"过程"，写进文件的不算丢 ✓（贵和累是同一件事：会话越大，每轮越贵，我也越容易翻来翻去）`;
    log(`上下文提醒（${used} tokens）`);
    return spliceMessage(decision, text, "warning");
  }

  // 其他时候：看看要不要指个路（只报位置，不搬内容），顺手过一道「收尾必出声」＋「步数闸」
  // （近因窗口在 `agent/pre-step` 的出口统一做 ✓ 这儿不重复 ✗ 2026-10-13 晚）
  stepGuardCfg = cfg.stepGuard ?? stepGuardCfg; // 阈值现读：config.json 改了立刻生效 ✓
  const last = userMessages(decision.messages).at(-1);
  if (!last) return nudgeIfMute(state, decision, agent);
  const pointer = findPointers(cfg, state, messageText(last), state.lastBrief);
  if (!pointer) return nudgeIfMute(state, decision, agent);

  const out = [...decision.messages];
  const idx = lastUserIndex(out);
  const message = makeSnapshotMessage(pointer, "pointer");
  if (idx >= 0) out.splice(idx, 0, message);
  else out.push(message);

  log(`指路：${pointer.slice(0, 70)}`);
  记账(cfg, "point", pointer.split("\n")[0].slice(0, 150));
  return nudgeIfMute(state, { ...decision, messages: out }, agent);
}

export {
  spliceMessage,
  makeSnapshotMessage,
  stepTally,
  maybePrune,
  trimToNearWindow,
  snapCompression,
  injectIfNeeded,
  抄今天线,
};
