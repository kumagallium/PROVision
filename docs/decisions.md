# 決定記録

段階間の契約。実装より先に決めた。変更するときは理由を追記して残す（消さない）。

---

## D-001 PROV エンティティの粒度 — 画像 1 枚 = 1 Entity

**決定**: 画像 1 枚を 1 つの `prov:Entity` とする。セッションはグラフの単位であって
Entity ではない。派生は `wasDerivedFrom`（reified `prov:Derivation`）で繋ぐ。

**Entity の同一性は画像の内容ハッシュ（SHA-256）で決める。**
IRI は `{base}/resource/image/{sha256}`。

**なぜ**
- 内容が変われば IRI が変わるので、§不変条件「元の絵を加工しない」が構造として守られる。
  既存 Entity を書き換える操作が原理的に書けない
- 同じ画像を 2 回作れば同じ IRI に収束する。重複が自然に畳まれる
- セッション単位にすると「どの版が論文に載ったか」が引けない。これはスコープの中心なので落とせない

**捨てたもの**: セッション = 1 Entity。枝分かれを表現できない。

---

## D-002 Activity に記録するもの — 再実行できる情報を全部

**決定**: 1 回の生成 = 1 つの `prov:Activity`。IRI は `{base}/resource/activity/{id}`。
次を必須項目とし、**1 つでも欠けたら記録を拒否する**（`assertReproducible`）。

| 項目 | 述語 | 例 |
|---|---|---|
| プロンプト全文 | `provision:prompt` | "a minimal line drawing of ..." |
| モデル識別子 | `provision:model` | "z-image-turbo-4bit" |
| seed | `provision:seed` | 42 |
| 開始・終了時刻 | `prov:startedAtTime` / `prov:endedAtTime` | ISO 8601 |

任意項目: `provision:negativePrompt` / `steps` / `guidance` / `width` / `height` / `provider`。

**なぜ**: 「再実行できる」が価値の柱。欠けても書けてしまう設計だと、欠けたまま溜まって
後から復元できない。書き込み時に落とすのが唯一効く場所。

**捨てたもの**: 「あとで補完する」方式。補完されないまま残ることが geo-logo で実証済み。

---

## D-003 意図（自然言語の指示）の置き場所 — Activity の属性

**決定**: 利用者が出した指示（「もっと余白を」「配色を寒色に」）は
`provision:intent` として **Activity に置く**。辺は素の `wasDerivedFrom` のまま保つ。

**なぜ**
- PROV の標準から外れない。`prov:Derivation` に独自属性を足すと、
  素の PROV しか読まない側（asterism / prov-jsonld-viz）で意図が落ちる
- 「どの指示でこうなったか」は Activity を辿れば出る。辺に置く必然性がない
- 1 つの Activity が複数の入力を使う場合、辺ごとに意図を分けても意味を持たない

**捨てたもの**: 辺の属性（`provision:intentOn` など）。連携が切れる代償に見合わない。

---

## D-004 名前空間 — 素の PROV ＋ `provision` の最小拡張

**決定**: `@vocab` は `http://www.w3.org/ns/prov#`。画像生成に固有の語だけを
`provision:` に置く。`matprov` は取り込まない（名前空間の切り方だけ真似る）。

```json
{
  "@context": [
    {"@vocab": "http://www.w3.org/ns/prov#"},
    "https://openprovenance.org/prov-jsonld/context.jsonld",
    "https://kumagallium.github.io/provision-schema/context.jsonld"
  ],
  "@graph": []
}
```

**なぜ**: 独自語彙を減らすことがそのまま相互運用性になる。連携できることが差別化の本体。

---

## D-005 直列化の形 — reified な PROV-JSONLD（openprovenance 形式）

**決定**: 関係は実体ノードとして書く。`Usage` / `Generation` / `Association` / `Derivation`
を `@graph` に並べ、値は `[{"@value": ...}]` の配列形式にする。

**なぜ**: `prov-jsonld-viz`（`~/develop/prov-jsonld-viz/index.html`）が
`item["@type"] === "Usage" | "Generation" | "Association"` を見て辺を描く実装だから。
受け入れ条件「書き出した JSON-LD が prov-jsonld-viz で開ける」はこの形でしか満たせない。

**関係ノードに `@id` は付けない。** viz は `@id` を持つ項目を無条件にノードとして描くため、
付けると Usage / Generation / Association が孤立した点として画面に散らばる（実機で確認）。
`@id` を落とせば辺だけが描かれる。JSON-LD としては空白ノードになるだけで問題ない。

**参照した外部リソースにもノードを置く。** 置かないと viz が「端点の無い辺」を作ろうとして
cytoscape が例外を投げ、**辺が 1 本も描かれない**（実機で確認。ノード 12・辺 0 になった）。
置くのは IRI と `prov:Entity` だけで、中身は主張しない——それは asterism 側の言うことである。

**`prov:Derivation` の実体ノードは書かない。** viz は辺を描かず、孤立ノードが増えるだけだった。
派生は Entity 側の `prov:wasDerivedFrom` として直接持たせてあり、SPARQL からはそちらで引ける
（`?new prov:wasDerivedFrom ?old`）。詳細が要る場合も `wasGeneratedBy` + `used` で辿れる。

---

## D-006 データへの接合点 — 「人間が参照した」として `prov:used` だけ張る

**決定**: 図版が元データ（asterism の curve / sample）と繋がる辺は、
生成 Activity の `prov:used` として書く。**`prov:wasDerivedFrom` は張らない。**
責任者は `prov:wasAssociatedWith` の人間 Agent。

