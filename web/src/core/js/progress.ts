/**
 * 進捗イベント・スロットリングの TypeScript 実装(詳細設計書 7 章)。
 *
 * Rust コア(core/src/progress.rs)の移植。イベント発火は
 * 「16ms 以上の経過」または「overall_ratio が 1% 以上の変化」のとき。
 */

/** 処理の大区分(詳細設計書 4.1 / 7.1) */
export type Phase = 'main_analyze' | 'tile_analyze' | 'match' | 'compose';

/** フェーズの固定配分(重み)。P1 10% / P2 20% / P3 55% / P4 15% */
export function phaseWeight(phase: Phase): number {
  switch (phase) {
    case 'main_analyze':
      return 0.1;
    case 'tile_analyze':
      return 0.2;
    case 'match':
      return 0.55;
    case 'compose':
      return 0.15;
  }
}

/** 進捗イベント(詳細設計書 3 章 ProgressEvent) */
export interface ProgressEvent {
  phaseCode: Phase;
  phaseRatio: number;
  overallRatio: number;
  assignedBlocks: number;
  totalBlocks: number;
}

/** 実行に含まれるフェーズの列 */
export class PhasePlan {
  private readonly phases: Phase[];

  constructor(phases: Phase[]) {
    const order: Phase[] = ['main_analyze', 'tile_analyze', 'match', 'compose'];
    this.phases = phases
      .filter((phase) => order.includes(phase))
      .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }

  /** スキップされたフェーズの再配分後の overall_ratio を計算する */
  overallRatio(phase: Phase, phaseRatio: number): number {
    if (phaseRatio < 0.0 || phaseRatio > 1.0) {
      throw new Error('phase_ratio must be in 0.0..1.0');
    }
    let totalWeight = 0.0;
    let before = 0.0;
    let found = false;
    for (const item of this.phases) {
      totalWeight += phaseWeight(item);
      if (item === phase) {
        found = true;
        break;
      }
      before += phaseWeight(item);
    }
    if (!found) {
      return before / totalWeight;
    }
    return (before + phaseRatio * phaseWeight(phase)) / totalWeight;
  }
}

/** 進捗発火のスロットラー(16ms / 1%) */
export class ProgressThrottle {
  private readonly minIntervalMs: number;
  private readonly minDelta: number;
  private lastMs: number | null = null;
  private lastRatio: number | null = null;

  constructor(minIntervalMs = 16.0, minDelta = 0.01) {
    this.minIntervalMs = minIntervalMs;
    this.minDelta = minDelta;
  }

  shouldEmit(nowMs: number, ratio: number): boolean {
    if (this.lastMs === null || this.lastRatio === null) {
      this.lastMs = nowMs;
      this.lastRatio = ratio;
      return true;
    }
    const timeOk = nowMs - this.lastMs >= this.minIntervalMs;
    const deltaOk = Math.abs(ratio - this.lastRatio) >= this.minDelta;
    if (timeOk || deltaOk) {
      this.lastMs = nowMs;
      this.lastRatio = ratio;
      return true;
    }
    return false;
  }
}
