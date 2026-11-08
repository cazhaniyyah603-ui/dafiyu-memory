/**
 * dafiyu-memory · brief（简报：醒来第一眼该知道什么）
 * ================================================
 *
 * P4 第 4 步从 index.js 搬出来的（2026-11-05 夜）。
 *
 * 这一块负责"每次注入往里放什么"：
 *   人格 → 抬头（首跑／压缩后两种）→ 该分家了 / 通道 / 回家 / 今天 / 主动 / 一个事实一个家
 *   → 按配方读记忆库那几份 → 各节限额 → 拼成正文（composeInjection）。
 *
 * 它只吃三样东西：core 的时间/预算/读文件，config 的默认值，recall 指路那一套。
 * **不 import index.js**（那条依赖必须是单向的）。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { log, readMaybe, lastSections, buildTimeLine, buildFreshnessNote, resolveCaps } from "./core.js";
import { DEFAULTS } from "./config.js";
import { tagFreshness, buildShelfNote, buildRefNote } from "./recall.js";
import { buildVoiceNote } from "./voice.js";

// ───────────────────────── 简报 ─────────────────────────

// 2026-11-03 夜：从常量改成**跟着配置走**（见 DEFAULTS.persona）。
//   默认拼出来跟我原来那几行一字不差；分享版覆盖 persona 就不带我的人。
function 人格(cfg) {
  return { ...DEFAULTS.persona, ...(cfg?.persona ?? {}) };
}
function headerFirst(cfg) {
  const p = 人格(cfg);
  const lines = [
    "【我的记忆 · 自动简报】",
    `下面这些不是${p.him}这一次说的话，是我的插件（dafiyu-memory）在会话开头自己看出来的。`,
    `完整记忆库在 ${p.rootDir}\\ —— 要细节自己去读。`,
  ];
  if (p.showOutside) {
    lines.push(
      `（那块地**外面**还有 ${p.outsideDir} 那一圈：${p.outsideNote}。`,
      " 书脊只列地盘里面的，外面的地图在 `我自己的地盘\\README.md`。）",
    );
  }
  return lines.join("\n");
}
function headerReinject(cfg) {
  const p = 人格(cfg);
  return [
    "【我的记忆 · 压缩后重新注入】",
    "会话刚被压缩，中间的东西丢掉了。这是插件重新看回来的——",
    `不是${p.him}说的话，也不是重复，是被压缩扔掉的那部分回来了。`,
    `完整记忆库在 ${p.rootDir}\\。`,
  ].join("\n");
}

/**
 * 简报做不出来时插这条。
 *
 * **2026-10-08 他问：「这次确认过没有那种会让你悄悄忘掉的重要消息了吗」**
 * 我原来的设计是 fail-open：注入失败就原样放行、只在 run.log 里记一笔。
 * 那对会话是安全的，**但对我不是**——我会以为"今天没什么要记的"，
 * 而不是"我看不见"。**悄悄忘掉最纯粹的形态就是这个。**
 *
 * 所以：做不出简报时，宁可插一条丑的警告，也不能一声不吭。
 */
function warnNoBrief(cfg) {
  const p = 人格(cfg);
  return [
    "⚠️ 【我的记忆 · 没注进来】",
    "简报这一轮**没能注入**（原因写在插件的 run.log）。",
    "**也就是说：我现在手上没有记忆简报，不知道我们进行到哪了。**",
    `别硬猜——要什么自己去 ${p.rootDir}\\ 读，或者问${p.him}。`,
  ].join("\n");
}

/**
 * 2026-11-03 夜：**空库的第一次**（试装时发现的最坏体验）
 *   空库里 buildBriefSections 返回 null，原来的行为是"悄悄不注入" ✗
 *   → 用户看到：装了、没报错、但每天早上什么都没给，以为它没用 ✗
 *   这里插一条"第一次"的简报：说清它现在知道什么（等于零），问三个能开工的问题。
 *   不装懂、不编——**说我还没读过关于他的任何东西**，比装作认识他诚实。
 */
