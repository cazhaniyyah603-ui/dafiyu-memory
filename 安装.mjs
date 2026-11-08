#!/usr/bin/env node
// 安装.mjs —— 一条命令把记忆系统装到 DSH 上（v0，2026-11-04 凌晨）
//
// 为什么是"一条命令"：验收门槛写的是"干净机器 5 分钟、四项全绿"。
// 六步：查前置 → 建库 → 写配置 → 注册插件 → 装控制台 → 自检。
//
// 三条铁律（跟导入.mjs 一样）
//   1. **先出计划，不动手**：默认 dry-run；加 --write 才真装
//   2. **不覆盖别人的东西**：建库只补缺的文件；配置合并只加自己的键（写前备份）
//   3. **可逆**：--uninstall 只删自己加的（配置键／插件登记），库原样留着
//
// 用法：
//   node 安装.mjs                                    # 只看计划（默认 dry-run）
//   node 安装.mjs --write --name 他 --me 我     # 真装
//   node 安装.mjs --write --name 他 --lib "D:\记忆" --plugin "C:\插件\我的记忆"
//   node 安装.mjs --self-check                       # 只跑五项自检
//   node 安装.mjs --uninstall                        # 卸掉登记，库留着
//
// 默认路径：
//   profile  %USERPROFILE%\.dsh\profiles\desktop
//   库       %USERPROFILE%\Documents\大肥鱼记忆
//   插件     本脚本目录往上两级：..\..\..\插件\我的记忆
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url)); // 工具箱\分享版
const argv = process.argv.slice(2);
const 有 = (k) => argv.includes(k);
const 取 = (k, d = "") => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const WRITE = 有("--write");
const UNINSTALL = 有("--uninstall");
const SELF_ONLY = 有("--self-check");
// --move <新库路径>：搬家（2026-11-05 加 —— 杜伽的 AI 点出来：绝对路径散在三处配置
// 加库里的文案里，漏一处系统不报错，只是文案还指着旧库）
const MOVE = 取("--move", "");
// --auto：配合 --move，把库里写死的旧路径**也**一起改。
// 默认**不动文件只列清单** —— 杜伽的 AI 指出：库里可能有「当时库在 D:\旧」这种历史记录，
// 自动替换等于篡改 ✗ 所以让人看一眼再决定。
const AUTO_MOVE = 有("--auto");
const DRY = !WRITE && !UNINSTALL && !SELF_ONLY && !MOVE;

const PROFILE = 取("--profile", join(homedir(), ".dsh", "profiles", "desktop"));
// 库位置：--lib 显式给了就用；没给的话下面（常量齐了以后）先看现装插件里配的 root，
// 读不到才退回默认 —— 2026-11-05 下午杜伽的 AI 第三轮指出：原来这里硬编码默认值，
// 搬过库的人一双击装吧.cmd 就被指回 Documents\大肥鱼记忆，库还在原地但简报读不到，人会以为记忆坏了。
let LIB = 取("--lib", join(homedir(), "Documents", "大肥鱼记忆"));
const 显式给了库 = 有("--lib");
// 插件在哪：分享包里自带一份（`本目录\插件\我的记忆`）；我们自己的树里在往上两级
const 自带插件 = join(HERE, "插件", "我的记忆");
const PLUGIN = resolve(取("--plugin", existsSync(自带插件) ? 自带插件 : join(HERE, "..", "..", "插件", "我的记忆")));
const HIM = 取("--name", "他");
const ME = 取("--me", "我");
const TEMPLATE = join(HERE, "库模板");
const 控制台源 = join(HERE, "控制台", "server.mjs");
const PKG = join(PROFILE, "package.json");
const 插件名 = "dafiyu-memory";
// 插件最终落在 profile 的 node_modules 里（复制过去，不是链回安装目录）
// —— 这样装完就能把解压出来的文件夹删掉，插件照常跑（2026-11-04 上午改）
const 插件落点 = join(PROFILE, "node_modules", 插件名);