**なぜ**
- 画像生成モデルはプロンプトを消費しただけで、測定曲線を読んでいない。
  「この曲線から派生した」と書けば**それは来歴の嘘**になる
- 一方「著者がこの曲線を見て、この図を作らせた」は実在する事実で、
  `prov:used` ＋ 人間 Agent への `wasAssociatedWith` で正確に書ける
- 新語彙が 1 つも要らない。asterism 側は素の PROV でこれを読める

**捨てたもの**: 図版とデータを `wasDerivedFrom` で直結すること。
横断クエリは書きやすくなるが、グラフが嘘をつく。

**副作用**: `wasDerivedFrom` は画像の親だけを指すので、
`prov:wasDerivedFrom*` の推移閉包が「画像の系譜」だけを正しく辿る。
外部リソースが混ざらないのは、この分離のおかげ。

---

## D-007 RDF への出口 — N-Triples を自前で書く

**決定**: asterism（Oxigraph）へ載せるための N-Triples は、JSON-LD ライブラリで
展開せず、`src/prov/ntriples.ts` が素の PROV の IRI を直接書く。

**なぜ**: JSON-LD の展開は `@context` をネットワークから取りに行く。
`provision-schema` の URL はまだ実在せず、openprovenance も外部依存になる。
グラフの形はこちらが完全に決めているので、直接書く方が決定論的でオフラインで動く。
`@context` を配信し始めたら、後から標準の展開に差し替えてもよい（出力は一致するはず）。

---

## D-008 後から分かったことは、書き換えずに「表明」として足す

**決定**: 生成のあとで分かること——「この版はこのデータに基づく」「この版が Figure 2 として
載った」——は、**既存の Entity / Activity を書き換えずに、別の `prov:Activity` として記録する**。

```
表明 Activity
  prov:used            <対象の画像>
  prov:used            <外部データ IRI>        ← 参照のとき
  prov:generated       <fabio:Figure>          ← 掲載のとき
  prov:wasAssociatedWith <人間 Agent>
  prov:startedAtTime   <言った時刻>
```

**なぜ**
- 不変条件（元の絵を加工しない・記録を書き換えない）をそのまま守れる
- **「生成時に分かっていたこと」と「後から人が主張したこと」が混ざらない。**
  いつ・誰が言ったかまで残るので、主張の責任が追える
- 掲載は世界の側で起きた事実であって、絵が変わったわけではない。
  Entity に後から属性を足すと、その区別が消える

**生成の Activity と表明の Activity の見分け方**: `provision:prompt` を持つかどうか。
表明は絵を作らないので prompt が無い。読み戻しはこれで判別する（新しい語彙を足さずに済む）。

**掲載の語彙は FaBiO を使う**（`fabio:Figure`、`http://purl.org/spar/fabio/`）。自作しない。
図版の IRI は**載った先の識別子から作る**（`{doi}#figure-2`）ので、
同じ論文の同じ図なら誰が記録しても同じ IRI に収束する。

**捨てたもの**: Entity に `publishedAs` のような属性を後から足すこと。書けてしまうが、
「いつ誰が言ったか」が消え、生成時の事実と区別できなくなる。

---

## D-009 `@context` は自分で配信する

**決定**: `provision` の `@context` を **GitHub Pages（`docs/schema/context.jsonld`）で実際に配信する**。
IRI も `https://kumagallium.github.io/PROVision/schema/context.jsonld#` に揃えた。

**なぜ**: 実在しない URL を書いておくと、JSON-LD を素直に展開する側（他のツール、
将来の自分）が 404 を踏む。D-007 で自前 N-Triples にして回避してはいるが、
**それは出口の都合であって、書き出したファイルが嘘をついてよい理由にはならない。**

---

## D-010 内容ハッシュは**画素**に取る。ファイル全体ではない

**決定**: Entity の IRI を決める内容ハッシュは、PNG の **IHDR ＋ 展開した IDAT**
（＝寸法と画素そのもの）から取る。ファイル全体のバイト列は数えない。

**なぜ**（2026-08-20 の実測）: 同じ prompt / model / seed で 2 回出したところ、
**画素は 3,146,752 バイトすべて一致**し、違っていたのは mflux が書き込む
`iTXt`（XMP）と `eXIf` だけだった——どちらにも生成時刻が入る。

ファイル全体を数えていると、**同じ絵でも毎回別の IRI になる**。
D-001 の「同じ内容は同じ Entity に収束する」が実質破れていた。
「再実行できる」という主張も、検査すれば必ず失敗する状態だった。

`recordGeneration` にバイト列をそのまま渡すと今も全体を数える。
呼び側は `imageContentDigest()` を通すこと（型では強制できないので、注記で残す）。

**この修正より前に記録した版は、旧方式のハッシュのまま**。書き換えない——
来歴は書き換えないという原則が、自分たちの都合より優先する。

---

## D-011 出し直して食い違ったら `prov:alternateOf` で繋ぐ

**決定**: 同じ指定で再実行して別の絵が出たとき、新しい版は元の版の
`prov:alternateOf` とする。`wasDerivedFrom` は張らない。

**なぜ**: 前の絵を材料にしたわけではないので、派生と書けば嘘になる（D-006 と同じ筋）。
PROV には「同じものを指す別の実体」を表す語があるので、それを使う。
新しい語彙は要らない。

**副作用**: 会話の切り出し（根ごとの連結成分）で、食い違った版が
別の会話として独立してしまうのを防げる。`roots()` と `rootOf()` は
`alternateOf` を辿って元の会話へ寄せる。
