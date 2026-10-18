/**
 * モックコア実装。
 *
 * handoff/04 のモック方針: コア未完成の間は同じ論理 API を持つ TypeScript モックで
 * UI 開発を進める。グリッド計算のみを実装し、平均色の算出(CIELAB/線形 RGB 平均)は
 * M2 でコア(Rust)に置き換わる。
 *
 * M1 以降は WASM 実装のフォールバックとしても使う(bridge.ts が差し替える)。
 */
import type { CoreBridge, GridInfo, ProgressCallback, ProgressEvent, RgbaImage } from './types';

/** ブロックサイズの既定値(詳細設計書 5 章 block_size) */
export const DEFAULT_BLOCK_SIZE = 24;

/** 進捗デモのダミー総ブロック数(見た目の確認用) */
export const PROGRESS_DEMO_TOTAL_BLOCKS = 1000;

/**
 * モック簡易版の overall_ratio。フェーズ内進捗をそのまま使う
 * (WASM 実装では core の PhasePlan による固定配分・正規化が適用される)。
 */
function toOverallRatio(ratio: number): number {
  return ratio;
}

/**
 * TS 側スロットラー(詳細設計書 7.2 と同じ規則: 16ms 以上の経過または 1% 以上の変化)。
 * モックでも本物と同じ規則を守らせるための簡易実装。
 */
class DemoThrottle {
  private lastMs: number | null = null;
  private lastRatio: number | null = null;

  shouldEmit(nowMs: number, ratio: number): boolean {
    if (this.lastMs === null || this.lastRatio === null) {
      this.lastMs = nowMs;
      this.lastRatio = ratio;
      return true;
    }
    const timeOk = nowMs - this.lastMs >= 16;
    const deltaOk = Math.abs(ratio - this.lastRatio) >= 0.01;
    if (timeOk || deltaOk) {
      this.lastMs = nowMs;
      this.lastRatio = ratio;
      return true;
    }
    return false;
  }
}

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
  const progressListeners = new Set<ProgressCallback>();
  let demoTimer: ReturnType<typeof setInterval> | null = null;

  const emit = (event: ProgressEvent): void => {
    for (const listener of progressListeners) {
      listener(event);
    }
  };

  return {
    async getVersion(): Promise<string> {
      return 'mock-core 0.1.0 (non-WASM fallback)';
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

    onProgress(callback: ProgressCallback): void {
      progressListeners.add(callback);
    },

    runProgressDemo(durationMs = 1000): Promise<void> {
      if (demoTimer !== null) {
        return Promise.resolve(); // 二重起動は無視
      }
      const throttle = new DemoThrottle();
      const totalBlocks = PROGRESS_DEMO_TOTAL_BLOCKS;
      const start = performance.now();
      return new Promise<void>((resolve) => {
        // 16ms 間隔のバッチ境界を模したタイマー(JS がコアの tick を駆動する形。
        // M5 で「コアがバッチ境界で JS を呼ぶ」本実装に置き換わる)
        const step = (): void => {
          const elapsed = performance.now() - start;
          const ratio = Math.min(1, elapsed / durationMs);
          if (throttle.shouldEmit(elapsed, ratio)) {
            emit({
              phaseCode: 'match',
              phaseRatio: ratio,
              overallRatio: toOverallRatio(ratio),
              assignedBlocks: Math.round(ratio * totalBlocks),
              totalBlocks,
            });
          }
          if (ratio >= 1) {
            if (demoTimer !== null) {
              clearInterval(demoTimer);
              demoTimer = null;
            }
            resolve();
          }
        };
        step(); // 開始時点(0%)を即時に通知する
        demoTimer = setInterval(step, 16);
      });
    },
  };
}