// ── 重装沿用现有库（2026-11-05 下午；杜伽的 AI 第三轮点出来的新隐患）──
// 她原话大意：安装器不读你现有的 config.json 里的 root，搬过库的人一重装就被指回默认位置。
// 库还在原地、什么都不丢，但简报会照旧路径读，人会以为记忆坏了。
// 所以：没显式给 --lib 时，先读现装插件里配的 root；读不到才用默认。
function 读现有root() {
  for (const f of [join(插件落点, "config.json"), join(插件落点, "effective-config.json")]) {
    try {
      if (!existsSync(f)) continue;
      const j = JSON.parse(String(readFileSync(f, "utf8")).replace(/^\uFEFF/, ""));
      const r = String(j?.root ?? j?.config?.root ?? "").trim();
      if (r) return r;
    } catch {
      /* 读不到就试下一个 */
    }
  }
  return "";
}
if (!显式给了库) {
  const 现 = 读现有root();
  if (现 && resolve(现).toLowerCase() !== resolve(LIB).toLowerCase()) {
    LIB = 现;
    // 这里在顶层，行() 还没定义（TDZ），所以直接用 console.log
    console.log(`  沿用已装的库：${LIB}`);
    console.log("  （没给 --lib 时不会把它挪回默认位置；要换库才显式给）");
  }
}
const 插件配置 = join(插件落点, "config.json");
// 面板（2026-11-05 凌晨加）：第二个插件，纯客户端 —— 只做一件事：把库里的控制台那一页
// 套进 DSH 侧边栏。装不上／挂不上都不影响记忆那颗（记忆先活，面板是锦上添花）
const 面板自带 = join(HERE, "插件", "大肥鱼面板");
const 面板源 = resolve(取("--panel", existsSync(面板自带) ? 面板自带 : join(HERE, "..", "..", "插件", "大肥鱼面板")));
const 面板名 = "dafiyu-console-panel";
const 面板落点 = join(PROFILE, "node_modules", 面板名);
const 面板在包 = existsSync(join(面板源, "lib", "client.js"));
const 时间戳 = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);

// 2026-11-05（杜伽的 AI：手写清单就会漏 —— 1.0.0 修过一次，1.0.1 重打包又丢了面板入口 ✗）
//   文件清单**只写这一处**：复制插件用它，--self-check 也用它 ✓ 再漏就是上游少了文件
// 2026-11-05 夜（P4 拆分之后）：lib 不再只有 index.js 一个文件 ——
//   第一次自证就炸在这：「Cannot find module '...\lib\core.js' imported from index.js」
//   安装器只搬了清单里的 index.js/voice.js，profile 里自然缺了 core/config/recall/brief/tools/lifecycle/console ✗
//   → 改成"读目录"，以后再加文件不用记得改这里（手写清单漏过两次了，这不是第三次的机会）
const 记忆文件 = [
  "package.json",
  "cordis.patch.yml",
  (() => {
    try {
      return readdirSync(join(PLUGIN, "lib"))
        .filter((f) => f.endsWith(".js") && !f.includes(".bak"))
        .map((f) => `lib\\${f}`);
    } catch {
      return ["lib\\index.js", "lib\\voice.js"]; // 插件源不在（dry-run）时给个底线清单
    }
  })(),
].flat();
// 2026-11-05 下午补 lib\index.js：原来清单里只有 client.js，而 DSH 按 package.json 的 main 找
// 宿主入口 → 找不到 → 面板挂不上。杜伽的 AI 在真机上撞出来的，见 ②d 那条自检。
const 面板文件 = ["package.json", "cordis.patch.yml", "lib\\index.js", "lib\\client.js"];

let 失败 = 0;
let 还没装 = false;   // 库都没建时自检不算失败，只是"还没装"
const 行 = (s = "") => console.log(s);
const 好 = (s) => 行(`  ✓ ${s}`);
const 坏 = (s) => { 失败 += 1; 行(`  ✗ ${s}`); };
const 步 = (n, s) => 行(`\n[${n}] ${s}`);

function 读JSON(file) {
  try {
    // 去掉 BOM：Windows 上有些工具存 JSON 会带 BOM，JSON.parse 会直接报错（测试里真撞上过）
    const 文 = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(文);
  } catch { return null; }
}
function 备份(file) {
  if (!existsSync(file)) return "";
  const dst = `${file}.bak-安装-${时间戳}`;
  copyFileSync(file, dst);
  return dst;
}

