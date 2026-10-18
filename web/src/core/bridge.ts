/**
 * コア呼び出しラッパ。
 *
 * handoff/04 M5: 行バッチ駆動の生成処理(P3 マッチング + P4 合成)を
 * WASM 経由で行う。
 * - wasm-pack 生成物(web/src/wasm/)を動的ロードする(ロードは 1 回のみ)
 * - ロードに失敗した環境ではモックへフォールバックする(UI 開発をブロックしない)
 * - コアの状態(メイン画像・ブロック特徴量)は WASM 内に保持される
 * - begin_run / step_run をバッチ境界ごとに呼び出し、進捗(onProgress)と
 *   部分結果(onResult)をホストに届け、キャンセル(cancel)はバッチ境界で止める
 */
import { createMockCore } from './mockCore';
import type {
  CoreBridge,
  GridInfo,
  MosaicConfig,
  ProgressCallback,
  ProgressEvent,
  ResultBatch,
  ResultCallback,
  TileInfo,
} from './types';

/** コア実装の種類(デバッグ表示用) */
export type CoreImplementation = 'mock' | 'wasm';

let currentImplementation: CoreImplementation = 'mock';

export function getCoreImplementation(): CoreImplementation {
  return currentImplementation;
}

/** wasm-bindgen の JsGridInfo を型付き GridInfo へ写す(寿命管理のため free する) */
function toGridInfo(info: {
  free(): void;
  readonly width: number;
  readonly height: number;
  readonly block_size: number;
  readonly cols: number;
  readonly rows: number;
  readonly total_blocks: number;
}): GridInfo {
  const grid: GridInfo = {
    width: info.width,
    height: info.height,
    blockSize: info.block_size,
    cols: info.cols,
    rows: info.rows,
    totalBlocks: info.total_blocks,
  };
  info.free();
  return grid;
}

/** wasm-bindgen の JsTileInfo を型付き TileInfo へ写す(寿命管理のため free する) */
function toTileInfo(info: {
  free(): void;
  readonly id: bigint;
  readonly thumb_w: number;
  readonly thumb_h: number;
  readonly mean_lab: Float32Array;
  readonly detail: number;
  readonly usage: number;
}): TileInfo {
  const tile: TileInfo = {
    id: info.id,
    thumbWidth: info.thumb_w,
    thumbHeight: info.thumb_h,
    // mean_lab はコアの [f32; 3] 固定(詳細設計書 3 章)なので 3 要素は常に存在する
    meanLab: [info.mean_lab[0] as number, info.mean_lab[1] as number, info.mean_lab[2] as number],
    detail: info.detail,
    usage: info.usage,
  };
  info.free();
  return tile;
}

