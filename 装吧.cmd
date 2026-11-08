@echo off
rem 这个文件用 GBK 存（cmd.exe 默认按 ANSI 读，存 UTF-8 中文会乱码）
setlocal
cd /d "%~dp0"
title 大肥鱼记忆 · 一键安装

echo.
echo   ============================================
echo    大肥鱼记忆 · 一键安装
echo   ============================================
echo.
echo   这个窗口里跑的是普通的 Windows 程序，
echo   不受 DSH 的沙箱限制，所以能正常写盘。
echo.

rem ── 先确认有 node ──
where node >nul 2>nul
if errorlevel 1 (
  echo   [x] 没找到 node。
  echo.
  echo   先去 https://nodejs.org 装 Node.js 22 或更高版本，
  echo   装完把这个窗口关了，再双击一次本文件。
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo   node %%v

echo.
echo   ── 开始安装 ──
echo.

rem ── 真装（--name 是谁、--me 是我，不写就用默认的「他」「我」）──
node "%~dp0安装.mjs" --write

set 结果=%errorlevel%

echo.
if "%结果%"=="0" (
  echo   ============================================
  echo    装好了 ?
  echo   ============================================
  echo.
  echo   下一步：把 DSH 重启一下。
  echo   重启后右边栏会多一个「记忆」页，点开就是控制台。
  echo.
  echo   想改称呼（默认是「他」和「我」）：
  echo     命令行里跑  node 安装.mjs --write --name 小水 --me 大肥鱼
) else (
  echo   ============================================
  echo    没装成（退出码 %结果%）
  echo   ============================================
  echo.
  echo   往上翻几行，看红色的 x 说了什么。
  echo   常见就两种：
  echo     · 没找到 node      → 去 nodejs.org 装一个 22 以上的
  echo     · 写不进去         → 看它列出来的那两个路径，是不是被别的程序占着
  echo.
  echo   还是不行的话，把这一屏截图发过来。
)

echo.
echo   （按任意键关掉这个窗口）
pause >nul