// ── 前置 ──
function 查前置() {
  步(1, "查前置");
  if (DRY || UNINSTALL) {
    好(`profile  ${PROFILE}${existsSync(PROFILE) ? "" : "（不存在——dry-run 只做展示）"}`);
    好(`插件     ${PLUGIN}${existsSync(PLUGIN) ? "" : "（不存在——dry-run 只做展示）"}`);
    好(`库       ${LIB}`);
    return;
  }
  if (!existsSync(PROFILE)) 坏(`profile 不存在：${PROFILE}`);
  if (!existsSync(join(PLUGIN, "lib", "index.js"))) 坏(`插件不存在或没构建：${PLUGIN}`);
  if (!existsSync(TEMPLATE)) 坏(`模板不存在：${TEMPLATE}`);
  if (!UNINSTALL && existsSync(PKG)) 好(`profile 找到了`);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 22) 好(`node ${process.versions.node}`);
  else 坏(`node 太旧（${process.versions.node}），要 22 以上`);

  // 2026-11-05 加：真机试装踩到的坑 —— 在 DSH 的对话框里跑 --write，
  // 沙箱会把写盘直接拒掉，表现是「跑到一半卡住」，人还以为是包坏了。
  // 与其中途静默失败，不如一上来就试着写一下，写不了当场说清楚。
  if (WRITE && !UNINSTALL) {
    const 能写 = (dir) => {
      try {
        if (!existsSync(dir)) return { ok: false, why: "目录不存在" };
        const 试 = join(dir, ".dsh-write-probe-" + 时间戳);
        writeFileSync(试, "x");
        unlinkSync(试);
        return { ok: true };
      } catch (e) {
        return { ok: false, why: String((e && (e.code || e.message)) || e) };
      }
    };
    const a = 能写(PROFILE);
    const b = 能写(dirname(LIB));
    if (a.ok && b.ok) 好("写盘通（profile 和库的位置都能写）");
    else {
      行("");
      行("  ✗ 写不进去 —— 你多半是在 DSH 的对话框里跑的。");
      行("    安装器要写这两个位置，都在 DSH 的工作区之外，会被沙箱直接拒写：");
      行(`      ${PROFILE}${a.ok ? "" : "   ← 写不了（" + a.why + "）"}`);
      行(`      ${LIB}${b.ok ? "" : "   ← 写不了（" + b.why + "）"}`);
      行("");
      行("    换个普通的 PowerShell／终端窗口，在解压出来的文件夹里重跑：");
      行("      node 安装.mjs --write");
      行("    Windows 上可以在这个文件夹里按住 Shift 右键 → 在此处打开 PowerShell 窗口。");
      process.exit(1);
    }
  }
}

// ── 建库 ──
function 建库() {
  步(2, `建库 → ${LIB}`);
  if (UNINSTALL || SELF_ONLY) { 行("  跳过（不建库）"); return; }
  const 今天 = new Date().toISOString().slice(0, 10);
  const 要写 = [];
  const 走 = (dir) => {
    for (const name of readdirSync(dir)) {
      const src = join(dir, name);
      const rel = src.slice(TEMPLATE.length + 1);
      const dst = join(LIB, rel);
      if (statSync(src).isDirectory()) { 走(src); continue; }
      if (existsSync(dst)) { 行(`  · 已有，不覆盖：${rel}`); continue; }
      要写.push({ src, dst, rel });
    }
  };
  走(TEMPLATE);
  for (const f of 要写) {
    if (DRY) { 好(`会写 ${f.rel}`); continue; }
    mkdirSync(dirname(f.dst), { recursive: true });
    let 文 = readFileSync(f.src, "utf8");
    文 = 文.replaceAll("{{今天}}", 今天);
    文 = 文.replaceAll("（你的名字）", HIM);
    writeFileSync(f.dst, 文, "utf8");
    好(`写 ${f.rel}`);
  }
  if (要写.length === 0) 好("库已经是齐的，一个文件都没动");
}

// ── 把插件复制进 profile（不链回安装目录）──
// 只复制跑得起来的四个文件；不覆盖 DSH 自己装的东西：只有目标不存在、或目标是我们自己放的才动。
// 把一组文件从源目录搬到落点：先查齐、再清空、再按表复制
function 搬一份(源目录, 落点, 文件表) {
  for (const f of 文件表) {
    if (!existsSync(join(源目录, f))) { 坏(`插件源缺 ${f}（${源目录}）`); return false; }
  }
  rmSync(落点, { recursive: true, force: true });
  for (const f of 文件表) {
    mkdirSync(dirname(join(落点, f)), { recursive: true });
    copyFileSync(join(源目录, f), join(落点, f));
  }
  return true;
}

function 复制插件() {
  // ① 记忆（主体）：就地安装（我们自己的 profile）就不搬
  if (resolve(PLUGIN) !== resolve(插件落点)) {
    搬一份(PLUGIN, 插件落点, 记忆文件);
  }
  // ② 面板（副的）：装不上也不能把记忆那颗带下水
  if (!面板在包) { 行("  · 这次没带来面板包，只装记忆（不影响用）"); return false; }
  if (resolve(面板源) === resolve(面板落点)) return false; // 就地安装
  try {
    return 搬一份(面板源, 面板落点, 面板文件);
  } catch (e) {
    坏(`面板复制失败（记忆不受影响）：${e?.message ?? e}`);
    return false;
  }
}