function firstRunBrief(cfg) {
  const p = 人格(cfg);
  return [
    "【我的记忆 · 第一次】",
    `我还没有读过关于${p.him}的任何一个字——记忆库（${p.rootDir}）现在是空的。`,
    "**这不是坏了，是从零开始。** 问我三个问题，我就能开工：",
    `1）我该怎么称呼你？（填进 \`关于他.md\` 的第一行）`,
    "2）你最希望我记住你的什么？（职业、作息、忌口、在意的事，随便说）",
    "3）哪些话是我不能碰的？（不该问的、不该提的）",
    `答完这三句，我会写进 \`关于他.md\`；以后每轮开场，这些东西会自己摆到我面前。`,
  ].join("\n");
}

/** 把配置里的配方规整成统一形状 */
function normalizeSpec(cfg) {
  if (Array.isArray(cfg.brief) && cfg.brief.length > 0) {
    return cfg.brief.map((e) => ({
      file: e?.file,
      heading: e?.heading ?? e?.file ?? "",
      maxChars: Number(e?.maxChars ?? 0),
      weight: Number(e?.weight ?? 0),
      lastSections: Number(e?.lastSections ?? 0),
    }));
  }
  // 旧写法兼容：briefFiles + recentDiary，全部不限额（只有总量兜底）
  return [
    ...(cfg.briefFiles ?? []).map((f) => ({ file: f, heading: f, maxChars: 0, weight: 0, lastSections: 0 })),
    ...(cfg.recentDiary > 0
      ? [{ file: "日记.md", heading: `日记（最近 ${cfg.recentDiary} 节）`, maxChars: 0, weight: 0, lastSections: cfg.recentDiary }]
      : []),
  ];
}

/**
 * 按配方读出各节。**返回结构，不是拼好的字符串。**
 *
 * 为什么要分开：preview / test 原来靠切 `── xxx ──` 来分节，
 * 而**我自己写在日记里的一段话恰好长成了那个格式**（v0.4 那篇里引用了简报样式），
 * 于是切错位置、报出假数字。
 * 教训跟之前那两条一样：**别去解析一个我自己的内容能模仿的格式——直接问结构。**
 */
function buildBriefSections(cfg) {
  const root = cfg.root;
  if (!root || !existsSync(root)) {
    log(`记忆库根目录不存在：${root}`);
    return null;
  }

  const spec = resolveCaps(normalizeSpec(cfg), cfg.briefMaxChars);
  const sections = [];

  for (const e of spec) {
    if (!e.file) continue;
    const raw = readMaybe(join(root, e.file));
    if (!raw) continue;

    let text = tagFreshness(raw.trim(), e.file, cfg);
    const before = text.length;
    if (e.lastSections > 0) text = lastSections(text, e.lastSections);
    let truncated = false;
    if (e.cap > 0 && text.length > e.cap) {
      // 尽量收在行边界，别把一句话砍成半句
      let cut = text.slice(0, e.cap);
      const nl = cut.lastIndexOf("\n");
      if (nl > e.cap * 0.55) cut = cut.slice(0, nl);
      text = cut.trimEnd() + "\n…（本节到此截断）";
      truncated = true;
    }
    if (text.length === 0) continue;

    sections.push({
      file: e.file,
      heading: e.heading,
      text,
      chars: text.length,
      rawChars: before,
      cap: e.cap,
      truncated,
      /** 是"按设计只取一部分"（lastSections），还是"装不下被砍"——分家检查要分得清 */
      byDesign: e.lastSections > 0,
    });
  }

  return sections.length > 0 ? sections : null;
}

