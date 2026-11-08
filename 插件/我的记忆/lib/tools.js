/**
 * dafiyu-memory · tools（我动手改记忆库用的那几个工具）
 * ===================================================
 *
 * P4 第 5 步从 index.js 搬出来的（2026-11-05 夜）。
 *
 * memory_append（只追加，不改写）· memory_update（同键只认最新）· memory_forget（作废/归档）
 * · memory_config（改我自己的插件配置）。
 *
 * 共同点：**动手前先备份**（备份文件）、错了**留痕**（记失败）。
 * 这几样是"我的手"，不是"简报"。所以它们跟简报分开放。
 *
 * 只吃 core 的 log 和 config 的 loadOverride，**不 import index.js**。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, copyFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { log } from "./core.js";
import { loadOverride } from "./config.js";

// ───────────────── 写入工具 ─────────────────────────

function appendTool(cfg) {
  return {
    name: "memory_append",
    description:
      "把一段内容追加进我的 F 盘记忆库（自动带时间戳）。只追加，不改写已有内容。" +
      "适合记下值得留下的东西：他的原话、我学到的、今天发生了什么。" +
      "目标文件用相对记忆库根目录的路径，例如 日记.md、生长\\状态.md、草稿纸.md、我的话.md。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["file", "text"],
      properties: {
        file: { type: "string", description: "目标文件（相对记忆库根目录）" },
        text: { type: "string", description: "要写进去的内容" },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
          path: { type: "string" },
          bytes: { type: "integer" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: value?.ok ? `✅ 已追加到 ${value.path}（${value.bytes} 字节）` : "❌ 没有写成",
        },
      ],
    },
    async execute(args) {
      // 参数名容错：我自己都按内置 write/edit 的习惯写成 file_path 过（工具当时报了"file 不能空"，是对的）。
      // **既然我自己会踩，那就让工具两种都认。**
      const rel = String(args?.file ?? args?.file_path ?? args?.path ?? "").trim();
      const text = String(args?.text ?? args?.content ?? "");
      if (!rel) throw new Error("file 不能空");
      if (!text) throw new Error("text 不能空");
      if (rel.includes("..") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) {
        throw new Error("file 只能是记忆库内的相对路径");
      }
      const path = join(cfg.root, rel);
      const stamp = new Date().toLocaleString("zh-CN", { timeZone: cfg.timeLine?.timeZone || "Asia/Shanghai" });
      appendFileSync(path, `\n\n<!-- ${stamp} -->\n${text}\n`, "utf8");
      const bytes = Buffer.byteLength(text, "utf8");
      // 回合日志：这一轮往记忆库写了什么（他 2026-10-11 夜要的"看得见这一轮用了什么" ✓ 借鉴 dsh-mnemon）
      try {
        const hm = new Date().toLocaleString("zh-CN", {
          timeZone: cfg.timeLine?.timeZone || "Asia/Shanghai",
          hour12: false,
        });
        const head = String(text).split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
        appendFileSync(
          join(cfg.root, "生长", "回合日志.md"),
          "- " + hm + " ｜ 写 → " + rel + "（" + bytes + " 字节）｜ " + head.slice(0, 40) + "\n",
          "utf8",
        );
      } catch { /* 日志写不成不影响正文 ✓ */ }
      log("追加 " + rel + "（" + bytes + " 字节）");
      return { ok: true, path, bytes };
    },
  };
}

// ───────────────── 改 / 删（2026-11-05 加）─────────────────────────
//
// 杜伽的 AI 点出来的真洞：库里写着「同一个键只认最新」，可这件事一直靠人手删改 ——
// 只能加不能改的记忆，最后会变成一堆互相矛盾的古事实，**比记不住更麻烦**。
// 这两个工具只干一件事：按 key 改、按 key 删，只管「- 键 → 值」这一种格式。
//
// 为什么不做成"随便改任意文件"：那等于递给我一把没有边界的刀，改坏了看不见
// ✗ 限定格式 + 改前备份 + 返回改前改后，出问题能退回来 ✓

const 键值行 = /^-\s*([^→]+?)\s*→\s*(.*)$/;