// ── 写配置 ──
function 写配置() {
  步(3, "放插件 + 写插件配置（只加自己的键，不动别人的）");
  if (UNINSTALL || SELF_ONLY) { 行("  跳过（不写配置）"); return; }
  // 先读旧配置（重装时它在插件目录里，复制会覆盖掉，所以要在复制之前读）
  const 旧 = 读JSON(插件配置) ?? {};
  if (DRY) {
    好(`会把插件复制到 ${插件落点}（之后安装包可以删）`);
    if (面板在包) 好(`也会把面板复制到 ${面板落点}（可选：挂不上不影响记忆）`);
  } else {
    const 搬了面板 = 复制插件();
    好(`插件已放进 ${插件落点}`);
    if (搬了面板) 好(`面板也放进去了（${面板落点}）`);
  }
  const brief = 旧.brief ?? [
    // 2026-11-05（杜伽的 AI 点出来）：这几个数以前和库模板文件头对不上（480 vs 450、700 vs 1250），
    // 模板写的给人看、config 写的真生效，两边必须一致 —— 以模板为准，改这里。
    { file: "关于他.md", maxChars: 1300 },
    { file: "关于他·事实.md", maxChars: 450 },
    { file: "生长\\状态.md", maxChars: 1250 },
    { file: "生长\\承诺.md", maxChars: 400 },
  ];
  const 新 = {
    ...旧,
    root: LIB,
    stateDir: join(LIB, "状态页"),
    persona: { ...(旧.persona ?? {}), him: HIM, me: ME, rootDir: LIB, showOutside: false },
    brief,
    voice: { ...(旧.voice ?? {}), enabled: false },
    // 分享版默认关"开场核家"：那是我们自己的钉子/提醒搬家工具，别人没有（2026-11-04 凌晨从简报里抓到泄露）
    homeCheck: { ...(旧.homeCheck ?? {}), enabled: false },
    // 分享版默认关"主动"：别人不点头就不出声（2026-11-04 上午加的功能，装了也安静）
    proactive: { ...(旧.proactive ?? {}), enabled: false },
    recall: { ...(旧.recall ?? {}), enabled: 旧.recall?.enabled ?? true },
  };
  if (DRY) { 好(`会写 ${插件配置}`); 好(`  root=${LIB}`); 好(`  persona.him=${HIM} / me=${ME}`); return; }
  const bak = 备份(插件配置);
  if (bak) 好(`旧配置备份 → ${bak.split("\\").pop()}`);
  mkdirSync(dirname(插件配置), { recursive: true });
  writeFileSync(插件配置, JSON.stringify(新, null, 2) + "\n", "utf8");
  好(`配置写好（root=${LIB}，persona=${HIM}/${ME}，voice 关）`);
}

// ── 注册插件 ──
// 2026-11-05：从"一个插件"改成"一串插件"——记忆是主体，面板是第二个（纯客户端）。
// 两个各自登记；面板登记失败不拖累记忆。
function 注册插件() {
  const 要登记的 = [{ 名: 插件名, 落点: 插件落点 }];
  if (面板在包) 要登记的.push({ 名: 面板名, 落点: 面板落点 });
  步(4, `注册进 DSH（${要登记的.map((x) => x.名).join(" ＋ ")}）`);
  if (UNINSTALL || SELF_ONLY) { 行("  跳过（不注册）"); return; }
  const pkg = 读JSON(PKG);
  if (!pkg) {
    if (DRY) { 好(`会补 ${PKG} 里的 dependencies 和 bundles（现在还没有这个文件）`); return; }
    坏(`读不了 ${PKG}`);
    return;
  }
  pkg.dependencies ??= {};
  pkg.dsh ??= {};
  pkg.dsh.profile ??= {};
  pkg.dsh.profile.bundles ??= [];
  const 要写的 = [];
  for (const { 名, 落点 } of 要登记的) {
    // 依赖写成"装进来的插件目录"，不是安装包目录 —— 安装包删了也不影响
    const link值 = `link:${落点.replaceAll("\\", "/")}`;
    const 需要依赖 = pkg.dependencies[名] !== link值;
    const 需要登记 = !pkg.dsh.profile.bundles.includes(名);
    if (需要依赖 || 需要登记) 要写的.push({ 名, link值, 需要登记 });
  }
  if (!要写的.length) { 好("已经登记过了，没动"); return; }
  if (DRY) {
    for (const x of 要写的) {
      好(`会把 dependencies.${x.名} = ${x.link值}`);
      if (x.需要登记) 好(`会把 ${x.名} 加进 dsh.profile.bundles`);
    }
    return;
  }
  const bak = 备份(PKG);
  if (bak) 好(`package.json 备份 → ${bak.split("\\").pop()}`);
  for (const x of 要写的) {
    pkg.dependencies[x.名] = x.link值;
    if (x.需要登记) pkg.dsh.profile.bundles.push(x.名);
    好(`${x.名} 登记好了`);
  }
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  好(`登记完成（重启 DSH 后生效）`);
}

