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
 * コアの論理 API。
 * M2 で setMainImage / getBlockMeanColors の実処理(P1)を WASM で行う。
 * M3 でタイル系(addTile/removeTile/clearTiles)を追加した(P2)。
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
  /** 完成画像(または現時点までの合成結果)の RGBA を取得する(P5 のエンコード前段) */
  exportImage(): Promise<RgbaImage>;
  /** 進捗イベント受け取り登録(M5 でコア駆動の発火に置き換わる) */
  onProgress(callback: ProgressCallback): void;
  /**
   * 進捗デモ(M1 検証用): ダミー処理を 16ms 間隔のバッチに区切り、
   * コアのスロットル規則(16ms / 1%)に従って進捗イベントを発火する。
   * M5 で実物の進捗(onResult / cancel 付き)に置き換わる。
   */
  runProgressDemo(durationMs?: number): Promise<void>;
}
