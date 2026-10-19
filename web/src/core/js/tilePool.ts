/**
 * タイル特徴量・タイルプールの TypeScript 実装(P2)。
 *
 * Rust コア(core/src/tile.rs)の移植。代表色は線形 RGB の周囲重み付き平均で、
 * 合成用サムネイルは長辺 64px 上限で保持する。メモリガード超過時は長辺を
 * 自動で半減する。
 */
import type { MosaicConfig } from '../types';
import { deltaE76, f32, linearRgbToLstar, linearRgbToXyz, srgb8LinearLut, xyzToLab } from './color';
import type { BlockFeature } from './grid';
import { KD_QUERY_K, KD_TREE_THRESHOLD, KdTree, VECTOR_DIMS } from './kdtree';
import { nowMs, SpanAgg } from './metrics';

/** 特徴量算出用サムネイルの 1 辺 px */
export const FEATURE_THUMB = 32;

/** タイル代表色(mean_lab)の周囲重み */
export const TILE_BORDER_WEIGHT = 2.5;

/** 合成用サムネイルの長辺上限 px */
export const COMPOSE_THUMB_MAX = 64;

/** 合成用サムネイル長辺の下限 px */
export const COMPOSE_THUMB_MIN_EDGE = 16;

/** 合成用サムネイル合計の上限バイト数(512 MB) */
export const MEMORY_GUARD_BYTES = 512 * 1024 * 1024;

/** タイル特徴量(詳細設計書 3 章 TileFeature) */
export interface TileFeature {
  id: bigint;
  thumbW: number;
  thumbH: number;
  /** CIELAB 代表色 (L*, a*, b*)(周囲重み付き平均) */
  meanLab: [number, number, number];
  /** タイル内 L* の標準偏差(0..128) */
  detail: number;
  /** 現在の使用回数 */
  usage: number;
}