// ── 装控制台 ──
// 控制台是"只读的一页"：把四块（今天／记忆／健康／花费）摆一起看。
// 它只是库里的两个文件，不注册插件、不常驻、不开机启动 —— 想关就关。
function 装控制台() {
  步(5, "装控制台（可选：只是一页只读小网站）");
  if (UNINSTALL) { 行("  跳过（卸载不清控制台，想删手动删库里的 控制台 文件夹）"); return; }
  const 目标目录 = join(LIB, "控制台");
  const 目标 = join(目标目录, "server.mjs");
  const 启动 = join(目标目录, "启动控制台.cmd");
  if (!existsSync(控制台源)) { 坏(`控制台源文件不在：${控制台源}`); return; }
  const 启动内容 = [
    "@echo off",
    "chcp 65001 >nul",
    'cd /d "%~dp0"',
    // 用"跑安装器的那个 node"的完整路径：双击时 PATH 里没有 node 也能开
    `"${process.execPath}" server.mjs --root "${LIB}" --plugin "${插件落点}"`,
    "echo.",
    "echo 控制台开着的时候别关这个窗口；关掉它页面就没了。",
    "pause",
    "",
  ].join("\r\n");
  if (DRY) {
    好(`会写 ${目标}`);
    好(`会写 ${启动}`);
    return;
  }
  mkdirSync(目标目录, { recursive: true });
  copyFileSync(控制台源, 目标);
  好("控制台程序已放好");
  if (existsSync(启动)) {
    行(`  · 启动脚本已有，不覆盖：${启动}`);
  } else {
    writeFileSync(启动, 启动内容, "utf8");
    好("启动脚本已写好（双击它就能看）");
  }
}

