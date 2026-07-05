# Claude Code への命令文（このファイルごと渡すか、下をコピペ）

このフォルダは「OSS TIMES」（世界の無料Webサービスを自動巡回するポータル）の完成品です。
以下を上から順に実行してください。

## 1. 初回の実データ取得（ローカル巡回）
```
node scripts/fetch-data.mjs
```
- GitHub/GitLab/Codeberg/HF Spaces/Show HN/Reddit/Dev.to/Bluesky/Qiita/Zenn を巡回し、
  data/data.json（掲載データ・日本語訳込み）と data/articles.json（紹介記事）を生成する
- 認証なしだとGitHub検索が毎分10回制限のため15〜30分かかる。環境変数 GITHUB_TOKEN があれば速い
- 完了後 `node -e "console.log(require('./data/data.json').meta.count)"` で件数を報告すること（目標: 800件以上）

## 2. ローカル確認
```
npx -y serve -l 8787 .
```
http://localhost:8787 を開き、カード表示・🇯🇵日本発を優先トグル・カテゴリ一覧タブを確認したら Ctrl+C で終了。

## 3. GitHubへ公開
```
git init && git add -A && git commit -m "OSS TIMES initial"
git branch -M main
gh repo create oss-times --public --source=. --push
```
（gh未ログインなら `gh auth login` を先に。リポジトリ名は変更可）

## 4. GitHub Pages を有効化
```
gh api repos/{owner}/oss-times/pages -X POST -f "source[branch]=main" -f "source[path]=/" || echo "既に有効かも。Settings→Pagesでmain/(root)を確認"
```

## 5. 掲載申請ボタンを有効化
index.html 冒頭の `const SUBMIT_URL=""` を
`https://github.com/<ユーザー名>/oss-times/issues/new?template=submit-service.yml`
に書き換えてコミット＆プッシュ。

## 6. （任意）Secrets 設定
```
gh secret set GROQ_API_KEY          # 紹介記事をLLM執筆に（console.groq.com/keysで無料取得）
gh secret set SAFE_BROWSING_API_KEY # 危険URLの自動除外
```

## 7. 動作確認
- Actionsタブで「データ自動巡回」が成功しているか確認（以後4時間ごと自動）
- サイトURL: https://<ユーザー名>.github.io/oss-times/ を開いて表示確認
- 最後に、サイトURL・掲載件数・国別上位3か国を報告すること

## 運用メモ
- 自作サービスの追加: data/custom.json に追記してpush
- 他者からの掲載申請: Issueに「approved」ラベルを付けるだけで自動掲載
- 非公開になったサービスは死活監視（404×2回）で自動クローズされる
