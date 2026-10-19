/**
 * フェーズ制御・行バッチ実行の TypeScript 実装(詳細設計書 4.1 / 4.4 / 7 章 / 8.1)。
 *
 * Rust コア(core/src/pipeline.rs)の移植。P3(マッチング)と P4(合成)を
 * 行バッチ単位で進め、バッチ境界で進捗イベントと部分結果を返す。
 */
import type { GridInfo, MosaicConfig, ResultBatch } from '../types';
import { composeRows } from './compose';
import type { BlockFeature } from './grid';
import { evaluateSwapRange, matchUnmatchedRange, type MatchResult } from './matchEngine';
import { nowMs, SpanAgg, type RunSpans } from './metrics';
import { PhasePlan, ProgressThrottle, type Phase, type ProgressEvent } from './progress';
import type { TilePool } from './tilePool';

/** マッチングの実行モード */
export type MatchMode = 'full' | 'fill_unmatched' | 'swap_evaluate';

/** `BatchRunState.step()` 1 バッチ分の結果 */
export interface Step {
  progress: ProgressEvent | null;
  result: ResultBatch | null;
  done: boolean;
}

type RunPhase = 'matching' | 'composing';

/** 行バッチで駆動する実行状態 */
export class BatchRunState {
  private readonly grid: GridInfo;
  private readonly features: BlockFeature[];
  private assigned: Array<bigint | null>;
  private readonly mode: MatchMode;
  private matchNextBlock = 0;
  private assignedCount: number;
  private readonly dirtyBlockRows: boolean[];
  private composeDirtyRows: number[] = [];
  private composedDirtyRows = 0;
  private composeCursor = 0;
  private phase: RunPhase = 'matching';
  private readonly plan = new PhasePlan(['match', 'compose']);
  private readonly throttle = new ProgressThrottle();
  private readonly out: Uint8ClampedArray<ArrayBuffer>;
  private readonly spans: RunSpans = {
    p3MatchBatch: new SpanAgg(),
    p4ComposeBatch: new SpanAgg(),
  };
  private canceled = false;
  private done = false;

  constructor(
    grid: GridInfo,
    blockFeatures: readonly BlockFeature[],
    assigned: Array<bigint | null>,
    seedRgba: Uint8Array | Uint8ClampedArray,
    mode: MatchMode,
  ) {
    const size = grid.width * grid.height * 4;
    if (seedRgba.length !== size) {
      throw new Error('seed rgba buffer length mismatch');
    }
    if (assigned.length !== grid.totalBlocks) {
      throw new Error('assignment table length mismatch');
    }
    this.grid = grid;
    this.features = blockFeatures.slice();
    this.assigned = assigned.slice();
    this.mode = mode;
    this.assignedCount = assigned.reduce(
      (count, slot) => count + (slot === null || slot === undefined ? 0 : 1),
      0,
    );
    this.dirtyBlockRows = new Array(grid.rows).fill(false);
    if (mode === 'full') {
      this.dirtyBlockRows.fill(true);
    }
    this.out = new Uint8ClampedArray(seedRgba);
  }

  /** フルマッチの実行状態を生成する */
  static createFull(
    grid: GridInfo,
    blockFeatures: readonly BlockFeature[],
    seedRgba: Uint8Array | Uint8ClampedArray,
  ): BatchRunState {
    return new BatchRunState(
      grid,
      blockFeatures,
      new Array<bigint | null>(grid.totalBlocks).fill(null),
      seedRgba,
      'full',
    );
  }

  isDone(): boolean {
    return this.done;
  }

  isCanceled(): boolean {
    return this.canceled;
  }

  takeOutput(): Uint8ClampedArray<ArrayBuffer> | null {
    if (!this.done) {
      return null;
    }
    return this.out;
  }

  takeAssignments(): Array<bigint | null> {
    return this.assigned;
  }

  takeSpans(): RunSpans {
    return {
      p3MatchBatch: this.spans.p3MatchBatch,
      p4ComposeBatch: this.spans.p4ComposeBatch,
    };
  }

  cancel(): void {
    this.canceled = true;
    this.done = true;
  }

  step(
    pool: TilePool,
    config: MosaicConfig,
    nowMsValue: number | null,
    mainRgba?: Uint8Array | Uint8ClampedArray,
  ): Step {
    if (this.done) {
      return { progress: null, result: null, done: true };
    }
    if (this.phase === 'matching') {
      return this.stepMatch(pool, config, nowMsValue);
    }
    return this.stepCompose(pool, config, nowMsValue, mainRgba);
  }

