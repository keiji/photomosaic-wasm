# ドキュメント索引

フォトモザイク生成アプリ(Web / Android / WASM 共通コア)の設計ドキュメント一覧。

| 文書                                                           | 内容                                                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [01_project_overview.md](./01_project_overview.md)             | プロジェクト概要書。プロダクトの目的・主要機能・完全オフラインによるプライバシーリスク低減を記載。             |
| [02_basic_design.md](./02_basic_design.md)                     | 基本設計書。画面遷移、画面構成、フォトモザイクの具体的処理を除いた処理の流れ、進捗表示と保存の仕様。           |
| [03_detailed_design.md](./03_detailed_design.md)               | 詳細設計書。モジュール分割、フォトモザイク処理の具体的な流れ、閾値などのパラメータ一覧、進捗コールバック設計。 |
| [04_performance_comparison.md](./04_performance_comparison.md) | JS / WASM の速度比較。初期計測、WASM の速度最適化、rAF 省略時の差、Web Worker 実装とブラウザ実測。             |
| [05_memory_comparison.md](./05_memory_comparison.md)           | JS / WASM のメモリフットプリント比較。計測方法、ブラウザ実測、WASM 採用判断、再計測用スクリプトの使い方。      |
| [handoff/](./handoff/)                                         | 実装に当たってのハンドオフ資料(下記)。                                                                         |

## ハンドオフ資料(handoff/ 配下)

| 文書                                                                               | 内容                                                                                                            |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [01_photomosaic_algorithm_survey.md](./handoff/01_photomosaic_algorithm_survey.md) | フォトモザイク処理の一般的な実装方法の調査まとめ(本アプリに限らない世の中の手法の整理)。                        |
| [02_wasm_build_guide.md](./handoff/02_wasm_build_guide.md)                         | Rust / Go から実行可能な .wasm を作成する手順。                                                                 |
| [03_go_vs_rust.md](./handoff/03_go_vs_rust.md)                                     | WASM 実装言語を Go / Rust のどちらにすべきかの検討資料。                                                        |
| [04_webapp_development_loop.md](./handoff/04_webapp_development_loop.md)           | Web アプリの開発手順。WASM バイナリと組み合わせて機能拡張を繰り返すループ開発の計画。                           |
| [05_performance_measurement.md](./handoff/05_performance_measurement.md)           | 性能の計測。フォトモザイク処理の各部の所要時間を計測可能にするための設計。                                      |
| [06_android_implementation_guide.md](./handoff/06_android_implementation_guide.md) | Android アプリの実装手順。Web アプリが一定整った段階での着手と、コア インターフェースへのフィードバックの流れ。 |

## 読む順番の推奨

1. プロジェクトの参加者: `01` → `02` → `03`
2. 実装着手者: `01`〜`03` を読んだ上で `handoff/03`(言語選定) → `handoff/02`(ビルド手順) → `handoff/04`(開発ループ) → `handoff/05`(計測) → `handoff/06`(Android)
3. 性能比較: `04`(速度) → `05`(メモリ)
4. アルゴリズムの背景を知りたい場合: `handoff/01`

## 用語の対応

本ドキュメント群で使う用語は [01_project_overview.md の用語定義](./01_project_overview.md#9-用語定義) に統一する。
