/**
 * dafiyu-memory · recall（指路 / 架子 / 过期引用自查）
 * ================================================
 *
 * P4 第 3 步从 index.js 搬出来的（2026-11-05 夜），原来是最大的一块。
 *
 * 这里全部是"**只报位置，不搬内容**"那一套：
 *   · 词索引 + 指路：他说一句话，我按词去记忆库里找"哪个文件里有相关的"，只给位置
 *   · 架子上还有什么：太久没被翻到的文件，提醒我它还躺着
 *   · 过期引用自查：我在文件里引用的旧路径／旧函数名，早就不存在了
 *
 * 依赖：core 的 log／readMaybe，config 的 DEFAULTS。**不 import index.js**（避免循环）。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { log, readMaybe } from "./core.js";
import { DEFAULTS } from "./config.js";

// ───────────────── 指路（v0.5）：命中关键词，但只给指针不给内容 ─────────────────

/**
 * 为什么不是"把命中的记忆搬进来"（meow-memory 是那么做的）：
 *
 *   · **把事实给我，我自己判断** —— 搬不搬、看哪份，归我
 *   · 一条指针 ~80 字，搬内容动辄上千字，**而且搬来的多半不是这次要的**
 *
 * 索引怎么来（不用分词器、零依赖）：
 *
 *   **我自己的文件就是索引。** 我加粗什么、起什么标题，就等于在说"这个重要"。
 *   所以词表 = 所有 .md 的标题行 + 加粗片段 + 文件名；
 *   再滤掉"到处都是"的词（超过四成文件都有的，当噪声）。
 */

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const indexCache = { root: "", at: 0, count: 0, terms: new Map() };

function listMdFiles(root, rel = "", depth = 0, out = []) {
  if (depth > 3) return out;
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}\\${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".") || e.name.startsWith("_")) continue;
      listMdFiles(root, r, depth + 1, out);
    } else if (e.name.endsWith(".md")) {
      out.push(r);
    }
  }
  return out;
}

