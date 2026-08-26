/**
 * いま居る版について、Step 3 の問いに答える面。
 *
 *   再実行 — この絵をもう一度出すのに要る情報
 *   横断 — 著者がどの外部データを参照していたか（asterism 側と繋ぐと論文まで届く）
 *   同一性 — 内容ハッシュ。これが Entity の IRI を決めている
 */
import type { ProvGraph } from '../prov/graph.js'
import { alternatesOf, compareGenerations, type FieldDifference } from '../prov/compare.js'
import {
  PIXEL_ORIGIN_LABELS,
  REPRODUCIBILITY_LABELS,
  lineagePixelOrigin,
  weakestReproducibility,
  type PixelOrigin,
} from '../ai/tools.js'

const CODE: React.CSSProperties = {
  display: 'block',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  background: '#f4f6f7',
  border: '1px solid #e0e5e8',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 11,
  fontFamily: 'ui-monospace, monospace',
  color: '#2f3a41',
  marginBottom: 8,
}

const H: React.CSSProperties = {
  margin: '12px 0 5px',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.04em',
  color: '#3f4a52',
}

export function DetailPanel({
  graph,
  entityId,
}: {
  graph: ProvGraph | null
  entityId: string | null
}) {
  if (!graph || !entityId) return null
  const entity = graph.getEntity(entityId)
  const activity = graph.activityThatGenerated(entityId)
  if (!entity || !activity) return null

  const published = graph.publicationsOf(entityId)

  return (
    <div>
      <h3 style={H}>再実行に要る情報</h3>
      <code style={CODE}>
        {[
          // 頼んだこと（intent）と実行されたこと（prompt）を**並べて出す**。
          // 別々に残しているのは突き合わせられるようにするためで（D-003）、
          // 片方しか見えないとその意味が無い。書き直しが入ればここで差が見える
          ...(activity.intent ? [`intent: ${activity.intent}`] : []),
          `prompt: ${activity.prompt}`,
          ...(activity.negativePrompt ? [`negative prompt: ${activity.negativePrompt}`] : []),
          `model:  ${activity.model}`,
          `seed:   ${activity.seed}`,
          ...(activity.steps !== undefined ? [`steps:  ${activity.steps}`] : []),
          ...(activity.guidance !== undefined ? [`guidance: ${activity.guidance}`] : []),
          ...(activity.width !== undefined
            ? [`size:   ${activity.width}x${activity.height ?? activity.width}`]
            : []),
          ...(activity.imageStrength !== undefined
            ? [`image strength: ${activity.imageStrength}`]
            : []),
          ...(activity.conditioningImageDigest
            ? [`conditioning image: ${activity.conditioningImageDigest}`]
            : []),
          ...(activity.maskImageDigest ? [`inpainting mask: ${activity.maskImageDigest}`] : []),
          // 取り込みの再実行に要るのは元のファイル（D-019）。手元のファイルと
          // 突き合わせられるように、画素ではなくバイト列のハッシュを出す
          ...(activity.sourceFileName ? [`source file: ${activity.sourceFileName}`] : []),
          ...(activity.sourceFileMediaType
            ? [`source type: ${activity.sourceFileMediaType}`]
            : []),
          ...(activity.sourceFileDigest
            ? [`source file sha256: ${activity.sourceFileDigest}`]
            : []),
          ...(activity.selectedTool ? [`tool:   ${activity.selectedTool}`] : []),
          ...(activity.toolArguments ? [`tool arguments: ${activity.toolArguments}`] : []),
          ...(activity.planningMode
            ? [
                `planning: ${activity.planningMode}${
                  activity.plannerModel
                    ? ` (${activity.plannerProvider ?? 'unknown'} / ${activity.plannerModel})`
                    : ''
                }`,
              ]
            : []),
          // 実行したコマンドの雛形（D-017）。PROVISION_IMAGE_COMMAND を差し替えた差は
          // 他の項目からは見えない。突き合わせでは見ているのに画面に無かった
          ...(activity.commandTemplate ? [`command: ${activity.commandTemplate}`] : []),
          ...(activity.provider ? [`provider: ${activity.provider}`] : []),
          // いつ走ったか。D-002 で再実行に要る情報として必須にしているのに出ていなかった
          `executed: ${activity.startedAtTime} → ${activity.endedAtTime}`,
        ].join('\n')}
      </code>

      {published.length > 0 ? (
        <>
          <h3 style={H}>掲載</h3>
          {published.map((f) => (
            <code key={f.id} style={CODE}>{`${f.label}\n${f.partOf}`}</code>
          ))}
        </>
      ) : null}

      <h3 style={H}>再現の範囲</h3>
      <code style={CODE}>{reproducibilityLines(graph, entityId).join('\n')}</code>

      <h3 style={H}>画素の由来</h3>
      <code style={CODE}>{pixelOriginLines(graph, entityId).join('\n')}</code>

      {alternatesOf(graph, entityId).map((other) => (
        <div key={other}>
          <h3 style={H}>食い違った版との差分</h3>
          <code style={CODE}>{comparisonLines(graph, other, entityId).join('\n')}</code>
        </div>
      ))}

      <h3 style={H}>この画像</h3>
      <code style={CODE}>{`sha256: ${entity.digest}`}</code>
    </div>
  )
}