/** 合成用サムネイル */
export interface ComposeThumb {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

interface DuplicateGroups {
  duplicateDe: number;
  duplicateDetail: number;
  index: Map<bigint, number>;
  usage: number[];
}

interface KdIndex {
  tree: KdTree;
  tileIds: bigint[];
}

type RgbaBytes = Uint8Array | Uint8ClampedArray;

/** 特徴量用サムネイルからタイル特徴量を算出する(P2) */
export function analyzeTileFeature(
  rgba: RgbaBytes,
  width: number,
  height: number,
  borderWeight: number,
): { meanLab: [number, number, number]; detail: number } {
  if (width <= 0 || height <= 0) {
    throw new Error('tile thumbnail size must be positive');
  }
  if (!Number.isFinite(borderWeight) || borderWeight < 1.0) {
    throw new Error('border weight must be a finite number >= 1.0');
  }
  const pixelCount = width * height;
  if (rgba.length !== pixelCount * 4) {
    throw new Error('rgba buffer length mismatch');
  }

  const centerX0 = Math.floor(width / 4);
  const centerX1 = width - centerX0;
  const centerY0 = Math.floor(height / 4);
  const centerY1 = height - centerY0;

  const lut = srgb8LinearLut();
  let sumR = 0.0;
  let sumG = 0.0;
  let sumB = 0.0;
  let totalWeight = 0.0;
  let sumLstar = 0.0;
  let sumLstarSq = 0.0;

  for (let i = 0; i < pixelCount; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    const inCenter = x >= centerX0 && x < centerX1 && y >= centerY0 && y < centerY1;
    const weight = inCenter ? 1.0 : borderWeight;
    const offset = i * 4;
    const lr = lut[rgba[offset] as number] as number;
    const lg = lut[rgba[offset + 1] as number] as number;
    const lb = lut[rgba[offset + 2] as number] as number;

    sumR += lr * weight;
    sumG += lg * weight;
    sumB += lb * weight;
    totalWeight += weight;

    const lstar = linearRgbToLstar(lr, lg, lb);
    sumLstar += lstar;
    sumLstarSq += lstar * lstar;
  }

  const meanLinear: [number, number, number] = [
    sumR / totalWeight,
    sumG / totalWeight,
    sumB / totalWeight,
  ];
  const [x, y, z] = linearRgbToXyz(meanLinear[0], meanLinear[1], meanLinear[2]);
  const meanLab = xyzToLab(x, y, z);

  const n = pixelCount;
  const meanL = sumLstar / n;
  const variance = Math.max(0.0, sumLstarSq / n - meanL * meanL);

  return {
    meanLab: [f32(meanLab[0]), f32(meanLab[1]), f32(meanLab[2])],
    detail: f32(Math.sqrt(variance)),
  };
}

/** 面積平均(ボックスフィルタ)で RGBA を縮小する(アスペクト維持) */
function downsampleRgba(
  rgba: RgbaBytes,
  width: number,
  height: number,
  maxEdge: number,
): ComposeThumb {
  const scale = maxEdge / Math.max(width, height);
  const newWidth = Math.min(width, Math.max(1, Math.round(width * scale)));
  const newHeight = Math.min(height, Math.max(1, Math.round(height * scale)));
  if (newWidth === width && newHeight === height) {
    return { width, height, data: new Uint8ClampedArray(rgba) };
  }

  const out = new Uint8ClampedArray(newWidth * newHeight * 4);
  for (let oy = 0; oy < newHeight; oy++) {
    const yBegin = Math.floor((oy * height) / newHeight);
    const yEnd = Math.min(height, Math.max(yBegin + 1, Math.ceil(((oy + 1) * height) / newHeight)));
    for (let ox = 0; ox < newWidth; ox++) {
      const xBegin = Math.floor((ox * width) / newWidth);
      const xEnd = Math.min(width, Math.max(xBegin + 1, Math.ceil(((ox + 1) * width) / newWidth)));
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      for (let y = yBegin; y < yEnd; y++) {
        const row = y * width * 4;
        for (let x = xBegin; x < xEnd; x++) {
          const offset = row + x * 4;
          sumR += rgba[offset] as number;
          sumG += rgba[offset + 1] as number;
          sumB += rgba[offset + 2] as number;
        }
      }
      const count = (xEnd - xBegin) * (yEnd - yBegin);
      const outOffset = (oy * newWidth + ox) * 4;
      out[outOffset] = Math.floor(sumR / count);
      out[outOffset + 1] = Math.floor(sumG / count);
      out[outOffset + 2] = Math.floor(sumB / count);
      out[outOffset + 3] = 255;
    }
  }
  return { width: newWidth, height: newHeight, data: out };
}

/** タイルプール(解析済み構成画像の集合) */
export class TilePool {
  private readonly features = new Map<bigint, TileFeature>();
  private readonly composeThumbs = new Map<bigint, ComposeThumb>();
  private orderedFeatures: TileFeature[] | null = null;
  private totalBytes = 0;
  private readonly guardBytes: number;
  private composeMaxEdge = COMPOSE_THUMB_MAX;
  private index: KdIndex | null = null;
  private readonly indexBuildAgg = new SpanAgg();
  private readonly kdThreshold: number;
  private groups: DuplicateGroups | null = null;

  constructor(guardBytes: number = MEMORY_GUARD_BYTES, kdThreshold: number = KD_TREE_THRESHOLD) {
    this.guardBytes = guardBytes;
    this.kdThreshold = kdThreshold;
  }

  /** タイルを解析してプールへ登録する(P2) */
  addTile(
    id: bigint,
    featureRgba: RgbaBytes,
    composeRgba: RgbaBytes,
    composeW: number,
    composeH: number,
  ): TileFeature {
    if (composeW === 0 || composeH === 0 || Math.max(composeW, composeH) > COMPOSE_THUMB_MAX) {
      throw new Error(`compose thumbnail edge must be within ${COMPOSE_THUMB_MAX}px`);
    }
    if (composeRgba.length !== composeW * composeH * 4) {
      throw new Error('rgba buffer length mismatch');
    }
    if (featureRgba.length !== FEATURE_THUMB * FEATURE_THUMB * 4) {
      throw new Error(`feature thumbnail must be ${FEATURE_THUMB}x${FEATURE_THUMB}`);
    }

    const { meanLab, detail } = analyzeTileFeature(
      featureRgba,
      FEATURE_THUMB,
      FEATURE_THUMB,
      TILE_BORDER_WEIGHT,
    );

    const existing = this.composeThumbs.get(id);
    const replacedBytes = existing ? existing.data.length : 0;

    let width = composeW;
    let height = composeH;
    let buffer = new Uint8ClampedArray(composeRgba);
    if (Math.max(composeW, composeH) > this.composeMaxEdge) {
      const resized = downsampleRgba(composeRgba, composeW, composeH, this.composeMaxEdge);
      width = resized.width;
      height = resized.height;
      buffer = resized.data;
    }

    for (;;) {
      const newTotal = this.totalBytes - replacedBytes + buffer.length;
      if (newTotal <= this.guardBytes) {
        break;
      }
      const next = Math.max(Math.floor(this.composeMaxEdge / 2), COMPOSE_THUMB_MIN_EDGE);
      if (next >= this.composeMaxEdge) {
        throw new Error(
          `memory guard exceeded: ${newTotal} bytes required, limit is ${this.guardBytes} bytes`,
        );
      }
      this.composeMaxEdge = next;
      this.downsampleAllThumbs();
      if (Math.max(width, height) > this.composeMaxEdge) {
        const resized = downsampleRgba(buffer, width, height, this.composeMaxEdge);
        width = resized.width;
        height = resized.height;
        buffer = resized.data;
      }
    }

    const feature: TileFeature = {
      id,
      thumbW: width,
      thumbH: height,
      meanLab,
      detail,
      usage: 0,
    };
    this.index = null;
    this.groups = null;
    this.orderedFeatures = null;
    this.features.set(id, feature);
    this.composeThumbs.set(id, { width, height, data: buffer });
    this.totalBytes = this.totalBytes + width * height * 4 - replacedBytes;
    return feature;
  }

