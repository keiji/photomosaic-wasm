/**
 * k-d 木近傍探索の TypeScript 実装(M7: 詳細設計書 4.5)。
 *
 * Rust コア(core/src/kdtree.rs)の移植。特徴ベクトル (L*, a*, b*, detail) の
 * 4 次元静的 k-d 木(median split)で、重み付き距離の近傍上位 k 件を返す。
 */
import { f32 } from './color';

/** k-d 木の使用閾値(この枚数を超えたら k-d 木を使用) */
export const KD_TREE_THRESHOLD = 2000;

/** k-d 木が返す近傍候補の上位件数 */
export const KD_QUERY_K = 32;

/** 特徴ベクトルの次元 (L*, a*, b*, detail) */
export const VECTOR_DIMS = 4;

interface KdNode {
  tile: number;
  axis: number;
  split: number;
  left: number | null;
  right: number | null;
}

interface HeapEntry {
  dist: number;
  tile: number;
}

function heapGreater(a: HeapEntry, b: HeapEntry): boolean {
  return a.dist > b.dist || (a.dist === b.dist && a.tile > b.tile);
}

/** 距離最大(同点はタイル位置最大)を先頭に持つ二分ヒープ */
class MaxHeap {
  private readonly items: HeapEntry[] = [];

  get length(): number {
    return this.items.length;
  }

  peek(): HeapEntry | undefined {
    return this.items[0];
  }

  push(entry: HeapEntry): void {
    const items = this.items;
    items.push(entry);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const parentEntry = items[parent] as HeapEntry;
      if (!heapGreater(entry, parentEntry)) {
        break;
      }
      items[index] = parentEntry;
      index = parent;
    }
    items[index] = entry;
  }

  pop(): HeapEntry | undefined {
    const items = this.items;
    if (items.length === 0) {
      return undefined;
    }
    const top = items[0] as HeapEntry;
    const last = items.pop() as HeapEntry;
    if (items.length === 0) {
      return top;
    }
    let index = 0;
    const length = items.length;
    while (true) {
      const left = index * 2 + 1;
      if (left >= length) {
        break;
      }
      const right = left + 1;
      let child = left;
      if (right < length) {
        const leftEntry = items[left] as HeapEntry;
        const rightEntry = items[right] as HeapEntry;
        if (heapGreater(rightEntry, leftEntry)) {
          child = right;
        }
      }
      const childEntry = items[child] as HeapEntry;
      if (!heapGreater(childEntry, last)) {
        break;
      }
      items[index] = childEntry;
      index = child;
    }
    items[index] = last;
    return top;
  }

  toArray(): HeapEntry[] {
    return this.items.slice();
  }
}

/** 静的 k-d 木(median split・完全平衡志向) */
export class KdTree {
  private readonly vectors: Float32Array;
  private readonly nodes: KdNode[] = [];
  private readonly root: number | null;

  constructor(vectors: Float32Array) {
    if (vectors.length % VECTOR_DIMS !== 0) {
      throw new Error('vector buffer length mismatch');
    }
    this.vectors = vectors;
    const count = vectors.length / VECTOR_DIMS;
    if (count === 0) {
      this.root = null;
      return;
    }
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      order[i] = i;
    }
    this.root = this.buildRecursive(order, 0, count);
  }

  private value(tile: number, axis: number): number {
    return this.vectors[tile * VECTOR_DIMS + axis] as number;
  }

  private buildRecursive(order: Uint32Array, start: number, end: number): number {
    const length = end - start;
    if (length === 1) {
      const tile = order[start] as number;
      const selfIndex = this.nodes.length;
      this.nodes.push({
        tile,
        axis: 0,
        split: this.value(tile, 0),
        left: null,
        right: null,
      });
      return selfIndex;
    }

    let axis = 0;
    let bestSpread = -Infinity;
    for (let d = 0; d < VECTOR_DIMS; d++) {
      let min = Infinity;
      let max = -Infinity;
      for (let i = start; i < end; i++) {
        const value = this.value(order[i] as number, d);
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      const spread = max - min;
      if (spread > bestSpread) {
        bestSpread = spread;
        axis = d;
      }
    }

    const slice = order.subarray(start, end);
    slice.sort((a, b) => {
      const diff = this.value(a, axis) - this.value(b, axis);
      return diff !== 0 ? diff : a - b;
    });

    const mid = length >> 1;
    const tile = order[start + mid] as number;
    const left = mid > 0 ? this.buildRecursive(order, start, start + mid) : null;
    const right = mid + 1 < length ? this.buildRecursive(order, start + mid + 1, end) : null;
    const selfIndex = this.nodes.length;
    this.nodes.push({
      tile,
      axis,
      split: this.value(tile, axis),
      left,
      right,
    });
    return selfIndex;
  }

  /** 重み付き距離で k 近傍のタイル位置を近い順で返す */
  query(query: readonly number[], k: number, wc: number, wd: number): Array<[number, number]> {
    if (k === 0 || this.root === null) {
      return [];
    }
    const heap = new MaxHeap();
    this.visit(this.root, query, k, wc, wd, heap);
    const results = heap.toArray().map((entry): [number, number] => [entry.dist, entry.tile]);
    results.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
    return results;
  }

  private visit(
    nodeIndex: number,
    query: readonly number[],
    k: number,
    wc: number,
    wd: number,
    heap: MaxHeap,
  ): void {
    const node = this.nodes[nodeIndex] as KdNode;
    const sq = weightedSqDist(this.vectors, node.tile, query, wc, wd);
    heap.push({ dist: sq, tile: node.tile });
    if (heap.length > k) {
      heap.pop();
    }
    const top = heap.peek();
    const bound = top?.dist;

    const axis = node.axis;
    const d = (query[axis] as number) - node.split;
    const perAxis = axis === VECTOR_DIMS - 1 ? wd : wc;
    const planeSq = f32(f32(f32(perAxis * perAxis) * d) * d);
    const boundOk = heap.length < k || bound === undefined || planeSq <= bound;
    const near = d <= 0.0 ? node.left : node.right;
    const far = d <= 0.0 ? node.right : node.left;
    if (near !== null) {
      this.visit(near, query, k, wc, wd, heap);
    }
    if (boundOk && far !== null) {
      this.visit(far, query, k, wc, wd, heap);
    }
  }
}

/** 重み付き 2 乗距離(P3 距離関数の色距離 + ディテール差項に対応) */
export function weightedSqDist(
  vectors: Float32Array,
  tile: number,
  query: readonly number[],
  wc: number,
  wd: number,
): number {
  const offset = tile * VECTOR_DIMS;
  const dl = f32(wc * f32((vectors[offset] as number) - (query[0] as number)));
  const da = f32(wc * f32((vectors[offset + 1] as number) - (query[1] as number)));
  const db = f32(wc * f32((vectors[offset + 2] as number) - (query[2] as number)));
  const dd = f32(wd * f32((vectors[offset + 3] as number) - (query[3] as number)));
  const sum1 = f32(f32(dl * dl) + f32(da * da));
  const sum2 = f32(sum1 + f32(db * db));
  return f32(sum2 + f32(dd * dd));
}
