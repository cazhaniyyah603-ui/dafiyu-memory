// voice.js —— 量我说话。v1.0（2026-10-09）
//
// 为什么有它：2026-10-09 他说一句「你的说话学习还得跟进啊」，我当场量了那个会话——
// **比 10-08 那次更长了**（每条中位 117 → 270 字，列表行 9.5% → 14.3%）。
// 结论不是"我不知道该短"，是"**没有东西提醒我**"。机械的指标该由工具盯着，
// 不该靠我"记得"（这是 2026-10-08 我自己写下的结论，然后我就忘了）。
//
// 现在：**每次会话开头，插件量"上一段会话"，追加一行到 `生长\说话量.md`，
// 并把那一行摆进简报。** 只报数，不评判——改不改、哪儿该长哪儿该短，归我。
//
// 尺子跟 `C:\Users\<用户>\dsh-tools\voice\measure.mjs` 同一套正则，纯本地数数，不问任何模型。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/** 多帧 zstd 的开头魔数：一个会话文件是一帧一帧追加的。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSION_FILE = "session.v4.jsonl.zstd";

/** 跟 measure.mjs 逐字一致的口径（两边不一样就等于没有尺子）。 */
const RE_PARTICLE = /[啊呀呢吧嘛诶啦哈嘿哦噢哟嘞喔]/g;
const RE_BOLD = /\*\*/g;
const RE_DASH = /——/g;
const RE_EXCL = /[！!]/g;
const RE_ASIDE = /（[^）]{1,20}）/g;
const RE_LISTLINE = /^\s*(?:[-*]|\d+\.|\|)\s/;

