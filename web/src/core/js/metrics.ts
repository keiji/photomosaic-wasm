/**
 * 性能計測の TypeScript 実装(M7: handoff/05 性能の計測設計)。
 *
 * Rust コア(core/src/metrics.rs と core-wasm の MetricsSession)の移植。
 * 計測は処理結果に影響しない。スパンはバッチ境界・フェーズ境界のみで記録する。
 */
import type { MetricsRun, MetricsSpan, MosaicConfig } from '../types';

/** 現在時刻をミリ秒で返す(単調時計。無い環境では Date.now) */
export function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** 単一スパン ID の累積統計 */
export class SpanAgg {
  count = 0;
  totalMs = 0;
  maxMs = 0;

  /** 1 回分のスパン時間を累積する(負値・非有限値は無視する) */
  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      return;
    }
    this.count += 1;
    this.totalMs += ms;
    this.maxMs = Math.max(this.maxMs, ms);
  }

  /** 平均時間(回数 0 は 0) */
  avgMs(): number {
    return this.count === 0 ? 0 : this.totalMs / this.count;
  }
}

/** run 開始前の P1/P2 蓄積(begin 時に run レコードへ引き取る) */
export interface PendingP1P2 {
  p1GridMs: number;
  p1BlockFeaturesMs: number;
  p2TileAnalyze: SpanAgg;
  p2TileCount: number;
}

/** 1 回の run(P3 + P4)のメトリクス */
export interface RunRecord {
  runId: number;
  trigger: string;
  startedAtMs: number;
  p1GridMs: number;
  p1BlockFeaturesMs: number;
  p2TileAnalyzeMs: number;
  p2TileMaxMs: number;
  p2TileAvgMs: number;
  p2Tiles: number;
  p2IndexBuild: SpanAgg;
  p3MatchBatch: SpanAgg;
  p3MatchTotalMs: number;
  p4ComposeBatch: SpanAgg;
  p4ComposeTotalMs: number;
  tilesBytes: number;
  blockSizePx: number;
  wC: number;
  wD: number;
  usagePenalty: number;
  neighborPenalty: number;
  neighborDe: number;
  duplicateDe: number;
  duplicateDetail: number;
  mainBlend: number;
  colorCorrect: number;
  rowBatch: number;
}

/** run 内のスパン計測結果(完了・キャンセル時に取り出す) */
export interface RunSpans {
  p3MatchBatch: SpanAgg;
  p4ComposeBatch: SpanAgg;
}

/** 直近 16 run にロールオーバする計測セッション */
export class MetricsSession {
  readonly pending: PendingP1P2 = {
    p1GridMs: 0,
    p1BlockFeaturesMs: 0,
    p2TileAnalyze: new SpanAgg(),
    p2TileCount: 0,
  };
  trigger: string | null = null;
  activeRecord: RunRecord | null = null;
  private nextRunId = 0;
  private readonly runs: RunRecord[] = [];

  private static readonly MAX_RUN_RECORDS = 16;

  recordP1Grid(ms: number): void {
    this.pending.p1GridMs += ms;
  }

  recordP1BlockFeatures(ms: number): void {
    this.pending.p1BlockFeaturesMs += ms;
  }

  recordP2Tile(ms: number): void {
    this.pending.p2TileAnalyze.record(ms);
    this.pending.p2TileCount += 1;
  }

  markTrigger(trigger: string): void {
    this.trigger = trigger;
  }

