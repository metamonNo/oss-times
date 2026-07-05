@echo off
chcp 65001 >nul
REM ============================================
REM  OSS TIMES ローカル実取得 + プレビュー
REM  必要: Node.js 20以上 (https://nodejs.org)
REM ============================================
echo [1/2] 全ソースから実データを取得中（翻訳込みで数分かかります）...
node scripts\fetch-data.mjs
if errorlevel 1 (echo 取得に失敗しました & pause & exit /b 1)
echo [2/2] http://localhost:8787 で起動します（Ctrl+Cで終了）
npx -y serve -l 8787 .