/**
 * この版が別の PC でどこまで再現するかを言葉にする（D-015 / D-016）。
 *
 * **鎖全体の等級も出す**のが肝。Jimp で切って mflux で描き直した版は、
 * 「この一手は確定的」だけを見せると再現すると誤解される。
 * 系譜に 1 本でも確率的な辺があれば、その版は再現しない。
 */
export function reproducibilityLines(graph: ProvGraph, entityId: string): string[] {
  const activity = graph.activityThatGenerated(entityId)
  const chain = graph.lineage(entityId)
  const grades = chain
    .map((a) => a.reproducibility)
    .filter((g): g is NonNullable<typeof g> => g !== undefined)

  const lines: string[] = []
  if (activity?.reproducibility) {
    lines.push(`この一手: ${REPRODUCIBILITY_LABELS[activity.reproducibility]}`)
  }
  if (grades.length > 0) {
    lines.push(`ここまでの系譜: ${REPRODUCIBILITY_LABELS[weakestReproducibility(grades)]}`)
  }
  if (lines.length === 0) {
    // 等級を足す前に作った版。無印を「再現する」と読ませない
    lines.push('等級を記録する前の版なので、再現の範囲は分からない')
  }

  // 環境が分かる Agent だけ出す。実測できなかったものは行を作らない（D-015）
  const environments = (activity?.wasAssociatedWith ?? [])
    .map((id) => graph.listAgents().find((a) => a.id === id))
    .filter((a) => a && (a.version || a.platform || a.modelFingerprint))
  for (const agent of environments) {
    const detail = [
      agent!.version ? `version ${agent!.version}` : undefined,
      agent!.modelFingerprint ? `model ${agent!.modelFingerprint}` : undefined,
      agent!.platform,
    ].filter(Boolean)
    lines.push(`${agent!.label}: ${detail.join(' / ')}`)
  }
  return lines
}

/**
 * その版の画素がどこから来たかを言葉にする（D-020）。
 *
 * **再現の範囲とは別の問い**である。LaMa は乱数を使わないので等級は
 * `environment-dependent` だが、消した領域を周囲から描いている。等級だけを見せると、
 * 決定的に近いことが「画素を作っていない」と読まれる。
 *
 * **本数で出す。** 0 が「1 本も無かった」なのか「そもそも見ていない」なのか
 * 区別できなくなるため（D-017 と同じ理由）。
 *
 * **「改ざんされていない」とは書かない。** 言えるのは、記録したツールのうち画素を
 * 作るものを通ったかまでで、PROVision の外で加工されてから持ち込まれた画像に
 * ついては何も言えない。
 */
export function pixelOriginLines(graph: ProvGraph, entityId: string): string[] {
  const activity = graph.activityThatGenerated(entityId)
  const origins = graph
    .lineage(entityId)
    .map((a) => a.pixelOrigin)
    .filter((o): o is PixelOrigin => o !== undefined)
  const summary = lineagePixelOrigin(origins)

  const lines: string[] = []
  if (activity?.pixelOrigin) {
    lines.push(`この一手: ${PIXEL_ORIGIN_LABELS[activity.pixelOrigin]}`)
  }
  if (summary.counted > 0) {
    lines.push(
      `ここまでの系譜: ${summary.counted} 本のうち、画素を作った手は ${summary.synthesized} 本`,
    )
    // 0 本のときだけ「では何をしたのか」を出す。作っているなら数が答えになっている。
    // この一手と同じなら言い直さない
    if (summary.synthesized === 0 && summary.strongest !== activity?.pixelOrigin) {
      lines.push(`一番強い手でも「${PIXEL_ORIGIN_LABELS[summary.strongest]}」`)
    }
  }
  // 画素の由来を足す前に作った版。無印を「画素を作っていない」と読ませない
  if (lines.length === 0) return ['画素の由来を記録する前の版なので、分からない']
  // 取り込んだ画像より前は見ていない。ここを落とすと集計が過大主張になる（D-020）
  if (summary.hasExternal) lines.push('取り込んだ画像より前は、この記録では見えない')
  return lines
}

/** 片側にしか記録が無い項目は「値が違う」と書かない。調べていないだけかもしれない */
function differenceLine(d: FieldDifference): string {
  const side = (v: string | undefined) => (v === undefined ? '（記録なし）' : v)
  return `${d.label}:\n  もう一方: ${side(d.left)}\n  この版:   ${side(d.right)}`
}

/**
 * 食い違った 2 版の差分（D-015）。
 *
 * **「原因」とは書かない。** 出せるのは記録した項目のうち違ったものだけで、
 * それが絵を変えた原因かどうかは言えない。文言でそこを混ぜると、
 * この画面自身が過大主張になる。
 */
export function comparisonLines(graph: ProvGraph, left: string, right: string): string[] {
  const result = compareGenerations(graph, left, right)
  if (result.unavailable) return [result.unavailable]
  if (result.differences.length === 0) {
    return [
      `記録した ${result.compared} 項目はすべて一致した。`,
      '記録していない要因（Metal の実装差、実行時の負荷）が残るので、',
      '環境が同一だったとは言えない。',
    ]
  }
  return [
    `記録した ${result.compared} 項目のうち ${result.differences.length} 項目が違う。`,
    'これは容疑者であって、絵が変わった原因が確かめられたわけではない。',
    '',
    ...result.differences.map(differenceLine),
  ]
}