  /** run の開始を記録する(P1/P2 の蓄積を引き取ったうえで新規レコード) */
  beginRunRecord(blockSizePx: number, config: MosaicConfig, tilesBytes: number): void {
    const trigger = this.trigger;
    const pendingGridMs = this.pending.p1GridMs;
    const pendingBlockFeaturesMs = this.pending.p1BlockFeaturesMs;
    const pendingTileAnalyze = this.pending.p2TileAnalyze;
    const pendingTileCount = this.pending.p2TileCount;
    this.trigger = null;
    this.pending.p1GridMs = 0;
    this.pending.p1BlockFeaturesMs = 0;
    this.pending.p2TileAnalyze = new SpanAgg();
    this.pending.p2TileCount = 0;
    this.nextRunId += 1;
    this.activeRecord = {
      runId: this.nextRunId,
      trigger: trigger ?? 'rematch',
      startedAtMs: nowMs(),
      p1GridMs: pendingGridMs,
      p1BlockFeaturesMs: pendingBlockFeaturesMs,
      p2TileAnalyzeMs: pendingTileAnalyze.totalMs,
      p2TileMaxMs: pendingTileAnalyze.maxMs,
      p2TileAvgMs: pendingTileAnalyze.avgMs(),
      p2Tiles: pendingTileCount,
      p2IndexBuild: new SpanAgg(),
      p3MatchBatch: new SpanAgg(),
      p3MatchTotalMs: 0,
      p4ComposeBatch: new SpanAgg(),
      p4ComposeTotalMs: 0,
      tilesBytes,
      blockSizePx,
      wC: config.w_c,
      wD: config.w_d,
      usagePenalty: config.usage_penalty,
      neighborPenalty: config.neighbor_penalty,
      neighborDe: config.neighbor_de,
      duplicateDe: config.duplicate_de,
      duplicateDetail: config.duplicate_detail,
      mainBlend: config.main_blend,
      colorCorrect: config.color_correct,
      rowBatch: config.row_batch,
    };
  }

  /** run の完了(またはキャンセル)で確定値を履歴へ追加する */
  finishRunRecord(spans: RunSpans, poolStats: SpanAgg, tilesBytes: number): void {
    const record = this.activeRecord;
    if (!record) {
      return;
    }
    this.activeRecord = null;
    record.p3MatchBatch = spans.p3MatchBatch;
    record.p3MatchTotalMs = spans.p3MatchBatch.totalMs;
    record.p4ComposeBatch = spans.p4ComposeBatch;
    record.p4ComposeTotalMs = spans.p4ComposeBatch.totalMs;
    record.p2IndexBuild = poolStats;
    record.tilesBytes = tilesBytes;
    while (this.runs.length >= MetricsSession.MAX_RUN_RECORDS) {
      this.runs.shift();
    }
    this.runs.push(record);
  }

  /** UI 型(MetricsRun[])へ変換して返す */
  toMetricsRuns(): MetricsRun[] {
    return this.runs.map((run) => {
      const spans: MetricsRun['spans'] = {};
      if (run.p1GridMs > 0) {
        spans.p1_grid = span(run.p1GridMs, run.p1GridMs, 1);
      }
      if (run.p1BlockFeaturesMs > 0) {
        spans.p1_block_features = span(run.p1BlockFeaturesMs, run.p1BlockFeaturesMs, 1);
      }
      if (run.p2Tiles > 0) {
        spans.p2_tile_analyze = span(run.p2TileAvgMs, run.p2TileMaxMs, run.p2Tiles);
      }
      if (run.p2IndexBuild.count > 0) {
        spans.p2_index_build = span(
          run.p2IndexBuild.avgMs(),
          run.p2IndexBuild.maxMs,
          run.p2IndexBuild.count,
        );
      }
      if (run.p3MatchBatch.count > 0) {
        spans.p3_match_batch = span(
          run.p3MatchBatch.avgMs(),
          run.p3MatchBatch.maxMs,
          run.p3MatchBatch.count,
        );
      }
      if (run.p4ComposeBatch.count > 0) {
        spans.p4_compose_batch = span(
          run.p4ComposeBatch.avgMs(),
          run.p4ComposeBatch.maxMs,
          run.p4ComposeBatch.count,
        );
      }
      return {
        runId: run.runId,
        trigger: run.trigger,
        startedAtMs: run.startedAtMs,
        phases: {
          P1_MAIN_ANALYZE: { ms: run.p1GridMs + run.p1BlockFeaturesMs },
          P2_TILE_ANALYZE: { ms: run.p2TileAnalyzeMs, tiles: run.p2Tiles },
          P3_MATCH: { ms: run.p3MatchTotalMs, batches: run.p3MatchBatch.count },
          P4_COMPOSE: { ms: run.p4ComposeTotalMs, batches: run.p4ComposeBatch.count },
        },
        spans,
        memory: { wasmHeapBytes: 0, tilesBytes: run.tilesBytes },
        config: {
          block_size: run.blockSizePx,
          w_c: run.wC,
          w_d: run.wD,
          alpha: run.colorCorrect,
          row_batch: run.rowBatch,
        },
      };
    });
  }
}

function span(avgMs: number, maxMs: number, count: number): MetricsSpan {
  return { count, avgMs, maxMs };
}
