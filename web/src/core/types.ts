/**
 * コア(共通処理本体)との論理 API 型定義。
 * 詳細設計書 2 章「コア API 仕様」の TypeScript 版。
 *
 * - 画像バッファは RGBA(1 ピクセル 4 バイト)、バイト順 R→G→B→A、
 *   行優先(上→下、左→右)、非プリマルチプライ、sRGB に統一する。
 * - M0 ではモック実装(core/mockCore.ts)のみ。M1 以降、WASM 実装に差し替える。
 */

/** RGBA ピクセルバッファを持つ画像(詳細設計書の入出力正規形) */
export interface RgbaImage {
  width: number;
  height: number;
  /** 長さ width * height * 4 の RGBA バッファ */
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** グリッド情報(詳細設計書 3 章 GridInfo) */
export interface GridInfo {
  /** メイン画像(解析用正規化後)のサイズ */
  width: number;
  height: number;
  /** 1 ブロックの辺長 px */
  blockSize: number;
  /** ブロック数(最終列/行は半端ブロック含む) */
  cols: number;
  rows: number;
  /** 全体ブロック数 = cols * rows(進捗バーの分母) */
  totalBlocks: number;
}

/**
 * 進捗イベント(詳細設計書 3 章 ProgressEvent)。
 * コアは文言を持たず、`phaseCode` は UI 側リソースで文言化する安定識別子のみ。
 */
export interface ProgressEvent {
  /** フェーズの安定識別子(例: "main_analyze" | "tile_analyze" | "match" | "compose") */
  phaseCode: string;
  /** 0.0..1.0(フェーズ内の進捗) */
  phaseRatio: number;
  /** 0.0..1.0(全フェーズ通し) */
  overallRatio: number;
  /** マッチ済みブロック数(match 中のみ有効) */
  assignedBlocks: number;
  totalBlocks: number;
}

/** 進捗イベントのコールバック(onProgress で登録する) */
export type ProgressCallback = (event: ProgressEvent) => void;

/**
 * 部分結果(詳細設計書 3 章 ResultBatch / 7.4)。
 * 行番号はブロック行(row_batch の単位)。画素行への写像は rowBegin * blockSize。
 * 完成した行範囲をプレビューへ逐次転写する(段階的置き換え表示)に使う。
 */
export interface ResultBatch {
  /** 完成したブロック行範囲 `[blockRowBegin, blockRowEnd)` */
  blockRowBegin: number;
  blockRowEnd: number;
  /** 1 ブロック行の高さ px(画素行 = blockRowBegin * blockSize) */
  blockSize: number;
  /** 画像幅 px */
  width: number;
  /** width * (blockRowEnd - blockRowBegin) * blockSize * 4 バイトの合成済み RGBA */
  rgba: Uint8Array;
}

/** 部分結果のコールバック(onResult で登録する) */
export type ResultCallback = (batch: ResultBatch) => void;

/**
 * マッチング・合成のパラメータ(詳細設計書 5 章)。
 * キー名はコア(getConfig/setConfig の JSON)と一致させる。
 */
export interface MosaicConfig {
  /** 色距離 (ΔE76) の重み。既定 1.0、範囲 0.5〜2.0 */
  w_c: number;
  /** ディテール差の重み。既定 0.25、範囲 0〜1.0 */
  w_d: number;
  /** 使用回数ペナルティ係数 λ。既定 0.35、範囲 0〜1.0 */
  usage_penalty: number;
  /** 直上/直左と同一タイルのペナルティ n_p。既定 0.5、範囲 0〜1.0 */
  neighbor_penalty: number;
  /** 「視覚上同一」とみなす ΔE76 閾値(固定 2.0) */
  identical_de: number;
  /** 差分再マッチ(タイル追加時)の差し替え判定マージン。既定 1.0、範囲 0.5〜2.0 */
  improve_margin: number;
  /** 類似タイルの同一視閾値(色距離 ΔE76 換算)。既定 2.0、範囲 0.5〜8.0。
   * 閾値内の類似タイル(同一写真の複製・至近バースト)は使用回数を共有する */
  duplicate_de: number;
  /** 類似タイルの同一視閾値(detail 差)。既定 4.0、範囲 0〜32 */
  duplicate_detail: number;
  /** 1 タイルの最大使用回数。既定 4、0 = 無制限 */
  usage_cap: number;
  /** 色補正強度 α。既定 0.85、範囲 0〜1.0(分母はタイルの周囲重み付き代表色) */
  color_correct: number;
  /** 行バッチ単位。既定 8、範囲 4〜32 */
  row_batch: number;
}

/**
 * タイル情報(詳細設計書 3 章 TileFeature)。
 * id はコア API の u64 に対応するため bigint を用いる。
 */
export interface TileInfo {
  /** アプリ側が採番したタイル ID */
  id: bigint;
  /** 合成用サムネイル寸法(P4 合成でブロック矩形へスケーリングする際の元) */
  thumbWidth: number;
  thumbHeight: number;
  /** CIELAB 平均 (L*, a*, b*) */
  meanLab: [number, number, number];
  /** タイル内 L*(明度)の標準偏差(0..128) */
  detail: number;
  /** 現在の使用回数(P3 の使用ペナルティ用) */
  usage: number;
}

/**
 * コアの計測結果 1 スパン(handoff/05 §3 の累計・回数・最大・平均)
 */
export interface MetricsSpan {
  count: number;
  avgMs: number;
  maxMs: number;
}

/**
 * コアの計測結果 1 run 分(getMetrics の出力。handoff/05 §4 スキーマ)。
 * 開発オーバーレイ・ベンチでの表示に使う(ゴールデン判定には使わない)
 */
export interface MetricsRun {
  runId: number;
  trigger: string;
  /** ホスト時計の開始時刻 ms(時計なしコアでは 0) */
  startedAtMs: number;
  phases: {
    P1_MAIN_ANALYZE: { ms: number };
    P2_TILE_ANALYZE: { ms: number; tiles: number };
    P3_MATCH: { ms: number; batches: number };
    P4_COMPOSE: { ms: number; batches: number };
  };
  spans: {
    p1_grid?: MetricsSpan;
    p1_block_features?: MetricsSpan;
    p2_tile_analyze?: MetricsSpan;
    p2_index_build?: MetricsSpan;
    p3_match_batch?: MetricsSpan;
    p4_compose_batch?: MetricsSpan;
  };
  memory: { wasmHeapBytes: number; tilesBytes: number };
  config: { block_size: number; w_c: number; w_d: number; alpha: number; row_batch: number };
}

/**
 * コアの論理 API。
 * M2 で setMainImage / getBlockMeanColors の実処理(P1)を WASM で行う。
 * M3 でタイル系(addTile/removeTile/clearTiles)を追加した(P2)。
 * M4 で一括生成(run)と設定(getConfig/setConfig)を追加した(P3+P4)。
 */
export interface CoreBridge {
  /** コアのバージョン文字列。UI とコアの不整合検知に使用する */
  getVersion(): Promise<string>;
  /** メイン画像を設定し、グリッド・ブロック特徴量を計算して全体ブロック数を返す(P1) */
  setMainImage(image: RgbaImage): Promise<GridInfo>;
  /** ブロックサイズを変更し、グリッドを再計算する(P1 再実行) */
  setBlockSize(px: number): Promise<GridInfo>;
  /**
   * コア算出のブロック平均色を返す(P1 の特徴量から逆変換)。
   * RGB 3 バイト × ブロック数、行優先(index = row * cols + col)。
   * メイン画像未設定時は空の配列を返す。
   */
  getBlockMeanColors(): Uint8Array;
  /**
   * タイル 1 枚を解析してプールへ登録する(P2)。
   * feature は特徴量用サムネイル(32×32、ボックスフィルタ縮小済み)、
   * compose は合成用サムネイル(長辺 64 上限)。id 重複時は置き換える。
   * メモリガード超過時は例外を投げる(プールは変更されない)。
   */
  addTile(id: bigint, feature: RgbaImage, compose: RgbaImage): Promise<TileInfo>;
  /** プールからタイルを削除する(存在しない id は例外) */
  removeTile(id: bigint): Promise<void>;
  /** タイルプールを空にする(リセット。コア内の合成用サムネイルを解放) */
  clearTiles(): void;
  /** 登録済みタイル数 */
  getTileCount(): number;
  /** 合成用サムネイルの合計バイト数(メモリガードの監視値) */
  getTilesMemoryBytes(): number;
  /** メイン画像の状態を破棄する(リセット。コア内の大容量バッファを開放) */
  clearMainImage(): void;
  /**
   * マッチング(P3)+ 合成(P4)を実行する(M5)。
   * 処理は行バッチ単位で進み、バッチ境界ごとに UI へ制御を返したうえで
   * 進捗(onProgress)と部分結果(onResult)を発火する。
   * メイン画像未設定・タイルプール空の場合は例外。完了後 exportImage で
   * 合成結果を取得できる。全ブロックを再マッチする(usage も正規化)
   */
  run(): Promise<void>;
  /**
   * 差分再マッチ(M6: 詳細設計書 4.4 差分再マッチ)。
   * 現在の割当表に対して未確定ブロックのマッチ・差し替え評価(improve_margin)を
   * 行い、再マッチしたブロック行のみを再合成する(既存の合成結果は保持)。
   * 進捗・部分結果の発火規則は run と同一。run 未実行(割当表が空)の場合は
   * 全ブロックをマッチする(run と等価)
   */
  rematch(): Promise<void>;
  /** 実行中の生成処理をキャンセルする(バッチ境界で停止。現時点までの合成結果は保持) */
  cancel(): void;
  /** 現在の設定パラメータを取得する(詳細設計書 5 章) */
  getConfig(): Promise<MosaicConfig>;
  /** 設定パラメータを上書きする(範囲外は例外) */
  setConfig(config: MosaicConfig): Promise<void>;
  /** 完成画像(または現時点までの合成結果)の RGBA を取得する(P5 のエンコード前段) */
  exportImage(): Promise<RgbaImage>;
  /**
   * コアの計測結果(JSON)を取得する(M7: handoff/05 §4 getMetrics)。
   * run 実行履歴の直近 16 分を返す。モック実装では null(計測なし)
   */
  getMetrics(): Promise<MetricsRun[]>;
  /** 進捗イベント受け取り登録(スロットリングはコアが行う。詳細設計書 7.2) */
  onProgress(callback: ProgressCallback): void;
  /** 部分結果(行バッチ単位の合成済み行)受け取り登録(詳細設計書 7.4) */
  onResult(callback: ResultCallback): void;
}