  private stepMatch(pool: TilePool, config: MosaicConfig, nowMsValue: number | null): Step {
    if (pool.tileCount() === 0) {
      this.done = true;
      return { progress: null, result: null, done: true };
    }
    const cols = this.grid.cols;
    const total = this.grid.totalBlocks;
    const batchBlocks = Math.max(config.row_batch, 1) * cols;
    const blockBegin = Math.min(this.matchNextBlock, total);
    const blockEnd = Math.min(blockBegin + batchBlocks, total);
    const spanStart = nowMs();

    if (this.mode === 'full' || this.mode === 'fill_unmatched') {
      const matched = matchUnmatchedRange(
        this.features,
        cols,
        pool,
        config,
        this.assigned,
        blockBegin,
        blockEnd,
      );
      this.assignedCount += matched.length;
      for (const position of matched) {
        const row = Math.floor(position / cols);
        this.dirtyBlockRows[row] = true;
      }
    } else {
      const swapped = evaluateSwapRange(
        this.features,
        cols,
        pool,
        config,
        this.assigned,
        blockBegin,
        blockEnd,
      );
      for (const position of swapped) {
        const row = Math.floor(position / cols);
        this.dirtyBlockRows[row] = true;
      }
    }
    this.matchNextBlock = blockEnd;
    this.spans.p3MatchBatch.record(nowMs() - spanStart);

    const progress = this.emit(
      'match',
      this.assignedCount / this.grid.totalBlocks,
      this.assignedCount,
      nowMsValue,
      false,
    );
    if (blockEnd >= total) {
      this.composeDirtyRows = [];
      for (let row = 0; row < this.dirtyBlockRows.length; row++) {
        if (this.dirtyBlockRows[row]) {
          this.composeDirtyRows.push(row);
        }
      }
      this.composedDirtyRows = 0;
      this.composeCursor = 0;
      this.phase = 'composing';
    }
    return { progress, result: null, done: false };
  }

  private stepCompose(
    pool: TilePool,
    config: MosaicConfig,
    nowMsValue: number | null,
    mainRgba?: Uint8Array | Uint8ClampedArray,
  ): Step {
    const batch = Math.max(config.row_batch, 1);
    const totalDirty = this.composeDirtyRows.length;
    const range = this.nextDirtyRange(batch);
    if (!range) {
      this.done = true;
      const progress = this.emit('compose', 1.0, this.grid.totalBlocks, nowMsValue, true);
      return { progress, result: null, done: true };
    }
    const [begin, end] = range;
    const spanStart = nowMs();
    composeRows(
      this.out,
      this.grid,
      this.features,
      this.assigned,
      pool,
      config,
      mainRgba,
      begin,
      end,
    );
    this.spans.p4ComposeBatch.record(nowMs() - spanStart);
    this.composedDirtyRows += end - begin;

    const width = this.grid.width;
    const blockSize = this.grid.blockSize;
    const sliceBegin = Math.min(begin * blockSize * width * 4, this.out.length);
    const sliceEnd = Math.min(end * blockSize * width * 4, this.out.length);
    const result: ResultBatch = {
      blockRowBegin: begin,
      blockRowEnd: end,
      width,
      blockSize,
      rgba: new Uint8Array(this.out.subarray(sliceBegin, sliceEnd)),
    };

    const finalStep = this.composeCursor >= totalDirty;
    const progress = this.emit(
      'compose',
      this.composedDirtyRows / totalDirty,
      this.grid.totalBlocks,
      nowMsValue,
      finalStep,
    );
    if (finalStep) {
      this.done = true;
    }
    return { progress, result, done: this.done };
  }

  private nextDirtyRange(maxRows: number): [number, number] | null {
    const start = this.composeDirtyRows[this.composeCursor];
    if (start === undefined) {
      return null;
    }
    let end = start + 1;
    let taken = 1;
    this.composeCursor += 1;
    while (this.composeCursor < this.composeDirtyRows.length && taken < maxRows) {
      const next = this.composeDirtyRows[this.composeCursor] as number;
      if (next === end) {
        end += 1;
        taken += 1;
        this.composeCursor += 1;
      } else {
        break;
      }
    }
    return [start, end];
  }

  private emit(
    phase: Phase,
    phaseRatio: number,
    assignedBlocks: number,
    nowMsValue: number | null,
    force: boolean,
  ): ProgressEvent | null {
    const overall = this.plan.overallRatio(phase, phaseRatio);
    const fire = force || (nowMsValue !== null && this.throttle.shouldEmit(nowMsValue, overall));
    if (force) {
      this.throttle.shouldEmit(nowMsValue ?? 0.0, overall);
    }
    if (!fire) {
      return null;
    }
    return {
      phaseCode: phase,
      phaseRatio,
      overallRatio: overall,
      assignedBlocks,
      totalBlocks: this.grid.totalBlocks,
    };
  }
}

/** 割当表からマッチ結果を組み立てる(未確定ブロックは除外) */
export function assignmentsToMatches(assigned: ReadonlyArray<bigint | null>): MatchResult[] {
  const matches: MatchResult[] = [];
  for (let i = 0; i < assigned.length; i++) {
    const tileId = assigned[i];
    if (tileId !== null && tileId !== undefined) {
      matches.push({ blockIndex: i, tileId });
    }
  }
  return matches;
}
