/**
 * モックコア実装。
 *
 * handoff/04(M0)の方針: コア未完成の間は同じ論理 API を持つ TypeScript モックで
 * UI 開発を進める。グリッド計算のみを実装し、平均色の算出(CIELAB/線形 RGB 平均)は
 * M2 でコア(Rust)に置き換わる。
 */
import type { CoreBridge, GridInfo, RgbaImage } from './types';

/** ブロックサイズの既定値(詳細設計書 5 章 block_size) */
export const DEFAULT_BLOCK_SIZE = 24;

/**
 * グリッド計算(詳細設計書 4.2)。
 * cols = ceil(w / block_size), rows = ceil(h / block_size)。
 * 右端・下端は半端サイズのブロックになり得る。
 */
export function computeGrid(width: number, height: number, blockSize: number): GridInfo {
  if (width <= 0 || height <= 0) {
    throw new Error('image size must be positive');
  }
  if (blockSize <= 0) {
    throw new Error('block size must be positive');
  }
  const cols = Math.ceil(width / blockSize);
  const rows = Math.ceil(height / blockSize);
  return {
    width,
    height,
    blockSize,
    cols,
    rows,
    totalBlocks: cols * rows,
  };
}

/**
 * モックコアを生成する。
 * exportImage はエクスポート経路の動作確認用にメイン画像をそのまま返す
 * (フォトモザイク合成はコア実装後に置き換わる)。
 */
export function createMockCore(): CoreBridge {
  let mainImage: RgbaImage | null = null;
  let currentBlockSize = DEFAULT_BLOCK_SIZE;

  return {
    async getVersion(): Promise<string> {
      return 'mock-core 0.1.0 (M0, non-WASM)';
    },

    async setMainImage(image: RgbaImage): Promise<GridInfo> {
      mainImage = image;
      return computeGrid(image.width, image.height, currentBlockSize);
    },

    async setBlockSize(px: number): Promise<GridInfo> {
      if (!mainImage) {
        throw new Error('main image is not set');
      }
      currentBlockSize = px;
      return computeGrid(mainImage.width, mainImage.height, px);
    },

    async exportImage(): Promise<RgbaImage> {
      if (!mainImage) {
        throw new Error('main image is not set');
      }
      // メタデータを引き継がないこと(基本設計書 3.4)は、
      // ピクセルバッファから再エンコードする本経路によって構造的に保証される
      return mainImage;
    },
  };
}
