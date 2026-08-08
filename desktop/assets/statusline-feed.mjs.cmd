@echo off
rem Statusline wrapper for the installed desktop app: runs the bundled Electron
rem binary as plain Node (no Chromium) so the machine needs no system Node.
rem Filename deliberately contains "statusline-feed.mjs" so STATUSLINE_MARK
rem matching in install-hooks.mjs / uninstall-hooks.mjs works unchanged.
rem
rem Unlike send-event.mjs.cmd this does NOT "exit /b 0". The hook shim is
rem fire-and-forget, but this wrapper runs the user's real statusline command
rem and must report ITS exit code, exactly as statusline-feed.mjs itself does.
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Mission Control Center.exe" "%~dp0statusline-feed.mjs" %*
exit /b %ERRORLEVEL%
