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
pnpm dev   # http://localhost:5173
```

React Flow（`@xyflow/react`）＋ ELK layered。ノードを選ぶと右の面に出る:

- **説明** — どの指示の連なりでこの版になったか（枝分かれした別案は入らない）
- **再実行に要る情報** — prompt / model / seed / steps / サイズ
- **この版が基づく外部データ** — 系譜をさかのぼって集めた参照 IRI

画像ノードはサムネイルを必ず出す。中身が見えないと版を見分けられないため。
参照の辺だけ点線にしてある——機械が消費したのではないから。

書き出した JSON-LD は [prov-jsonld-viz](https://github.com/kumagallium/prov-jsonld-viz)
にそのまま貼っても描画される（実機で確認済み）。

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
