@echo off
REM SYNC.cmd — CP 双仓同步（一条命令，2026-11-18 立）
REM   引擎仓：%~dp0  ；数据仓：%USERPROFILE%\cp-memory
REM   行为：引擎仓提交+推送 → 数据镜像+提交+推送；任一步失败非零退出，不静默。
setlocal
set "ROOT=%~dp0"
set "NODE=%ROOT%tools\node\node.exe"
if not exist "%NODE%" (
  echo [sync] tools\node 缺失，回退系统 node
  set "NODE=node"
)
"%NODE%" "%ROOT%cp-sync.cjs" all %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [sync] 失败 rc=%RC% —— 未推成功，别关窗口直接看上面报错
) else (
  echo.
  echo [sync] 完成。核对：引擎 %ROOT:~0,-1% ；数据 %USERPROFILE%\cp-memory
)
exit /b %RC%