/** 去掉 markdown 记号和标点，留下内容 */
function cleanTerm(s) {
  return String(s)
    .replace(/[`*_#>\[\]（）()「」【】《》"'’，。、：；！？…—\-\s]/g, "")
    .trim();
}

/**
 * 它像不像一个"词"（而不是一句话）？
 *
 * 2026-10-08 拿真记忆库试出来的：光靠长度不行，我加粗的常常是整句话——
 * 「五这一趟对我自己的用处」「又栽在同一个地方第三次了」这种永远匹配不上。
 * 虚词（的了是我你他这那么什怎吗呢吧）是句子的指纹，带这些的多半不是词。
 */
const FUNC_CHARS = /[的了是我你他她它这那么什怎吗呢吧啊呀嘛]/;

/**
 * 泛词名单。这些词到处都是，指了等于没指。
 * （实测：「今天中午吃啥」会命中标题里的「今天」——那种指路只会让人觉得蠢。）
 */
const STOP_TERMS = new Set([
  "今天", "明天", "昨天", "现在", "时候", "时间", "内容", "东西", "事情", "地方",
  "问题", "方法", "一般", "可以", "需要", "应该", "如果", "因为", "所以", "这样",
  "那样", "这里", "那里", "一下", "一直", "已经", "还是", "就是", "没有", "一个",
  "我们", "你们", "他们", "自己", "什么", "怎么", "然后", "而且", "但是",
  // 2026-10-23 加的：时间泛词。"今天早上"这种词指出去，比不指还蠢 ✓
  // （那一天他真看见了：「今天早上」→ 一个折叠测试文件 —— 我记下来了）
  "今天早上", "今天上午", "今天中午", "今天下午", "今天晚上", "今天夜里",
  "昨天早上", "昨天中午", "昨天下午", "昨天晚上", "明天早上", "明天中午",
  "明天下午", "明天晚上", "今早", "今下午", "今晚上", "昨晚", "明早", "明晚",
  "早上", "上午", "中午", "下午", "晚上", "半夜", "夜里", "凌晨", "白天",
  "这两天", "前几天", "前两天", "那天", "这天", "头一天", "一会儿", "等会儿",
  "上次", "这次", "下次", "以前", "以后", "之前", "之后", "当时",
]);

function isGoodTerm(t, maxLen) {
  if (typeof t !== "string") return false;
  if (t.length < 2 || t.length > maxLen) return false;
  if (FUNC_CHARS.test(t)) return false;
  if (STOP_TERMS.has(t)) return false;
  return true;
}

function buildTermIndex(root, ttlMinutes, cfg) {
  const now = Date.now();
  if (
    indexCache.root === root &&
    indexCache.terms.size > 0 &&
    now - indexCache.at < ttlMinutes * 60000
  ) {
    return indexCache.terms;
  }

  // 2026-10-23：测试残留和折叠归档不进词表 ✗
  // 起因：「今天早上」指到了一个 foldtest 文件 —— 那些东西不是记忆，是试验场
  const excludes = (cfg?.recall?.excludePaths ?? ["上下文折叠", "foldtest", "\\测试"]);
  const files = listMdFiles(root).filter((rel) => !excludes.some((x) => String(rel).includes(x)));
  const terms = new Map(); // 词 -> Set(文件)

  for (const rel of files) {
    const text = readMaybe(join(root, rel));
    if (!text) continue;

    const add = (t) => {
      if (!t) return;
      if (!terms.has(t)) terms.set(t, new Set());
      terms.get(t).add(rel);
    };

    // 标题行、加粗片段：短、像词的就收。
    // 带括号/顿号的再按分隔符拆一次——「眼睛（本地视觉服务）」要能同时对上这两半。
    const addSplit = (raw, maxLen) => {
      const whole = cleanTerm(raw);
      if (isGoodTerm(whole, maxLen)) add(whole);
      for (const part of String(raw).split(/[（）()「」【】《》·、,，/／|]+/)) {
        const c = cleanTerm(part);
        if (c !== whole && isGoodTerm(c, maxLen)) add(c);
      }
    };

    for (const m of text.matchAll(/^#{1,6}\s+(.+)$/gm)) addSplit(m[1], 10);
    for (const m of text.matchAll(/\*\*(.+?)\*\*/g)) addSplit(m[1], 10);

    // 反引号里的标识符：整串太长就拆开收零件（`ds-harness-remote` → remote）
    // 这样他说 "Remote" 也能对上我文件里的 `ds-harness-remote`
    for (const m of text.matchAll(/`([^`\n]{4,60})`/g)) {
      for (const part of String(m[1]).split(/[-_/.\\:]+/)) {
        const c = part.trim().toLowerCase();
        if (/^[a-z0-9]+$/.test(c) && c.length >= 4) add(c);
      }
    }

    // 文件名
    const fn = cleanTerm(String(rel).replace(/^.*[\\/]/, "").replace(/\.md$/, ""));
    if (isGoodTerm(fn, 10)) add(fn);
  }

  // 到处都是的词当噪声滤掉（也算一种不需要依赖的 TF-IDF）
  if (files.length >= 4) {
    const limit = files.length * 0.4;
    for (const [t, set] of [...terms]) if (set.size > limit) terms.delete(t);
  }

  indexCache.root = root;
  indexCache.at = now;
  indexCache.terms = terms;
  indexCache.count = files.length;
  log(`重建词索引：${files.length} 个文件，留用 ${terms.size} 个词`);
  return terms;
}

/** 真的用户消息（排除我自己注入的那些） */
function userMessages(messages) {
  return messages.filter((m) => m?.role === "user" && m?.source?.kind === "user");
}

function messageText(m) {
  return (m?.content ?? [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join(" ");
}

/* ───────── v1.1：把"我现在在哪个会话"写下来（2026-10-09 晚）─────────
 * 为什么要它：微信通道可以"钉"在一个会话上，但**会话是会换的**（换会话／新会话）。
 * 钉死一个 id 等于把他钉在过去 —— 他要的是**跟着往前走**。
 * 所以：**新会话一开（这个会话里还没有我说过的话），就把它的 id 写进
 * `生长\当前会话.txt`**；微信那边读这个文件 → 自动跟着走。
 * 两个护栏：① 老会话被重新打开时**不写**（里面已经有我说过的话）；
 *           ② 微信通道自己的工作区里的会话**不写**（不然它自己把指针抢走）。
 */
function workspaceStoreFile() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || "", ".dsh");
  return join(home, "storages", "workspace.json");
}

/** 这个会话属于某个"不是微信通道"的工作区吗 */
function inHumanWorkspace(sid) {
  try {
    const j = JSON.parse(readFileSync(workspaceStoreFile(), "utf8"));
    for (const w of Object.values(j?.tables?.workspaces ?? {})) {
      const p = String(w?.path ?? "").toLowerCase();
      if (p.includes("dsh_wechat")) continue; // 微信通道自己的地盘，跳过
      if ((w?.sessionIds ?? []).includes(sid)) return true;
    }
  } catch {
    /* 读不到就当"不确定"，不写 */
  }
  return false;
}

/** 新会话开场：写下"当前会话"。写不进去也不许抛（注入绝不能因此坏掉）。 */
function noteCurrentSession(cfg, sid, messages) {
  try {
    if (!cfg?.root || !sid) return;
    if (!Array.isArray(messages) || messages.some((m) => m?.role === "assistant")) return; // 不是新会话
    if (!inHumanWorkspace(sid)) return;
    const file = join(cfg.root, "生长", "当前会话.txt");
    let old = "";
    try {
      old = readFileSync(file, "utf8").trim();
    } catch {
      old = "";
    }
    if (old === sid) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, sid + "\n", "utf8");
    log(`当前会话 → ${sid.slice(0, 8)}（已写进 生长\\当前会话.txt）`);
  } catch (e) {
    log(`写当前会话失败: ${e?.message ?? e}`);
  }
}

