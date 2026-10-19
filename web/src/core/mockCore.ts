/**
 * モックコア実装。
 *
 * handoff/04 のモック方針: コア未完成の間は同じ論理 API を持つ TypeScript モックで
 * UI 開発を進める。グリッド計算のみを実装し、平均色の算出(CIELAB/線形 RGB 平均)は
 * M2 でコア(Rust)に置き換わる。
 *
 * M1 以降は WASM 実装のフォールバックとしても使う(bridge.ts が差し替える)。
 */
import type {
  CoreBridge,
  GridInfo,
  MetricsRun,
  MosaicConfig,
  ProgressCallback,
  ProgressEvent,
  ResultBatch,
  ResultCallback,
  RgbaImage,
  TileInfo,
} from './types';

/** ブロックサイズの既定値(詳細設計書 5 章 block_size) */
export const DEFAULT_BLOCK_SIZE = 24;

/** モックのメモリガード上限(詳細設計書 5 章 memory_guard に合わせる) */
const MOCK_MEMORY_GUARD_BYTES = 512 * 1024 * 1024;

/** モックの行バッチ単位(詳細設計書 5 章 row_batch の既定値) */
const MOCK_ROW_BATCH = 8;

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
  const resultListeners = new Set<ResultCallback>();
  /** 進行中の run(キャンセルはバッチ境界で効く。M5 の WASM 実装と同一規則) */
  let activeRun: { canceled: boolean } | null = null;
  let runStartedAt = 0;
  // 設定パラメータ(M4): 既定値を保持し、setConfig で差し替える
  let config: MosaicConfig = {
    w_c: 1.0,
    w_d: 0.25,
    usage_penalty: 0.35,
    neighbor_penalty: 0.5,
    identical_de: 2.0,
    improve_margin: 1.0,
    usage_cap: 4,
    color_correct: 0.7,
    row_batch: 8,
  };

  // --- タイルプール(M3): 特徴量は WASM 実装の簡易版(sRGB 単純平均) ---
  interface MockTile {
    info: TileInfo;
    compose: RgbaImage;
  }
  const tiles = new Map<bigint, MockTile>();
  let tilesMemoryBytes = 0;

  const emit = (event: ProgressEvent): void => {
    for (const listener of progressListeners) {
      listener(event);
    }
  };

  const emitResult = (batch: ResultBatch): void => {
    for (const listener of resultListeners) {
      listener(batch);
    }
  };

  /** バッチ境界ごとの待機(UI への制御返し。詳細設計書 8.1 のモック版) */
  const nextBatch = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 16));

  /**
   * ダミーの生成実行(run / rematch 共通)。
   * メイン画像・タイルの有無を検証したうえで、行バッチ単位の進捗・部分結果
   * (メイン画像の行コピー)を発火し、cancel() はバッチ境界で止める
   */
  const simulateRun = async (): Promise<void> => {
    if (!mainImage) {
      throw new Error('main image is not set');
    }
    if (tiles.size === 0) {
      throw new Error('tile pool is empty');
    }
    const grid = computeGrid(mainImage.width, mainImage.height, currentBlockSize);
    const throttle = new DemoThrottle();
    const handle = { canceled: false };
    activeRun = handle;
    runStartedAt = performance.now();

    const totalBlocks = grid.totalBlocks;
    // P3 マッチング: 行バッチ単位で進捗を発火(16ms / 1% 規則を模倣)
    for (let matched = 0; matched < grid.rows; matched += MOCK_ROW_BATCH) {
      const assignedRows = Math.min(matched + MOCK_ROW_BATCH, grid.rows);
      if (handle.canceled) {
        activeRun = null;
        return;
      }
      const ratio = assignedRows / grid.rows;
      const nowMs = performance.now() - runStartedAt;
      if (throttle.shouldEmit(nowMs, ratio)) {
        emit({
          phaseCode: 'match',
          phaseRatio: ratio,
          overallRatio: ratio,
          assignedBlocks: assignedRows * grid.cols,
          totalBlocks,
        });
      }
      await nextBatch();
    }
    // P4 合成: 行バッチごとに部分結果(メイン画像の行コピー)を発火
    for (let rowBegin = 0; rowBegin < grid.rows; rowBegin += MOCK_ROW_BATCH) {
      if (handle.canceled) {
        activeRun = null;
        return;
      }
      const rowEnd = Math.min(rowBegin + MOCK_ROW_BATCH, grid.rows);
      const pixelBegin = rowBegin * grid.blockSize;
      const pixelEnd = Math.min(rowEnd * grid.blockSize, mainImage.height);
      const bytesPerRow = mainImage.width * 4;
      const rgba = new Uint8Array(
        mainImage.data.buffer.slice(pixelBegin * bytesPerRow, pixelEnd * bytesPerRow),
      );
      emitResult({
        blockRowBegin: rowBegin,
        blockRowEnd: rowEnd,
        blockSize: grid.blockSize,
        width: grid.width,
        rgba,
      });
      const ratio = rowEnd / grid.rows;
      if (throttle.shouldEmit(performance.now() - runStartedAt, ratio)) {
        emit({
          phaseCode: 'compose',
          phaseRatio: ratio,
          overallRatio: ratio,
          assignedBlocks: totalBlocks,
          totalBlocks,
        });
      }
      await nextBatch();
    }
    activeRun = null;
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

    getBlockMeanColors(): Uint8Array {
      if (!mainImage) {
        return new Uint8Array(0);
      } // モック簡易実装: sRGB の単純平均(WASM 実装では線形平均 → CIELAB → 逆変換)
      const grid = computeGrid(mainImage.width, mainImage.height, currentBlockSize);
      const colors = new Uint8Array(grid.totalBlocks * 3);
      for (let row = 0; row < grid.rows; row++) {
        for (let col = 0; col < grid.cols; col++) {
          const x0 = col * grid.blockSize;
          const y0 = row * grid.blockSize;
          const bw = Math.min(grid.blockSize, mainImage.width - x0);
          const bh = Math.min(grid.blockSize, mainImage.height - y0);
          let sumR = 0;
          let sumG = 0;
          let sumB = 0;
          for (let y = y0; y < y0 + bh; y++) {
            let offset = (y * mainImage.width + x0) * 4;
            for (let x = 0; x < bw; x++) {
              sumR += mainImage.data[offset] as number;
              sumG += mainImage.data[offset + 1] as number;
              sumB += mainImage.data[offset + 2] as number;
              offset += 4;
            }
          }
          const count = bw * bh;
          const out = (row * grid.cols + col) * 3;
          colors[out] = Math.round(sumR / count);
          colors[out + 1] = Math.round(sumG / count);
          colors[out + 2] = Math.round(sumB / count);
        }
      }
      return colors;
    },

    clearMainImage(): void {
      mainImage = null;
    },

    async run(): Promise<void> {
      // モックではモザイク合成を行わず、行バッチ単位の進捗・部分結果
      // (メイン画像の行コピー)を発火する(コア実装環境での UI 遷移
      // GENERATING → DONE と進捗表示・部分描画の確認用のダミー)。
      // 差分再マッチ(M6)のリマッチ/差し替えはモックでは区別せず同一のダミー
      return simulateRun();
    },

    async rematch(): Promise<void> {
      // 差分再マッチ(M6)のダミー: run と同一の進捗・部分結果を発火する。
      // (モックに割当表の概念はないため、未確定ブロックのみの部分合成は模倣しない)
      return simulateRun();
    },

    cancel(): void {
      if (activeRun === null) {
        return;
      }
      activeRun.canceled = true;
      activeRun = null;
    },

    async getConfig(): Promise<MosaicConfig> {
      return { ...config };
    },

    async getMetrics(): Promise<MetricsRun[]> {
      // モックには計測概念がないため空履歴を返す(オーバーレイは非表示のまま)
      return [];
    },
    async setConfig(next: MosaicConfig): Promise<void> {
      config = { ...next };
    },

    async addTile(id: bigint, feature: RgbaImage, compose: RgbaImage): Promise<TileInfo> {
      // 簡易特徴量: sRGB 単純平均(WASM 実装では線形平均 → CIELAB)
      const pixelCount = feature.width * feature.height;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      for (let offset = 0; offset < pixelCount * 4; offset += 4) {
        sumR += feature.data[offset] as number;
        sumG += feature.data[offset + 1] as number;
        sumB += feature.data[offset + 2] as number;
      }
      const meanR = sumR / pixelCount;
      const meanG = sumG / pixelCount;
      const meanB = sumB / pixelCount;

      // 簡易 detail: 最大/最小輝度(0..255)差を L* スケール(0..128)へ粗く写像
      let minLum = 255;
      let maxLum = 0;
      for (let offset = 0; offset < pixelCount * 4; offset += 4) {
        const lum =
          0.299 * (feature.data[offset] as number) +
          0.587 * (feature.data[offset + 1] as number) +
          0.114 * (feature.data[offset + 2] as number);
        minLum = Math.min(minLum, lum);
        maxLum = Math.max(maxLum, lum);
      }

      const composeBytes = compose.width * compose.height * 4;
      const existing = tiles.get(id);
      const nextBytes =
        tilesMemoryBytes - (existing ? existing.compose.data.byteLength : 0) + composeBytes;
      if (nextBytes > MOCK_MEMORY_GUARD_BYTES) {
        throw new Error('memory guard exceeded');
      }

      const info: TileInfo = {
        id,
        thumbWidth: compose.width,
        thumbHeight: compose.height,
        meanLab: [meanR, meanG, meanB], // モック簡易実装: 線形 Lab 変換はしない
        detail: ((maxLum - minLum) / 255) * 128,
        usage: 0,
      };
      tiles.set(id, { info, compose });
      tilesMemoryBytes = nextBytes;
      return info;
    },

    async removeTile(id: bigint): Promise<void> {
      const existing = tiles.get(id);
      if (!existing) {
        throw new Error(`unknown tile id: ${id}`);
      }
      tilesMemoryBytes -= existing.compose.data.byteLength;
      tiles.delete(id);
    },

    clearTiles(): void {
      tiles.clear();
      tilesMemoryBytes = 0;
    },

    getTileCount(): number {
      return tiles.size;
    },

    getTilesMemoryBytes(): number {
      return tilesMemoryBytes;
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

    onResult(callback: ResultCallback): void {
      resultListeners.add(callback);
    },
  };
}
