/**
 * Worker 内のコア実行ランタイム。
 *
 * - Worker 初期化時にコアを生成し、進捗・部分結果をメインスレッドへ送る
 * - コア API 呼び出しを RPC として処理する
 * - 画像バッファは transferable として送受信する
 * - バッチ間は setTimeout(0) で Worker のイベントループへ制御を返す。
 *   メインスレッドの rAF は使わないため、UI はブロックされない。
 */
import type { CoreBridge, MosaicConfig, RgbaImage } from './types';
import type {
  WorkerAddTileResult,
  WorkerCallRequest,
  WorkerEventMessage,
  WorkerExportImageResult,
  WorkerInitRequest,
  WorkerMainImageResult,
  WorkerRequest,
  WorkerResponse,
  WorkerTileStatsResult,
} from './workerProtocol';

/** Worker 側でコアに渡すスケジューラ設定 */
export interface WorkerCoreOptions {
  scheduleNextBatch: (callback: () => void) => void;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse | WorkerEventMessage, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

/** 画像ビューのバッファを transferable として返す(SharedArrayBuffer は対象外) */
function transferableBuffer(view: { buffer: ArrayBufferLike }): Transferable[] {
  return view.buffer instanceof ArrayBuffer ? [view.buffer] : [];
}

/** コア API 呼び出しを実行し、応答と transferable を返す */
async function dispatch(
  core: CoreBridge,
  request: WorkerCallRequest,
): Promise<{ result: unknown; transfer?: Transferable[] }> {
  const { method, args } = request;
  switch (method) {
    case 'getVersion':
      return { result: await core.getVersion() };

    case 'setMainImage': {
      const image = args[0] as RgbaImage;
      const grid = await core.setMainImage(image);
      const blockMeanColors = core.getBlockMeanColors();
      const result: WorkerMainImageResult = { grid, blockMeanColors };
      return { result, transfer: transferableBuffer(blockMeanColors) };
    }

    case 'setBlockSize': {
      const grid = await core.setBlockSize(args[0] as number);
      const blockMeanColors = core.getBlockMeanColors();
      const result: WorkerMainImageResult = { grid, blockMeanColors };
      return { result, transfer: transferableBuffer(blockMeanColors) };
    }

    case 'addTile': {
      const info = await core.addTile(
        args[0] as bigint,
        args[1] as RgbaImage,
        args[2] as RgbaImage,
      );
      const result: WorkerAddTileResult = {
        info,
        tileCount: core.getTileCount(),
        tilesMemoryBytes: core.getTilesMemoryBytes(),
      };
      return { result };
    }

    case 'removeTile': {
      await core.removeTile(args[0] as bigint);
      const result: WorkerTileStatsResult = {
        tileCount: core.getTileCount(),
        tilesMemoryBytes: core.getTilesMemoryBytes(),
      };
      return { result };
    }

    case 'clearTiles': {
      core.clearTiles();
      const result: WorkerTileStatsResult = {
        tileCount: core.getTileCount(),
        tilesMemoryBytes: core.getTilesMemoryBytes(),
      };
      return { result };
    }

    case 'clearMainImage':
      core.clearMainImage();
      return { result: undefined };

    case 'run':
      await core.run();
      return { result: undefined };

    case 'rematch':
      await core.rematch();
      return { result: undefined };

    case 'cancel':
      core.cancel();
      return { result: undefined };

    case 'getConfig':
      return { result: await core.getConfig() };

    case 'setConfig':
      await core.setConfig(args[0] as MosaicConfig);
      return { result: undefined };

    case 'exportImage': {
      const image = await core.exportImage();
      const result: WorkerExportImageResult = { image };
      return { result, transfer: transferableBuffer(image.data) };
    }

    case 'getMetrics':
      return { result: await core.getMetrics() };
  }
}

/** Worker を開始する。コア生成関数は Worker エントリごとに注入する */
export function startWorker(createCore: (options: WorkerCoreOptions) => Promise<CoreBridge>): void {
  let core: CoreBridge | null = null;

  const respond = (id: number, result?: unknown, transfer?: Transferable[]): void => {
    scope.postMessage({ type: 'response', id, ok: true, result }, transfer);
  };

  const fail = (id: number, err: unknown): void => {
    scope.postMessage({
      type: 'response',
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  };

  scope.onmessage = (event: MessageEvent<WorkerRequest>): void => {
    const request = event.data;
    void (async () => {
      if (request.type === 'init') {
        try {
          core = await createCore({
            // rAF は使わず、Worker のイベントループへ制御を返す。
            // これによりキャンセル要求と進捗メッセージを処理できる。
            scheduleNextBatch: (callback) => setTimeout(callback, 0),
          });
          core.onProgress((progress) => {
            scope.postMessage({ type: 'progress', event: progress });
          });
          core.onResult((batch) => {
            scope.postMessage({ type: 'result', batch }, transferableBuffer(batch.rgba));
          });
          respond((request as WorkerInitRequest).id, {
            version: await core.getVersion(),
          });
        } catch (err) {
          fail((request as WorkerInitRequest).id, err);
        }
        return;
      }

      if (!core) {
        fail(request.id, new Error('core is not initialized'));
        return;
      }
      try {
        const { result, transfer } = await dispatch(core, request);
        respond(request.id, result, transfer);
      } catch (err) {
        fail(request.id, err);
      }
    })();
  };
}