// ── 自检 ──
async function 自检() {
  步(6, "自检");
  // 库都没有＝还没装过，这时候报一堆红叉只会吓人：先说清楚，再退出
  if (!existsSync(join(LIB, "关于他.md"))) {
    还没装 = true;
    行(`  还没装：库不在 ${LIB}`);
    行("  先跑一遍 node 安装.mjs --write（默认装到 文档\\大肥鱼记忆，也可以 --lib 指定）");
    return;
  }
  // ① 库文件在
  const 必需 = ["关于他.md"];
  const 缺 = 必需.filter((f) => !existsSync(join(LIB, f)));
  if (缺.length === 0) 好(`① 库在（${LIB}）`);
  else 坏(`① 库缺文件：${缺.join("、")}`);

  // ② 插件文件在 profile 里 + 登记在
  const pkg = 读JSON(PKG);
  const 登记 = pkg?.dsh?.profile?.bundles?.includes(插件名) === true;
  const 文件在 = existsSync(join(插件落点, "lib", "index.js"));
  if (登记 && 文件在) 好(`② 插件已登记且在 profile 里（${插件落点}）`);
  else if (登记) 坏(`② 登记了但插件文件不在（${插件落点}）`);
  else 坏(`② 插件没在 bundles 里`);
  // 面板：可选那一颗 —— 只提示，不算失败（挂不上去不影响记忆）
  if (面板在包) {
    const 面登记 = pkg?.dsh?.profile?.bundles?.includes(面板名) === true;
    const 面在 = existsSync(join(面板落点, "lib", "client.js"));
    if (面登记 && 面在) 好(`   面板也登记了（${面板名}，重启 DSH 后侧边栏多一页）`);
    else if (面登记) 坏(`   面板登记了但文件不在（${面板落点}）`);
    else 行(`   面板没登记（记忆照跑；想挂面板重跑 --write）`);
  }

  // ②b 配置里的库路径对不对（2026-11-05 加：杜伽的 AI 说「只改一半配置会静默指错」）
  // ⚠️ root 不一定在 config.json 里 —— 它也可能写在 profile 的 YAML 里（我自己这台就是）。
  //    所以先看 config.json，再看插件自己写出来的 effective-config.json（那份才是真生效的），
  //    两处都没有就跳过、别误报 ✗（2026-11-05 自测抓到的）
  let 配置 = 读JSON(插件配置);
  if (!配置?.root) 配置 = 读JSON(join(插件落点, "effective-config.json"))?.config ?? null;
  if (!配置) {
    行("  ②b 读不到配置里的 root（可能在 profile 的 YAML 里）—— 跳过这项");
  } else {
    const 指 = 配置.root ?? "";
    const 指Persona = 配置.persona?.rootDir ?? "";
    const 指State = 配置.stateDir ?? "";
    if (!指) {
      坏("②b 配置里 root 是空的 —— 插件会把路径算到盘根，控制台起不来");
      行("     修：重跑 node 安装.mjs --write");
    } else if (!existsSync(指)) {
      坏(`②b root 指的目录不存在：${指}`);
      行(`     修：node 安装.mjs --move "${LIB}"`);
    } else if (resolve(指) !== resolve(LIB)) {
      坏(`②b 配置的 root 指向 ${指}，不是这个库（${LIB}）`);
      行("     这就是「只改了一半」—— 简报照样生成，但它照旧路径读，你看到的东西就不对了");
      行(`     修：node 安装.mjs --move "${LIB}"`);
    } else {
      // 只查真正会导致「指错库」的两处：root 和 persona.rootDir。
      // stateDir 允许和库分开（它只决定冷却文件放哪，不影响读哪个库）→ 只提一句，不报错
      const 人也对 = !指Persona || resolve(指Persona) === resolve(LIB);
      if (!人也对) {
        坏("②b persona.rootDir 和 root 不是同一个地方 —— 简报头部会指错库");
        行(`     root=${指}`);
        行(`     persona.rootDir=${指Persona || "（空）"}`);
        行(`     修：node 安装.mjs --move "${LIB}"`);
      } else {
        if (指State && resolve(指State).toLowerCase() !== resolve(join(LIB, "状态页")).toLowerCase()) {
          行(`     （stateDir 在别处：${指State} —— 不碍事，只是状态文件另放）`);
        }
        好(`②b 配置指对了（root = ${指}）`);
      }
    }
  }

  // ②c 包内清单文件全在（2026-11-05 加；杜伽的 AI：这次 3 个 bug 里 2 个能被它当场抓住）
  {
    const 缺 = [];
    if (resolve(PLUGIN) !== resolve(插件落点)) {
      for (const f of 记忆文件) if (!existsSync(join(PLUGIN, f))) 缺.push(`插件\\${f}`);
    }
    if (面板在包) {
      for (const f of 面板文件) if (!existsSync(join(面板源, f))) 缺.push(`面板\\${f}`);
    }
    if (缺.length) 坏(`②c 安装包里的文件不全（复制进 profile 会缺）：${缺.join("、")}`);
    else 好(`②c 包内清单文件齐（记忆 ${记忆文件.length} 个${面板在包 ? ` / 面板 ${面板文件.length} 个` : ""}）`);
  }

  // ②d 面板能不能真的加载（2026-11-05 下午加；杜伽的 AI 指出：自检拿「清单」去查「清单」＝假绿）
  //   所以她这条要求不依赖清单：**真去 import 一次**，import 不过就红。
  //   真相来自事实，不来自「我以为的清单」。
  //   装到 profile 的那份 → 按包名解析（这才是 DSH 真正走的路：找 main / "."）
  //   没装 → 只查包本身的结构（文件在、main 指对）
  {
    if (existsSync(join(面板落点, "package.json"))) {
      try {
        const { createRequire } = await import("node:module");
        const req = createRequire(join(PROFILE, "深怕.cjs"));
        const 入口 = req.resolve(面板名);
        const m = await import(pathToFileURL(入口).href);
        if (typeof m.apply !== "function") 坏(`②d 面板入口能加载，但没导出 apply（${入口}）`);
        else 好("②d 面板真能加载（按包名解析 → 导出 apply ✓）");
      } catch (e) {
        坏(`②d 面板加载不了（装上也挂不上）：${String(e?.message ?? e).slice(0, 140)}`);
      }
    } else if (面板在包) {
      const 缺 = [];
      try {
        const p = JSON.parse(String(readFileSync(join(面板源, "package.json"), "utf8")).replace(/^\uFEFF/, ""));
        if (!existsSync(join(面板源, "lib", "index.js"))) 缺.push("缺 lib\\index.js");
        if (p.main !== "lib/index.js") 缺.push("main 不是 lib/index.js");
        if (p.exports?.["."] !== "./lib/index.js") 缺.push('缺 "." 导出');
        if (缺.length) 坏(`②d 面板包结构不对（${缺.join("、")}）—— 装上也挂不上`);
        else {
          // 结构对了还不够：**真 import 一次**（不看清单，看事实）
          const m = await import(pathToFileURL(join(面板源, "lib", "index.js")).href);
          if (typeof m.apply !== "function") 坏("②d 面板入口能 import，但没导出 apply");
          else 好("②d 面板真能加载（还没装，import 包里的入口 → apply ✓）");
        }
      } catch (e) {
        坏(`②d 面板包读不了：${e?.message ?? e}`);
      }
    } else 好("②d 面板没在，跳过");
  }

  // ③ 简报真能生成（直接调插件导出的 composeInjection，不猜）
  try {
    const mod = await import(pathToFileURL(join(插件落点, "lib", "index.js")).href);
    const cfg = mod.effectiveConfig({ root: LIB, stateDir: join(LIB, "状态页"), persona: { him: HIM, me: ME } });
    const 简报 = mod.composeInjection(cfg, false, "self-check");
    if (typeof 简报 === "string" && 简报.trim().length > 40) 好(`③ 简报能生成（${简报.length} 字符）`);
    else 坏(`③ 简报是空的（生成不出内容）`);
  } catch (e) {
    坏(`③ 简报生成报错：${e?.message ?? e}`);
  }

  // ④ 检索服务（可选：没有就是降级关键词，不算失败）
  好("④ 检索：没服务也能用（降级关键词），想开服务另说");

  // ⑤ 控制台文件在（不算必须：缺了只提示，不计失败）
  const 控制台目标 = join(LIB, "控制台", "server.mjs");
  if (existsSync(控制台目标)) 好("⑤ 控制台在（库\\控制台\\启动控制台.cmd 双击看）");
  else 行("  ⑤ 控制台没放（不影响记忆；想要就重跑安装器，或手动把 控制台\\ 放进库）");

  // ⑥ 最近有没有出错（2026-11-05 加：杜伽的 AI 说"失败不可见" —— 光进插件日志用户看不见）
  const 出错文件 = join(LIB, "生长", "出错记录.md");
  if (existsSync(出错文件)) {
    const 条 = readFileSync(出错文件, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith("- ") && !l.includes("（例："));
    if (!条.length) 好("⑥ 出错记录：空着（好事）");
    else {
      行(`  ⑥ 出错记录里有 ${条.length} 条，最近一条：`);
      行(`     ${条[条.length - 1].trim().slice(0, 140)}`);
    }
  } else 行("  ⑥ 还没有出错记录文件（插件真出错时自己会建）");
}