  private downsampleAllThumbs(): void {
    const updated: Array<{ id: bigint; thumb: ComposeThumb }> = [];
    for (const [id, thumb] of this.composeThumbs) {
      if (Math.max(thumb.width, thumb.height) > this.composeMaxEdge) {
        updated.push({
          id,
          thumb: downsampleRgba(thumb.data, thumb.width, thumb.height, this.composeMaxEdge),
        });
      }
    }
    for (const { id, thumb } of updated) {
      const old = this.composeThumbs.get(id);
      if (!old) {
        continue;
      }
      this.totalBytes -= old.data.length;
      this.composeThumbs.set(id, thumb);
      this.totalBytes += thumb.data.length;
      const feature = this.features.get(id);
      if (feature) {
        feature.thumbW = thumb.width;
        feature.thumbH = thumb.height;
      }
    }
    if (updated.length > 0) {
      this.index = null;
      this.groups = null;
    }
  }

  /** プールからタイルを削除する */
  removeTile(id: bigint): void {
    const thumb = this.composeThumbs.get(id);
    if (!thumb) {
      throw new Error(`unknown tile id: ${id}`);
    }
    this.totalBytes -= thumb.data.length;
    this.composeThumbs.delete(id);
    this.features.delete(id);
    this.index = null;
    this.groups = null;
    this.orderedFeatures = null;
  }

  /** プールを空にする */
  clear(): void {
    this.features.clear();
    this.composeThumbs.clear();
    this.totalBytes = 0;
    this.index = null;
    this.groups = null;
    this.orderedFeatures = null;
  }

  tileCount(): number {
    return this.features.size;
  }

  totalComposeBytes(): number {
    return this.totalBytes;
  }

  feature(id: bigint): TileFeature | undefined {
    return this.features.get(id);
  }

