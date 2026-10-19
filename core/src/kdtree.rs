//! k-d 木近傍探索(M7: 詳細設計書 4.5)。
//!
//! - 特徴ベクトル (L*, a*, b*, detail) の 4 次元 k-d 木(静的・median split)
//! - 距離は P3 距離関数の色距離とディテール差に対応する重み付き距離:
//!   `d² = (w_c·ΔL)² + (w_c·Δa)² + (w_c·Δb)² + (w_d·Δdetail)²`
//!   (P3 の D = w_c·ΔE76 + w_d·|Δdetail| + … の使用ペナルティ・隣接
//!   ペナルティを除いた前段なので、この重み付き距離の順位と前段の順位は一致する)
//! - 使用ペナルティ・隣接ペナルティは、k-d 木が返す近傍候補上位 32 件を
//!   呼び出し側(P3 の完全な距離関数)で再評価して反映する(詳細設計書 4.5)
//! - 木はタイル特徴量のスナップショット。タイルの追加・削除・置き換えが
//!   あれば呼び出し側で再構築する(構築時間は p2_index_build スパンで計る)
//! - 軸選択・ソートはタイル位置(= タイル ID 昇順の並びの元の順番)で同点を
//!   破らないため、同一入力に対して決定的な結果を保証する

use std::collections::BinaryHeap;

/// k-d 木の使用閾値(詳細設計書 5 章 kd_tree_threshold、固定)。
/// この枚数を超えたら k-d 木を使用(以下は総当たり)
pub const KD_TREE_THRESHOLD: u32 = 2_000;

/// k-d 木が返す近傍候補の上位件数(詳細設計書 4.5: 上位 32 件を再評価)
pub const KD_QUERY_K: usize = 32;

/// 特徴ベクトルの次元 (L*, a*, b*, detail)
pub const VECTOR_DIMS: usize = 4;

/// k-d 木の 1 ノード(フラット配列で保持)
struct KdNode {
    /// このノードが保持するタイル位置(vectors 配列上の位置)
    tile: u32,
    /// タイルの特徴ベクトル(距離計算を走査でキャッシュにより短く保つ)
    vector: [f32; VECTOR_DIMS],
    /// 分割軸 (0..VECTOR_DIMS)
    axis: u8,
    /// 分割値(node.vector[axis])
    split: f32,
    left: Option<u32>,
    right: Option<u32>,
}

/// 静的な k-d 木(median split・完全平衡志向)。
///
/// query の重みは build に含めず query 時に適用する(config 変更しても
/// 木の再構築が不要になる)
pub struct KdTree {
    nodes: Vec<KdNode>,
    /// 根ノードの番号(子→親の順に push するため最後の要素)
    root: Option<u32>,
}

/// p(t, i) の便利な構造の呼び名を省略しない: クエリの結果(候補)は
/// `(重み付き距離², タイル位置)` のタプル(距離昇順・同点はタイル位置昇順)
impl KdTree {
    /// タイル特徴ベクトルから k-d 木を構築する。
    ///
    /// - 軸は「その分割区間で値の広がり(最大−最小)が最大の軸」を選ぶ
    ///   (同点は最小軸番号を優先 → 決定的)
    /// - median で二分する(平衡。一方に倒した最悪ケースを避ける)
    /// - index のみのノード処理のため再帰呼び出しで子を先に作り、
    ///   親ノードを後に push する(children の番号は push 前に確定する)
    pub fn build(vectors: &[[f32; VECTOR_DIMS]]) -> KdTree {
        if vectors.is_empty() {
            return KdTree {
                nodes: Vec::new(),
                root: None,
            };
        }
        let mut order: Vec<u32> = (0..vectors.len() as u32).collect();
        let mut nodes: Vec<KdNode> = Vec::with_capacity(vectors.len());
        let root = build_recursive(vectors, &mut order, &mut nodes);
        KdTree {
            nodes,
            root: Some(root),
        }
    }

