# PROVision

**チャットで作った図版の系譜を、W3C PROV のグラフとして残す道具。**

研究・技術資料の図版（概念図・グラフィカルアブストラクト・スライド図版）は、
何十回も作り直された末に 1 枚が論文に載る。載ったのがどの版で、どの指示から生まれ、
元データのどの版に基づいていたのかは、普通は再現できない。PROVision はそこを残す。

生成 1 回を `prov:Activity`、画像 1 枚を `prov:Entity` として記録し、
派生を `prov:wasDerivedFrom` で繋ぐ。自然言語の指示（「もっと余白を取って」）は
Activity の属性として載せる。書き出すのは **PROV-JSONLD のファイル 1 つ**。DB もサーバも要らない。

## C2PA / Content Credentials と何が違うか

C2PA は**ファイル 1 個に署名付きメタデータを埋める**仕組みで、来歴はそのファイルに閉じている。
Midjourney のジョブツリーや ComfyUI のワークフローも、ツール内に閉じた履歴である。

PROVision が狙うのはそこではない。

> **系譜が領域（ノート・データ・画像）をまたいで 1 つの PROV グラフになり、
> AI が SPARQL / MCP でクエリできること。**

図版は [Graphium](https://github.com/kumagallium/Graphium) のノートに貼られ、
その元データは [asterism](https://github.com/kumagallium/asterism) にある。
どちらも PROV を語彙にしているので、**変換なしで 1 つのグラフに繋がる**。
「この図版は、どのデータセットのどの版に基づいているか」を SPARQL で遡れる——
これはファイル単位の署名では原理的に答えられない問いで、PROVision の存在理由でもある。

そのため **W3C PROV に完全準拠する**。独自拡張は `provision` 名前空間に、
画像生成に固有の語（prompt / model / seed）だけを最小限置く。
他ドメインの語彙（matprov 等）は取り込まない。**連携できることが差別化の本体**だから。

## 使う

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit

# 動作確認用のサンプルグラフを書き出す
pnpm tsx scripts/make-sample.ts data/sample.provision.jsonld

# 実際に画像を生成しながら派生グラフを作る（mflux の量子化済み z-image-turbo が要る）
pnpm tsx scripts/generate-lineage.ts
```

生成は直列で 1 枚 2〜3 分。途中で落ちても `data/run/cache/` から続きを走る
（キャッシュ鍵は prompt / seed / steps / サイズ / モデル＝再現に要る情報そのもの）。

## 画面

```bash
pnpm dev   # 画面（5173）とローカルサーバ（8788）が一緒に上がる
```

3 面。**左に履歴、真ん中に来歴グラフ、右にチャット。**

| 面 | 役割 |
|---|---|
| 左 | これまでの版を時刻順に。いま居る版の系譜だけ色を残し、枝の外は薄くする |
| 中央 | React Flow（`@xyflow/react`）＋ ELK layered の来歴グラフ。ノードを選ぶと「いま居る版」が変わる |
| 右 | チャット。いま居る版までの会話が出る。送ると次の版が生まれる |

**チャットの履歴を別に持たない。** 右に出ているのは `graph.lineage()` そのもので、
指示は `provision:intent`、返事は生成された画像である。別ストアを持つと、
グラフと食い違ったときにどちらが本当か分からなくなる。

**分岐は特別な操作ではない。** 途中の版を選んでから送れば、そこから枝が生える。
すでに続きがある版を選ぶと、ボタンが「ここから分岐して生成」に変わる。

画像ノードはサムネイルを必ず出す。中身が見えないと版を見分けられないため。
参照の辺だけ点線にしてある——機械が消費したのではないから。

書き出した JSON-LD は [prov-jsonld-viz](https://github.com/kumagallium/prov-jsonld-viz)
にそのまま貼っても描画される（実機で確認済み）。

## デスクトップ版

```bash
node scripts/fetch-node.mjs      # 同梱する Node を取ってくる（初回だけ）
pnpm tauri dev                   # 開発
pnpm tauri build                 # 配布物を組む
```

Tauri。画面はブラウザ版とまったく同じで、画像生成とグラフの保存は
**同梱した Node + Hono のサイドカー**が担う。構成は geo-logo（元は Graphium）から移植した。

踏み抜いた罠も一緒に持ってきている:

- WebView から `http://127.0.0.1` への**素の fetch は mixed content で落ちる**。
  `src/ui/api-base.ts` の `apiFetch` が `@tauri-apps/plugin-http` に迂回する。
  画像も同じ理由で `ProvImage` が blob: に変えてから `<img>` に渡す
- `.app` 起動時の cwd は `/` なので、既定の `cwd/data` は作れない。
  置き場は Rust 側で決めて `PROVISION_DATA_DIR` で必ず渡す
- サイドカーは Rust から直接 spawn する。Shell プラグイン経由だと Windows で
  spawn は成功するのに stdout/stderr が届かず、起動失敗の原因が追えない

### リリース

tagpr ＋ GitHub Actions。Graphium / asterism と同じ運用に揃えてある。

1. PR を main にマージする
2. tagpr が「次のリリース用 PR」を自動で作る／更新する（**手を入れずマージするだけ**）
3. マージするとタグが打たれ、`desktop-release.yml` が macOS (Apple Silicon) を組む
4. 署名した `latest.json` を **GitHub Pages（`docs/updater/latest.json`）** に置く

昇格は merged PR のラベルで決める（既定は patch。`major` / `minor` を貼る）。

**自動更新の真実源は Pages 側。** `releases/latest/download` は tagpr の publish 直後に
新タグを指すが、実ビルドは十数分かかるので、その間クライアントが 404 を踏む。

壊れた案内を配らないための歯止めを 3 つ入れてある:

| 歯止め | 何を防ぐか |
|---|---|
| 署名が空なら publish を中止 | 署名なしの `latest.json` を配ると、クライアントは以後更新できなくなる |
| `sort -V` で配信中の版と比較 | 過去タグのワークフローを再実行しても、古い版を全員に offer しない |
| `release-drift-check.yml`（日次） | ビルドが落ちて `latest.json` が再生成されないと、更新が古い版に固定される。それを別経路で見る |

配布前に **サイドカーの smoke test** を必ず通す（`/api/health` に応答するか）。
ESM バンドルに `__dirname` が無い罠と、新しい依存が package 内の資産を読みに行って
起動即死する罠を、ここで拾う。

サードパーティ action は commit SHA で固定してある（タグは可変で、上書きされると
成果物に任意コードを混ぜられる）。更新は Dependabot が PR で提案する。

**まだ設定が要るもの**（鍵と資格情報なので、リポジトリの持ち主が入れる）:

| Secret | 用意の仕方 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `pnpm tauri signer generate -w ~/.tauri/provision.key`。公開鍵は `tauri.conf.json` の `pubkey` に貼る |
| `APPLE_CERTIFICATE` | Developer ID の `.p12` を base64 にしたもの |
| `APPLE_CERTIFICATE_PASSWORD` | その `.p12` のパスワード |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: ...（TEAMID）` |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | 公証用。`APPLE_PASSWORD` は App 用パスワード |

Secrets が無くても組める（署名なし。Gatekeeper の警告が出るが動く）。

## 横断クエリ（グラフでしかできないこと）

図版の系譜と、asterism が持つ測定データを **1 本の SPARQL で跨ぐ**。
接合点は `prov:used` ただ 1 つで、変換も対応表も要らない。

```bash
git clone https://github.com/kumagallium/asterism ~/develop/asterism
./scripts/crossgraph-query.sh queries/figure-to-data.rq data/run/lineage   # docker が要る
```

投稿版の図版 1 つを起点にすると、こう返る:

| 世代 | 参照した曲線 | 物性 | 試料 | 論文 | インジェスト実行 |
|---|---|---|---|---|---|
| GA v1 | 1171-316-665 | Seebeck coefficient | CC1 | Boron-Doped Ba8Al14Si31 Clathrate… | run-20260604T172858Z |
| GA v1 | 1171-318-665 | ZT | CC1 | 同上 | run-20260604T172858Z |

投稿版から 3 世代さかのぼって、著者が参照した測定曲線に行き当たり、
そこから試料・論文・**元データがどのインジェスト実行で入ったか（＝データの版）**まで届く。
枝分かれした別案（単色版）は投稿版の祖先ではないので、正しく除外される。

図版とデータの辺は `prov:wasDerivedFrom` ではなく `prov:used` である。
画像生成モデルは測定曲線を読んでいないので、派生と書けば来歴が嘘になる。
「著者がこれを見てこの図を作らせた」という実在する事実だけを書く（[D-006](docs/decisions.md)）。

`queries/figure-intents.rq` は「どの指示の連なりで今の形になったか」を返す。

## 決めたこと

段階間の契約は [`docs/decisions.md`](docs/decisions.md) にある。要点:

| | 決定 |
|---|---|
| 粒度 | 画像 1 枚 = 1 Entity。同一性は内容の SHA-256 |
| Activity | prompt / model / seed / 時刻は**必須**。欠けたら記録を拒否する |
| 意図 | Activity の `provision:intent`。辺は素の `wasDerivedFrom` のまま |
| 語彙 | 素の PROV ＋ `provision` の最小拡張のみ |
| データへの辺 | `prov:used`（人間が参照した事実）。`wasDerivedFrom` は張らない |

## 不変条件

- **元の絵を加工しない。** 派生は必ず新しい Entity を作る。
  内容ハッシュが IRI を決めるので、既存 Entity の書き換えは構造上できない
- **再現に要る情報を落とさない。** seed / モデル識別子 / プロンプト全文。
  1 つ欠けると「再実行できる」という価値の柱が折れるので、書き込み時に弾く
- **W3C PROV から外れない。** 語彙の独自化は連携の断絶であり、製品価値の毀損に直結する

## ライセンス

Apache License 2.0（asterism に揃えた）。`schema/` の `@context` も同じ条件で使ってよい。
