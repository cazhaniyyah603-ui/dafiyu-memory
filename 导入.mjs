#!/usr/bin/env node
// 导入.mjs —— 把"别人已有的 AI 伙伴文件"读进我们的库（v0，2026-11-03 夜他点了这个想法）
//
// 为什么要它（他的原话）：「我觉得你刚才说的导入一次这个想法很好」
//   分享出去的人大多已经有一堆东西了：AGENTS.md、memory.md、聊天导出、笔记。
//   要求他们先清空再来用我们，等于让他们搬家 ✗
//   → 我们做搬运工：**只读他们的，只写我们自己的**，一步可逆 ✓
//
// 三条铁律
//   1. **先报告，不动手**：默认 dry-run；加 --write 才写，而且只写目标库，绝不改源文件
//   2. **不编内容**：原文照搬，只加"来自哪个文件哪一行"的出处；判断归类是提议，不是事实
//   3. **可逆**：写出去的都是 `导入-*.md` 新文件，删掉就等于没导入过
//
// 用法：
//   node 导入.mjs <源目录或文件>                  # 只出报告（默认）
//   node 导入.mjs <源目录或文件> --write --to <库根>  # 真写进目标库
//   node 导入.mjs <源> --map 关于他=记忆.md,时间线=chat.jsonl   # 手动指定谁归哪（覆盖自动判断）
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename, extname, relative } from "node:path";

const argv = process.argv.slice(2);
// 2026-11-03 夜：源路径就是**第一个非选项参数**，不能写 indexOf>0（只是位置恰好为 0 时会被自己漏掉）
const SRC = (() => {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--to" || a === "--map") { i++; continue; }
    if (!a.startsWith("--")) return a;
  }
  return "";
})();
const WRITE = argv.includes("--write");
const TO = (() => { const i = argv.indexOf("--to"); return i >= 0 ? argv[i + 1] : ""; })();
const MAP = (() => {
  const i = argv.indexOf("--map");
  if (i < 0) return {};
  const out = {};
  for (const kv of String(argv[i + 1] ?? "").split(",")) {
    const [k, v] = kv.split("=");
    if (k && v) out[k.trim()] = v.trim();
  }
  return out;
})();

// 四类去处（目标库里也都叫这个名，跟简报配方对齐）
const 类 = {
  关于他: "他这个人：称呼/职业/城市/喜好/忌讳/作息",
  事实: "会变的事实：键 → 值（同键只认最新）",
  时间线: "发生过什么：带时间的一行一事",
  承诺: "答应过还没做的、待办、提醒",
};

// 判据顺序＝"这行话本身有多像"，从强到弱。**内容先于文件名**：
//   `notes.md` 里写着「待办：…」就该进承诺，不该因为文件名像笔记就进事实 ✗（v0 实测犯过）
const 判据 = [
  ["关于他", /(我是谁|关于我|关于他|人设|称呼|喜欢吃|不吃|忌口|作息|起床|睡觉|职业|城市|怕什么|在意)/i],
  ["时间线", /(^\s*[-*]\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2})|(^\s*[-*]\s*\d{1,2}:\d{2})|(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}.{0,20}(说|做|发生|吃|去了))/],
  ["承诺", /(答应|承诺|待办|还没做|没做完|提醒我|下次要|TODO|未完成|欠着)/i],
  ["事实", /^\s*[-*]?\s*[^\s：:]{1,12}\s*(→|->|＝|=|：|:)\s*\S/],
];

const 文件名线索 = [
  ["关于他", /(agent|persona|人设|关于他|关于我|user|profile|助手|伙伴)/i],
  ["时间线", /(memory|日记|diary|log|流水|日志|chat|对话|聊天记录|export)/i],
  ["事实", /(fact|事实|备忘|notes|清单|cheatsheet)/i],
  ["承诺", /(todo|待办|承诺|promise|backlog)/i],
];

function walk(p, out = []) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walk(join(p, name), out);
    }
  } else {
    const ext = extname(p).toLowerCase();
    if ([".md", ".txt", ".jsonl", ".json", ".markdown"].includes(ext)) out.push(p);
  }
  return out;
}

function 猜类(文件, 段 = "") {
  // 内容优先（强到弱）；内容看不出来才靠文件名
  for (const [k, re] of 判据) if (re.test(段)) return k;
  for (const [k, re] of 文件名线索) if (re.test(basename(文件))) return k;
  return "待定";
}