    /// 重み付き距離で k 近傍のタイル位置を近い順で返す
    /// (返り値は `(重み付き距離², タイル位置)`。同距離はタイル位置昇順)
    pub fn query(
        &self,
        query: &[f32; VECTOR_DIMS],
        k: usize,
        w_c: f32,
        w_d: f32,
    ) -> Vec<(f32, u32)> {
        if k == 0 || self.nodes.is_empty() {
            return Vec::new();
        }
        let root = self.root.expect("non-empty tree has a root");
        // 上位 k 件は「最遠を除去する MaxHeap」で管理する。要素は
        // (距離²の位パターン, タイル位置) の辞書式順序: 非負の f32 は位パターンの
        // 順序が値の順序と一致するため、heap.pop() は距離最大(同点は
        // タイル位置最大)を除去する
        let mut heap: BinaryHeap<(u32, u32)> = BinaryHeap::new();
        visit(self, root, query, k, w_c, w_d, &mut heap);
        let mut results: Vec<(f32, u32)> = heap
            .into_vec()
            .into_iter()
            .map(|(bits, tile)| (f32::from_bits(bits), tile))
            .collect();
        results.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        results
    }
}

/// 走査の再帰(木と heap を参照引数で共有)
fn visit(
    tree: &KdTree,
    node_i: u32,
    query: &[f32; VECTOR_DIMS],
    k: usize,
    w_c: f32,
    w_d: f32,
    heap: &mut BinaryHeap<(u32, u32)>,
) {
    let node = &tree.nodes[usize::try_from(node_i).expect("node index fits usize")];
    let sq = weighted_sq_dist(&node.vector, query, w_c, w_d);
    heap.push((sq.to_bits(), node.tile));
    if heap.len() > k {
        heap.pop();
    }
    let bound = heap.peek().map(|&(bits, _)| f32::from_bits(bits));

    // 分割平面からのクエリ偏差(重み込み)で near/far を決める
    let axis = usize::from(node.axis);
    let d = query[axis] - node.split;
    let per_axis = if axis == VECTOR_DIMS - 1 { w_d } else { w_c };
    let plane_sq = per_axis * per_axis * d * d;
    let bound_ok = heap.len() < k || bound.is_none_or(|b| plane_sq <= b);
    let (near, far) = if d <= 0.0 {
        (node.left, node.right)
    } else {
        (node.right, node.left)
    };
    if let Some(near_i) = near {
        visit(tree, near_i, query, k, w_c, w_d, heap);
    }
    if bound_ok {
        if let Some(far_i) = far {
            visit(tree, far_i, query, k, w_c, w_d, heap);
        }
    }
}

/// 重み付き 2 乗距離(P3 距離関数の色距離 + ディテール差項に対応)
pub fn weighted_sq_dist(v: &[f32; VECTOR_DIMS], q: &[f32; VECTOR_DIMS], w_c: f32, w_d: f32) -> f32 {
    let dl = w_c * (v[0] - q[0]);
    let da = w_c * (v[1] - q[1]);
    let db = w_c * (v[2] - q[2]);
    let dd = w_d * (v[3] - q[3]);
    dl * dl + da * da + db * db + dd * dd
}