// ── 卸载 ──
function 卸载() {
  步("卸", "只删自己加的登记，库原样留着");
  const pkg = 读JSON(PKG);
  if (pkg) {
    const bak = 备份(PKG);
    if (bak) 好(`package.json 备份 → ${bak.split("\\").pop()}`);
    if (pkg.dependencies) { delete pkg.dependencies[插件名]; delete pkg.dependencies[面板名]; }
    if (Array.isArray(pkg.dsh?.profile?.bundles)) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((x) => x !== 插件名 && x !== 面板名);
    }
    writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    好("插件登记已删（重启 DSH 生效）");
  } else 坏(`读不了 ${PKG}`);
  if (existsSync(插件配置)) {
    const bak = 备份(插件配置);
    if (bak) 好(`配置备份 → ${bak.split("\\").pop()}`);
    // 只删"我们加的那半"：留一个空对象，别人自己的键不碰
    writeFileSync(插件配置, "{}\n", "utf8");
    好("插件配置已清空（原文件有备份）");
  }
  // 插件是我们复制进来的才删；"就地安装"（我们自己的 profile）不删
  if (resolve(PLUGIN) !== resolve(插件落点)) {
    if (existsSync(插件落点)) { rmSync(插件落点, { recursive: true, force: true }); 好("复制进 profile 的记忆插件已删"); }
  } else 行("  记忆插件是就地安装的，没删（删了会把记忆插件本身弄丢）");
  if (面板在包 && resolve(面板源) !== resolve(面板落点)) {
    if (existsSync(面板落点)) { rmSync(面板落点, { recursive: true, force: true }); 好("面板插件文件已删"); }
  }
  行(`  库没动：${LIB}`);
}