/** WASM 実装をロードして構築する(失敗時は例外を投げ、呼び出し側でモックへフォールバック) */
async function createWasmCore(): Promise<CoreBridge> {
  const wasm = await import('../wasm/photomosaic_core_wasm.js');
  await wasm.default();
  // 初期化が済んだことを往復サンプルで確認する(handoff/02 検収基準)
  wasm.add(1, 1);

  // 直近のグリッド情報(exportImage の寸法に使用。コア内状態のミラー)
  let lastGrid: GridInfo | null = null;

  const progressListeners = new Set<ProgressCallback>();
  const emit = (event: ProgressEvent): void => {
    for (const listener of progressListeners) {
      listener(event);
    }
  };

  const resultListeners = new Set<ResultCallback>();
  const emitResult = (batch: ResultBatch): void => {
    for (const listener of resultListeners) {
      listener(batch);
    }
  };

  /**
   * 進行中の行バッチ駆動ループ(1 run につき 1 つのハンドル)。
   * cancel() はこのハンドルを介して stepping の継続を止める。
   * コア(WASM)は 1 バッチを同期的に処理してバッチ境界で JS へ制御を返す
   * (詳細設計書 8.1)
   */
  let activeRun: { canceled: boolean } | null = null;

  /**
   * 行バッチ境界で UI に制御を返す。
   * requestAnimationFrame がある環境では描画に合わせて次バッチを再開し、
   * それ以外(非描画環境)では macrotask 次点で再開する(詳細設計書 8.1)
   */
  const scheduleNextBatch = (callback: () => void): void => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => callback());
    } else {
      setTimeout(callback, 16);
    }
  };

  /**
   * begin で開始した行バッチ駆動ループ(M5 run / M6 rematch の共通駆動)。
   * 各バッチで進捗(onProgress)と部分結果(onResult)を発火する。
   * cancel() 呼び出しでバッチ境界の継続を止める
   */
  const driveRun = (begin: () => void): Promise<void> => {
    begin();
    const handle = { canceled: false };
    // 同一 run のハンドルのみ解除する(先の run の後始末が後発の
    // run のハンドルを誤って消すのを防ぐ: 要求の合流の連続操作)
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
        let out: Awaited<ReturnType<typeof wasm.step_run>>;
        try {
          out = wasm.step_run(performance.now());
        } catch (err) {
          if (activeRun === handle) {
            activeRun = null;
          }
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        try {
          const progress = out.progress;
          if (progress) {
            emit({
              phaseCode: progress.phase_code,
              phaseRatio: progress.phase_ratio,
              overallRatio: progress.overall_ratio,
              assignedBlocks: progress.assigned_blocks,
              totalBlocks: progress.total_blocks,
            });
            progress.free();
          }
          const result = out.result;
          if (result) {
            emitResult({
              blockRowBegin: result.row_begin,
              blockRowEnd: result.row_end,
              blockSize: result.block_size,
              width: result.width,
              // rgba は wasm-bindgen がコピーした新規バッファ。
              // 部分描画で転写するため参照先はここでは保持しない
              rgba: result.rgba,
            });
            result.free();
          }
          const done = out.done;
          out.free();
          if (done) {
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
        // バッチ境界で JS へ制御を返す(詳細設計書 8.1)
        scheduleNextBatch(drive);
      };
      drive();
    });
  };

  return {
    async getVersion(): Promise<string> {
      return wasm.get_version();
    },

    async setMainImage(image): Promise<GridInfo> {
      // Vec<u8> 引数への転送は wasm-bindgen がコピー 1 回で行う(handoff/02 2.4)
      const rgba = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
      const info = wasm.set_main_image(rgba, image.width, image.height);
      lastGrid = toGridInfo(info);
      return lastGrid;
    },

    async setBlockSize(px): Promise<GridInfo> {
      const info = wasm.set_block_size(px);
      lastGrid = toGridInfo(info);
      return lastGrid;
    },

    getBlockMeanColors(): Uint8Array {
      return wasm.get_block_mean_colors();
    },

    async addTile(id: bigint, feature, compose): Promise<TileInfo> {
      // Vec<u8> 引数への転送は wasm-bindgen がコピー 1 回で行う(handoff/02 2.4)
      const featureBytes = new Uint8Array(
        feature.data.buffer,
        feature.data.byteOffset,
        feature.data.byteLength,
      );
      const composeBytes = new Uint8Array(
        compose.data.buffer,
        compose.data.byteOffset,
        compose.data.byteLength,
      );
      const info = wasm.add_tile(id, featureBytes, composeBytes, compose.width, compose.height);
      return toTileInfo(info);
    },

    async removeTile(id: bigint): Promise<void> {
      wasm.remove_tile(id);
    },

    clearTiles(): void {
      wasm.clear_tiles();
    },

    getTileCount(): number {
      return wasm.get_tile_count();
    },

    getTilesMemoryBytes(): number {
      return wasm.get_tiles_memory_bytes();
    },

    clearMainImage(): void {
      wasm.clear_main_image();
      lastGrid = null;
    },

    async run(): Promise<void> {
      // 行バッチ駆動ループ(M5): 1 バッチごとに UI に制御を返し、
      // 進捗(onProgress)と部分結果(onResult)を届ける。
      // cancel() 呼び出しでバッチ境界の継続を止める
      return driveRun(() => wasm.begin_run());
    },

    async rematch(): Promise<void> {
      // 差分再マッチ(M6: 詳細設計書 4.4): 未確定ブロックのマッチ・
      // 差し替え評価(improve_margin)を行い、再マッチした行のみ再合成する。
      // 駆動と進捗・部分結果の発火は run と共通(driveRun)
      return driveRun(() => wasm.begin_rematch());
    },

    cancel(): void {
      if (activeRun === null) {
        return;
      }
      activeRun.canceled = true;
      activeRun = null;
      // コア側もキャンセル状態にしておく(次のバッチを禁止する)。
      // 既存のマッチ結果・現時点までの合成結果は保持される(詳細設計書 7.5)
      wasm.cancel();
    },

    async getConfig(): Promise<MosaicConfig> {
      return JSON.parse(wasm.get_config());
    },

    async setConfig(config: MosaicConfig): Promise<void> {
      wasm.set_config(JSON.stringify(config));
    },

    async exportImage(): Promise<import('./types').RgbaImage> {
      // run 済みならコアが P4 合成結果を、未実行ならメイン画像を返す
      if (!lastGrid) {
        throw new Error('main image is not set');
      }
      const rgba = wasm.export_main_image();
      // Uint8Array(ArrayBufferLike)から型付きバッファへ複製する(エクスポートは低頻度)
      const data = new Uint8ClampedArray(rgba.length);
      data.set(rgba);
      return { width: lastGrid.width, height: lastGrid.height, data };
    },

    onProgress(callback: ProgressCallback): void {
      progressListeners.add(callback);
    },

    onResult(callback: ResultCallback): void {
      resultListeners.add(callback);
    },
  };
}

/** WASM 初期化の結果をキャッシュする(1 回だけ試行。失敗時はモックへフォールバック) */
let wasmInit: Promise<CoreBridge> | null = null;

/**
 * コアブリッジを生成する。
 * WASM のロードに成功したら実装('wasm')を返し、失敗したらモック('mock')に
 * フォールバックする。実装の種類は getCoreImplementation() で確認できる。
 */
export async function createCoreBridge(): Promise<CoreBridge> {
  if (wasmInit === null) {
    wasmInit = createWasmCore()
      .then((core) => {
        currentImplementation = 'wasm';
        return core;
      })
      .catch((err: unknown) => {
        console.warn('WASM core failed to load, falling back to mock core', err);
        currentImplementation = 'mock';
        wasmInit = null; // 次回の呼び出しで再試行できるようにする
        return createMockCore();
      });
  }
  return wasmInit;
}