function 备份文件(path) {
  try {
    // 到毫秒：只到小时的话，同一小时内改两次，第二次的备份会把第一次的覆盖掉 ✗（自测抓到的）
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    const dir = join(dirname(path), "备份");
    mkdirSync(dir, { recursive: true });
    const dst = join(dir, basename(path) + "." + stamp + ".bak");
    copyFileSync(path, dst);
    return dst;
  } catch (e) {
    log(`备份失败（不挡正事）: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * 失败也留个痕（2026-11-05 加）。
 *
 * 杜伽的 AI 指出来：装的时候坏了三处，全是黑盒 —— catch 后只 log()，日志只在插件目录，
 * 用户根本看不见 ✗ 建议把「最近一次失败摘要」写进库，人能看到，我也能读到。
 * 这里就是那支笔。记失败本身失败就算了（不能因为记不下来把正事也拖垮）。
 */
function 记失败(root, 阶段, e) {
  try {
    // 2026-11-05（杜伽的 AI 点出「错误处理依赖出错的那个对象」—— 经典坑，也最讽刺）：
    //   原来第一行是 `if (!root) return;` ⇒ **正好在 root 出事的时候它什么都不记** ✗
    //   现在：root 空就退到 config.json 里写的 root；还是没有才放弃（那时 log() 已经写进 run.log，不算全瞎）。
    let 库 = String(root ?? "").trim();
    if (!库) {
      try { 库 = String(loadOverride()?.root ?? "").trim(); } catch {}
    }
    if (!库) return;
    const dir = join(库, "生长");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    const msg = String((e && (e.message || e)) || e).split("\n")[0].slice(0, 200);
    appendFileSync(
      join(dir, "出错记录.md"),
      `- ${stamp} ｜ ${阶段} ｜ ${msg}\n`,
      "utf8",
    );
  } catch {
    /* 记不下来就算了，别把正事也拖垮 */
  }
}

/**
 * 按 key 改 / 删一行。
 * 只认「- 键 → 值」这一种格式 —— 别的写法不归它管，宁可报"没有这个键"也不猜。
 */
function 键工具(cfg, opts = {}) {
  const 删 = opts.删 === true;
  return {
    name: 删 ? "memory_forget" : "memory_update",
    description: 删
      ? "按 key 删掉记忆库里的一行（只认「- 键 → 值」格式，比如 关于他·事实.md 里的「- 他.作息 → …」）。用于「这条事实作废了」。删前自动备份到同目录 备份\\。"
      : "按 key 覆盖记忆库里的一行（只认「- 键 → 值」格式，比如 关于他·事实.md 里的「- 他.作息 → …」）。键在就整行换掉、不在就追加到「## 现行」段末尾。改前自动备份，返回改前改后 —— 这就是库里写的「同一个键只认最新」。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: 删 ? ["file"] : ["file", "key", "value"],
      properties: {
        file: { type: "string", description: "目标文件（相对记忆库根目录），比如 关于他·事实.md、我\\关于我·事实.md" },
        ...(删
          ? {
              key: { type: "string", description: "键名（「- 键 → 值」里 `→` 左边那段）。给了就只删这一行" },
              archive: { type: "boolean", description: "没给 key 时用：把整个文件移进库里的 归档\\（不真删，随时能拿回来）" },
            }
          : {
              key: { type: "string", description: "键名：`→` 左边那段，比如 他.作息" },
              value: { type: "string", description: "新值：`→` 右边那段（整行会被替换）" },
            }),
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
          note: { type: "string" },
          before: { type: "string" },
          after: { type: "string" },
          backup: { type: "string" },
        },
      },
      render: (_args, v) => [{ type: "text", text: (v?.ok === true ? "✅ " : "❌ ") + (v?.note ?? "") }],
    },
    async execute(args) {
      const rel = String(args?.file ?? "").trim();
      const key = String(args?.key ?? "").trim();
      if (!rel) throw new Error("file 不能空");
      // 删模式允许不给 key —— 那就是整份归档
      if (!key && !(删 && args?.archive === true)) {
        throw new Error("key 不能空（要整份归档就加 archive: true）");
      }
      if (rel.includes("..") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) {
        throw new Error("file 只能是记忆库内的相对路径");
      }
      const path = join(cfg.root, rel);
      if (!existsSync(path)) throw new Error(`文件不存在：${rel}`);

      // 整份归档（杜伽的 AI：forget 要能「按 key 或按文件」）
      if (删 && !key) {
        const 归档目录 = join(cfg.root, "归档");
        mkdirSync(归档目录, { recursive: true });
        const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
        const dst = join(归档目录, `${basename(path, extname(path))}.${stamp}${extname(path)}`);
        renameSync(path, dst);
        log(`归档 ${rel}`);
        return { ok: true, note: `已归档：${rel} → 归档\\${basename(dst)}（不是删，随时能拿回来）`, backup: dst };
      }

      const 原文 = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
      const lines = 原文.split(/\r?\n/);
      const at = lines.findIndex((l) => {
        const m = l.match(键值行);
        return m && m[1].trim() === key;
      });
      const before = at >= 0 ? lines[at].trim() : "";
      const bak = 备份文件(path);

      if (删) {
        if (at < 0) return { ok: false, note: `没有这个键：${key}（什么都没动）` };
        lines.splice(at, 1);
        writeFileSync(path, lines.join("\n"), "utf8");
        log(`删键 ${rel} :: ${key}`);
        return { ok: true, note: `已删：${before}`, before, backup: bak ?? "" };
      }

      const val = String(args?.value ?? "").replace(/\r?\n/g, " ").trim();
      if (!val) throw new Error("value 不能空");
      const 新行 = `- ${key} → ${val}`;
      if (at >= 0) {
        lines[at] = 新行;
      } else {
        const h = lines.findIndex((l) => /^##\s*现行/.test(l));
        if (h >= 0) {
          let i = h + 1;
          while (i < lines.length && !/^##\s/.test(lines[i])) i++;
          let j = i - 1;
          while (j > h && !lines[j].trim()) j--;
          lines.splice(j + 1, 0, 新行);
        } else {
          lines.push("", "## 现行", "", 新行);
        }
      }
      writeFileSync(path, lines.join("\n"), "utf8");
      log(`改键 ${rel} :: ${key}`);
      return {
        ok: true,
        note: `${at >= 0 ? "已改" : "已加"}：${新行}`,
        before,
        after: 新行,
        backup: bak ?? "",
      };
    },
  };
}

export { appendTool, 键值行, 备份文件, 记失败, 键工具 };