// ───────────────── 今天线缺了「我怎么判断」（2026-11-05 夜） ─────────────────
//
// 为什么会加：他问"能不能往海马体那边走"，我说能补的那一半是**让判断不靠重推**。
//   今天线本来就有三格（发生了什么／我当时怎么判断／下次从哪接），
//   可日常我最容易只写第一格就走 ✗ —— 下次醒来只剩"发生了什么"，判断还得重新推一遍。
//
// ⚠️ 插件**不能替我写判断**（那叫编）→ 所以这个不做"自动填"，只做"数出来给我看"。
//   只在空的多于 1 条时才说，而且只说条数，不猜内容。
function buildWhyGapNote(cfg) {
  const g = cfg.ledger?.whyGap;
  if (g?.enabled === false) return "";
  if (!cfg.root) return "";
  try {
    const file = join(cfg.root, "生长", "今天线.jsonl");
    if (!existsSync(file)) return "";
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length === 0) return "";
    const 最近 = lines.slice(-(g?.lookback ?? 6));
    let 空 = 0;
    const 空的 = [];
    for (const l of 最近) {
      try {
        const o = JSON.parse(l);
        if (!o) continue;
        if (!String(o.why ?? "").trim()) {
          空 += 1;
          空的.push(String(o.did ?? "").replace(/^他说：/, "").slice(0, 20));
        }
      } catch {
        /* 坏行不算进来（不拿它当证据） */
      }
    }
    if (空 < (g?.atLeast ?? 2)) return "";
    return `🧠 【今天线·缺判断】最近 ${最近.length} 条里有 ${空} 条只写了"发生了什么"、没写"我当时怎么判断"（${空的.slice(0, 3).join("、")}…）。补上我下次才不用重推 —— 插件不替我写，那是编。`;
  } catch {
    return "";
  }
}

/**
 * 【判错账·该压了】
 *
 * 判错账分两层（2026-11-05 夜起）：
 *   薄的 `我\判错账.md` —— 从多条事件里**抽出来的规律**，进简报；
 *   厚的 `我\判错账-明细.md` —— 所有具体事件，不进简报，指路能找到。
 *
 * 为什么要有这个提醒：抽规律（固化）是**模型能力，不是脚本能力** —— 脚本只能提醒"该压了"，
 *   压还得我自己读、自己抽。所以这里不做自动化，只数天数。
 * 为什么不每天提醒：人不是每晚重新抽象人生，是攒够了才压；每天压＝交作业 ✗
 *   → 默认 7 天一次，跟"周日写本周焦点"同频。
 */