// ── 搬家（--move <新库路径>）──
//
// 2026-11-05 加。杜伽的 AI 指出：说明书写"换电脑：拷文件夹 + --write --lib"，
// 但绝对路径散在三处配置（root / stateDir / persona.rootDir）**加**用户自己写在
// 库内 md 里的路径里 —— 配置改对了、文案还指着旧库，系统不会报错 ✗
// 所以这个命令一次干三件事：改全配置、扫库内所有文本文件替换旧路径、逐份备份。
function 搬家() {
  const 新库 = resolve(MOVE);
  步("搬", `库 → ${新库}`);

  const 配置 = 读JSON(插件配置);
  if (!配置) { 坏(`读不了插件配置：${插件配置}`); return; }
  // 三处的旧值都收上来 —— 「只改一半配置」是最坑的（杜伽的 AI 实测过）
  const 旧们 = {
    root: 配置.root ?? "",
    stateDir: 配置.stateDir ?? "",
    "persona.rootDir": 配置.persona?.rootDir ?? "",
  };
  const 旧库 = 旧们.root || 旧们["persona.rootDir"];
  if (!旧库) { 坏("配置里没有 root，判断不出旧库在哪"); return; }
  行(`  旧库  ${旧库}`);
  行(`  新库  ${新库}`);

  // 三处配置本来就对不上 = 「之前只改了一半」的症状
  const 非空 = Object.values(旧们).filter(Boolean);
  if (非空.length && new Set(非空.map((v) => resolve(v).toLowerCase())).size > 1) {
    行("");
    行("  ⚠️ 三处配置本来就对不上：");
    for (const [k, v] of Object.entries(旧们)) 行(`      ${k} = ${v || "（空）"}`);
    行("     这就是「只改了一半」的样子 —— 系统不报错，但简报会自信地指错地方 ✗");
    行("     我按 root 为准搬，另外两处一起对齐。");
  }

  if (resolve(旧库) === 新库) { 行("  新旧路径一样，不用动"); return; }
  if (!existsSync(新库)) {
    坏(`新库不存在：${新库}`);
    行("    先把整个库文件夹拷过去，再跑这个（这个命令只管改路径，不搬文件）");
    return;
  }
  try {
    const 试 = join(新库, ".搬家-试探");
    writeFileSync(试, "x");
    unlinkSync(试);
  } catch (e) {
    坏(`新库写不进去：${e?.code ?? e}`);
    行("    你多半是在 DSH 的对话框里跑的 —— 换个普通 PowerShell 窗口重跑。");
    return;
  }

  // ① 三处配置一起改
  const bak = 备份(插件配置);
  const 新配置 = {
    ...配置,
    root: 新库,
    stateDir: join(新库, "状态页"),
    persona: { ...(配置.persona ?? {}), rootDir: 新库 },
  };
  writeFileSync(插件配置, JSON.stringify(新配置, null, 2) + "\n", "utf8");
  好(`配置三处改好了（root / stateDir / persona.rootDir）${bak ? ` 备份 ${bak.split("\\").pop()}` : ""}`);

  // ② 扫库内的旧路径 —— **默认只列清单，不动文件**
  //   （杜伽的 AI：库里可能有「当时库在 D:\旧」这种历史记录，自动替换等于篡改 ✗
  //    所以让人看一眼再决定，--auto 才动手）
  const 旧串 = 旧库.replace(/[\\/]+$/, "");
  const 新串 = 新库.replace(/[\\/]+$/, "");
  let 扫过 = 0;
  const 命中 = [];
  const 走 = (dir) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { 走(p); continue; }
      if (!/\.(md|txt|json|ya?ml)$/i.test(n)) continue;
      扫过 += 1;
      let 文;
      try { 文 = readFileSync(p, "utf8"); } catch { continue; }
      if (!文.includes(旧串)) continue;
      const 行们 = 文.split(/\r?\n/);
      const 例子 = (行们.find((l) => l.includes(旧串)) || "").trim().slice(0, 90);
      命中.push({ rel: p.slice(新库.length + 1), 处: 行们.filter((l) => l.includes(旧串)).length, 例子 });
    }
  };
  走(新库);

  if (!命中.length) {
    好(`扫了 ${扫过} 份文本，没有写死的旧路径（干净）`);
  } else if (AUTO_MOVE) {
    let 好数 = 0;
    for (const h of 命中) {
      const p = join(新库, h.rel);
      try {
        备份(p);
        writeFileSync(p, readFileSync(p, "utf8").split(旧串).join(新串), "utf8");
        好数 += 1;
      } catch (e) {
        坏(`改不了 ${h.rel}：${e?.message ?? e}`);
      }
    }
    好(`--auto：改了 ${好数} / ${命中.length} 份（每份都备份了）`);
  } else {
    行("");
    行(`  ⚠️ 有 ${命中.length} 份文件写着旧路径 —— **我没动它们**：`);
    for (const h of 命中.slice(0, 20)) {
      行(`    · ${h.rel}（${h.处} 处）`);
      行(`        ${h.例子}`);
    }
    if (命中.length > 20) 行(`    …… 还有 ${命中.length - 20} 份`);
    行("");
    行("  为什么不动：里面可能有「当时库在 D:\\旧位置」这种**历史记录**，自动替换等于篡改 ✗");
    行("  想让我一起改：重跑时加 --auto（每份都先备份）");
    行("  想自己改：照上面清单手动改，改完重启 DSH");
  }

  行(`\n  重启 DSH 生效。旧库那一个文件夹留着当备份，确认没事再删。`);
}

// ── 主流程 ──
(async () => {
  行("大肥鱼记忆 · 安装器");
  行(`  profile  ${PROFILE}`);
  行(`  库       ${LIB}`);
  行(`  插件     ${PLUGIN}`);
  行(`  模式     ${MOVE ? "搬家" : UNINSTALL ? "卸载" : SELF_ONLY ? "只自检" : DRY ? "dry-run（只看计划）" : "真装"}`);
  if (MOVE) 行(`  搬到     ${resolve(MOVE)}`);

  查前置();
  if (MOVE) { 搬家(); }
  else if (UNINSTALL) { 卸载(); }
  else if (SELF_ONLY) { await 自检(); }
  else {
    建库();
    写配置();
    注册插件();
    装控制台();
    if (!DRY) await 自检();
  }

  if (DRY) {
    行("\n这是计划，什么都没动。确认没问题加 --write 真装。");
  }
  行(`\n结果：${还没装 ? "还没装（不是错）" : 失败 === 0 ? "全绿 ✓" : `${失败} 项没过 ✗`}`);
  process.exit(还没装 ? 0 : 失败 === 0 ? 0 : 1);
})();
