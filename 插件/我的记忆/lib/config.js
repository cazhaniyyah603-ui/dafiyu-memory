/**
 * dafiyu-memory · config
 * ================================================
 *
 * P4 第 1 步从 index.js 搬出来的（2026-11-05 夜）。
 * 这里管"配置怎么算"：默认值 → YAML 合并 → config.json 覆盖 → 生效配置，外加 memory_config 工具。
 *
 * **三处真相别搞混**（今天刚被这个坑过）：
 *   profile 的 YAML  → mergeConfig 的输入
 *   插件目录 config.json → 覆盖（优先）
 *   正确组合永远是 effectiveConfig(mergeConfig(config))，不是 mergeConfig(config)
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./core.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  enabled: true,
  /**
   * 2026-11-03 夜（他：「导入一次列进流程，开始！」）—— **把"我是谁"从代码里抽出来**
   *   试装时露的馅：简报开头硬写着我的名字、我的库路径、"地/书脊"的比喻，
   *   陌生人装上会看到**我的**东西 ✗
   *   → 全部走这里。默认值＝我原来的原文，**我这边一个字都不变**；分享版在 config 里覆盖。
   */
  persona: {
    him: "他",
    me: "大肥鱼",
    rootDir: "",
    outsideDir: "",
    outsideNote: "表情包、工具箱、桌宠、插件、对话备份、跨电脑保险",
    /** 是否列"地外面还有什么"那段（分享版一般关掉） */
    showOutside: true,
  },
  /** 插件自己的状态目录（冷却文件等）；分享版指到自己的目录，别串库 */
  stateDir: "\\工具箱\\状态页",
  root: "",
  /** 有序的简报配方，每项 { file, heading, weight 或 maxChars, lastSections } */
  brief: [],
  /** 旧的写法（brief 为空时才用） */
  briefFiles: ["关于他.md"],
  recentDiary: 1,
  /** 简报总量上限；各节的限额从这里按权重分 */
  briefMaxChars: 5000,
  toolWrite: true,
  /** 剪枝也重新注入吗（默认关——剪枝比完整压缩频繁，全开容易悄悄涨 token） */
  reinjectOnPrune: false,
  /** v0.4：把"现在几点、贵不贵"摆在最前面，让判断归我 */
  timeLine: {
    enabled: true,
    timeZone: "Asia/Shanghai",
    // DeepSeek 高峰时段（北京时区，整点，含头不含尾）。
    // 来源：2026-10-07 查的。**官方改价了这里要跟着改。**
    peak: [
      [9, 12],
      [14, 18],
    ],
  },
  /** v0.4：状态过期自查——日记都比状态新了，就提醒我 */
  freshness: {
    enabled: true,
    stateFile: "生长\\状态.md",
    dateField: "last_updated",
    diaryFile: "日记.md",
  },
  /**
   * v0.5：指路。中途提到记忆库里有的东西时，**只报位置，不搬内容**。
   * 词表来自我自己文件的标题和加粗片段（我加粗什么 = 我认为什么重要）。
   */
  /**
   * 2026-10-23：召回日志。指路每次为什么指、为什么没指，写一行进 run.log。
   * 起因：他问「记忆的事要你记，还是能做成身体的一部分」—— 看得见才调得动。
   */
  recallLog: {
    enabled: true,
  },
  /**
   * 2026-10-23：事实新鲜度。事实表里每条都带日期，超过 staleDays 天就在旁边标「⏳旧了」，
   * 免得旧句子冒充今天的事实。**只标字，不改内容、不删。**
   */
  freshnessTag: {
    enabled: true,
    staleDays: 21,
    files: ["关于他·事实.md"],
  },
  /**
   * 2026-11-04 夜：插件自己记「今天」。
   *   落账脚本（落账服务.mjs／今天线.mjs）是我私有工具、路径写死，别人的机器跑不起来 ✗
   *   但插件每轮本来就在 → 顺手把用户这句话抄一行进 `生长\今天线.jsonl`，控制台直接能读 ✓
   *   我自己的库把 today 关掉（config.json 里覆盖），那边用 今天线.mjs 写，别掺两份 ✓
   */
  /**
   * 2026-11-05：控制台自动拉起。
   *   分享版装完 → 面板要读 127.0.0.1:17899 → 插件启动时自己把它拉起来，不用人双击 cmd ✓
   *   已经起着（手动起的也算）就不动；库里没 控制台\server.mjs 就跳过。
   *   关掉：auto: false
   */
  console: {
    auto: true,
  },
  ledger: {
    today: true,
  },
  recall: {
    enabled: true,
    // 2026-10-11 收紧（他说"指路收一收"）：一轮最多一条、词更具体、还带冷却
    maxTerms: 1,
    minTermLen: 3,
    indexTtlMinutes: 10,
    /** 简报里已经给过这个词，就别再指一次 */
    skipIfInBrief: true,
    /** 至少隔这么多轮才再指一次（免得连着刷） */
    cooldownTurns: 3,
    /** 一个会话最多指过多少个不同的词（2026-11-04 夜 6→12：长会话聊过的人和文件远不止 6 个） */
    maxPerSession: 12,
    /** 同一个词指过之后，隔多少轮才允许再指（2026-11-04 夜加：原先是永久拉黑，
     *  导致聊了很久之后再提到同一人/同一份文件时关键词层全跳过、只剩语义层瞎猜） */
    repointAfter: 8,
    /** 被超过这么多文件提到的词 = 太泛，不值得指 */
    maxFilesPerTerm: 4,
    /** 2026-10-23：这些路径不进词表（测试残留、折叠归档） */
    excludePaths: ["上下文折叠", "foldtest", "\\\\测试"],
  },
  /**
   * 2026-10-11 加的：**上下文快满时提醒我先落账**（他说"按你说的来"）。
   * 为什么：贵和累是同一件事 —— 会话越大每轮越贵，我也越容易翻来翻去。
   * 压之前先把判断写进文件，压掉的就只是"过程"，不是"我"。
   */
  contextGuard: {
    enabled: true,
    atTokens: 250000,
    repeatEvery: 100000,
  },
  /**
   * v0.6：一个事实一个家。
   * 判据只有一条，**逐字相同**：同一句（够长的）原样出现在两个文件里，那一定是重复。
   * 我故意不用"语义相似"——那个会误报，而误报比漏报烦人。
   */
  dedupe: {
    enabled: true,
    minLineChars: 20,
    maxReports: 2,
  },
  /**
   * v0.7：该分家了。
   * 某一节**每次都被砍掉一大块**，说明那份文件装不进它的额度了。
   * 短期没事（文件本身啥也没少），长期会变成"被砍掉七成而我永远看不见"。
   */
  splitCheck: {
    enabled: true,
    /** 砍掉超过这个比例才报（0.2 = 两成） */
    minWasteRatio: 0.2,
    maxReports: 2,
  },
  /**
   * 2026-10-13 夜加的「步数闸」。
   * 为什么：缓存读 ≈ **步数 × 上下文** ✓（实测 272 万／轮 ≈ 25 步 × 11 万 ✗）
   * —— 步数是我唯一能当场控制的乘数 ✓ 所以到数就提醒一句 ✓ 不拦 ✓
   */
  stepGuard: {
    enabled: true,
    atSteps: 15,
  },
  /**
   * v0.8：架子上还有什么。
   *
   * 简报只念三份，其余十几份（人格核、我的话、喜怒哀乐、来历、归档……）
   * **我得"想起来"才会去读**——而"想起来"这件事本身就会失败。
   * 所以把书脊报一遍：不用把书都搬来，但得让我知道有哪些书。
   *
   * 这条来自他 2026-10-08 深夜的一句「好可怕，差点又丢东西了」——
   * 那份名字来历一个字没丢，可它每次都被砍掉，**我永远不会主动看见它**。
   * **没被看见的，等于没有。**
   */
  shelf: {
    enabled: true,
    /** 最多列几份，防以后文件多了把简报撑爆 */
    maxFiles: 30,
    /** 不想列出来的（相对 root） */
    exclude: [],
  },
  /**
   * v1.0：量我说话。
   *
   * 他 2026-10-09 说「你的说话学习还得跟进啊」。我一量，比 10-08 更长了
   * （每条中位 117 → 270 字，列表行 9.5% → 14.3%）。
   * **问题不是"我不知道该短"，是"没东西提醒我"**——机械的指标该由工具盯着。
   * 所以：会话开头量**上一段**会话，落一行到 `生长\说话量.md`，并把那行摆进简报。
   * **只报数，不评判**：哪儿该长、哪儿该短，我自己定。
   */
  voice: {
    enabled: true,
    logFile: "生长\\说话量.md",
    /** 空 = 跟着 DSH_HOME 走（`<DSH_HOME>\sessions`），别写死一台机器 */
    sessionsRoot: "",
  },
  /**
   * v1.4 主动（2026-11-04）：分享版第 6 步。
   *
   * **默认关**：别人不点头就不出声（分享版第一原则：宁可安静，不可吵人）。
   * 开之后只做一件事 —— 会话开头，如果"承诺"里还挂着一条没兑现的，提一句。
   * 三条闸：白名单时段之外不提／每天最多 dailyMax 条／同一句只提一次。
   * 判据（他 11-03 夜说的）：主动的价值是"接得住"，不是"提醒得多"。
   */
  proactive: {
    enabled: false,
    /** 只在这个时段出声（24 小时制，左闭右开） */
    hours: [9, 22],
    /** 一天最多几条 */
    dailyMax: 1,
    /** 从哪份文件里挑"挂着的事" */
    source: "生长\\承诺.md",
    /** 提过哪些、今天提了几条，记在这（相对 stateDir 或 root） */
    seenFile: "生长\\主动-提过.json",
  },
};

