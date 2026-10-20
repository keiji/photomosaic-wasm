/**
 * 純 TypeScript コア実装(WASM を使わない比較用)。
 *
 * `CoreBridge` と同じ論理 API を提供する。アルゴリズムは Rust コア
 * (core/src/*.rs)を TypeScript へ移植したもので、グリッド計算・ブロック特徴量・
 * タイル解析・k-d 木マッチング・合成・行バッチ進捗・メトリクスを同等に扱う。
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
import { labToSrgb8 } from './js/color';
import { computeBlockFeatures, computeGridInfo, DEFAULT_BLOCK_SIZE } from './js/grid';
import type { BlockFeature } from './js/grid';
import { BatchRunState } from './js/pipeline';
import { MetricsSession } from './js/metrics';
import { TilePool } from './js/tilePool';

/** 既定の設定パラメータ(詳細設計書 5 章) */
function defaultConfig(): MosaicConfig {
  return {
    w_c: 1.0,
    w_d: 0.25,
    usage_penalty: 0.35,
    neighbor_penalty: 0.5,
    neighbor_de: 8.0,
    identical_de: 2.0,
    improve_margin: 1.0,
    duplicate_de: 2.0,
    duplicate_detail: 4.0,
    usage_cap: 1,
    no_reuse: true,
    color_correct: 0.85,
    main_blend: 0.2,
    row_batch: 8,
  };
}

interface MainImageState {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  grid: GridInfo;
  features: BlockFeature[];
  /** 現在の割当表(空 = 未確定。フルラン後に全ブロック分) */
  assigned: Array<bigint | null>;
  /** 現在の割当表の計算後にタイルが追加されたか(差し替え評価の要否) */
  tilesAddedSinceMatch: boolean;
  /** P4 合成結果 */
  composed: Uint8ClampedArray<ArrayBuffer> | null;
  /** 進行中の行バッチ実行 */
  run: BatchRunState | null;
}

function validateConfig(config: MosaicConfig): void {
  const finiteInRange = (value: number, min: number, max: number, field: string): void => {
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`config field '${field}' must be in ${min}..=${max}`);
    }
  };
  const nonNegativeInteger = (value: number, field: string): void => {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new Error(`config field '${field}' must be a non-negative integer`);
    }
  };
  finiteInRange(config.w_c, 0.5, 2.0, 'w_c');
  finiteInRange(config.w_d, 0.0, 1.0, 'w_d');
  finiteInRange(config.usage_penalty, 0.0, 1.0, 'usage_penalty');
  finiteInRange(config.neighbor_penalty, 0.0, 1.0, 'neighbor_penalty');
  finiteInRange(config.neighbor_de, 2.0, 16.0, 'neighbor_de');
  if (!Number.isFinite(config.identical_de) || config.identical_de <= 0) {
    throw new Error("config field 'identical_de' must be a positive number");
  }
  finiteInRange(config.improve_margin, 0.5, 2.0, 'improve_margin');
  finiteInRange(config.duplicate_de, 0.5, 8.0, 'duplicate_de');
  finiteInRange(config.duplicate_detail, 0.0, 32.0, 'duplicate_detail');
  nonNegativeInteger(config.usage_cap, 'usage_cap');
  if (typeof config.no_reuse !== 'boolean') {
    throw new Error("config field 'no_reuse' must be a boolean");
  }
  finiteInRange(config.color_correct, 0.0, 1.0, 'color_correct');
  finiteInRange(config.main_blend, 0.0, 0.8, 'main_blend');
  if (!Number.isInteger(config.row_batch) || config.row_batch < 4 || config.row_batch > 32) {
    throw new Error("config field 'row_batch' must be in 4..=32");
  }
}

/** UI スレッドへ制御を返す(描画環境では rAF、非描画環境では macrotask) */
function defaultScheduleNextBatch(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => callback());
  } else {
    setTimeout(callback, 16);
  }
}

/** 行バッチ間のスケジューラ設定(Worker では setTimeout(0) を注入する) */
export interface JsCoreOptions {
  scheduleNextBatch?: (callback: () => void) => void;
}

