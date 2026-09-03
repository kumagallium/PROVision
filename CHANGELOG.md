# Changelog

## [v0.2.24](https://github.com/kumagallium/PROVision/compare/v0.2.23...v0.2.24) - 2026-09-03

- feat(ui): 気に入らない版を消さずに「よけておく」 by @kumagallium in https://github.com/kumagallium/PROVision/pull/68

## [v0.2.23](https://github.com/kumagallium/PROVision/compare/v0.2.22...v0.2.23) - 2026-09-03

- feat(prompt): 清書を自分で書けるようにし、部分を頼むときは全体を名指ししない規則を足す by @kumagallium in https://github.com/kumagallium/PROVision/pull/66

## [v0.2.22](https://github.com/kumagallium/PROVision/compare/v0.2.21...v0.2.22) - 2026-09-02

- fix(ui): 生成の節点に意図ではなく実行された全文（清書）を出す by @kumagallium in https://github.com/kumagallium/PROVision/pull/64

## [v0.2.21](https://github.com/kumagallium/PROVision/compare/v0.2.20...v0.2.21) - 2026-09-02

- fix(bundle): 同梱する uv を externalBin に移し、本体と同じ署名を受けるようにする by @kumagallium in https://github.com/kumagallium/PROVision/pull/62

## [v0.2.20](https://github.com/kumagallium/PROVision/compare/v0.2.19...v0.2.20) - 2026-09-02

- feat(setup): 画像生成環境を設定画面のボタン一つで入れる by @kumagallium in https://github.com/kumagallium/PROVision/pull/59

## [v0.2.19](https://github.com/kumagallium/PROVision/compare/v0.2.18...v0.2.19) - 2026-08-28

- fix(image): 清書を文字消しの定型文で置き換えない by @kumagallium in https://github.com/kumagallium/PROVision/pull/56
- feat(ui): グラフで「いま見ている版」と「さっき生まれた版」を示す by @kumagallium in https://github.com/kumagallium/PROVision/pull/58

## [v0.2.18](https://github.com/kumagallium/PROVision/compare/v0.2.17...v0.2.18) - 2026-08-28

- fix(ai): 清書を必須にして、日本語のまま画像モデルへ渡さない by @kumagallium in https://github.com/kumagallium/PROVision/pull/54

## [v0.2.17](https://github.com/kumagallium/PROVision/compare/v0.2.16...v0.2.17) - 2026-08-28

- ci(tagpr): リリース PR を検査できる余地を残す by @kumagallium in https://github.com/kumagallium/PROVision/pull/51
- fix: ポートの許可も動かし、Keychain で固まらないようにする by @kumagallium in https://github.com/kumagallium/PROVision/pull/53

## [v0.2.16](https://github.com/kumagallium/PROVision/compare/v0.2.15...v0.2.16) - 2026-08-28

- fix(ui): ポートを OS に選ばせる by @kumagallium in https://github.com/kumagallium/PROVision/pull/49

## [v0.2.15](https://github.com/kumagallium/PROVision/compare/v0.2.14...v0.2.15) - 2026-08-28

- fix(ui): ポートが塞がっていても起動できるようにする by @kumagallium in https://github.com/kumagallium/PROVision/pull/47

## [v0.2.14](https://github.com/kumagallium/PROVision/compare/v0.2.13...v0.2.14) - 2026-08-27

- fix(image): 保存を求める文を条件形にして、判定を外しても壊れないようにする by @kumagallium in https://github.com/kumagallium/PROVision/pull/40

## [v0.2.13](https://github.com/kumagallium/PROVision/compare/v0.2.12...v0.2.13) - 2026-08-27

- fix(image): 作り替えの判定を書き直し文にも当てる by @kumagallium in https://github.com/kumagallium/PROVision/pull/38

## [v0.2.12](https://github.com/kumagallium/PROVision/compare/v0.2.11...v0.2.12) - 2026-08-26

- fix(ui): 過去の会話でノードが重なるのと、生成後にグラフが空になるのを直す by @kumagallium in https://github.com/kumagallium/PROVision/pull/36

## [v0.2.11](https://github.com/kumagallium/PROVision/compare/v0.2.10...v0.2.11) - 2026-08-26

- fix(image): 作り替えの依頼に「すべて保て」を付けないようにする by @kumagallium in https://github.com/kumagallium/PROVision/pull/34