/// 区間を median 分割する再帰構築(子→親の順で push)。区間の根ノード番号を返す
fn build_recursive(
    vectors: &[[f32; VECTOR_DIMS]],
    partition: &mut [u32],
    out: &mut Vec<KdNode>,
) -> u32 {
    assert!(!partition.is_empty(), "partition must not be empty");
    if partition.len() == 1 {
        let tile = partition[0];
        let vector = vectors[usize::try_from(tile).expect("tile index fits usize")];
        let self_i = u32::try_from(out.len()).expect("node count fits u32");
        out.push(KdNode {
            tile,
            vector,
            axis: 0,
            split: vector[0],
            left: None,
            right: None,
        });
        return self_i;
    }

    // 最大広がりの軸を選ぶ(同点は最小軸番号を優先 → 決定的)
    let axis = (0..VECTOR_DIMS)
        .map(|d| {
            let mut min = f32::MAX;
            let mut max = f32::MIN;
            for &tile in partition.iter() {
                let value = vectors[usize::try_from(tile).expect("tile index fits usize")][d];
                min = min.min(value);
                max = max.max(value);
            }
            (max - min, d)
        })
        .max_by(|(a_spread, a_axis), (b_spread, b_axis)| {
            a_spread
                .total_cmp(b_spread)
                .then_with(|| b_axis.cmp(a_axis))
        })
        .map(|(_, axis)| axis)
        .expect("at least 1 axis");

    // 選んだ軸で median 分割(stable ソート: 同点はタイル位置昇順を維持)
    partition.sort_by(|&a, &b| {
        let (va, vb) = (
            vectors[usize::try_from(a).expect("a fits usize")][axis],
            vectors[usize::try_from(b).expect("b fits usize")][axis],
        );
        va.total_cmp(&vb).then_with(|| a.cmp(&b))
    });
    let mid = partition.len() / 2;
    let tile = partition[mid];
    let vector = vectors[usize::try_from(tile).expect("tile index fits usize")];
    let left = if mid > 0 {
        Some(build_recursive(vectors, &mut partition[..mid], out))
    } else {
        None
    };
    let right = if mid + 1 < partition.len() {
        Some(build_recursive(vectors, &mut partition[mid + 1..], out))
    } else {
        None
    };
    let self_i = u32::try_from(out.len()).expect("node count fits u32");
    out.push(KdNode {
        tile,
        vector,
        axis: u8::try_from(axis).expect("axis fits u8"),
        split: vector[axis],
        left,
        right,
    });
    self_i
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 決定的な擬似乱数パターン(乱数クレートなし。決定的)
    fn pseudo(i: usize) -> [f32; VECTOR_DIMS] {
        [
            (i * 37 % 100) as f32,                       // L*
            ((i * 41 + 7) % 200) as i32 as f32 - 100.0,  // a*
            ((i * 43 + 13) % 200) as i32 as f32 - 100.0, // b*
            (i * 29 % 128) as f32,                       // detail
        ]
    }

    fn brute_force(
        vectors: &[[f32; 4]],
        q: &[f32; 4],
        k: usize,
        w_c: f32,
        w_d: f32,
    ) -> Vec<(f32, u32)> {
        let mut list: Vec<(f32, u32)> = vectors
            .iter()
            .enumerate()
            .map(|(i, v)| (weighted_sq_dist(v, q, w_c, w_d), i as u32))
            .collect();
        list.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        list.truncate(k);
        list
    }

    #[test]
    fn query_matches_brute_force_on_deterministic_set() {
        let vectors: Vec<[f32; 4]> = (0..500).map(pseudo).collect();
        let tree = KdTree::build(&vectors);
        let queries: Vec<[f32; 4]> = (0..50).map(|i| pseudo(i + 7)).collect();
        for (qi, q) in queries.iter().enumerate() {
            for w_c in [0.5_f32, 1.0, 2.0] {
                for w_d in [0.0_f32, 0.25, 1.0] {
                    let got = tree.query(q, KD_QUERY_K, w_c, w_d);
                    let expect = brute_force(&vectors, q, KD_QUERY_K, w_c, w_d);
                    assert_eq!(got, expect, "query {qi} mismatch with w_c={w_c} w_d={w_d}");
                }
            }
        }
    }

    #[test]
    fn query_k_smaller_than_pool_returns_exact_top_k() {
        let vectors: Vec<[f32; 4]> = (0..100).map(pseudo).collect();
        let tree = KdTree::build(&vectors);
        let q = pseudo(17);
        for k in [1_usize, 5, 32] {
            let got = tree.query(&q, k, 1.0, 0.25);
            let expect = brute_force(&vectors, &q, k, 1.0, 0.25);
            assert_eq!(got, expect, "k={k}");
        }
    }

    #[test]
    fn query_on_empty_tree_returns_empty() {
        let tree = KdTree::build(&[]);
        assert!(tree.query(&pseudo(1), 32, 1.0, 0.25).is_empty());
    }

    #[test]
    fn duplicate_vectors_are_order_stable() {
        // 同一ベクトルが複数ある場合: 同距離はタイル位置昇順で安定に返る
        let vectors: Vec<[f32; 4]> = vec![[10.0, 0.0, 0.0, 0.0]; 5];
        let tree = KdTree::build(&vectors);
        let got = tree.query(&[10.0, 0.0, 0.0, 0.0], 3, 1.0, 1.0);
        assert_eq!(got, vec![(0.0, 0), (0.0, 1), (0.0, 2)]);
    }

    #[test]
    fn build_size_is_within_2n() {
        // ノード数は各タイル 1 ノード(メモリ効率)
        let vectors: Vec<[f32; 4]> = (0..1000).map(pseudo).collect();
        let tree = KdTree::build(&vectors);
        assert_eq!(tree.nodes.len(), 1000);
    }
}
