@echo off
set CODEX_OBS_INSTANCE=default
if not defined CODEX_OBS_HOME set "CODEX_OBS_HOME=%USERPROFILE%\.codex"
python "%~dp0hook.py"