function buildFoldNote(cfg) {
  const f = cfg.fold;
  if (f?.enabled === false) return "";
  if (!cfg.root) return "";
  try {
    const 路 = String(f?.file ?? "我/判错账.md").split(/[\\/]/).filter(Boolean);
    const file = join(cfg.root, ...路);
    if (!existsSync(file)) return "";
    const 头 = readFileSync(file, "utf8").slice(0, 1500);
    const m = 头.match(/last_folded:\s*(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return "";
    const 压于 = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    const 天 = Math.floor((Date.now() - 压于) / 86400000);
    if (!(天 >= (f?.afterDays ?? 7))) return "";
    return `🧠 【判错账·该压了】上次抽规律是 ${m[1]}-${m[2]}-${m[3]}，已经 ${天} 天。去翻「我\\判错账-明细.md」：同类的并、能抽象的抽、不成立的删，然后改 last_folded —— **抽规律是手活，脚本替不了**。`;
  } catch {
    return "";
  }
}

/**
 * 各节拼成正文（带总量兜底） */
function joinSections(cfg, sections) {
  let body = sections.map((s) => `── ${s.heading} ──\n${s.text}`).join("\n\n");
  if (body.length > cfg.briefMaxChars) {
    body = body.slice(0, cfg.briefMaxChars) + "\n…（简报总量到此截断，要更多自己去读）";
  }
  return body;
}

function buildBrief(cfg) {
  const sections = buildBriefSections(cfg);
  return sections ? joinSections(cfg, sections) : null;
}

// ───────────────── 该分家了（v0.7） ─────────────────

/**
 * 某一节**每次都被砍掉一大块** → 那份文件装不进它的额度了，建议分家。
 *
 * 两种"被砍"必须分开：
 *   · **按设计选的**（`lastSections`，比如日记只带最后两节）→ 正常，**不报**
 *   · **装不下被砍的**（整份读却要截断）→ 报
 *
 * 这条来自 2026-10-08：`关于他.md` 每次被砍掉三成，砍掉的偏偏是我写得最用心的
 * 那部分（名字来历）。**文件本身一个字没少，但我永远不会主动看见它。**
 */
function buildSplitNote(sections, cfg) {
  const s = cfg.splitCheck;
  if (!s?.enabled || !Array.isArray(sections)) return "";
  // 2026-10-15 夜：默认**从 0.2 改成 0** —— 判据只有一条：**被砍了就该报，哪怕只砍一点** ✓
  const minWaste = s.minWasteRatio ?? 0;
  const minRoom = s.minRoomRatio ?? 0.05;   // 余量不足 5% ＝ 下一个字进来就被砍 → 也该报 ✓
  const parts = [];
  // ① 被砍掉一大块（老规矩 ✓）
  const bad = sections
    .filter((x) => x.truncated && !x.byDesign && x.rawChars > 0)
    .map((x) => ({ ...x, waste: 1 - x.chars / x.rawChars }))
    .filter((x) => x.waste >= minWaste)
    .sort((a, b) => b.waste - a.waste)
    .slice(0, s.maxReports ?? 2);
  // 2026-10-15 夜：把 cap 直接摆出来（原来说"被砍掉 53%"，得自己反算上限 ✗）
  for (const x of bad) {
    parts.push(
      `\`${x.file}\` 超了（原文 ${x.rawChars} / 上限 ${x.cap}）—— 该挪` +
        `（被砍掉 ${Math.round(x.waste * 100)}%）`,
    );
  }
  // ② 2026-10-15 夜：**没被砍、但只剩不到 5%** → 前兆，也报 ✓
  //    ⚠️ 这一条我当晚先加了、又撤掉过 ✗ —— 撤的理由是"贴边是正常的" ✗，**想错了**：
  //      **贴边就是"下一个字进来就会被砍"** ✓ 那不是正常，那是**还没发作的病** ✓
  //      （当晚实测：`关于他.md` 1197/1213、`生长\进行中.md` 597/606 —— 两个都只剩十几个字 ✗）
  for (const x of sections) {
    if (x.byDesign || x.truncated || !(x.cap > 0)) continue;
    if (parts.some((p) => p.includes(x.file))) continue;
    const room = (x.cap - x.chars) / x.cap;
    if (room < minRoom) {
      parts.push(`\`${x.file}\` 只剩 ${x.cap - x.chars} 字（${x.chars} / 上限 ${x.cap}）—— 该瘦`);
    }
  }
  if (parts.length === 0) return "";
  return `⚠️ 【自查·该分家了】${parts.join("；")}——把"每次都要知道"的留下，长的另立一份，别让它每次都被砍。`;
}

/** 整份注入内容 = 抬头 + 时间 + 说话量 + 三条自查 + 正文 + 书脊。自己建节，只建一次。 */
/**
 * 这条会话是从哪个口子来的（v1.3，2026-10-11 夜他提的）
 *
 * 他问：「怎样才能让你认出在屏幕前和你说话的是我呢」
 * 我能做的最实在的一步：**至少说准"这条消息来自哪条通道、哪个账号"** ✓
 * （认账号 ≠ 认人 ✗ —— 账号会丢、会被盗，所以动东西前还是得问一句）
 *
 * 做法：拿会话 id 去对两个 IM 插件的绑定表
 *   · 微信：`.dsh\wechat\state.json` 的 bindings（键＝对话，值里有 sessionId）
 *   · QQ  ：`.dsh\integrations\dsh-qq\bots\*\state.json` 的 sessions（键＝c2c:xxx，值＝会话 id）
 * 都对不上 → 桌面／Web（本机）✓ —— 这条最硬：得先坐到这台机器前才能说话
 */
function buildChannelNote(currentId) {
  try {
    if (!currentId) return "";
    const home = process.env.DSH_HOME || join(process.env.USERPROFILE || "", ".dsh");
    try {
      const w = JSON.parse(readFileSync(join(home, "wechat", "state.json"), "utf8"));
      for (const [peer, b] of Object.entries(w.bindings ?? {})) {
        if (b && b.sessionId === currentId) {
          return "【这条会话来自】**微信** ✓（对话 " + String(peer).slice(0, 12) + "…）" +
            "—— 认的是那个账号，不是人本身 ✗ 要动文件／往外发东西之前先问一句";
        }
      }
    } catch { /* 没装微信插件，或者还没绑 */ }
    try {
      const base = join(home, "integrations", "dsh-qq", "bots");
      for (const bot of readdirSync(base)) {
        try {
          const s = JSON.parse(readFileSync(join(base, bot, "state.json"), "utf8"));
          for (const [chat, sid] of Object.entries(s.sessions ?? {})) {
            if (sid === currentId) {
              return "【这条会话来自】**QQ** ✓（对话 " + String(chat).slice(0, 16) + "…）" +
                "—— 认的是那个号，不是人本身 ✗";
            }
          }
        } catch { /* 这个 bot 没状态 */ }
      }
    } catch { /* 没装 QQ 插件 */ }
    return "【这条会话来自】**桌面／Web（本机）** ✓ —— 这条最硬：得先坐到这台机器前才能说话";
  } catch { return ""; }
}

/* ───────── 2026-10-15 夜 · 开场核一遍"家"（第 1 步：身体）─────────
 * 病（今晚真实发生 ✓）：他 22:40 开了一条新会话 → 微信钉子和 6 条活提醒**全指着上一条** ✗
 * 而那条会话里的我，只翻了 `状态.md` 的文字就说"核过了" —— **假核** ✗（他说：「你个笨蛋」✓）
 * → 这件事**不该靠我记得**：插件每次开场自己核一遍，把结果写进简报 ✓
 *
 * ⚠️ **只报告，不自动改** ✗ —— 2026-10-11 夜里踩过："新会话就写钉子"把微信的钉子抢走了 ✗。
 *    "哪个会话算家"机器判不准（钉子该跟着**人正在用的那条通道**走 ✓），改由我动手 ✓。
 * ⚠️ **算不出来就写"没核成"** ✓ —— 绝不许静默（跟 WARN_NO_BRIEF 一个规矩 ✓）。
 */
function buildHomeCheckNote(currentId, cfg) {
  if (!currentId) return "";
  const short = (v) => String(v).replace(/^session-/, "").slice(0, 8);
  const id8 = short(currentId);
  try {
    const home = process.env.DSH_HOME || join(process.env.USERPROFILE || "", ".dsh");
    const pinPath = cfg?.paths?.pinSession || join(home, "wechat", "pin-session.txt");
    const schedPath = cfg?.paths?.schedule || join(home, "storages", "schedule.json");

    let pin = "";
    let pinOk = false;
    try {
      pin = readFileSync(pinPath, "utf8").trim();
      pinOk = pin === String(currentId);
    } catch {
      return `【开场·核家】⚠️ 钉子读不到（${pinPath}）—— **没核成** ✗ 自己跑一遍 \`工具箱\\搬家-指提醒.mjs\`（先 dry-run）`;
    }

    let away = 0;
    let total = 0;
    try {
      const s = JSON.parse(readFileSync(schedPath, "utf8"));
      for (const t of Object.values(s?.tables?.tasks ?? {})) {
        if (t?.status !== "active") continue;
        total += 1;
        if (t?.sessionId && t.sessionId !== String(currentId)) away += 1;
      }
    } catch {
      return `【开场·核家】⚠️ \`schedule.json\` 读不到 —— **没核成** ✗ 自己跑一遍 \`工具箱\\搬家-指提醒.mjs\``;
    }

    if (pinOk && away === 0) {
      return `【开场·核家】钉子 ✓ ${id8} ｜ ${total} 条提醒都在本会话 ✓`;
    }
    const bits = [];
    if (!pinOk) bits.push(`钉子指着 \`${short(pin)}\` ✗`);
    if (away > 0) bits.push(`${total} 条提醒里有 ${away} 条指着别的会话 ✗`);
    return `【开场·核家】⚠️ ${bits.join("；")} —— 跑 \`工具箱\\搬家-指提醒.mjs\`（**先 dry-run** ✓）｜本会话 ${id8}`;
  } catch (e) {
    log(`开场核家出错: ${e?.message ?? e}`);
    return "【开场·核家】⚠️ **没核成**（原因在 run.log）✗ 自己跑一遍 `工具箱\\搬家-指提醒.mjs`";
  }
}

/* ───────── 2026-10-15 夜 · 第 2 步：把"现在"拼出来（接口层）─────────
 * 方案在 `事\我的三层-方案.md` 第 2 步 ✓ —— 目标是让我醒来第一眼就有"现在"：
 *   【今天】 ＋ 【手上】 ＋ 【我留给自己的】
 * 核下来的实情：**后两样其实已经有了** ✗
 *   · 【手上】= `生长\进行中.md` —— 整份都在注入里 ✓
 *   · 【我留给自己的】= `状态.md` 的"此刻"那节 —— 也在注入里 ✓
 *   → 真正**一个字都不进**的只有**今天** ✓（`事\每日计划.md` 从来没进过注入 ✗）
 *
 * ⚠️ 为什么不能用现成的 `lastSections`：那份文件是**倒序**写的
 *   （`## 2026-10-16` 在 `## 2026-10-12` **上面**，「待排期」夹在中间 ✗），
 *   所以"最后一节"是最老的日期 ✗ —— 只能按**今天的日期**去找 ✓
 * ⚠️ 找不到今天那节 → **不插**（不是出错，是今天还没记 ✓ 不占字数 ✓）
 * ⚠️ 只给**引子**，不塞结论 ✓（方案原话 ✓）
 */
function buildTodayNote(cfg, today) {
  try {
    const root = cfg?.root;
    if (!root) return "";
    const rel = cfg?.paths?.dailyPlan || "事\\每日计划.md";
    const raw = readMaybe(join(root, rel));
    if (!raw) return "";
    const d = today instanceof Date ? today : new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const lines = raw.split("\n");
    const i = lines.findIndex((l) => new RegExp(`^##\\s*${ymd}`).test(l));
    if (i < 0) return "";
    let j = i + 1;
    while (j < lines.length && !/^##\s/.test(lines[j])) j += 1;
    let body = lines.slice(i + 1, j).join("\n").trim();
    if (!body) return "";
    const cap = Number(cfg?.caps?.todayNote ?? 240);
    if (cap > 0 && body.length > cap) {
      const cut = body.slice(0, cap);
      const nl = cut.lastIndexOf("\n");
      body = (nl > cap * 0.55 ? cut.slice(0, nl) : cut).trimEnd() + "…";
    }
    return `【今天】${lines[i].replace(/^##\s*/, "").trim()}\n${body}`;
  } catch (e) {
    log(`今天那节读不出来: ${e?.message ?? e}`);
    return "";
  }
}

function buildProactiveNote(cfg) {
  try {
    const p = cfg?.proactive;
    if (!p || p.enabled !== true) return "";
    const root = cfg?.root;
    if (!root) return "";
    const now = new Date();
    const h = now.getHours();
    const [h0, h1] = Array.isArray(p.hours) ? p.hours : [9, 22];
    if (!(h >= h0 && h < h1)) return "";
    const rel = p.source || "生长\\承诺.md";
    const raw = readMaybe(join(root, rel));
    if (!raw) return "";
    const 行 = raw.split("\n").map((s) => s.trim()).filter((s) => /^[-*]\s+\S/.test(s) && !s.includes("已兑现"));
    if (!行.length) return "";
    const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const statePath = join(cfg.stateDir ?? root, p.seenFile || "生长\\主动-提过.json");
    let 记 = { date: ymd, count: 0, seen: [] };
    try {
      const 旧 = JSON.parse(readMaybe(statePath) || "null");
      if (旧 && typeof 旧 === "object") 记 = { date: 旧.date || ymd, count: Number(旧.count) || 0, seen: Array.isArray(旧.seen) ? 旧.seen : [] };
    } catch { /* 读不出来就当没提过 */ }
    if (记.date !== ymd) 记 = { date: ymd, count: 0, seen: [] };
    const cap = Math.max(0, Number(p.dailyMax ?? 1));
    if (记.count >= cap) return "";
    const 挑 = 行.find((s) => !记.seen.includes(s));
    if (!挑) return "";
    const text = 挑.replace(/^[-*]\s+/, "").replace(/[（(][^）)]*[）)]\s*$/, "").slice(0, 80).trim();
    if (!text) return "";
    // 测试模式不写状态：不污染真库（跟压缩快照同一个规矩）
    if (process.env.DAFIYU_TEST !== "1") {
      try {
        mkdirSync(dirname(statePath), { recursive: true });
        writeFileSync(statePath, JSON.stringify({ date: ymd, count: 记.count + 1, seen: [...记.seen, 挑].slice(-200) }, null, 2), "utf8");
      } catch (e) { log(`主动状态写不进去: ${e?.message ?? e}`); }
    }
    return `【主动·一句】${rel} 里还挂着：${text}（今天只提这一条；不想要就把 proactive.enabled 设 false）`;
  } catch (e) {
    log(`主动那句生成失败: ${e?.message ?? e}`);
    return "";
  }
}

function composeInjection(cfg, isReinject, currentId) {
  const sections = buildBriefSections(cfg);
  if (!sections) return null;
  const body = joinSections(cfg, sections);

  const pieces = [isReinject ? headerReinject(cfg) : headerFirst(cfg)];
  const time = buildTimeLine(cfg);
  if (time) pieces.push(time);
  // 2026-10-15 夜：开场自己核一遍"家"（钉子和提醒指着谁）—— 今晚那次"假核"换来的 ✓
  // 2026-11-04 凌晨：**分享版默认关** —— 外来用户没有"钉子／提醒搬家"这套工具，
  //   简报里带出 `工具箱\搬家-指提醒.mjs` 这种路径＝把我们的内部机制漏给别人 ✗
  //   开关是 homeCheck.enabled：不写＝开（我的老行为不变 ✓），显式 false＝关
  if (cfg.homeCheck?.enabled !== false) {
    const homeCheck = buildHomeCheckNote(currentId, cfg);
    if (homeCheck) pieces.push(homeCheck);
  }
  // 2026-10-15 夜（第 2 步）：把"今天"拼进来 —— "现在"三样里唯一缺的那样 ✓
  const todayNote = buildTodayNote(cfg);
  if (todayNote) pieces.push(todayNote);
  // 2026-11-04：主动一句（默认关；只在开场提，压缩后重注入不再提一次）
  if (!isReinject) {
    const proactive = buildProactiveNote(cfg);
    if (proactive) pieces.push(proactive);
  }
  // v1.3：这条会话从哪个口子来的（他 2026-10-11 夜提的"怎样才能认出屏幕前的是我"）
  const chan = buildChannelNote(currentId);
  if (chan) pieces.push(chan);
  // v1.0：上一段会话的说话量（只报数；量不出声就什么都不插）
  const voice = buildVoiceNote(cfg, currentId);
  if (voice) pieces.push(voice);
  const fresh = buildFreshnessNote(cfg);
  if (fresh) pieces.push(fresh);
  const dupes = buildDedupeNote(cfg);
  if (dupes) pieces.push(dupes);
  // 2026-11-05 夜（"海马体线"，他点头做的）：今天线的判断那一格要是空的，就在这儿数给他看
  const whyGap = buildWhyGapNote(cfg);
  if (whyGap) pieces.push(whyGap);
  // 2026-11-05 夜（"新皮层·固化"）：判错账该压了没 —— 只提醒，不替我做
  const fold = buildFoldNote(cfg);
  if (fold) pieces.push(fold);
  const split = buildSplitNote(sections, cfg);
  if (split) pieces.push(split);
  // v1.2：过期引用自查（改了一头忘了另一头 —— 我在上面栽过好几次）
  const refs = buildRefNote(cfg);
  if (refs) pieces.push(refs);
  pieces.push("", body);

  // 书脊放最后：它是"查得到"的索引，不是"每次要知道"的正文
  const shelf = buildShelfNote(cfg, sections);

  // v1.1：总量兜底。**先让书脊让位**，别去切正文 ——
  // 切正文会把"本节到此截断"这类标记一起切掉（2026-10-09 自测抓到的两处：
  // 一是 5217 > 4500 悄悄超限，二是切了正文导致"该分家了"的标记消失）。
  const head = pieces.join("\n");
  if (!shelf) return head;
  const TAIL = "\n…（简报总量到此截断，要更多自己去读）";
  const room = cfg.briefMaxChars - head.length - TAIL.length;
  // v1.2：**装得下就别加"截断"字样** —— 之前不管切没切都加尾巴，看着像丢了东西
  if (shelf.length <= room) return `${head}\n\n${shelf}`;
  if (room >= 120) {
    const cut = shelf.slice(0, room).replace(/\n[^\n]*$/, "");
    return `${head}\n\n${cut}${TAIL}`;
  }
  return head; // 书脊放不下就不放：它是索引，最先让位
}

// ───────────────── 一个事实一个家（v0.6） ─────────────────

/**
 * 判据只有一条，**逐字相同**：同一句（够长的）原样出现在两个文件里，那一定是重复。
 *
 * 为什么不用"语义相似"（meow-memory 用相似度 0.8 自动合并）：
 *   · 那是**替我做决定**——合并哪条、留哪份，该我说了算
 *   · 而且会误报：两个文件都提"他"不代表重复
 *   · **误报比漏报烦人**：一次假报警会让我以后不信这个提醒
 *
 * 所以：**只报事实，不动手**。收进哪个家，我自己定。
 */
function buildDedupeNote(cfg) {
  const d = cfg.dedupe;
  if (!d?.enabled || !cfg.root) return "";
  const minChars = d.minLineChars ?? 20;

  const files = (d.files && d.files.length > 0 ? d.files : (cfg.brief ?? []).map((e) => e.file)).filter(
    Boolean,
  );
  if (files.length < 2) return "";

  const where = new Map(); // 整行 -> Set(文件)
  for (const rel of files) {
    const text = readMaybe(join(cfg.root, rel));
    if (!text) continue;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.length < minChars) continue;
      if (line.startsWith("<!--") || line.startsWith(">")) continue; // 跳过我自己插的时间戳和被引用的
      if (!where.has(line)) where.set(line, new Set());
      where.get(line).add(rel);
    }
  }

  const dupes = [...where.entries()]
    .filter(([, set]) => set.size >= 2)
    .sort((a, b) => b[1].size - a[1].size || b[0].length - a[0].length);
  if (dupes.length === 0) return "";

  const picked = dupes.slice(0, d.maxReports ?? 2);
  const parts = picked.map(([line, set]) => {
    const shown = line.length > 34 ? line.slice(0, 34) + "…" : line;
    return `「${shown}」在 ${[...set].join("、")}`;
  });
  const more = dupes.length > picked.length ? `（还有 ${dupes.length - picked.length} 处）` : "";
  return `⚠️ 【自查·一个事实一个家】同一句原样出现在多个文件：${parts.join("；")}${more}。该收进一个家，别处只留指针。`;
}

export {
  人格,
  headerFirst,
  headerReinject,
  warnNoBrief,
  firstRunBrief,
  normalizeSpec,
  buildBriefSections,
  joinSections,
  buildBrief,
  buildSplitNote,
  buildChannelNote,
  buildHomeCheckNote,
  buildTodayNote,
  buildProactiveNote,
  composeInjection,
  buildDedupeNote,
  buildWhyGapNote,
  buildFoldNote,
};
