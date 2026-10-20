/**
 * メトリクス収集の単体テスト。
 * WASM 版(core-wasm の MetricsSession)と同じ蓄積・スパン・ロールオーバを確認する。
 */
import { describe, expect, it } from 'vitest';
import type { MosaicConfig } from '../types';
import { MetricsSession, SpanAgg } from './metrics';

const config: MosaicConfig = {
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

const finish = (metrics: MetricsSession, p3Ms: number, p4Ms: number): void => {
  const p3 = new SpanAgg();
  p3.record(p3Ms);
  const p4 = new SpanAgg();
  p4.record(p4Ms);
  metrics.finishRunRecord({ p3MatchBatch: p3, p4ComposeBatch: p4 }, new SpanAgg(), 100);
};

describe('MetricsSession', () => {
  it('P1/P2 の蓄積を run レコードへ引き取り、スパン平均を正しく返す', () => {
    const metrics = new MetricsSession();
    metrics.recordP1Grid(2);
    metrics.recordP1BlockFeatures(8);
    metrics.recordP2Tile(10);
    metrics.recordP2Tile(30);
    metrics.markTrigger('tile_added');
    metrics.beginRunRecord(24, config, 100);
    finish(metrics, 100, 50);

    const runs = metrics.toMetricsRuns();
    expect(runs.length).toBe(1);
    const run = runs[0];
    expect(run?.runId).toBe(1);
    expect(run?.trigger).toBe('tile_added');
    expect(run?.phases.P1_MAIN_ANALYZE.ms).toBe(10);
    expect(run?.phases.P2_TILE_ANALYZE.ms).toBe(40);
    expect(run?.phases.P2_TILE_ANALYZE.tiles).toBe(2);
    expect(run?.phases.P3_MATCH.ms).toBe(100);
    expect(run?.phases.P3_MATCH.batches).toBe(1);
    expect(run?.phases.P4_COMPOSE.ms).toBe(50);
    expect(run?.phases.P4_COMPOSE.batches).toBe(1);

    expect(run?.spans.p1_grid).toEqual({ count: 1, avgMs: 2, maxMs: 2 });
    expect(run?.spans.p1_block_features).toEqual({ count: 1, avgMs: 8, maxMs: 8 });
    expect(run?.spans.p2_tile_analyze).toEqual({ count: 2, avgMs: 20, maxMs: 30 });
    expect(run?.spans.p3_match_batch).toEqual({ count: 1, avgMs: 100, maxMs: 100 });
    expect(run?.spans.p4_compose_batch).toEqual({ count: 1, avgMs: 50, maxMs: 50 });
    expect(run?.memory).toEqual({ wasmHeapBytes: 0, tilesBytes: 100 });
    expect(run?.config).toEqual({
      block_size: 24,
      w_c: 1.0,
      w_d: 0.25,
      alpha: 0.85,
      row_batch: 8,
    });
  });

  it('begin 時に P1/P2 の蓄積を消費し、次 run へ持ち越さない', () => {
    const metrics = new MetricsSession();
    metrics.recordP2Tile(10);
    metrics.beginRunRecord(24, config, 100);
    finish(metrics, 10, 10);

    metrics.beginRunRecord(24, config, 100);
    finish(metrics, 10, 10);

    const runs = metrics.toMetricsRuns();
    expect(runs[0]?.phases.P2_TILE_ANALYZE.tiles).toBe(1);
    expect(runs[1]?.phases.P2_TILE_ANALYZE.tiles).toBe(0);
    expect(runs[1]?.phases.P1_MAIN_ANALYZE.ms).toBe(0);
  });

  it('run 履歴は直近 16 件にロールオーバする', () => {
    const metrics = new MetricsSession();
    for (let i = 0; i < 20; i++) {
      metrics.beginRunRecord(24, config, 100);
      finish(metrics, 10, 10);
    }
    const runs = metrics.toMetricsRuns();
    expect(runs.length).toBe(16);
    expect(runs[0]?.runId).toBe(5);
    expect(runs[15]?.runId).toBe(20);
  });
});