/** 从 "2026-10-22" 算到今天几天了（本地时区即可，差一天无所谓） */
function ageDaysOf(dateStr) {
  try {
    const then = new Date(dateStr + "T00:00:00+08:00").getTime();
    if (!Number.isFinite(then)) return null;
    return Math.floor((Date.now() - then) / 86400000);
  } catch {
    return null;
  }
}

/**
 * 给事实表里的日期打上「多久以前」；超过 staleDays 再标「⏳旧了」。
 * 只动字，不动内容：`（2026-10-22）` → `（2026-10-22，1 天前）`
 */
function tagFreshness(text, file, cfg) {
  const spec = cfg.freshnessTag ?? {};
  if (spec.enabled === false) return text;
  const files = spec.files ?? ["关于他·事实.md"];
  if (!files.some((f) => String(file).endsWith(f))) return text;
  const staleDays = spec.staleDays ?? 21;
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/（(\d{4}-\d{2}-\d{2})）\s*$/);
    if (!m) { out.push(line); continue; }
    const days = ageDaysOf(m[1]);
    if (days === null || days < 0) { out.push(line); continue; }
    if (days === 0) { out.push(line); continue; }   // 今天的不用标，标了就是噪声
    const tag = days >= staleDays ? `，${days} 天前 ⏳旧了` : `，${days} 天前`;
    out.push(line.slice(0, m.index) + "（" + m[1] + tag + "）");
  }
  return out.join("\n");
}
/**
 * 回想（2026-10-23 夜，他："我们的记忆系统还缺什么"）：
 * 关键词指路撞不上近义词（"交接"↔"搬运"、"要多小"↔"巴掌大"），这一层补语义。
 * 背后是常驻服务 `工具箱\回想服务.py`（127.0.0.1:8770）。
 * 规矩照旧：**只报位置，不搬内容**；服务没起就静默跳过（绝不卡会话 ✓）。
 * 用 execFileSync：pre-step 是同步钩子；一次 100～300 ms，可接受。
 * config 里 `recall.semantic: false` 可一键关掉。
 */
