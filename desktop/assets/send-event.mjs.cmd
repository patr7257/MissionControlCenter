@echo off
rem Hook shim wrapper for the installed desktop app: runs the bundled Electron
rem binary as plain Node (no Chromium) so the machine needs no system Node.
rem Filename deliberately contains "send-event.mjs" so SHIM_MARK matching in
rem install-hooks.mjs / uninstall-hooks.mjs works unchanged.
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Mission Control Center.exe" "%~dp0send-event.mjs" %*
exit /b 0
