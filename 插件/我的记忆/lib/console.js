/**
 * dafiyu-memory · console（把只读控制台拉起来）
 * ===========================================
 *
 * P4 第 6 步从 index.js 搬出来的（2026-11-05 夜）。
 *
 * 分享版装完，DSH 面板要 iframe 打开 127.0.0.1:17899。
 * 以前得人自己双击「启动控制台.cmd」，忘了就是白框。现在插件自己拉。
 *
 * 三条护栏：库里没控制台就跳过 / 端口通就不管 / 起不来只记日志绝不拖垮插件。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { log, HERE } from "./core.js";

// ── 控制台自动拉起（2026-11-05）──────────────────────────────────────
// 为什么：分享版装完，DSH 面板要 iframe 打开 `127.0.0.1:17899`。
//   以前得人自己双击 `启动控制台.cmd`，忘了就是白框 ✗
//   → 插件启动时自己拉；探端口，已经起着就不动 ✓
// 三条护栏：① 库里没控制台就跳过 ② 端口通就不管（手动的也算）③ 起不来只记日志，绝不拖垮插件 ✓
const 控制台端口 = 17899;
let 控制台进程 = null;
function 探端口(port, ms = 700) {
  return new Promise((resolve) => {
    let done = false;
    const 收 = (v) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch {}
      resolve(v);
    };
    const s = net.connect({ host: "127.0.0.1", port });
    s.setTimeout(ms);
    s.once("connect", () => 收(true));
    s.once("timeout", () => 收(false));
    s.once("error", () => 收(false));
  });
}
async function 拉起控制台(cfg) {
  const server = join(cfg.root, "控制台", "server.mjs");
  if (!existsSync(server)) return { ok: false, why: "库里没有 控制台\\server.mjs" };
  if (await 探端口(控制台端口)) return { ok: true, why: "已经起着" };
  const args = [
    server,
    "--root", cfg.root,
    "--state", cfg.stateDir ?? join(cfg.root, "状态页"),
    "--plugin", join(HERE, ".."),
  ];
  const child = spawn(process.execPath, args, { stdio: "ignore", windowsHide: true });
  child.once("error", (e) => log(`控制台起不来: ${e?.message ?? e}`));
  child.unref();
  控制台进程 = child;
  log(`控制台已拉起 pid=${child.pid}`);
  return { ok: true, why: "刚拉起", pid: child.pid };
}
function 关掉控制台() {
  const 子 = 控制台进程;
  控制台进程 = null;
  if (!子 || !子.pid || 子.killed) return;
  // 2026-11-05 夜：**不立刻杀**。改插件文件会触发热重载（dispose 之后马上又 apply），
  //   立刻杀就把刚起来的服务带走，面板当场变「控制台没开」✗
  //   等几秒，先看有没有新实例把端口占上 —— 占上了说明是热重载，留着 ✓
  setTimeout(async () => {
    try {
      if (await 探端口(控制台端口)) {
        log("控制台还活着（新实例接管了），不杀");
        return;
      }
      子.kill();
      log("控制台已关（延迟确认没人接管）");
    } catch (e) {
      log(`关控制台失败: ${e?.message ?? e}`);
    }
  }, 6000).unref?.();
}


export { 拉起控制台, 关掉控制台 };