// 切段：markdown 按行，jsonl 按行取 text；一行就是一条（我们的库就是这么记的）
function 切段(文件) {
  const raw = readFileSync(文件, "utf8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/);
  const segs = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (extname(文件) === ".jsonl") {
      let o; try { o = JSON.parse(line); } catch { continue; }
      const text = String(o.text ?? o.content ?? o.msg ?? "").trim();
      if (!text) continue;
      const t = String(o.t ?? o.time ?? o.date ?? "").slice(0, 16);
      segs.push({ line: i + 1, text: (t ? `[${t}] ` : "") + text });
    } else {
      // 标题行只承载结构、不承载内容 → 跳过
      //   （不跳会变成初稿里的空条目「- 关于他」「- 他是谁」 —— 2026-11-04 实测）
      if (/^#{1,6}\s/.test(line)) continue;
      // 正文一行一条
      segs.push({ line: i + 1, text: line });
    }
  }
  return segs;
}

function 主() {
  if (!SRC || !existsSync(SRC)) {
    console.log("用法：node 导入.mjs <源目录或文件> [--write --to <库根>] [--map 类=文件]");
    console.log("  默认只出报告，不动任何文件。\n");
    console.log("四类去处：");
    for (const [k, v] of Object.entries(类)) console.log(`  ${k.padEnd(4)} ${v}`);
    process.exit(SRC ? 1 : 0);
  }

  const 文件们 = statSync(SRC).isDirectory() ? walk(SRC) : [SRC];
  const 报告 = [];
  const 攒 = { 关于他: [], 事实: [], 时间线: [], 承诺: [] };
  const 跳过 = [];

  for (const f of 文件们) {
    const rel = relative(SRC, f) || basename(f);
    const st = statSync(f);
    if (st.size > 8 * 1024 * 1024) { 跳过.push([rel, "超过 8 MB，v0 不读（先手动挑几段）"]); continue; }
    let segs;
    try { segs = 切段(f); } catch (e) { 跳过.push([rel, "读不了：" + e.message]); continue; }
    if (!segs.length) { 跳过.push([rel, "没有可读的正文"]); continue; }

    // 手动 map 优先
    let 手动 = null;
    for (const [k, v] of Object.entries(MAP)) if (rel.includes(v) || basename(f) === v) 手动 = k;

    // 2026-11-04 夜实测：`chat.jsonl` 里「睡觉！」「我睡觉时间是几点来着？」这种碎句
    //   被内容规则（作息/睡觉）抢进「关于他」，初稿「他是谁」里全是聊天流水 ✗
    //   → 文件名已经明确是流水/聊天类的，**整份归时间线**，只把明确的"答应/待办"挑进承诺
    const 文件类 = 手动 ?? 猜类(f, "");
    const 承诺re = 判据.find(([k]) => k === "承诺")?.[1];
    let 归类 = 0;
    const 每条 = [];
    for (const s of segs) {
      let k;
      if (手动) k = 手动;
      else if (文件类 === "时间线") k = 承诺re && 承诺re.test(s.text) ? "承诺" : "时间线";
      else k = 猜类(f, s.text);
      if (k === "待定") continue;
      if (s.text.length < 4) continue;
      攒[k].push({ 来源: rel, 行: s.line, 文本: s.text });
      归类++;
      每条.push(k);
    }
    report(报告, rel, segs.length, 归类, 每条, st.size);
  }

  // ── 出报告 ──
  console.log("═══ 导入体检（只读，什么都没动）═══");
  console.log(`源：${SRC}   文件 ${文件们.length} 个\n`);
  console.log("文件                                  行数  归类  去向");
  for (const r of 报告) {
    const 去向 = Object.entries(r.计数).map(([k, v]) => `${k}×${v}`).join(" ") || "—";
    console.log(`${r.文件.slice(0, 34).padEnd(36)}${String(r.行数).padStart(4)}  ${String(r.归类).padStart(4)}  ${去向}`);
  }
  if (跳过.length) {
    console.log("\n跳过的（每条都说了为什么）：");
    for (const [f, why] of 跳过) console.log(`  ✗ ${f} —— ${why}`);
  }
  console.log("\n各类收了多少行：");
  for (const k of Object.keys(攒)) console.log(`  ${k.padEnd(4)} ${攒[k].length} 行`);

  // 去重：同文本只留第一次（别人的文件常有重复条目）
  let 重复 = 0;
  for (const k of Object.keys(攒)) {
    const seen = new Set();
    攒[k] = 攒[k].filter((x) => {
      const key = x.文本.slice(0, 60);
      if (seen.has(key)) { 重复++; return false; }
      seen.add(key); return true;
    });
  }
  if (重复) console.log(`\n去重：丢掉 ${重复} 行重复内容`);

  if (!WRITE) {
    console.log("\n（这是 dry-run。确认没问题再加 --write --to <你的库根> 真写进去）");
    return;
  }
  if (!TO) { console.log("\n✗ --write 要配 --to <库根>"); process.exit(1); }

  // ── 真写：只写 导入-*.md，绝不碰源文件 ──
  mkdirSync(join(TO, "事"), { recursive: true });
  const 报告行 = ["# 导入报告", "", `> ${new Date().toISOString().slice(0, 19).replace("T", " ")} +08:00 从 \`${SRC}\` 导入`, ""];
  // 2026-11-04 夜，真实样本实测出的两个毛病：
  //   ① `- # 出门清单` `- > —— 这不是定时提醒` —— 搬运时没剥 Markdown 标记，读起来像残渣
  //   ② 两个源文件的内容都归到「事实」就混成一锅，读者分不清哪句来自哪份
  //   → 统一剥标记 ＋ **按来源文件分小节**
  const 干净 = (t) => String(t)
    .replace(/^[-*+]\s+/, "")
    .replace(/^#+\s*/, "")
    .replace(/^>\s*/, "")
    .trim();
  for (const [k, rows] of Object.entries(攒)) {
    if (!rows.length) continue;
    const 文件 = join(TO, "事", `导入-${k}.md`);
    const 按来源 = new Map();
    for (const x of rows) {
      if (!按来源.has(x.来源)) 按来源.set(x.来源, []);
      按来源.get(x.来源).push(x);
    }
    const 内容 = [
      `# 导入-${k}`,
      "",
      `> 从别人的文件搬来的（原文照抄，带出处）。**这些都是搬运，不是判断** —— 看着不对就整份删掉，等于没导入过。`,
      `> 来源：\`${SRC}\``,
      "",
      ...[...按来源].flatMap(([来源, arr]) => [
        `## 来自 ${来源}（${arr.length} 行）`,
        "",
        ...arr.map((x) => `- ${干净(x.文本)}　\`${x.来源}:${x.行}\``),
        "",
      ]),
    ].join("\n");
    writeFileSync(文件, 内容, "utf8");
    报告行.push(`- ${k} → \`事/导入-${k}.md\`（${rows.length} 行）`);
    console.log(`  ✓ 写出 ${相对(TO, 文件)}（${rows.length} 行）`);
  }
  writeFileSync(join(TO, "事", "导入报告.md"), 报告行.join("\n"), "utf8");
  console.log(`  ✓ 写出 事/导入报告.md`);

  // 2026-11-03 夜：光写 事\导入-*.md 简报读不到（配方认的是固定那几份）→
  //   **只在目标文件还不存在时**生成一份"初稿"，顶上那几份的名字，装完立刻能用。
  //   已经有的文件一个字节都不覆盖 ✗（先来的人是主人）
  // 初稿复用上面写出那段定义的 干净()，否则会变成 "- - 称呼 → 阿哲" "- # 我是小助手"（v0 实测）
  const 初稿 = [
    ["关于他", join(TO, "关于他.md"), (rows) =>
      `# 关于他\n\n> 导入生成的初稿（原文照抄，改坏了直接改这行下面就行）\n\n## 他是谁\n\n${rows.map((x) => 干净(x.文本)).filter(Boolean).map((t) => `- ${t}`).join("\n")}\n`],
    ["事实", join(TO, "关于他·事实.md"), (rows) =>
      `# 会变的事实（同键只认最新）\n\n> 导入初稿，一行一条\n\n${rows.map((x) => 干净(x.文本)).filter(Boolean).map((t) => `- ${t}`).join("\n")}\n`],
    ["承诺", join(TO, "生长", "承诺.md"), (rows) =>
      `# 承诺（还没兑现的）\n\n${rows.map((x) => 干净(x.文本)).filter(Boolean).map((t) => `- ${t}`).join("\n")}\n`],
  ];
  for (const [k, 文件, 生成] of 初稿) {
    const rows = 攒[k] ?? [];
    if (!rows.length) continue;
    if (existsSync(文件)) { console.log(`  · ${相对(TO, 文件)} 已存在 → 不覆盖（导入内容留在 事/导入-${k}.md）`); continue; }
    mkdirSync(dirname(文件), { recursive: true });
    writeFileSync(文件, 生成(rows), "utf8");
    console.log(`  ✓ 生成初稿 ${相对(TO, 文件)}（${rows.length} 行）`);
  }
  // 时间线不给固定名字（每个系统叫法不同）→ 留在 事/导入-时间线.md，靠书架被看见
  console.log("\n原文件一个都没动 ✓ 想撤销：删掉 事/导入-*.md 和刚生成的初稿就行。");
}

function dirname(p) { return p.replace(/[\\/][^\\/]+$/, ""); }

function report(报告, 文件, 行数, 归类, 每条, 大小) {
  const 计数 = {};
  for (const k of 每条) 计数[k] = (计数[k] ?? 0) + 1;
  报告.push({ 文件, 行数, 归类, 计数, 大小 });
}
function 相对(a, b) { return relative(a, b).replace(/\\/g, "/"); }

主();
