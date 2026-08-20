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
