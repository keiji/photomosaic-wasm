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
 * コアの論理 API。
 * M0 で使用するのはメイン画像の設定・ブロックサイズ変更・エクスポートのみ。
 * タイル系(addTile/removeTile)と進捗系(onProgress/onResult/run/cancel)は
 * M3/M5 のマイルストーンでインターフェースに追加する。
 */
export interface CoreBridge {
  /** コアのバージョン文字列。UI とコアの不整合検知に使用する */
  getVersion(): Promise<string>;
  /** メイン画像を設定し、グリッド・ブロック特徴量を計算して全体ブロック数を返す(P1) */
  setMainImage(image: RgbaImage): Promise<GridInfo>;
  /** ブロックサイズを変更し、グリッドを再計算する(P1 再実行) */
  setBlockSize(px: number): Promise<GridInfo>;
  /** 完成画像(または現時点までの合成結果)の RGBA を取得する(P5 のエンコード前段) */
  exportImage(): Promise<RgbaImage>;
}