## [v0.2.10](https://github.com/kumagallium/PROVision/compare/v0.2.9...v0.2.10) - 2026-08-26

- fix(ui): 候補をできた順に出し、生成中は入力を伏せる by @kumagallium in https://github.com/kumagallium/PROVision/pull/32

## [v0.2.9](https://github.com/kumagallium/PROVision/compare/v0.2.8...v0.2.9) - 2026-08-26

- fix(config): 更新のたびに AI モデルの登録が消えるのを直す by @kumagallium in https://github.com/kumagallium/PROVision/pull/30

## [v0.2.8](https://github.com/kumagallium/PROVision/compare/v0.2.7...v0.2.8) - 2026-08-26

- docs: D-020 の表を実装に合わせる by @kumagallium in https://github.com/kumagallium/PROVision/pull/27
- feat(image): 矢印を引けるようにする by @kumagallium in https://github.com/kumagallium/PROVision/pull/29

## [v0.2.7](https://github.com/kumagallium/PROVision/compare/v0.2.6...v0.2.7) - 2026-08-26

- feat(prov): 複数の画像を材料に1枚作れるようにする by @kumagallium in https://github.com/kumagallium/PROVision/pull/24
- feat(image): ガンマ補正とスケールバーを足す by @kumagallium in https://github.com/kumagallium/PROVision/pull/26

## [v0.2.6](https://github.com/kumagallium/PROVision/compare/v0.2.5...v0.2.6) - 2026-08-26

- fix(prov): 記録しているのに確かめられない項目をなくす by @kumagallium in https://github.com/kumagallium/PROVision/pull/21
- feat(image): 実測にもとづいて生成の既定を見直す — 1枚あたりの時間を半分にする by @kumagallium in https://github.com/kumagallium/PROVision/pull/22

## [v0.2.5](https://github.com/kumagallium/PROVision/compare/v0.2.4...v0.2.5) - 2026-08-26

- feat(prov): 指示を節点として置き、候補を1つの会話にまとめる by @kumagallium in https://github.com/kumagallium/PROVision/pull/19

## [v0.2.4](https://github.com/kumagallium/PROVision/compare/v0.2.3...v0.2.4) - 2026-08-26

- feat(ui): 1つの指示から候補を複数出せるようにする by @kumagallium in https://github.com/kumagallium/PROVision/pull/17

## [v0.2.3](https://github.com/kumagallium/PROVision/compare/v0.2.2...v0.2.3) - 2026-08-26

- feat(prov): 外から持ち込んだ画像を取り込めるようにする by @kumagallium in https://github.com/kumagallium/PROVision/pull/13
- feat(prov): 画素を作る操作を使わない設定を足す by @kumagallium in https://github.com/kumagallium/PROVision/pull/16

## [v0.2.2](https://github.com/kumagallium/PROVision/compare/v0.2.1...v0.2.2) - 2026-08-26

- feat(prov): 版が食い違ったとき、どこが違うか出せるようにする by @kumagallium in https://github.com/kumagallium/PROVision/pull/10
- feat(prov): 画素を作ったかどうかを、再現の等級と別の軸で記録する by @kumagallium in https://github.com/kumagallium/PROVision/pull/12

## [v0.2.1](https://github.com/kumagallium/PROVision/compare/v0.2.0...v0.2.1) - 2026-08-25

- fix(image): 背景にむらがある画像で余白が削れないのを直す by @kumagallium in https://github.com/kumagallium/PROVision/pull/8

## [v0.2.0](https://github.com/kumagallium/PROVision/compare/v0.1.2...v0.2.0) - 2026-08-25

- feat(image): 画像ツールを自動選択して来歴を記録 by @kumagallium in https://github.com/kumagallium/PROVision/pull/6

## [v0.1.2](https://github.com/kumagallium/PROVision/compare/v0.1.1...v0.1.2) - 2026-08-20

## [v0.1.1](https://github.com/kumagallium/PROVision/compare/v0.1.0...v0.1.1) - 2026-08-20

- build(deps): Bump actions/checkout from 4.4.0 to 7.0.1 by @dependabot[bot] in https://github.com/kumagallium/PROVision/pull/1

## [v0.1.0](https://github.com/kumagallium/PROVision/commits/v0.1.0) - 2026-08-20
