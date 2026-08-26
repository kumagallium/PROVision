/** 画面の配色。PROV の役割ごとに 1 か所で決める。 */
export const PALETTE = {
  /** 画像（prov:Entity） */
  image: { main: '#4b7a52', bg: '#eef4ef', text: '#2d4a32' },
  /** 生成（prov:Activity）。意図が載る */
  activity: { main: '#5b8fb9', bg: '#eaf1f7', text: '#3f6c92' },
  /** 人間が参照した外部リソース（asterism の測定曲線など） */
  external: { main: '#c08b3e', bg: '#f7f1e6', text: '#7a5a22' },
  /** 1 回の送信（prov:Plan）。候補が枝分かれする起点（D-022） */
  plan: { main: '#8a7bb8', bg: '#f1eef8', text: '#54487a' },
} as const

export const EDGE_STYLE = {
  /** 前の版を使った */
  used: { stroke: '#8aa0ae', dash: undefined },
  /** 人間が参照した。機械が消費したのではないので点線にする */
  referenced: { stroke: '#c08b3e', dash: '6 4' },
  /** 生成した */
  generated: { stroke: '#5b8fb9', dash: undefined },
  /** その送信から走った（prov:hadPlan）。材料ではないので細く見せる */
  planned: { stroke: '#8a7bb8', dash: '4 3' },
  /** 同じ指定で出し直したら別の絵になった（prov:alternateOf）。派生ではない */
  alternate: { stroke: '#a8513f', dash: '2 4' },
} as const