  /** 全タイルの特徴量(ID 昇順) */
  featuresInOrder(): TileFeature[] {
    if (this.orderedFeatures === null) {
      const ids = Array.from(this.features.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      this.orderedFeatures = ids
        .map((id) => this.features.get(id))
        .filter((feature): feature is TileFeature => feature !== undefined);
    }
    return this.orderedFeatures;
  }

  bumpUsage(id: bigint): void {
    const feature = this.features.get(id);
    if (feature) {
      feature.usage = Math.min(0xffffffff, feature.usage + 1);
    }
    const groups = this.groups;
    if (groups) {
      const group = groups.index.get(id);
      if (group !== undefined) {
        groups.usage[group] = Math.min(0xffffffff, (groups.usage[group] as number) + 1);
      }
    }
  }

  decreaseUsage(id: bigint): void {
    const feature = this.features.get(id);
    if (feature) {
      feature.usage = Math.max(0, feature.usage - 1);
    }
    const groups = this.groups;
    if (groups) {
      const group = groups.index.get(id);
      if (group !== undefined) {
        groups.usage[group] = Math.max(0, (groups.usage[group] as number) - 1);
      }
    }
  }

  recountUsage(assigned: ReadonlyArray<bigint | null | undefined>): void {
    this.resetUsage();
    for (const id of assigned) {
      if (id !== null && id !== undefined) {
        this.bumpUsage(id);
      }
    }
  }

  allUsageReached(cap: number): boolean {
    if (cap === 0) {
      return false;
    }
    const groups = this.groups;
    if (groups) {
      return groups.usage.length > 0 && groups.usage.every((usage) => usage >= cap);
    }
    if (this.features.size === 0) {
      return false;
    }
    for (const feature of this.features.values()) {
      if (feature.usage < cap) {
        return false;
      }
    }
    return true;
  }

  resetUsage(): void {
    for (const feature of this.features.values()) {
      feature.usage = 0;
    }
    const groups = this.groups;
    if (groups) {
      groups.usage.fill(0);
    }
  }

  composeThumb(id: bigint): ComposeThumb | undefined {
    return this.composeThumbs.get(id);
  }

  composeMaxEdgeValue(): number {
    return this.composeMaxEdge;
  }

  usesKdIndex(): boolean {
    return this.features.size > this.kdThreshold;
  }

  indexBuildStats(): SpanAgg {
    return this.indexBuildAgg;
  }

  /** マッチング・差し替え評価に使う候補タイルの ID(昇順・重複なし) */
  candidatesFor(block: BlockFeature, config: MosaicConfig): bigint[] {
    if (!this.usesKdIndex()) {
      return [];
    }
    if (this.index === null) {
      const t0 = nowMs();
      const ordered = this.featuresInOrder();
      const vectors = new Float32Array(ordered.length * VECTOR_DIMS);
      const tileIds: bigint[] = new Array(ordered.length);
      for (let i = 0; i < ordered.length; i++) {
        const feature = ordered[i] as TileFeature;
        tileIds[i] = feature.id;
        const offset = i * VECTOR_DIMS;
        vectors[offset] = feature.meanLab[0];
        vectors[offset + 1] = feature.meanLab[1];
        vectors[offset + 2] = feature.meanLab[2];
        vectors[offset + 3] = feature.detail;
      }
      const tree = new KdTree(vectors);
      this.indexBuildAgg.record(nowMs() - t0);
      this.index = { tree, tileIds };
    }
    const index = this.index;
    if (!index) {
      return [];
    }
    const query = [block.meanLab[0], block.meanLab[1], block.meanLab[2], block.detail];
    const results = index.tree.query(query, KD_QUERY_K, config.w_c, config.w_d);
    const ids = results.map(([, tileIndex]) => index.tileIds[tileIndex] as bigint);
    ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return ids.filter((id, i) => i === 0 || id !== (ids[i - 1] as bigint));
  }

  featuresFor(ids: readonly bigint[]): TileFeature[] {
    const result: TileFeature[] = [];
    for (const id of ids) {
      const feature = this.features.get(id);
      if (feature) {
        result.push(feature);
      }
    }
    return result;
  }

  /** 類似タイルの同一視グループを構築済みにする */
  ensureGroups(duplicateDe: number, duplicateDetail: number): void {
    const current = this.groups;
    if (
      current &&
      current.duplicateDe === duplicateDe &&
      current.duplicateDetail === duplicateDetail
    ) {
      return;
    }
    const t0 = nowMs();
    const index = new Map<bigint, number>();
    const members: bigint[][] = [];
    for (const feature of this.featuresInOrder()) {
      let joined: number | null = null;
      for (let g = 0; g < members.length; g++) {
        const group = members[g] as bigint[];
        const repId = group[0] as bigint;
        const rep = this.features.get(repId);
        if (!rep) {
          continue;
        }
        const de = deltaE76(feature.meanLab, rep.meanLab);
        if (de <= duplicateDe && Math.abs(feature.detail - rep.detail) <= duplicateDetail) {
          joined = g;
          break;
        }
      }
      let group: number;
      if (joined === null) {
        members.push([]);
        group = members.length - 1;
      } else {
        group = joined;
      }
      (members[group] as bigint[]).push(feature.id);
      index.set(feature.id, group);
    }
    const usage = members.map((group) => {
      let sum = 0;
      for (const id of group) {
        const feature = this.features.get(id);
        if (feature) {
          sum += feature.usage;
        }
      }
      return sum;
    });
    this.indexBuildAgg.record(nowMs() - t0);
    this.groups = { duplicateDe, duplicateDetail, index, usage };
  }

  groupOf(id: bigint): number | undefined {
    return this.groups?.index.get(id);
  }

  effectiveUsage(id: bigint): number {
    const groups = this.groups;
    if (groups) {
      const group = groups.index.get(id);
      return group === undefined ? 0 : (groups.usage[group] as number);
    }
    return this.features.get(id)?.usage ?? 0;
  }
}