/** 純 TypeScript コアを生成する */
export function createJsCore(options: JsCoreOptions = {}): CoreBridge {
  const schedule = options.scheduleNextBatch ?? defaultScheduleNextBatch;
  let main: MainImageState | null = null;
  const pool = new TilePool();
  let config = defaultConfig();
  const metrics = new MetricsSession();

  const progressListeners = new Set<ProgressCallback>();
  const resultListeners = new Set<ResultCallback>();

  const emitProgress = (event: ProgressEvent): void => {
    for (const listener of progressListeners) {
      listener(event);
    }
  };

  const emitResult = (batch: ResultBatch): void => {
    for (const listener of resultListeners) {
      listener(batch);
    }
  };

  let activeRun: { canceled: boolean } | null = null;

  const finishRun = (run: BatchRunState): void => {
    const out = run.takeOutput();
    if (main && out !== null) {
      main.composed = out;
    }
    if (main) {
      main.assigned = run.takeAssignments();
      pool.recountUsage(main.assigned);
    }
    metrics.finishRunRecord(run.takeSpans(), pool.indexBuildStats(), pool.totalComposeBytes());
  };

  const stepInternal = (
    nowMsValue: number,
  ): { progress: ProgressEvent | null; result: ResultBatch | null; done: boolean } => {
    if (!main) {
      throw new Error('main image is not set');
    }
    const run = main.run;
    if (!run) {
      throw new Error('run is not started');
    }
    const step = run.step(pool, config, nowMsValue, main.rgba);
    if (step.done) {
      finishRun(run);
      main.run = null;
    }
    return {
      progress: step.progress,
      result: step.result,
      done: step.done,
    };
  };

  const cancelInternal = (): void => {
    if (!main) {
      return;
    }
    const run = main.run;
    if (!run) {
      return;
    }
    run.cancel();
    finishRun(run);
    main.run = null;
  };

  const beginRun = (): void => {
    if (!main) {
      throw new Error('main image is not set');
    }
    if (pool.tileCount() === 0) {
      throw new Error('tile pool is empty');
    }
    pool.resetUsage();
    main.composed = null;
    main.tilesAddedSinceMatch = false;
    main.assigned = [];
    main.run = BatchRunState.createFull(main.grid, main.features, main.rgba);
    metrics.beginRunRecord(main.grid.blockSize, config, pool.totalComposeBytes());
  };

  const beginRematch = (): void => {
    if (!main) {
      throw new Error('main image is not set');
    }
    if (pool.tileCount() === 0) {
      throw new Error('tile pool is empty');
    }

    const totalBlocks = main.grid.totalBlocks;
    let mode: 'full' | 'fill_unmatched' | 'swap_evaluate';
    let rematchNeeded: boolean;
    let assigned: Array<bigint | null>;

    if (main.assigned.length === 0) {
      pool.resetUsage();
      mode = 'full';
      rematchNeeded = true;
      assigned = new Array<bigint | null>(totalBlocks).fill(null);
    } else if (main.assigned.some((slot) => slot === null || slot === undefined)) {
      mode = 'fill_unmatched';
      rematchNeeded = true;
      assigned = main.assigned;
      main.assigned = [];
    } else if (main.tilesAddedSinceMatch) {
      mode = 'swap_evaluate';
      rematchNeeded = true;
      assigned = main.assigned;
      main.assigned = [];
    } else {
      mode = 'fill_unmatched';
      rematchNeeded = false;
      assigned = main.assigned;
      main.assigned = [];
    }
    main.tilesAddedSinceMatch = false;
    if (rematchNeeded) {
      pool.recountUsage(assigned);
    }

    const seed = main.composed ?? main.rgba;
    main.composed = null;
    main.run = new BatchRunState(main.grid, main.features, assigned, seed, mode);
    metrics.beginRunRecord(main.grid.blockSize, config, pool.totalComposeBytes());
  };

  const driveRun = (begin: () => void): Promise<void> => {
    begin();
    const handle = { canceled: false };
    activeRun = handle;
    return new Promise<void>((resolve, reject) => {
      const drive = (): void => {
        if (handle.canceled) {
          if (activeRun === handle) {
            activeRun = null;
          }
          resolve();
          return;
        }
        let out: { progress: ProgressEvent | null; result: ResultBatch | null; done: boolean };
        try {
          out = stepInternal(performance.now());
        } catch (err) {
          if (activeRun === handle) {
            activeRun = null;
          }
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        try {
          if (out.progress) {
            emitProgress(out.progress);
          }
          if (out.result) {
            emitResult(out.result);
          }
          if (out.done) {
            if (activeRun === handle) {
              activeRun = null;
            }
            resolve();
            return;
          }
        } catch (err) {
          if (activeRun === handle) {
            activeRun = null;
          }
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        schedule(drive);
      };
      drive();
    });
  };

  return {
    progressMode: 'determinate' as const,
    async getVersion(): Promise<string> {
      return 'photomosaic-core-js 0.1.0';
    },

    async setMainImage(image: RgbaImage): Promise<GridInfo> {
      if (image.data.length !== image.width * image.height * 4) {
        throw new Error('rgba buffer length mismatch');
      }
      const t0 = performance.now();
      const grid = computeGridInfo(image.width, image.height, DEFAULT_BLOCK_SIZE);
      const gridMs = performance.now() - t0;
      const t1 = performance.now();
      const features = computeBlockFeatures(
        image.data,
        image.width,
        image.height,
        DEFAULT_BLOCK_SIZE,
      );
      const featuresMs = performance.now() - t1;
      metrics.recordP1Grid(gridMs);
      metrics.recordP1BlockFeatures(featuresMs);
      metrics.markTrigger('initial');
      main = {
        rgba: image.data,
        grid,
        features,
        assigned: [],
        tilesAddedSinceMatch: false,
        composed: null,
        run: null,
      };
      return grid;
    },

    async setBlockSize(px: number): Promise<GridInfo> {
      if (px <= 0) {
        throw new Error('block size must be positive');
      }
      if (!main) {
        throw new Error('main image is not set');
      }
      const width = main.grid.width;
      const height = main.grid.height;
      const t0 = performance.now();
      const grid = computeGridInfo(width, height, px);
      const gridMs = performance.now() - t0;
      const t1 = performance.now();
      const features = computeBlockFeatures(main.rgba, width, height, px);
      const featuresMs = performance.now() - t1;
      metrics.recordP1Grid(gridMs);
      metrics.recordP1BlockFeatures(featuresMs);
      metrics.markTrigger('block_size_change');
      main.grid = grid;
      main.features = features;
      main.assigned = [];
      main.tilesAddedSinceMatch = false;
      main.composed = null;
      main.run = null;
      return grid;
    },

    getBlockMeanColors(): Uint8Array {
      if (!main) {
        return new Uint8Array(0);
      }
      const colors = new Uint8Array(main.features.length * 3);
      for (let i = 0; i < main.features.length; i++) {
        const feature = main.features[i] as BlockFeature;
        const [r, g, b] = labToSrgb8(feature.meanLab[0], feature.meanLab[1], feature.meanLab[2]);
        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      }
      return colors;
    },

    async addTile(id: bigint, feature: RgbaImage, compose: RgbaImage): Promise<TileInfo> {
      const t0 = performance.now();
      const info = pool.addTile(id, feature.data, compose.data, compose.width, compose.height);
      if (main) {
        main.tilesAddedSinceMatch = true;
      }
      metrics.recordP2Tile(performance.now() - t0);
      metrics.markTrigger('tile_added');
      return {
        id: info.id,
        thumbWidth: info.thumbW,
        thumbHeight: info.thumbH,
        meanLab: [info.meanLab[0], info.meanLab[1], info.meanLab[2]],
        detail: info.detail,
        usage: info.usage,
      };
    },

    async removeTile(id: bigint): Promise<void> {
      pool.removeTile(id);
      if (main) {
        for (let i = 0; i < main.assigned.length; i++) {
          if (main.assigned[i] === id) {
            main.assigned[i] = null;
          }
        }
      }
      metrics.markTrigger('tile_removed');
    },

    clearTiles(): void {
      pool.clear();
    },

    getTileCount(): number {
      return pool.tileCount();
    },

    getTilesMemoryBytes(): number {
      return pool.totalComposeBytes();
    },

    clearMainImage(): void {
      main = null;
    },

    async run(): Promise<void> {
      return driveRun(beginRun);
    },

    async rematch(): Promise<void> {
      return driveRun(beginRematch);
    },

    cancel(): void {
      if (activeRun === null) {
        return;
      }
      activeRun.canceled = true;
      activeRun = null;
      cancelInternal();
    },

    async getConfig(): Promise<MosaicConfig> {
      return { ...config };
    },

    async setConfig(next: MosaicConfig): Promise<void> {
      validateConfig(next);
      config = { ...next };
    },

    async exportImage(): Promise<RgbaImage> {
      if (!main) {
        throw new Error('main image is not set');
      }
      const data = main.composed ?? main.rgba;
      return {
        width: main.grid.width,
        height: main.grid.height,
        data: new Uint8ClampedArray(data),
      };
    },

    async getMetrics(): Promise<MetricsRun[]> {
      return metrics.toMetricsRuns();
    },

    onProgress(callback: ProgressCallback): void {
      progressListeners.add(callback);
    },

    onResult(callback: ResultCallback): void {
      resultListeners.add(callback);
    },
  };
}