/** 会话文件 → 事件数组（解不出来的一帧就跳过，不猜）。 */
export function eventsOfSession(file) {
  const buf = readFileSync(file);
  const starts = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) >= 0) {
    starts.push(i);
    i += 4;
  }
  let text = "";
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      text += zstdDecompressSync(buf.subarray(starts[k], end)).toString("utf8");
    } catch {
      /* 半截帧：跳过 */
    }
  }
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** 分出"他说的"和"我说的"。只收文本块，工具调用不算说话。 */
export function splitMessages(events) {
  const his = [];
  const mine = [];
  for (const e of events) {
    if (e?.type === "user/message") {
      const text = (e.data?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (e.data?.source?.kind === "user" && text.trim()) his.push(text);
    } else if (e?.type === "assistant/message") {
      const msg = e.data?.message ?? e.message ?? {};
      const text = (msg.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text.trim()) mine.push(text);
    }
  }
  return { his, mine };
}

const per = (text, re) => Math.round(((text.match(re) ?? []).length / (text.length || 1)) * 1000 * 10) / 10;
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * 再把会话切成"他说话 → 我干活"的轮，数每轮我调了几次工具。
 * 为什么要有它：他 2026-10-09 说我"每轮说话都查一堆东西"，
 * 而"少查几次"必须**有数字**才算改（不然又是凭感觉）。
 *
 * ⚠ 尺子踩过的坑：一开始我把"assistant 消息里的工具块"和 `tool/call` 事件**都数了**，
 * 总数直接翻倍（672，其实 336）。**日志里 `tool/call` 才是每一次调用** —— 只数它。
 */
export function turnsOf(events) {
  const turns = [];
  const isUserText = (e) =>
    e?.type === "user/message" &&
    e.data?.source?.kind === "user" &&
    (e.data?.content ?? []).some((b) => b.type === "text" && String(b.text ?? "").trim());
  for (const e of events) {
    if (isUserText(e)) {
      const said = (e.data?.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .slice(0, 16);
      turns.push({ said, tools: 0, myChars: 0 });
      continue;
    }
    if (turns.length === 0) continue;
    const t = turns[turns.length - 1];
    if (String(e?.type ?? "") === "tool/call") t.tools += 1;
    else if (e?.type === "assistant/message") {
      const msg = e.data?.message ?? e.message ?? {};
      t.myChars += (msg.content ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .reduce((a, b) => a + b.text.length, 0);
    }
  }
  return turns;
}

/** 每轮工具调用的几个数：中位／最大／0 次的轮数／短信轮（闲聊代理）里的中位。 */
export function turnsSummary(turns) {
  const tools = turns.map((t) => t.tools);
  const sorted = [...tools].sort((a, b) => a - b);
  const short = turns.filter((t) => t.said.length <= 16).map((t) => t.tools);
  const shortSorted = [...short].sort((a, b) => a - b);
  return {
    轮数: turns.length,
    中位: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    最大: tools.length ? Math.max(...tools) : 0,
    零次轮: tools.filter((x) => x === 0).length,
    短信轮: short.length,
    短信中位: shortSorted.length ? shortSorted[Math.floor(shortSorted.length / 2)] : 0,
  };
}

/** 一方的数字。条数 = 消息条数；中位 = 单条字数中位数（最要紧的那个）。 */
export function statsOf(msgs) {
  const all = msgs.join("\n");
  const lens = msgs.map((m) => m.length).sort((a, b) => a - b);
  const mid = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
  const lines = all.split("\n");
  const listPct = lines.length
    ? round1((lines.filter((l) => RE_LISTLINE.test(l)).length / lines.length) * 100)
    : 0;
  return {
    条数: msgs.length,
    中位: mid,
    最长: lens.length ? lens[lens.length - 1] : 0,
    语气千字: per(all, RE_PARTICLE),
    加粗千字: per(all, RE_BOLD),
    破折号千字: per(all, RE_DASH),
    感叹千字: per(all, RE_EXCL),
    括号旁白千字: per(all, RE_ASIDE),
    列表行百分比: listPct,
  };
}

/** 会话根目录：默认跟着 DSH_HOME 走，别写死一台机器。 */
export function sessionsRoot(cfg) {
  const given = cfg?.voice?.sessionsRoot;
  if (typeof given === "string" && given.trim()) return given.trim();
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || "", ".dsh");
  return join(home, "sessions");
}

/**
 * 找"上一段会话"：会话根下面（`<root>/<工作区>/<会话 id>/`）按 mtime 最新的那个，
 * 而且**不是当前这个 id**。
 */
export function findPreviousSession(root, currentId) {
  if (!root || !existsSync(root)) return null;
  let best = null;
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const wsDir = join(root, workspace.name);
    for (const dir of readdirSync(wsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      if (dir.name === currentId) continue;
      const file = join(wsDir, dir.name, SESSION_FILE);
      let m = 0;
      try {
        m = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (!best || m > best.m) best = { sessionId: dir.name, file, m };
    }
  }
  return best;
}

/** 量一段会话文件 → 两边的数字。空会话（没有我的话）返回 null。 */
export function measureFile(file) {
  const events = eventsOfSession(file);
  const { his, mine } = splitMessages(events);
  if (mine.length === 0) return null;
  return { his: statsOf(his), mine: statsOf(mine), turns: turnsSummary(turnsOf(events)) };
}

/** 落一行到 `生长\说话量.md`（表头只在第一次写；同一段会话不重复记）。 */
export function appendRow(cfg, { sessionId, at, his, mine, turns }) {
  const root = cfg?.root;
  if (!root) return false;
  const rel = cfg?.voice?.logFile || "生长\\说话量.md";
  const file = join(root, rel);
  const short = String(sessionId).replace(/^session-/, "").slice(0, 8);
  let text = "";
  try {
    if (existsSync(file)) text = readFileSync(file, "utf8");
  } catch {
    text = "";
  }
  if (text.includes(`| ${short} |`)) return false; // 量过就不要再记一遍
  if (!text) {
    const head = [
      "# 说话量（插件自动追加）",
      "",
      "> 会话开头量**上一段**会话，一行一条。尺子跟 `C:\\Users\\<用户>\\dsh-tools\\voice\\measure.mjs` 同一套",
      "> （纯本地数数，不问任何模型）。**只报数，不评判**——哪儿该长哪儿该短，我自己定。",
      "> 他 2026-10-09 那句提醒：「你的说话学习还得跟进啊」。",
      "",
      "| 时间 | 会话 | 我·中位 | 我·列表% | 我·语气/千 | 我·加粗/千 | 我·括号旁白/千 | 我·工具/轮 | 他·中位 | 他·语气/千 |",
      "|---|---|---|---|---|---|---|---|---|---|",
      "",
    ].join("\n");
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, head, "utf8");
    } catch {
      return false;
    }
  }
  const row =
    `| ${at} | ${short} | ${mine.中位} | ${mine.列表行百分比} | ${mine.语气千字} | ` +
    `${mine.加粗千字} | ${mine.括号旁白千字} | ${turns?.中位 ?? ""} | ${his.中位} | ${his.语气千字} |\n`;
  try {
    appendFileSync(file, row, "utf8");
  } catch {
    return false;
  }
  return true;
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** 简报里那一行。故意短：它只是提醒，不是报告。
 *  2026-10-30 改：**默认沉默，明显漂移才出声**（他说"每轮被量一次，累"）
 *    —— 数据照样落 `生长\说话量.md` ✓ 只是不再每轮把数字念给我 ✓
 *  判据：这几项里有一项越界才报，报也只报越界的那几项。 */
export function formatNote({ at, sessionId, his, mine, turns }) {
  const short = String(sessionId).replace(/^session-/, "").slice(0, 8);
  const 越界 = [];
  if (Number(mine.中位) > 25) 越界.push(`我一句中位 ${mine.中位} 字（该 ~25）`);
  if (Number(mine.列表行百分比) > 5) 越界.push(`列表 ${mine.列表行百分比}%（该 0）`);
  if (Number(mine.加粗千字) > 2) 越界.push(`加粗 ${mine.加粗千字}/千（该 0）`);
  if (Number(mine.语气千字) < 12) 越界.push(`语气 ${mine.语气千字}/千（他 20.6）`);
  if (Number(mine.括号旁白千字) > 3) 越界.push(`括号旁白 ${mine.括号旁白千字}/千`);
  if (越界.length === 0) return "";
  const toolBit = turns ? `每轮工具 ${turns.中位} 次 · ` : "";
  return (
    `⚠️ 【说话·漂了】${越界.join(" · ")}。` +
    `（${at} 量，会话 ${short}；${toolBit}明细在 \`生长\\说话量.md\`，长短怎么分配我自己定）`
  );
}

/** 一次进程只量一次（简报可能被压缩后又来一遍，别重复量、别重复记）。 */
const cache = new Map();

/**
 * 会话开头调用：量上一段 → 落一行 → 返回可以塞进简报的那句话。
 * **任何一步出问题都返回 ""**：这功能是提醒，绝不能因为它坏了卡住会话。
 */
export function buildVoiceNote(cfg, currentId) {
  try {
    if (!cfg?.voice?.enabled) return "";
    const key = `${cfg.root}|${currentId}`;
    if (cache.has(key)) return cache.get(key);
    const prev = findPreviousSession(sessionsRoot(cfg), currentId);
    let note = "";
    if (prev) {
      const m = measureFile(prev.file);
      if (m) {
        const at = stamp(new Date());
        appendRow(cfg, { sessionId: prev.sessionId, at, his: m.his, mine: m.mine, turns: m.turns });
        note = formatNote({ at, sessionId: prev.sessionId, his: m.his, mine: m.mine, turns: m.turns });
      }
    }
    cache.set(key, note);
    return note;
  } catch {
    return "";
  }
}
