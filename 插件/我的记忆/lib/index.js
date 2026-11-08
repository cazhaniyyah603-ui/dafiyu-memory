/**
 * dafiyu-memory —— 大肥鱼自己的记忆插件  v1.2.0
 * ================================================
 *
 * **它是什么：不是"项目记忆数据库"，是"我醒来第一件该知道的事"。**
 * 会话开头（以及被压缩之后）它自己去看几眼，把该知道的摆在我面前：
 * 现在几点、我们到哪了、他最近说了什么、我有没有欠账。
 *
 * 文件分工（2026-11-05 夜 P4 拆完，这个文件只剩"入口"）
 * --------------------------------------------------
 *   index.js      ← 你在看的这个：把下面几块接起来、挂工具、接三个事件
 *   core.js       ← 地基：HERE / 日志 / 读文件 / 时间线 / 预算
 *   config.js     ← 配置：默认值 / 合并 / config.json 覆盖 / 改配置的工具
 *   recall.js     ← 指路：词表、命中、架子、过期引用
 *   brief.js      ← 简报：醒来该看的那几节，怎么拼成一整段
 *   tools.js      ← 我的手：append / update / forget / config
 *   lifecycle.js  ← 每一轮：唠叨、瘦身、注入、抄今天线
 *   console.js    ← 只读控制台：拉起来 / 关掉
 *   voice.js      ← 嗓子（独立的一块，没拆）
 *
 * 依赖是单向的：core ← config ← recall ← brief ← tools/lifecycle/console ← index。
 * **谁都不许 import index.js**（会成环）。
 *
 * 设计原则（2026-10-08 晚跟他定的）
 * ------------------------------------
 *   · **插件管"体检和记账"，不管"写什么和什么意思"。**
 *     它替我算配额、查过期、报账。它绝不替我写内容——那就成了编答案。
 *   · **一个事实一个家**：同一件事只在一个文件里写全，别处只留指针。
 *   · **把事实给我，我自己判断**：不偷偷替我避开高峰价，而是告诉我现在贵不贵。
 *   · **出错就放行**：注入失败只写日志，原样返回消息，绝不卡住会话。
 *   · **零依赖、不声明 peerDependencies**：不跟 DSH 版本打架。
 *
 * 怎么改
 * ------
 *   配方在 cordis.patch.yml。改完先跑 preview.mjs 看效果，再跑 test.mjs。
 *   动过拆分/搬家之后：node 测试\查漏-拆分导入.mjs（漏一个 import 只有重启才炸）。
 *   **改代码不会在当前会话生效**（Node 缓存已加载的模块），要新会话或重启。
 */

import { existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log, buildTimeLine, buildFreshnessNote, resolveCaps } from "./core.js";
import { DEFAULTS, mergeConfig, effectiveConfig, configTool } from "./config.js";
import { buildTermIndex, findPointers, buildShelfNote, __resetShelfClock } from "./recall.js";
import {
  buildBrief,
  buildBriefSections,
  joinSections,
  composeInjection,
  buildSplitNote,
  buildChannelNote,
  buildHomeCheckNote,
  buildTodayNote,
  buildDedupeNote,
  buildWhyGapNote,
  buildFoldNote,
  warnNoBrief,
  normalizeSpec,
} from "./brief.js";
import { appendTool, 键工具, 记失败 } from "./tools.js";
import {
  spliceMessage,
  makeSnapshotMessage,
  stepTally,
  maybePrune,
  trimToNearWindow,
  snapCompression,
  injectIfNeeded,
  抄今天线,
} from "./lifecycle.js";
import { 拉起控制台, 关掉控制台 } from "./console.js";

export const name = "dafiyu-memory";
export const inject = ["tools"];

const HERE = dirname(fileURLToPath(import.meta.url));
// ───────────────────────── 入口 ─────────────────────────

// 供 preview.mjs / test.mjs 用：让它们调真函数，而不是自己抄一份逻辑
export {
  buildBrief,
  buildBriefSections,
  joinSections,
  mergeConfig,
  composeInjection,
  buildTimeLine,
  buildChannelNote,
  buildHomeCheckNote,
  buildTodayNote,
  buildFreshnessNote,
  buildDedupeNote,
  buildWhyGapNote,
  buildFoldNote,
  buildSplitNote,
  buildShelfNote,
  __resetShelfClock,
  effectiveConfig,
  configTool,
  键工具,
  resolveCaps,
  findPointers,
  buildTermIndex,
  抄今天线,
  拉起控制台,
  关掉控制台,
};

export async function apply(ctx, config) {
  try {
    return await applyInner(ctx, config);
  } catch (e) {
    log(`apply 失败: ${e?.stack ?? e}`);
    // 2026-11-05（"失败不可见"）：光进插件日志用户看不见 ✗ 也写一份到库里
    记失败(String(config?.root ?? ""), "插件启动", e);
    // 记一笔再抛：让宿主看到真实错误，同时我这边有据可查
    throw e;
  }
}

