// 大肥鱼记忆 · 控制台面板（2026-11-05）
//
// 为什么这么写：
//   面板**不重算任何数据** —— 套的就是那个只读小网站（127.0.0.1:17899）。
//   同一份数据两处各算一遍迟早会漂，所以只套不搬。
//   控制台由 dafiyu-memory 插件启动时自己拉起（探端口不通就 spawn 一个），
//   所以正常情况这里直接就有画面；万一真没起来，把"怎么办"写在面板上，不给一片白。
//
// 形态照 dafiyu-panel 那套（已在用的写法）：
//   · sidebar.panellist 的 id 对应 main 的 key —— 左侧栏画按钮、主区画那一页
window.__ModuleLoader__.load({
  id: "dafiyu-console-panel",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var h = React.createElement;

    var CONSOLE_ID = "dafiyu-console";
    var CONSOLE_URL = "http://127.0.0.1:17899/";

    var 样式 = {
      页面: {
        width: "100%",
        height: "calc(100vh - 56px)",
        border: 0,
        display: "block",
        background: "#f3f5f9",
      },
      提示: { padding: "28px 26px", lineHeight: 1.95, fontSize: 13 },
      标题: { fontWeight: 600, marginBottom: 8, fontSize: 14 },
      淡: { color: "#8b94a3" },
      按钮: {
        marginTop: 14,
        padding: "6px 14px",
        borderRadius: 7,
        border: "1px solid #d6dbe4",
        background: "#fff",
        cursor: "pointer",
        fontSize: 13,
      },
    };

    function Frame() {
      var s = React.useState(null); // null=在查  true=通  false=不通
      var ok = s[0], setOk = s[1];
      var t = React.useState(0);
      var n = t[0], 再来 = t[1];

      React.useEffect(function () {
        var alive = true;
        setOk(null);
        fetch(CONSOLE_URL, { cache: "no-store" })
          .then(function () {
            if (alive) setOk(true);
          })
          .catch(function () {
            if (alive) setOk(false);
          });
        return function () {
          alive = false;
        };
      }, [n]);

      if (ok === null) return h("div", { style: 样式.提示 }, "看看控制台开着没…");

      if (ok === false) {
        return h(
          "div",
          { style: 样式.提示 },
          h("div", { style: 样式.标题 }, "控制台没在跑"),
          h(
            "div",
            { style: 样式.淡 },
            "这一页只负责显示；数据页是那个只读小网站（127.0.0.1:17899），它现在没起来。",
          ),
          h(
            "div",
            { style: Object.assign({}, 样式.淡, { marginTop: 6 }) },
            "插件启动时会自己把它拉起来 —— 一直没起来的话，重启一次 DSH 试试。",
          ),
          h(
            "button",
            {
              style: 样式.按钮,
              onClick: function () {
                再来(n + 1);
              },
            },
            "再试一次",
          ),
        );
      }

      return h("iframe", {
        src: CONSOLE_URL,
        title: "大肥鱼记忆 · 控制台",
        style: 样式.页面,
      });
    }

    function Icon() {
      return h("span", { style: { fontSize: 15, lineHeight: 1 } }, "🐋");
    }

    function apply(ctx) {
      try {
        ctx.effect(function () {
          return ctx.slots.inject("main", function () {
            return ctx.slots.register({ name: "main", key: CONSOLE_ID }, Frame);
          });
        }, "dafiyu-console-panel.main");

        ctx.effect(function () {
          return ctx.slots.inject("sidebar.panellist", function () {
            return ctx.slots.register(
              {
                name: "sidebar.panellist",
                id: CONSOLE_ID,
                order: 30,
                label: function () {
                  return "记忆";
                },
              },
              Icon,
            );
          });
        }, "dafiyu-console-panel.tab");

        console.info("[dafiyu-console-panel] 挂上了");
      } catch (e) {
        console.info("[dafiyu-console-panel] 挂载失败（不影响页面）：" + String((e && e.message) || e));
      }
    }

    exports.name = "dafiyu-console-panel";
    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