function semanticHint(cfg, state, text, briefText) {
  // 冷却（2026-10-24 早上加）：服务挂的时候 curl 每次要等 2.5 秒，一轮里好几个钩子会一起卡 ✗
  // 失败后 60 秒内不再试 —— 服务被看护拉起来也就等一会儿，比每轮白等强 ✓
  // 2026-11-03 夜：冷却文件路径跟着 cfg.stateDir 走（分享版写死就等于串到我状态目录 ✗）
  const COOL = join(cfg.stateDir ?? DEFAULTS.stateDir, "语义-冷却.txt");
  try {
    if (fs.existsSync(COOL) && Date.now() - Number(fs.readFileSync(COOL, "utf8")) < 60000) return "";
  } catch {}
  try {
    if (cfg.recall?.semantic === false) return "";
    // 去掉口语壳再查（实测：「我想知道交接要多少块」比「交接要多少块」差很多）
    const q = String(text)
      .replace(/^(我想知道|我想问|帮我|请|查一下|看一下|还记得|我们之前|之前|那个|就是说)/g, "")
      .slice(0, 60).replace(/\s+/g, " ").trim();
    if (q.length < 4) return "";
    // 2026-11-03 夜：太短的招呼语不去翻记忆 —— 一句「大肥鱼！」（4 个字）只是叫我，
    //   语义层却翻出日记里两条旧句，既没用在对话里，还占名额 ✗
    //   判据：去掉标点后不足 8 个字，就不算"在问一件跟过去有关的事"。
    //   注意只管语义层：关键词层照旧（「铝型材」三四个字也该能指路 ✓）
    if (String(text).replace(/[\s，。！？!?、~～…,.：:；;“”"'（）()]/g, "").length < 8) return "";
    state.semSteps = (state.semSteps ?? 0) + 1;
    const seen = (state.semPointed ??= new Set());
    if (seen.size >= 12) return "";
    if (state.semLastAt !== undefined && state.semSteps - state.semLastAt < 1) return "";
    const out = execFileSync(
      "curl.exe",
      ["-s", "-m", "2", "http://127.0.0.1:8770/recall?q=" + encodeURIComponent(q) + "&n=3"],
      { encoding: "utf8", timeout: 2500, windowsHide: true },
    );
    const hits = JSON.parse(out).hits ?? [];
    const lines = [];
    for (const h of hits) {
      const where = h.file + ":" + h.line;
      if (seen.has(where)) continue;
      const snippet = String(h.text ?? "").replace(/[|`*#>]/g, "").trim().slice(0, 34);
      if (!snippet) continue;
      if (typeof briefText === "string" && briefText.includes(snippet.slice(0, 12))) continue;
      lines.push(where + "「" + snippet + "…」");
      seen.add(where);
      // 2026-11-03 夜：语义兜底只留 1 条（原来是 2 条）——"一轮最多一条指路"，多了就是噪音
      if (lines.length >= 1) break;
    }
    if (!lines.length) return "";
    state.semLastAt = state.semSteps;
    try { fs.unlinkSync(COOL); } catch {}
    return "💡 【回想】语义上这些地方有相关的（只报位置）：" + lines.join("；");
  } catch {
    // 记下失败时间：60 秒内不再试（服务多半挂了，等看护拉起）
    try { fs.writeFileSync(COOL, String(Date.now()), "utf8"); } catch {}
    // 2026-11-05（杜伽的 AI：静默退化用户永远不知道）—— 一个会话只提示一次，别刷屏
    if (!state.semWarned) {
      state.semWarned = true;
      log("语义召回不可用，已退化到关键词（127.0.0.1:8770 没响应）");
    }
    return "";
  }
}
/**
 * 找指针。返回一行提示，或者空串。
 * **只报"哪儿有"，不搬内容**；同一个词一个会话只报一次。
 */
function findPointers(cfg, state, text, briefText) {
  const r = cfg.recall;
  if (!r?.enabled) return "";
  if (typeof text !== "string" || text.length < 4) return "";

  // 冷却 + 总量上限（2026-10-11 加的）
  state.steps = (state.steps ?? 0) + 1;
  // 每会话最多指过多少个不同的词。原来是 6，2026-11-04 夜提到 12：
  //   一个长会话里聊过的人/文件远不止 6 个，6 一到后面全是语义层在瞎猜
  if (state.pointed.size >= (r.maxPerSession ?? 12)) return "";
  // 2026-11-03 夜（他点头收）：冷却期原本会把语义层放进来"补一条"，
  //   结果冷却反而成了语义每轮冒头的出口 —— 今晚连着冒了「每一次」「子代理」两条不相干的 ✗
  //   改成：冷却期直接闭嘴；语义只在下面"关键词一条都没撞上"时才跑（真缺近义词的场合正好都空手）。
  if (state.lastPointAt !== undefined && state.steps - state.lastPointAt < (r.cooldownTurns ?? 3)) return "";

  let terms;
  try {
    terms = buildTermIndex(cfg.root, r.indexTtlMinutes ?? 10, cfg);
  } catch (e) {
    log(`建索引失败: ${e?.message ?? e}`);
    return "";
  }

  const hits = [];
  const lowerText = text.toLowerCase();
  // 2026-11-03 夜（他点出来的）：「一般我说的第二条都是我们前面聊的第二条」——
  //   他那句「第二条缺点」指的是**这轮对话里**我列的第二条，不是记忆库里叫"第二条"的东西。
  //   纯指代词进词表 → 指路就是瞎指（今天指到了 草稿纸.md 里"他提的意见（第二条）"，答非所问）。
  //   判据：整词就是指代，一个字的内容都没有 → 不查记忆，语义那层也不放行。
  const 指代词 = /^(第[一二三四五六七八九十0-9]+[条点项个]?|这|那|它|上面|下面|前面|后面|刚才|上面那个|下面那个|这一条|那一条|这一条|这条|那条|这句|那句|这个|那个|这里|那里)$/;
  const 只有指代 = 指代词.test(text.replace(/[\s，。？！、~～…,.?!：:；;“”"'（）()]/g, ""));
  // 2026-10-23 加的账：这次为什么没指（只记数，不影响判断）
  const skip = { 没出现: 0, 指过: 0, 简报里有: 0, 太泛: 0, 指代: 0 };
  for (const [term, files] of terms) {
    if (term.length < (r.minTermLen ?? 2)) continue;
    if (指代词.test(term)) { skip.指代 += 1; continue; }
    // 纯英文标识符（从反引号里拆出来的）不分大小写
    const haystack = /^[a-z0-9]+$/.test(term) ? lowerText : text;
    if (!haystack.includes(term)) continue;
    // 2026-11-04 夜实测：「指过一次就永久拉黑」✗
    //   隔 20 轮再提到同一个人，关键词层被永久跳过 → 退到语义层
    //   语义层又可能捞回聊天碎片（「杜伽」那次捞到 折叠-原话池 里一句"小笨蛋 你杜伽姐姐…"），答非所问
    //   → 改成按轮数冷却：上次指它超过 repointAfter 轮（默认 8）就允许再指一次
    const lastAt = state.pointedAt?.get(term);
    if (lastAt !== undefined && state.steps - lastAt < (r.repointAfter ?? 8)) { skip.指过 += 1; continue; }
    // 简报里已经给过这个词 → 别再指一次（"一个事实一个家"）
    if (r.skipIfInBrief !== false && typeof briefText === "string" && briefText.includes(term)) { skip.简报里有 += 1; continue; }
    // 被很多文件提到的词 = 太泛（"项目""状态"这种），不值得指
    if (files.size > (r.maxFilesPerTerm ?? 4)) { skip.太泛 += 1; continue; }
    hits.push({ term, files: [...files] });
  }
  if (cfg.recallLog?.enabled !== false) {
    const skipTxt = Object.entries(skip).filter(([, n]) => n > 0).map(([k, n]) => k + n).join("／") || "无";
    log(`召回账：词表 ${terms.size}，命中 ${hits.length}，跳过 ${skipTxt}`);
  }

  // 词长的更具体，排前面；提到文件少的更可能是"这一件事"而不是泛泛的词
  hits.sort((a, b) => b.term.length - a.term.length || a.files.length - b.files.length);
  const picked = hits.slice(0, r.maxTerms ?? 2);
  // 关键词一条都没撞上 → 退到语义（近义词的缺口在这儿补）
  // 但整句只是一个指代（「就那个」「第二条呢」）时，语义也是瞎猜 → 不查
  if (picked.length === 0) {
    if (只有指代) return "";
    return semanticHint(cfg, state, text, briefText) || "";
  }

  // 记录"这次指了哪些、第几步指的"（pointsAt 用于按轮数冷却，pointed 保留给"指过什么"的统计）
  state.pointedAt ??= new Map();
  for (const p of picked) {
    state.pointed.add(p.term);
    state.pointedAt.set(p.term, state.steps);
  }
  state.lastPointAt = state.steps;   // 冷却计数（2026-10-11）

  // 2026-11-05 夜（海马体线第 3 样，他点头做的）：
  //   原来这里是 `p.files.slice(0, 3)` —— 按**扫描顺序**取前三个 ✗
  //   199 份文件里，昨天刚改的和半年前那份排一样前 ⇒ 指路指到的常是"陈年旧账"，不是"最近那件事"。
  //   改成：**最近碰过的排前面**（mtime 降序），钉子永远第一。
  //   为什么是 mtime：我真正需要被提醒的，多半是"前几天才碰过的"；久远的要有钉子才该露头。
  const 规范 = (x) => String(x).replace(/\//g, "\\");
  const 钉子 = new Set((r.pins ?? ["关于他.md", "关于他·事实.md"]).map(规范));
  const 新鲜度 = (rel) => {
    try {
      return statSync(join(cfg.root, rel)).mtimeMs;
    } catch {
      return 0;
    }
  };
  const 排文件 = (arr) =>
    [...arr].sort((a, b) => {
      const 钉A = 钉子.has(规范(a));
      const 钉B = 钉子.has(规范(b));
      if (钉A !== 钉B) return 钉A ? -1 : 1;
      return 新鲜度(b) - 新鲜度(a);
    });

  // 2026-11-05 夜（海马体线第 2 样）：指路只给路径，我分不清它是"我做过的事"还是"一份资料"。
  //   判"亲历还是查来"判不准 ✗（同一份文件里两者都有）—— 但判**文件类型**是 100% 准的，因为它就是文件放在哪。
  //   看到〔流水〕我知道那天确实发生过；看到〔方案〕我知道可能过时了；看到〔教训〕我知道是自己踩过的坑。
  //   只标**路径里看不出来的含义**四类 —— 〔手艺〕〔状态〕这种跟目录名重复，标了是废话 ✗
  const 类型标 = (rel) => {
    const p = 规范(rel);
    if (/^(生长\\今天线|今天线|日记|生长\\日记)/.test(p)) return "流水";
    if (/^关于他/.test(p)) return "他说的";
    if (/^手艺\\坑(\\|$)/.test(p)) return "教训";
    if (/^事(\\|$)/.test(p)) return "方案";
    return "";
  };
  const 带标 = (rel) => {
    const t = 类型标(rel);
    return t ? `〔${t}〕${rel}` : rel;
  };

  const lines = picked.map((p) => `「${p.term}」→ ${排文件(p.files).slice(0, 3).map(带标).join("、")}`);
  return `💡 【指路】记忆库里还有：${lines.join("；")}。（只报位置，没替你搬过来——要看自己去读）`;
}

// ───────────────── 架子上还有什么（v0.8） ─────────────────

// 书脊多久露一次（0 = 每次简报都给；2026-10-30 起 12 小时一次，平时沉默 ✓）
let shelfShownAt = 0;

/**
 * 把记忆库里**没被注入的那些**文件列成一行书脊。
 *
 * 为什么需要：简报只念三份，其余十几份我得"想起来"才去读——而"想起来"会失败。
 * **没被看见的，等于没有。** 不用把书都搬来，但得让我知道有哪些书。
 */
function buildShelfNote(cfg, sections) {
  const s = cfg.shelf;
  if (!s?.enabled || !cfg.root) return "";
  // 2026-10-30：**默认沉默，12 小时只露一次**（他说"我从没用它导航过，纯噪声"）
  //   书脊本身没错，是"每轮都铺开"错了 ✗ 需要看的时候，问一句 找工具.mjs 就行 ✓
  if (Date.now() - shelfShownAt < 12 * 3600e3) return "";
  shelfShownAt = Date.now();
  const injected = new Set((sections ?? []).map((x) => x.file));
  // 2026-11-03 夜（重启后看一眼简报就发现的）：exclude 原来只认**一模一样的文件名** ✗
  //   结果 `折叠-*.md` 那批（几十份、单份 5～7 MB 的压缩前原文）全被当"书"列出来，
  //   269 份里一大半是垃圾，书架成了噪音 ✗
  //   → 改成：以 `*` 结尾的按前缀排（"折叠-*"），带路径分隔符的按路径尾排，其余仍按原名排
  const excludePatterns = (s.exclude ?? []).map((p) => String(p).replace(/\//g, "\\"));
  // 折叠档是"压缩前的原文"，本来就不是"书"（真要读就按关键词直接捞）→ 默认永远不进书架
  const 默认排除 = ["折叠-*", "上下文折叠*", "foldtest*"];
  const isExcluded = (f) => {
    const name = String(f).replace(/\//g, "\\");
    return [...默认排除, ...excludePatterns].some((p) =>
      p.endsWith("*")
        ? name.startsWith(p.slice(0, -1)) || name.includes("\\" + p.slice(0, -1))
        : name === p || name.endsWith("\\" + p),
    );
  };

  let files;
  try {
    files = listMdFiles(cfg.root).filter((f) => !injected.has(f) && !isExcluded(f));
  } catch (e) {
    log(`列书架失败: ${e?.message ?? e}`);
    return "";
  }
  if (files.length === 0) return "";

  const total = files.length;
  // v1.3（2026-10-13 夜）：`shelf.always` —— **钉在书架最前、绝不被 maxFiles 挤掉**的那几份
  //   为什么：他问「插件整合做了应该可以让你今晚这种忘记自己有什么插件的情况有所改善吧」✓
  //   我的病根是**不知道有什么** ✗ —— 那"有什么"的索引就必须**每次都看得见** ✓
  //   （只钉"地图"，不钉内容 ✓ 地图自己去读 ✗）
  const norm = (p) => String(p).replace(/\//g, "\\");
  const always = (s.always ?? [])
    .map(norm)
    .filter((rel) => !injected.has(rel) && files.some((f) => norm(f) === rel));
  const rest = files.filter((f) => !always.some((a) => a === norm(f)));
  files = [...always, ...rest.slice(0, Math.max(0, (s.maxFiles ?? 30) - always.length))];

  const sizeOf = (rel) => {
    let chars = 0;
    try {
      chars = readFileSync(join(cfg.root, rel), "utf8").length;
    } catch {
      /* 读不到就不报大小 */
    }
    return chars >= 1000 ? `${Math.round(chars / 100) / 10}k` : String(chars);
  };

  // v1.2：分家之后**按抽屉分组**显示（我\ 事\ 手艺\ 生长\ …），一行一组，看得清。
  const groups = new Map();
  for (const rel of files) {
    const parts = String(rel).split(/[\\/]/);
    const g = parts.length > 1 ? parts[0] : "（根目录）";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(rel);
  }
  const lines = [];
  for (const [g, list] of groups) {
    lines.push(`   ${g}：${list.map((rel) => `${rel.split(/[\\/]/).pop()}(${sizeOf(rel)})`).join(" · ")}`);
  }
  const more = total > files.length ? `…等 ${total} 份` : "";
  return (
    `📚 【架子上还有什么】除了上面那几份，记忆库里还有 ${total} 份：\n` +
    `${lines.join("\n")}${more ? `\n   ${more}` : ""}\n` +
    `   （不用都读。**你提到相关的东西时我会指路**；想细看哪份自己去读。）`
  );
}

// 测试钩子（2026-11-03 夜）：书架有个"12 小时只露一次"的模块级时钟（shelfShownAt），
//   在进程里跑多处断言时，第一次就把窗口吃了，后面全看不到书架 ✗
//   生产不改，测试里调它把时钟归零即可。
export function __resetShelfClock() {
  shelfShownAt = 0;
}

// ───────────────── 过期引用自查（v1.2） ─────────────────

/**
 * 为什么加：2026-10-09 夜分家（根目录 24 份 → 我\ 事\ 手艺\ 生长\），
 * 最怕的就是**改了一头、忘了另一头** —— 我在这上面栽过好几次
 * （`交接.md` 改成 `项目.md` 之后，AGENTS.md 和备份脚本的清单都还指着旧名字）。
 *
 * 做法：只扫"最容易被当事实读"的几份（README / 状态 / 关于他），
 * 把里面提到的 `xxx.md` 挨个找一遍 —— 带路径的按路径找，不带路径的按**文件名**在库里找。
 * 找不到的就报出来。库外面的文件（AGENTS.md 之类）在跳过名单里，不误报。
 */
const refCache = new Map();
function buildRefNote(cfg) {
  try {
    if (!cfg.root || !cfg.splitCheck?.enabled) return "";
    const key = cfg.root;
    if (refCache.has(key)) return refCache.get(key);
    const files = listMdFiles(cfg.root);
    const base = new Set(files.map((f) => String(f).split(/[\\/]/).pop().toLowerCase()));
    const outside = new Set(["agents.md", "readme.md", "claude.md"]);
    const scan = ["README.md", join("生长", "状态.md"), "关于他.md"];
    const missing = new Map();
    for (const rel of scan) {
      let text = "";
      try {
        text = readFileSync(join(cfg.root, rel), "utf8");
      } catch {
        continue;
      }
      const found = [];
      for (const m of text.matchAll(/`([^`\n]{1,60}?\.md)`/g)) found.push(m[1]);
      for (const m of text.matchAll(/(?:^|[\s（(【])([\w\u4e00-\u9fa5·\-]{1,40}\.md)/g)) found.push(m[1]);
      for (const token of found) {
        const t = token.trim();
        const leaf = t.split(/[\\/]/).pop().toLowerCase();
        if (!leaf || outside.has(leaf)) continue;
        const ok = /[\\/]/.test(t) ? existsSync(join(cfg.root, t)) : base.has(leaf);
        if (!ok) missing.set(t, rel);
      }
    }
    const list = [...missing.entries()].slice(0, 2);
    const note = list.length
      ? `⚠️ 【自查·过期引用】${list
          .map(([t, where]) => `\`${t}\`（${where} 里提到，但记忆库里找不到）`)
          .join("；")}——**改完记得两头一起改。**`
      : "";
    refCache.set(key, note);
    return note;
  } catch (e) {
    log(`过期引用自查出错: ${e?.message ?? e}`);
    return "";
  }
}

export {
  SKIP_DIRS,
  buildTermIndex,
  listMdFiles,
  cleanTerm,
  isGoodTerm,
  userMessages,
  messageText,
  workspaceStoreFile,
  inHumanWorkspace,
  noteCurrentSession,
  ageDaysOf,
  tagFreshness,
  semanticHint,
  findPointers,
  buildShelfNote,
  buildRefNote,
};