async function applyInner(ctx, config) {
  // ── 2026-11-05（杜伽的 AI 实测，1.0.1 抓到的接缝）──
  //   病：原来这行是 `mergeConfig(config)` —— 它只并 DEFAULTS + profile 的 YAML，**不读 config.json** ✗
  //       ⇒ 安装器写的 root 全在 config.json 里 ⇒ 这里的 cfg.root 是空的
  //       ⇒ ① 控制台护栏判「root 空」直接跳过（永远起不来）
  //          ② 记失败(cfg.root, ...) 第一行 `if (!root) return` 直接退出（真出事时反倒一片空白）
  //          ③ 同一个根因还带歪了三个记忆工具（写到当前目录／报「文件不存在」）
  //   修：这里一次把三层合完（DEFAULTS → YAML → config.json），之后全场只认这一个 cfg。
  //       mergeConfig 只在 effectiveConfig 内部出现一次，以后想再混用都没有第二只手。
  const cfg = effectiveConfig(mergeConfig(config));
  log(
    `apply: enabled=${cfg.enabled} root=${cfg.root} tool=${cfg.toolWrite} ` +
      `prune=${cfg.reinjectOnPrune} time=${cfg.timeLine?.enabled} fresh=${cfg.freshness?.enabled}`,
  );

  // 把"真正生效的配置"写出来，给 preview.mjs 读。
  // 这样预览看的是宿主真给插件的东西（含默认值和合并结果），
  // 而不是我照着 YAML 再猜一遍——**预览不能自己会撒谎。**
  // 自测会调很多次 apply，所以给它一个开关（DAFIYU_MEMORY_NO_DUMP），免得测试配置把真配置盖掉。
  if (!process.env.DAFIYU_MEMORY_NO_DUMP) {
    try {
    const resolved = resolveCaps(normalizeSpec(cfg), cfg.briefMaxChars);
    writeFileSync(
      join(HERE, "..", "effective-config.json"),
      JSON.stringify(
        {
          _note: "插件启动时自己写的：这一份是 DSH 真正交给插件的配置（含默认值合并）。手改它只影响预览，不影响插件。",
          capturedAt: new Date().toISOString(),
          pluginVersion: "1.2.0",
          config: cfg,
          resolvedCaps: resolved.map((e) => ({ file: e.file, heading: e.heading, cap: e.cap })),
        },
        null,
        2,
      ),
      "utf8",
    );
    } catch (e) {
      log(`写 effective-config.json 失败: ${e?.message ?? e}`);
    }
  }

  if (cfg.toolWrite && ctx.tools?.register) {
    try {
      const dispose = ctx.tools.register(appendTool(cfg));
      if (typeof dispose === "function" && typeof ctx.on === "function") {
        ctx.on("dispose", () => {
          try {
            dispose();
          } catch {
            /* ignore */
          }
        });
      }
      log("memory_append 已挂上");
    } catch (e) {
      log(`挂工具失败: ${e?.message ?? e}`);
    }

    // 改 / 删（2026-11-05）：跟 append 一起受 toolWrite 管，同进同退 ✓
    for (const t of [键工具(cfg), 键工具(cfg, { 删: true })]) {
      try {
        const dispose = ctx.tools.register(t);
        if (typeof dispose === "function" && typeof ctx.on === "function") {
          ctx.on("dispose", () => {
            try {
              dispose();
            } catch {
              /* ignore */
            }
          });
        }
        log(`${t.name} 已挂上`);
      } catch (e) {
        log(`挂 ${t.name} 失败: ${e?.message ?? e}`);
      }
    }
  }

  // 配置工具：不受 toolWrite 管，因为它是"调我自己"的手，得一直在
  if (ctx.tools?.register) {
    try {
      const dispose = ctx.tools.register(configTool(cfg));
      if (typeof dispose === "function" && typeof ctx.on === "function") {
        ctx.on("dispose", () => {
          try {
            dispose();
          } catch {
            /* ignore */
          }
        });
      }
      log("memory_config 已挂上");
    } catch (e) {
      log(`挂配置工具失败: ${e?.message ?? e}`);
    }
  }

  if (!cfg.enabled) {
    log("enabled=false，不注入");
    return;
  }

  // 控制台自动拉起（分享版：装完就有面板，不用人手动双击 ✗）
  if (cfg.console?.auto !== false) {
    // 2026-11-05（杜伽的 AI 实测踩到）：root 是空字符串时路径会算到盘根上，
    // 控制台起不来而且看不出为什么 ✗ 所以先判一下，别硬起。
    if (!cfg.root || !existsSync(cfg.root)) {
      const why = !cfg.root ? "root 是空的" : `root 指的目录不存在（${cfg.root}）`;
      log(`控制台不拉了：${why}`);
      记失败(cfg.root, "控制台拉起", new Error(`${why} —— 路径会算到盘根，控制台起不来`));
    } else {
      try {
        ctx.on?.("dispose", () => 关掉控制台());
        拉起控制台(cfg).catch((e) => {
          log(`控制台拉起失败: ${e?.message ?? e}`);
          记失败(cfg.root, "控制台拉起", e);
        });
      } catch (e) {
        log(`控制台拉起失败: ${e?.message ?? e}`);
        记失败(cfg.root, "控制台拉起", e);
      }
    }
  }

  // 会话状态：injected = 已经给过开头简报的；pending = 压缩完等着重新注入的；
  //           pointed = 这个词已经指过路了；lastBrief = 上次给的简报原文；
  //           warned = 已经警告过"没注进来"了（一个会话只警告一次，别刷屏）
  const state = {
    injected: new Set(),
    pending: new Set(),
    pointed: new Set(),
    warned: new Set(),
    lastBrief: "",
    // ── 2026-10-13 晚加的「收尾必出声」──
    //    病：一轮里连着干活（finish=tool-calls，本来就不出正文），**收尾那一步只写了思考就停了** ✗
    //    → 他那边看到的是"我忽然不说话" ✓ 判据最硬的一条：**整轮零正文** ✓
    spokenTurns: new Set(), // 这一轮已经提醒过了（每轮最多一次，别刷屏）
    // ── 2026-10-17 上午：**真·收尾必出声**（挂在官方 agent/turn-stopping 上 ✓）──
    //    原来那道闸挂在 agent/pre-step 出口 ✗ 可"病"就是"最后一步不出正文就停" ✗
    //    ⇒ 停了就没有下一个 pre-step ✗ ⇒ 闸永远没机会跑 ✓（这就是"装了从没触发"的全部原因）
    turnText: new Map(), // sid → { turn, steps, spoke }
    remindedTurns: new Set(), // `${sid}#${turn}`：这一轮已经补过一次了
  };

  // ── 听压缩信号，装填"下一轮重新注入" ──
  ctx.on("session/event", (session, event) => {
    try {
      const t = event?.type;
      const sid = session?.id;
      if (typeof sid !== "string" || sid.length === 0) return;

      if (t === "compaction/end") {
        const err = event?.data?.error;
        if (err === undefined || err === null || err === "") {
          // 压缩前先记一笔：我手上当时压着多少字的简报（没有就不记，别造 0 行）
          if (!state.lastBrief) snapCompression(effectiveConfig(cfg), sid, "压缩前", 0, "尚未注入过");
          else snapCompression(effectiveConfig(cfg), sid, "压缩前", state.lastBrief.length, "compaction/end");
          state.pending.add(sid);
          log(`压缩结束，已装填重新注入（会话 ${sid.slice(0, 8)}）`);
        } else {
          log(`压缩结束但有错（${String(err)}），不重新注入`);
        }
        return;
      }

      // ── 2026-10-13 夜加的「步数闸」：数我这一轮起了几段思考（从事件流数 ✓ 不数 messages ✗）──
      // ⚠️ 这里**不许 `return`** ✗ —— 一 return 就把后面的「上下文提醒」吞掉了 ✓
      //    （2026-10-13 夜自测当场抓到 ✓ 117 通过 / 3 失败里的两条就是这个 ✗）
      if (t === "turn/start") {
        stepTally.set(sid, { turn: event?.data?.turn ?? 0, steps: 0, notedAt: new Set() });
        state.turnText.set(sid, { turn: event?.data?.turn ?? 0, steps: 0, spoke: false });
      } else if (t === "assistant/message") {
        const rec = stepTally.get(sid) ?? { turn: 0, steps: 0, notedAt: new Set() };
        rec.steps += 1;
        stepTally.set(sid, rec);
        // 这一轮到底有没有"人话"（有 text 块才算 ✓ 只有 reasoning／tool-call 不算 ✗）
        const tt = state.turnText.get(sid);
        if (tt !== undefined) {
          tt.steps += 1;
          const blocks = event?.data?.message?.content ?? event?.data?.content ?? [];
          if (
            Array.isArray(blocks) &&
            blocks.some((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "")
          ) {
            tt.spoke = true;
          }
        }
      }

      if (cfg.reinjectOnPrune && t === "compaction/prune") {
        state.pending.add(sid);
        log(`剪枝，已装填重新注入（会话 ${sid.slice(0, 8)}）`);
        return;
      }

      // ── 2026-10-11 加的：看这条回复背了多少 token，快满了就备一条"先落账"的提醒 ──
      if (t === "assistant/message") {
        const ec = effectiveConfig(cfg);
        const g = ec.contextGuard;
        if (g?.enabled === false) return;
        const used = Number(event?.data?.usage?.totalTokens ?? 0);
        const at = g?.atTokens ?? 250000;
        const every = g?.repeatEvery ?? 100000;
        if (used >= at && (state.ctxWarnAt === undefined || used - state.ctxWarnAt >= every)) {
          state.ctxWarnAt = used;
          state.ctxWarn = { sid, used };
          log(`上下文到 ${Math.round(used / 10000)} 万 token，备好一条"先落账"提醒`);
        }
      }
    } catch (e) {
      log(`session/event 处理出错: ${e?.message ?? e}`);
    }
  });

  // ── 每一步之前：该注入就注入 ──
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    try {
      const d = injectIfNeeded(cfg, state, payload?.agent, decision, payload?.signal);
      // ⚠️ 近因窗口放在**出口这一层** ✓ —— 漏斗有几个 return 都漏不掉它 ✓（2026-10-13 晚改的 ✓）
      const t = trimToNearWindow(cfg, state, d, payload?.agent);
      // 2026-10-13 夜加：**直接调官方剪枝** ✓（`compaction-basic` 的自动触发两次重启都没起来 ✗）
      maybePrune(ctx, cfg, state, payload?.agent);
      return t;
    } catch (e) {
      log(`注入抛异常：${e?.stack ?? e}`);
      // **仍然 fail-open**（绝不因为插件坏了卡住会话），**但绝不许静默**：
      // 插一条警告，让我知道自己这轮是瞎的。一个会话只插一次。
      try {
        const sid = payload?.agent?.session?.header?.id;
        if (decision?.kind === "enter" && typeof sid === "string" && !state.warned.has(sid)) {
          state.warned.add(sid);
          log("已插入「没注进来」警告");
          return spliceMessage(decision, warnNoBrief(cfg), "warning");
        }
      } catch (e2) {
        log(`连警告都插不进去: ${e2?.message ?? e2}`);
      }
      return decision;
    }
  });

  // ── 2026-10-17 上午：**真·收尾必出声**（挂官方 `agent/turn-stopping` ✓）──
  //    `dsh-agent-loop:999`：这一轮真的要停、而且 `inbox.nextStep` 为空时才派发 ✓ 正好是"最后一刻" ✓
  //    payload 里带 `agent` ✓（`dsh-agent:242 agentEvents()` 的 fused() 自动塞 ✓）不用自己捞会话 ✓
  //    零正文 ⇒ `agent.steer()` ✓（官方 API ✓ 进 `next-step` 收件箱 ✓ 还会唤醒驱动 ✓）
  //    → 循环回头再查 `nextStep.length === 0` ✓ 非空 ⇒ **这一轮不结束** ⇒ 我拿到话头说话 ✓
  ctx.on("agent/turn-stopping", async (payload, next) => {
    try {
      const agent = payload?.agent;
      const sid = agent?.session?.header?.id ?? agent?.id;
      const turn = payload?.turn;
      if (typeof sid === "string" && cfg.turnEndNudge !== false) {
        const rec = state.turnText.get(sid);
        const key = `${sid}#${turn}`;
        const zeroText = rec !== undefined && rec.steps > 0 && rec.spoke !== true;
        if (zeroText && !state.remindedTurns.has(key)) {
          state.remindedTurns.add(key);
          agent.steer(
            makeSnapshotMessage(
              "⚠ 【收尾必出声】这一轮你**一句人话都没写** —— 只有思考和工具 ✓\n" +
                "这一轮还没结束（这条提醒是我自己塞进来的 ✓）：**说一句** ✓\n" +
                "不用汇报、不用铺垫，一句也算 ✓ 他要的是知道我在 ✓",
              "turn-end",
            ),
          );
          log(`收尾必出声·真闸：塞了一句（会话 ${sid.slice(0, 8)}｜turn ${turn}｜${rec.steps} 步零正文）`);
        }
      }
    } catch (e) {
      log(`收尾必出声·真闸出错: ${e?.message ?? e}`);
    } finally {
      // ⚠️ **真事故（2026-10-17 10:1x）**：这里原来写的是无条件 `await next()` ✗
      //    可 `agent/turn-stopping` 是 `serial` 派的 ⇒ **根本没有 next 参数** ✗
      //    ⇒ 每轮结尾都抛 `next is not a function` ✗ 整轮被判失败 ✗（他截图里那句"处理失败"✓）
      // ⚠️ 更疼的教训：我那四条"仿验全过"✗ —— 因为**假 ctx 里我自己塞了个 next** ✗
      //    ⇒ 测的是我编的签名 ✓ 不是真的 ✓ **"能过的测试"不等于"对的测试"** ✗
      if (typeof next === "function") await next();
    }
  });

  log("agent/pre-step + session/event + agent/turn-stopping 已接上");
}