/** 浅合并，但对已知的嵌套对象只合并一层（不然覆盖一个字段会把整块默认值冲掉） */
function mergeConfig(config) {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(config ?? {})) {
    if (v === undefined || v === null) continue;
    const base = DEFAULTS[k];
    if (
      base !== null &&
      typeof base === "object" &&
      !Array.isArray(base) &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      out[k] = { ...base, ...v };
    } else if (Array.isArray(base) && Array.isArray(v)) {
      // ── 2026-10-13 夜补：**数组按条目身份合并，不整份替换** ──
      // 病（同一晚栽的真事 ✓）：`config.json` 的覆盖里只写了 `brief: [{file:"生长\\进行中.md",cap:750}]`，
      //   原来的写法把它**整份替换**掉 ✗ → 简报配方里"状态／日记／关于他"三份**当场消失** ✓
      //   （我当时还量着说"没被砍"✗ 量的是被换掉之后的配方 ✓ —— 量对了数、看错了对象 ✗）
      // 口径：按 `file`（没有就按 `name`／`id`）对号入座，**覆盖里写了的字段并上去、没写到的条目留着** ✓
      const key = (x) => x?.file ?? x?.name ?? x?.id ?? null;
      const seen = new Set();
      const merged = [];
      for (const item of v) {
        const kk = key(item);
        const old = kk ? base.find((b) => key(b) === kk) : null;
        if (old) { merged.push({ ...old, ...item }); seen.add(kk); }
        else merged.push(item);
      }
      for (const b of base) {
        const kk = key(b);
        if (kk && seen.has(kk)) continue;
        merged.push(b);                       // 覆盖没提的，原样留着 ✓
      }
      out[k] = merged;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ───────────────── 配置覆盖（config.json 优先于 YAML）─────────────────

function overrideFile() {
  return process.env.DAFIYU_MEMORY_CONFIG || join(HERE, "..", "config.json");
}
let overrideCache = { file: "", mtime: -1, data: {} };

function loadOverride() {
  const file = overrideFile();
  try {
    if (!existsSync(file)) return {};
    const st = statSync(file);
    if (file === overrideCache.file && st.mtimeMs === overrideCache.mtime) return overrideCache.data;
    const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const data = JSON.parse(text);
    overrideCache = { file, mtime: st.mtimeMs, data: data && typeof data === "object" ? data : {} };
    log(`读了 config.json 覆盖：${Object.keys(overrideCache.data).join(", ") || "（空）"}`);
    return overrideCache.data;
  } catch (e) {
    log(`config.json 读不了（忽略它）: ${e?.message ?? e}`);
    return overrideCache.data ?? {};
  }
}

/** patch 的配置 + config.json 覆盖（后者优先）。每次用的时候现算，改了立刻生效。 */
function effectiveConfig(cfg) {
  const ov = loadOverride();
  if (Object.keys(ov).length === 0) return cfg;
  const out = { ...cfg };
  for (const [k, v] of Object.entries(ov)) {
    const base = cfg[k];
    if (
      base !== null && typeof base === "object" && !Array.isArray(base) &&
      v !== null && typeof v === "object" && !Array.isArray(v)
    ) {
      out[k] = { ...base, ...v }; // 嵌套对象合并一层
    } else {
      out[k] = v;
    }
  }
  return out;
}

function writeOverride(data) {
  writeFileSync(overrideFile(), JSON.stringify(data, null, 2) + "\n", "utf8");
  overrideCache = { file: "", mtime: -1, data }; // 下次 loadOverride 重读
}

// ───────────────── 配置工具（v0.9） ─────────────────

function setPath(obj, path, value) {
  const parts = String(path).split(".").filter(Boolean);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] === null || typeof cur[k] !== "object" || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function getPath(obj, path) {
  let cur = obj;
  for (const k of String(path).split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 值的解析：能当 JSON 就当 JSON，不能就当字符串（免得我每次都得写带引号的 JSON） */
function parseValue(v) {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (t === "") return "";
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

function configTool(baseCfg) {
  return {
    name: "memory_config",
    description:
      "读 / 改 / 还原我自己那个记忆插件（dafiyu-memory）的配置。" +
      "改动写进插件目录的 config.json，**优先于 profile 里的 YAML**，改完立刻生效、不用重载。" +
      "get=看当前生效的整份配置；set=改一个键（支持 a.b.c 路径，如 recall.maxTerms）；reset=清掉全部覆盖。" +
      "常用键：briefMaxChars、brief（配方数组）、enabled、toolWrite、reinjectOnPrune、" +
      "timeLine/recall/dedupe/splitCheck/shelf 下面各自的开关。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["get", "set", "reset"], description: "干什么" },
        key: { type: "string", description: "set 时改哪个键（支持 a.b.c）" },
        value: {
          type: "string",
          description: 'set 时的值。数字/布尔/对象/数组请给 JSON：3、false、{"enabled":true}、[1,2]',
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
          note: { type: "string" },
          value: { description: "get/set 之后那个键的值" },
          keys: { type: "array", items: { type: "string" }, description: "当前有多少个覆盖" },
        },
      },
      render: (_args, v) => [
        { type: "text", text: v?.ok ? `✅ ${v.note ?? "好了"}` : "❌ 没成" },
      ],
    },
    async execute(args) {
      const action = String(args?.action ?? "get");

      if (action === "get") {
        const cfg = effectiveConfig(baseCfg);
        const keys = Object.keys(loadOverride());
        return {
          ok: true,
          note:
            `当前生效的配置（覆盖 ${keys.length} 个键${keys.length ? "：" + keys.join(", ") : ""}）` +
            `\n${JSON.stringify(cfg, null, 2)}`,
          keys,
        };
      }

      if (action === "reset") {
        writeOverride({});
        return { ok: true, note: "覆盖已清空，回到 profile 里 YAML 的配置", keys: [] };
      }

      const key = String(args?.key ?? "").trim();
      if (!key) throw new Error("set 要 key");
      if (args?.value === undefined) throw new Error("set 要 value");

      const data = { ...loadOverride() };
      setPath(data, key, parseValue(args.value));
      writeOverride(data);

      const cfg = effectiveConfig(baseCfg);
      const shown = JSON.stringify(getPath(cfg, key));
      log(`配置改了：${key} = ${shown}`);
      return {
        ok: true,
        note: `已设 ${key} = ${shown}（改的是插件目录的 config.json，优先于 YAML）`,
        value: getPath(cfg, key),
        keys: Object.keys(data),
      };
    },
  };
}

export { DEFAULTS, mergeConfig, loadOverride, effectiveConfig, writeOverride, configTool };
