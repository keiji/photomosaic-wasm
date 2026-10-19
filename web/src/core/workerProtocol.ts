/**
 * Web Worker とメインスレッド間の RPC プロトコル。
 *
 * コアを Worker 内で実行し、メインスレッドは UI だけを担当する。
 * 画像バッファは transferable として送受信し、コピーを避ける。
 */
import type {
  GridInfo,
  MetricsRun,
  MosaicConfig,
  ProgressEvent,
  ResultBatch,
  RgbaImage,
  TileInfo,
} from './types';

/** Worker が受け付けるコア API メソッド(同期取得系はメイン側でキャッシュする) */
export type WorkerMethod =
  | 'getVersion'
  | 'setMainImage'
  | 'setBlockSize'
  | 'addTile'
  | 'removeTile'
  | 'clearTiles'
  | 'clearMainImage'
  | 'run'
  | 'rematch'
  | 'cancel'
  | 'getConfig'
  | 'setConfig'
  | 'exportImage'
  | 'getMetrics';

/** Worker 初期化要求 */
export interface WorkerInitRequest {
  type: 'init';
  id: number;
}

/** コア API 呼び出し要求 */
export interface WorkerCallRequest {
  type: 'call';
  id: number;
  method: WorkerMethod;
  args: unknown[];
}

export type WorkerRequest = WorkerInitRequest | WorkerCallRequest;

/** 初期化結果 */
export interface WorkerInitResult {
  version: string;
}

/** 成功応答 */
export interface WorkerSuccessResponse {
  type: 'response';
  id: number;
  ok: true;
  result?: unknown;
}

/** 失敗応答 */
export interface WorkerErrorResponse {
  type: 'response';
  id: number;
  ok: false;
  error: string;
}

export type WorkerResponse = WorkerSuccessResponse | WorkerErrorResponse;

/** 進捗イベント通知 */
export interface WorkerProgressMessage {
  type: 'progress';
  event: ProgressEvent;
}

/** 部分結果通知 */
export interface WorkerResultMessage {
  type: 'result';
  batch: ResultBatch;
}

export type WorkerEventMessage = WorkerProgressMessage | WorkerResultMessage;

/** setMainImage / setBlockSize の結果 */
export interface WorkerMainImageResult {
  grid: GridInfo;
  blockMeanColors: Uint8Array;
}

/** addTile の結果 */
export interface WorkerAddTileResult {
  info: TileInfo;
  tileCount: number;
  tilesMemoryBytes: number;
}

/** removeTile / clearTiles の結果 */
export interface WorkerTileStatsResult {
  tileCount: number;
  tilesMemoryBytes: number;
}

/** exportImage の結果 */
export interface WorkerExportImageResult {
  image: RgbaImage;
}

/** getConfig / setConfig の結果 */
export type WorkerConfigResult = MosaicConfig;

/** getMetrics の結果 */
export type WorkerMetricsResult = MetricsRun[];

/** Worker へ渡す設定・引数の型をまとめた補助型 */
export type WorkerSetConfigArgs = [MosaicConfig];
