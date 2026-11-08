/**
 * dafiyu-memory · core（最底层）
 * ================================================
 *
 * P4 第 1 步从 index.js 搬出来的（2026-11-05 夜）。
 * 这里只放**谁也不依赖**的东西：HERE、日志。
 * 依赖方向是单向的：config.js / index.js → core.js，core.js 不 import 任何人。
 * （这样就不会绕出循环 import —— 拆分最容易死在这一步。）
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 日志路径在调用时才算——这样自测可以用 DAFIYU_MEMORY_LOG 把它指到临时文件，
 *  免得测试噪声把真日志淹掉（run.log 的用途正是"出问题先看这个"）。 */
function logPath() {
  return process.env.DAFIYU_MEMORY_LOG || join(HERE, "..", "run.log");
}

function log(msg) {
  try {
    const file = logPath();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
  } catch {
    /* 日志写不了就算了，绝不能让日志把正事搞挂 */
  }
}

// ── 通用工具（P4 第 2 步搬进来的）：读文件、取末几节、时间感、过期自查、预算分配 ──
// 它们只吃 fs 和 cfg，不碰 index.js 里的任何东西 —— 所以能待在最底层。

// ───────────────────────── 小工具 ─────────────────────────

function readMaybe(path) {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch (e) {
    log(`读不了 ${path}: ${e?.message ?? e}`);
    return null;
  }
}

/** 取最近 n 节（按 "\n## " 分节） */
function lastSections(text, n) {
  const parts = text.split(/\n(?=##\s)/);
  return parts.slice(-n).join("\n").trim();
}

// ───────────────────────── 时间 + 价段 ─────────────────────────

/**
 * "现在是 2026-10-08 22:40 周四（北京时间）—— 低谷时段，便宜。"
 * 高峰规则来自配置；**我不替它做决定，只把事实摆出来。**
 */
function buildTimeLine(cfg) {
  const t = cfg.timeLine;
  if (!t?.enabled) return "";
  try {
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: t.timeZone || "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    }).formatToParts(new Date());
    const get = (k) => parts.find((p) => p.type === k)?.value ?? "";
    const hour = Number(get("hour"));
    const wd = get("weekday"); // 中文短周几：周六／周日 …
    const isWeekend = /周(六|日|末)/.test(wd);
    // ⚠️ 2026-10-10 凌晨查官方定价页更正：高峰只是 **UTC 01:00-04:00 与 06:00-10:00 的周一至周五**，
    // 「**周末与节假日全天谷价**」。原来这里不看星期几 —— 周末白天会误报"贵"。
    // 配置：peakWeekdaysOnly（默认 true）／holidays: ['10-01', …]（法定假日，全天算谷价）
    const holidays = new Set(t.holidays ?? []);
    const mmdd = `${get("month")}-${get("day")}`;
    const isHoliday = holidays.has(mmdd);
    const weekdayOnly = t.peakWeekdaysOnly !== false;
    const inPeakHours = (t.peak ?? []).some(([a, b]) => hour >= a && hour < b);
    const isPeak = inPeakHours && !isHoliday && !(weekdayOnly && isWeekend);
    const why = isPeak ? "" : isHoliday ? "，节假日" : isWeekend ? "，周末" : "";
    const when = `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${wd}`;
    return `【现在】${when}（${t.timeZone}）—— ${isPeak ? "**高峰时段，token 贵，能省就省**" : `低谷时段，便宜${why}`}`;
  } catch (e) {
    log(`算时间失败: ${e?.message ?? e}`);
    return "";
  }
}

// ───────────────────────── 过期自查 ─────────────────────────

/**
 * 状态文件的 last_updated 比日记里最新那天还旧 → 状态过期了，提醒我。
 * **这条是我 2026-10-08 晚上靠肉眼发现的**（当时状态停在 10-07，
 * 而插件每次都会把那份过期的状态当事实喂给我）。现在让它自己查。
 */
function buildFreshnessNote(cfg) {
  const c = cfg.freshness;
  if (!c?.enabled || !cfg.root) return "";
  try {
    const statePath = join(cfg.root, c.stateFile);
    const diaryPath = join(cfg.root, c.diaryFile);
    if (!existsSync(statePath) || !existsSync(diaryPath)) return "";

    const m = readFileSync(statePath, "utf8").match(
      new RegExp(`^\\s*${c.dateField}\\s*:\\s*(\\d{4}-\\d{2}-\\d{2})`, "m"),
    );
    if (!m) return "";
    const stateDate = m[1];

    const dates = [...readFileSync(diaryPath, "utf8").matchAll(/^##\s+(\d{4}-\d{2}-\d{2})/gm)].map(
      (x) => x[1],
    );
    if (dates.length === 0) return "";
    const newest = dates.sort().at(-1);
    if (newest <= stateDate) return "";

    return `⚠️ 【自查】\`${c.stateFile}\` 的 ${c.dateField} 还停在 **${stateDate}**，可日记已经写到 **${newest}** —— **状态过期了，该更新，不然下次我又会拿旧状态当真。**`;
  } catch (e) {
    log(`过期自查失败: ${e?.message ?? e}`);
    return "";
  }
}

// ───────────────────────── 预算分配（v0.4 的 B） ─────────────────────────

/**
 * 把总预算按权重分给各节。
 *
 *   · 写了 `maxChars` 的：拿固定额度，先从总预算里扣掉
 *   · 写了 `weight` 的：分剩下的，按权重比例
 *   · 两个都没写的：不限额
 *
 * 除了额度，**还要给标题、分隔符和可能的截断标记留位置**——
 * 不然各节额度之和正好等于总预算时，全局兜底会把最后一节的尾巴（连同它自己的
 * 「本节到此截断」标记）一起吃掉，**结果是它被砍了我却看不到标记**。
 * （2026-10-08 自测抓出来的真 bug。）
 */
function resolveCaps(spec, totalBudget) {
  const explicit = spec.filter((e) => Number(e.maxChars) > 0);
  const weighted = spec.filter((e) => !(Number(e.maxChars) > 0) && Number(e.weight) > 0);
  const usedByExplicit = explicit.reduce((a, e) => a + Number(e.maxChars), 0);

  // 每节：标题（"── x ──\n"）+ 可能的截断标记（"\n…（本节到此截断）"）+ 节间空行
  const overhead = spec.reduce((a, e) => a + String(e.heading ?? "").length + 24, 0) +
    Math.max(0, spec.length - 1) * 2;

  const sumWeight = weighted.reduce((a, e) => a + Number(e.weight), 0);
  const pool = Math.max(0, totalBudget - usedByExplicit - overhead);

  for (const e of spec) {
    if (Number(e.maxChars) > 0) e.cap = Number(e.maxChars);
    else if (Number(e.weight) > 0 && sumWeight > 0) e.cap = Math.floor((pool * Number(e.weight)) / sumWeight);
    else e.cap = 0; // 不限额
  }
  return spec;
}

export { HERE, log, logPath, readMaybe, lastSections, buildTimeLine, buildFreshnessNote, resolveCaps };
