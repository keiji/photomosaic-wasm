/**
 * マッチング(P3)の TypeScript 実装(詳細設計書 4.4)。
 *
 * Rust コア(core/src/match_engine.rs)の移植。
 * 距離関数 D = w_c * ΔE76 + w_d * |detail差| + λ * usage + n_p * nearness。
 */
import type { MosaicConfig } from '../types';
import { deltaE76, f32 } from './color';
import type { BlockFeature } from './grid';
import type { TileFeature, TilePool } from './tilePool';

/** マッチ結果(詳細設計書 3 章 MatchResult) */
export interface MatchResult {
  blockIndex: number;
  tileId: bigint;
}

/** 候補タイルと直上・直左タイルの近さ(0.0..=1.0) */
export function neighborNearness(
  tile: TileFeature,
  left: TileFeature | undefined,
  above: TileFeature | undefined,
  config: MosaicConfig,
): number {
  const radius = config.neighbor_de;
  let nearness = 0.0;
  for (const neighbor of [left, above]) {
    if (!neighbor) {
      continue;
    }
    const de = deltaE76(tile.meanLab, neighbor.meanLab);
    nearness = Math.max(nearness, f32(Math.max(0.0, f32(1.0 - f32(de / radius)))));
  }
  return nearness;
}

/** 1 ブロックに対する距離評価(詳細設計書 4.4 の距離関数) */
export function distance(
  block: BlockFeature,
  tile: TileFeature,
  usage: number,
  nearness: number,
  config: MosaicConfig,
): number {
  const colorTerm = f32(config.w_c * deltaE76(block.meanLab, tile.meanLab));
  const detailTerm = f32(config.w_d * Math.abs(block.detail - tile.detail));
  const usageTerm = config.usage_penalty * usage;
  const neighborTerm = config.neighbor_penalty * nearness;
  return f32(colorTerm + detailTerm + usageTerm + neighborTerm);
}

/** 全ブロックをマッチングする(P3) */
export function matchBlocks(
  blocks: readonly BlockFeature[],
  cols: number,
  pool: TilePool,
  config: MosaicConfig,
): MatchResult[] {
  const assigned: Array<bigint | null> = new Array(blocks.length).fill(null);
  matchUnmatchedRange(blocks, cols, pool, config, assigned, 0, blocks.length);
  return assignmentsToMatches(assigned);
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

/** ブロック範囲のうち未確定ブロックをマッチする */
export function matchUnmatchedRange(
  blocks: readonly BlockFeature[],
  cols: number,
  pool: TilePool,
  config: MosaicConfig,
  assigned: Array<bigint | null>,
  blockBegin: number,
  blockEnd: number,
): number[] {
  const matched: number[] = [];
  if (pool.tileCount() === 0 || cols === 0 || assigned.length !== blocks.length) {
    return matched;
  }
  const begin = Math.min(blockBegin, Math.min(blockEnd, blocks.length));
  const end = Math.min(blockEnd, blocks.length);
  pool.ensureGroups(config.duplicate_de, config.duplicate_detail);

  for (let i = begin; i < end; i++) {
    if (assigned[i] !== null && assigned[i] !== undefined) {
      continue;
    }

    if (pool.allUsageReached(config.usage_cap)) {
      pool.resetUsage();
    }

    const block = blocks[i] as BlockFeature;
    const col = i % cols;
    const leftId = col > 0 ? (assigned[i - 1] ?? null) : null;
    const aboveId = i >= cols ? (assigned[i - cols] ?? null) : null;
    const neighborLeft = leftId === null ? undefined : pool.feature(leftId);
    const neighborAbove = aboveId === null ? undefined : pool.feature(aboveId);

    let candidateIds = pool.candidatesFor(block, config);
    if (candidateIds.length === 0) {
      candidateIds = pool.featuresInOrder().map((feature) => feature.id);
    }

    let best: { d: number; tile: TileFeature } | null = null;
    let nearBest: { d: number; tile: TileFeature } | null = null;

    for (const tile of pool.featuresFor(candidateIds)) {
      const de = deltaE76(block.meanLab, tile.meanLab);
      const nearness = neighborNearness(tile, neighborLeft, neighborAbove, config);
      const d = distance(block, tile, pool.effectiveUsage(tile.id), nearness, config);

      if (best === null || d < best.d) {
        best = { d, tile };
      }
      if (de < config.identical_de) {
        const takeNear =
          nearBest === null ||
          tile.detail > nearBest.tile.detail ||
          (tile.detail === nearBest.tile.detail && d < nearBest.d);
        if (takeNear) {
          nearBest = { d, tile };
        }
      }
    }

    const chosen = (nearBest ?? best)?.tile;
    if (!chosen) {
      continue;
    }
    pool.bumpUsage(chosen.id);
    assigned[i] = chosen.id;
    matched.push(i);
  }

  return matched;
}

/** ブロック範囲に対し差し替え評価を行う(差分再マッチ) */
export function evaluateSwapRange(
  blocks: readonly BlockFeature[],
  cols: number,
  pool: TilePool,
  config: MosaicConfig,
  assigned: Array<bigint | null>,
  blockBegin: number,
  blockEnd: number,
): number[] {
  const swapped: number[] = [];
  if (pool.tileCount() === 0 || cols === 0 || assigned.length !== blocks.length) {
    return swapped;
  }
  const begin = Math.min(blockBegin, Math.min(blockEnd, blocks.length));
  const end = Math.min(blockEnd, blocks.length);
  pool.ensureGroups(config.duplicate_de, config.duplicate_detail);

  for (let i = begin; i < end; i++) {
    const currentId = assigned[i];
    if (currentId === null || currentId === undefined) {
      continue;
    }
    const currentTile = pool.feature(currentId);
    if (!currentTile) {
      continue;
    }

    const block = blocks[i] as BlockFeature;
    const col = i % cols;
    const leftId = col > 0 ? (assigned[i - 1] ?? null) : null;
    const aboveId = i >= cols ? (assigned[i - cols] ?? null) : null;
    const neighborLeft = leftId === null ? undefined : pool.feature(leftId);
    const neighborAbove = aboveId === null ? undefined : pool.feature(aboveId);

    const nearnessCurrent = neighborNearness(currentTile, neighborLeft, neighborAbove, config);
    const currentD = distance(
      block,
      currentTile,
      pool.effectiveUsage(currentId),
      nearnessCurrent,
      config,
    );

    let candidateIds = pool.candidatesFor(block, config);
    if (candidateIds.length === 0) {
      candidateIds = pool.featuresInOrder().map((feature) => feature.id);
    } else if (!candidateIds.includes(currentId)) {
      candidateIds.push(currentId);
      candidateIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }

    let best: { d: number; id: bigint } | null = null;
    for (const tile of pool.featuresFor(candidateIds)) {
      const nearness = neighborNearness(tile, neighborLeft, neighborAbove, config);
      const d = distance(block, tile, pool.effectiveUsage(tile.id), nearness, config);
      if (best === null || d < best.d) {
        best = { d, id: tile.id };
      }
    }
    if (!best) {
      continue;
    }

    if (best.id !== currentId && currentD - best.d >= config.improve_margin) {
      assigned[i] = best.id;
      pool.bumpUsage(best.id);
      pool.decreaseUsage(currentId);
      swapped.push(i);
    }
  }

  return swapped;
}
