/**
 * Worker 内のコアを呼び出すメインスレッド側ブリッジ。
 *
 * `CoreBridge` と同じ API を提供し、同期取得系(getBlockMeanColors /
 * getTileCount / getTilesMemoryBytes)は Worker 応答時のキャッシュを返す。
 * 進捗は Worker から postMessage で届くが、UI は不定進捗を表示する。
 */
import type {
  CoreBridge,
  GridInfo,
  MetricsRun,
  MosaicConfig,
  ProgressCallback,
  ResultCallback,
  RgbaImage,
  TileInfo,
} from './types';
import type {
  WorkerAddTileResult,
  WorkerEventMessage,
  WorkerExportImageResult,
  WorkerInitResult,
  WorkerMainImageResult,
  WorkerMethod,
  WorkerRequest,
  WorkerResponse,
  WorkerTileStatsResult,
} from './workerProtocol';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** Worker コアのメインスレッド側プロキシ */
export class WorkerCoreBridge implements CoreBridge {
  readonly progressMode = 'indeterminate' as const;

  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly progressListeners = new Set<ProgressCallback>();
  private readonly resultListeners = new Set<ResultCallback>();
  private nextId = 1;
  private version = '';
  private blockMeanColors: Uint8Array = new Uint8Array(0);
  private tileCount = 0;
  private tilesMemoryBytes = 0;

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = (event: MessageEvent<WorkerResponse | WorkerEventMessage>) => {
      this.handleMessage(event.data);
    };
    this.worker.onerror = (event: ErrorEvent) => {
      this.rejectAll(new Error(event.message || 'core worker error'));
    };
    this.worker.onmessageerror = () => {
      this.rejectAll(new Error('core worker message error'));
    };
  }

  /** Worker を初期化する。初期化に失敗した場合は reject する */
  async init(): Promise<void> {
    const result = await this.request<WorkerInitResult>({
      type: 'init',
      id: this.nextId++,
    });
    this.version = result.version;
  }

  async getVersion(): Promise<string> {
    if (this.version !== '') {
      return this.version;
    }
    const version = await this.call<string>('getVersion', []);
    this.version = version;
    return version;
  }

  async setMainImage(image: RgbaImage): Promise<GridInfo> {
    const result = await this.call<WorkerMainImageResult>(
      'setMainImage',
      [image],
      [image.data.buffer],
    );
    this.blockMeanColors = result.blockMeanColors;
    return result.grid;
  }

  async setBlockSize(px: number): Promise<GridInfo> {
    const result = await this.call<WorkerMainImageResult>('setBlockSize', [px]);
    this.blockMeanColors = result.blockMeanColors;
    return result.grid;
  }

  getBlockMeanColors(): Uint8Array {
    return this.blockMeanColors;
  }

  async addTile(id: bigint, feature: RgbaImage, compose: RgbaImage): Promise<TileInfo> {
    const result = await this.call<WorkerAddTileResult>(
      'addTile',
      [id, feature, compose],
      [feature.data.buffer, compose.data.buffer],
    );
    this.tileCount = result.tileCount;
    this.tilesMemoryBytes = result.tilesMemoryBytes;
    return result.info;
  }

  async removeTile(id: bigint): Promise<void> {
    const result = await this.call<WorkerTileStatsResult>('removeTile', [id]);
    this.tileCount = result.tileCount;
    this.tilesMemoryBytes = result.tilesMemoryBytes;
  }

  clearTiles(): void {
    void this.call<WorkerTileStatsResult>('clearTiles', [])
      .then((result) => {
        this.tileCount = result.tileCount;
        this.tilesMemoryBytes = result.tilesMemoryBytes;
      })
      .catch((err: unknown) => {
        console.warn('worker clearTiles failed', err);
      });
  }

  getTileCount(): number {
    return this.tileCount;
  }

  getTilesMemoryBytes(): number {
    return this.tilesMemoryBytes;
  }

  clearMainImage(): void {
    void this.call('clearMainImage', [])
      .then(() => {
        this.blockMeanColors = new Uint8Array(0);
      })
      .catch((err: unknown) => {
        console.warn('worker clearMainImage failed', err);
      });
  }

  async run(): Promise<void> {
    await this.call('run', []);
  }

  async rematch(): Promise<void> {
    await this.call('rematch', []);
  }

  cancel(): void {
    void this.call('cancel', []).catch((err: unknown) => {
      console.warn('worker cancel failed', err);
    });
  }

  async getConfig(): Promise<MosaicConfig> {
    return this.call<MosaicConfig>('getConfig', []);
  }

  async setConfig(config: MosaicConfig): Promise<void> {
    await this.call('setConfig', [config]);
  }

  async exportImage(): Promise<RgbaImage> {
    const result = await this.call<WorkerExportImageResult>('exportImage', []);
    return result.image;
  }

  async getMetrics(): Promise<MetricsRun[]> {
    return this.call<MetricsRun[]>('getMetrics', []);
  }

  onProgress(callback: ProgressCallback): void {
    this.progressListeners.add(callback);
  }

  onResult(callback: ResultCallback): void {
    this.resultListeners.add(callback);
  }

  private call<T>(method: WorkerMethod, args: unknown[], transfer?: Transferable[]): Promise<T> {
    return this.request<T>(
      {
        type: 'call',
        id: this.nextId++,
        method,
        args,
      },
      transfer,
    );
  }

  private request<T>(message: WorkerRequest, transfer?: Transferable[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(message.id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        // 同一 ArrayBuffer を複数回 transfer すると DataCloneError になるため重複を除く
        this.worker.postMessage(message, transfer ? [...new Set(transfer)] : []);
      } catch (err) {
        this.pending.delete(message.id);
        reject(err);
      }
    });
  }

  private handleMessage(message: WorkerResponse | WorkerEventMessage): void {
    if (message.type === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error));
      }
      return;
    }

    if (message.type === 'progress') {
      for (const listener of this.progressListeners) {
        listener(message.event);
      }
      return;
    }

    for (const listener of this.resultListeners) {
      listener(message.batch);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export type WorkerCoreKind = 'wasm' | 'js';

/** Worker を生成してコアブリッジを初期化する */
export async function createWorkerCoreBridge(kind: WorkerCoreKind): Promise<CoreBridge> {
  const worker =
    kind === 'wasm'
      ? new Worker(new URL('./wasm.worker.ts', import.meta.url), { type: 'module' })
      : new Worker(new URL('./js.worker.ts', import.meta.url), { type: 'module' });
  const bridge = new WorkerCoreBridge(worker);
  try {
    await bridge.init();
    return bridge;
  } catch (err) {
    worker.terminate();
    throw err;
  }
}
