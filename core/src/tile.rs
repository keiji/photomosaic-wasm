//! タイル特徴量・タイルプール(P2 タイル解析: 詳細設計書 4.3)。
//!
//! - 特徴量算出はブロック(P1)と同一の手法:
//!   線形 RGB で画素平均 → CIELAB(D65)の `mean_lab`、L* の標準偏差 `detail`
//! - 特徴量はブロックサイズに依存しないため、ブロックサイズ変更時は P2 を再実行しない
//!   (キャッシュ再利用。詳細設計書 4.3 の 4)
//! - 特徴量用サムネイル(32×32)はホスト側でボックスフィルタ(面積平均)縮小して渡す。
//!   合成用サムネイル(長辺 64 上限)はコア内に保持し(P4 合成で使用)、
//!   合計バイト数をメモリガード(詳細設計書 5 章 memory_guard)で監視する

use crate::color::{linear_rgb_to_lstar, srgb8_linear_lut};
use crate::kdtree::{KdTree, KD_QUERY_K, KD_TREE_THRESHOLD, VECTOR_DIMS};
use crate::metrics::SpanAgg;
use std::collections::BTreeMap;
use std::fmt;

/// 特徴量算出用サムネイルの 1 辺 px(詳細設計書 5 章 feature_thumb、32×32 固定)
pub const FEATURE_THUMB: u32 = 32;

/// 合成用サムネイルの長辺上限 px(詳細設計書 5 章 compose_thumb_max、固定)
pub const COMPOSE_THUMB_MAX: u32 = 64;

/// 合成用サムネイル長辺の下限 px(メモリガード自動半減の下限。詳細設計書 6 章)
pub const COMPOSE_THUMB_MIN_EDGE: u32 = 16;

/// 合成用サムネイル合計の上限バイト数(詳細設計書 5 章 memory_guard、既定 512 MB)。
/// 超過時(自動縮小では収まらない場合)はホストへエラーを通知する
pub const MEMORY_GUARD_BYTES: u64 = 512 * 1024 * 1024;

/// タイル特徴量(詳細設計書 3 章 TileFeature)
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TileFeature {
    /// アプリ側が採番する ID
    pub id: u64,
    /// 合成用サムネイル寸法(P4 でブロック矩形へスケーリング描画する際の元)
    pub thumb_w: u32,
    pub thumb_h: u32,
    /// CIELAB 平均 (L*, a*, b*)
    pub mean_lab: [f32; 3],
    /// タイル内 L*(明度)の標準偏差(0..128)
    pub detail: f32,
    /// 現在の使用回数(P3 の使用ペナルティ用。M4 のマッチング実装で更新開始)
    pub usage: u32,
}

/// 特徴量用サムネイルからタイル特徴量を算出する(P2)。
///
/// `rgba` は R→G→B→A 順・行優先の 1 ピクセル 4 バイト。アルファは
/// ホスト側で白背景合成済みであるため無視する(詳細設計書 4.3 の 1)。
/// 戻り値は `(mean_lab, detail)`。計算手法はブロック特徴量(grid.rs)と同一。
pub fn analyze_tile_feature(rgba: &[u8], width: u32, height: u32) -> ([f32; 3], f32) {
    assert!(
        width > 0 && height > 0,
        "tile thumbnail size must be positive"
    );
    let pixel_count = usize::try_from(width).expect("width fits usize")
        * usize::try_from(height).expect("height fits usize");
    assert_eq!(rgba.len(), pixel_count * 4, "rgba buffer length mismatch");

    let lut = srgb8_linear_lut();
    let mut sum_linear = [0.0_f64; 3];
    let mut sum_lstar = 0.0_f64;
    let mut sum_lstar_sq = 0.0_f64;

    for pixel in rgba.as_chunks::<4>().0 {
        let lr = lut[pixel[0] as usize];
        let lg = lut[pixel[1] as usize];
        let lb = lut[pixel[2] as usize];

        // 線形 RGB で画素平均を取る(sRGB のまま平均しない。P1 と同一手法)
        sum_linear[0] += lr;
        sum_linear[1] += lg;
        sum_linear[2] += lb;

        // detail 用: 画素ごとの L*
        let lstar = linear_rgb_to_lstar(lr, lg, lb);
        sum_lstar += lstar;
        sum_lstar_sq += lstar * lstar;
    }

    let n = f64::from(u32::try_from(pixel_count).expect("pixel count fits u32"));
    let mean_linear = [sum_linear[0] / n, sum_linear[1] / n, sum_linear[2] / n];
    let mean_xyz = crate::color::linear_rgb_to_xyz(mean_linear[0], mean_linear[1], mean_linear[2]);
    let mean_lab = crate::color::xyz_to_lab(mean_xyz[0], mean_xyz[1], mean_xyz[2]);

    // detail: L* の母標準偏差(平均 L* 回りの分散。丸めによる負値は 0 にクランプ)
    let mean_l = sum_lstar / n;
    let variance = (sum_lstar_sq / n - mean_l * mean_l).max(0.0);

    (
        [mean_lab[0] as f32, mean_lab[1] as f32, mean_lab[2] as f32],
        variance.sqrt() as f32,
    )
}

/// タイルプール操作のエラー
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TilePoolError {
    /// 特徴量用サムネイルの寸法が 32×32([`FEATURE_THUMB`])でない
    FeatureSizeMismatch,
    /// 合成用サムネイルの寸法が不正(0 を含む、または長辺が [`COMPOSE_THUMB_MAX`] 超)
    ComposeSizeInvalid,
    /// バッファ長が寸法と不一致
    BufferLengthMismatch,
    /// 存在しないタイル ID への操作
    UnknownTile { id: u64 },
    /// メモリガード超過(詳細設計書 5 章 memory_guard)
    MemoryGuardExceeded {
        required_bytes: u64,
        limit_bytes: u64,
    },
}

impl fmt::Display for TilePoolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TilePoolError::FeatureSizeMismatch => {
                write!(f, "feature thumbnail must be {FEATURE_THUMB}x{FEATURE_THUMB}")
            }
            TilePoolError::ComposeSizeInvalid => {
                write!(f, "compose thumbnail edge must be within {COMPOSE_THUMB_MAX}px")
            }
            TilePoolError::BufferLengthMismatch => write!(f, "rgba buffer length mismatch"),
            TilePoolError::UnknownTile { id } => write!(f, "unknown tile id: {id}"),
            TilePoolError::MemoryGuardExceeded {
                required_bytes,
                limit_bytes,
            } => write!(
                f,
                "memory guard exceeded: {required_bytes} bytes required, limit is {limit_bytes} bytes"
            ),
        }
    }
}

impl std::error::Error for TilePoolError {}

/// タイルプール(解析済み構成画像の集合。詳細設計書 9 章の用語)。
///
/// 特徴量に加え、P4 合成で使う合成用サムネイルをコア内に保持する。
/// 合成用サムネイルの合計バイト数はメモリガードで監視し、超過の場合は
/// 長辺を自動で半減する(解像度を落として登録を続ける。詳細設計書 5 章/6 章)。
/// 大量タイル(> kd_tree_threshold)ではマッチング候補取得に k-d 木を使う
pub struct TilePool {
    features: BTreeMap<u64, TileFeature>,
    /// 合成用サムネイル(id → (幅, 高さ, RGBA))
    compose_thumbs: BTreeMap<u64, (u32, u32, Vec<u8>)>,
    total_compose_bytes: u64,
    guard_bytes: u64,
    /// 合成用サムネイル長辺の現上限(メモリガード自動半減で下がる)
    compose_max_edge: u32,
    /// k-d 木(遅延構築。タイルの登録変更で無効化。詳細設計書 4.5)
    index: Option<KdIndex>,
    /// k-d 木構築の状態(構築回数と所要の累積。計測の常時化)
    index_build_stats: SpanAgg,
    /// k-d 木に切り替えるタイル数閾値(既定 [`KD_TREE_THRESHOLD`]。テスト上書き用)
    kd_threshold: u32,
}

/// k-d 木と、木の葉での保持順に対応したタイル ID リスト
struct KdIndex {
    tree: KdTree,
    tile_ids: Vec<u64>,
}

impl TilePool {
    /// 既定のメモリガード([`MEMORY_GUARD_BYTES`])でプールを生成する
    pub fn new() -> Self {
        Self::with_guard(MEMORY_GUARD_BYTES)
    }

    /// メモリガードの上限バイト数を指定してプールを生成する(テスト・将来の設定用)
    pub fn with_guard(guard_bytes: u64) -> Self {
        TilePool {
            features: BTreeMap::new(),
            compose_thumbs: BTreeMap::new(),
            total_compose_bytes: 0,
            guard_bytes,
            compose_max_edge: COMPOSE_THUMB_MAX,
            index: None,
            index_build_stats: SpanAgg::default(),
            kd_threshold: KD_TREE_THRESHOLD,
        }
    }

    /// タイルを解析してプールへ登録する(P2)。
    ///
    /// - `feature_rgba`: 特徴量用サムネイル(32×32 固定。ボックスフィルタ縮小済み)
    /// - `compose_rgba`: 合成用サムネイル(現長辺上限内、アスペクト維持)
    /// - 同一 `id` が既に存在する場合は置き換える(解析のやり直しに対応)
    /// - 登録がメモリガード([`MEMORY_GUARD_BYTES`])を超える場合は、合成用
    ///   サムネイル長辺上限を自動で半減し、既存分を含めて再サンプリングして
    ///   収める(詳細設計書 5 章 memory_guard / 6 章 超大量タイル)。
    ///   下限([`COMPOSE_THUMB_MIN_EDGE`])に達しても収まらない場合は拒否する
    pub fn add_tile(
        &mut self,
        id: u64,
        feature_rgba: &[u8],
        compose_rgba: &[u8],
        compose_w: u32,
        compose_h: u32,
    ) -> Result<TileFeature, TilePoolError> {
        if compose_w == 0 || compose_h == 0 || compose_w.max(compose_h) > COMPOSE_THUMB_MAX {
            return Err(TilePoolError::ComposeSizeInvalid);
        }
        let compose_bytes =
            u64::try_from(compose_rgba.len()).map_err(|_| TilePoolError::BufferLengthMismatch)?;
        if compose_bytes != u64::from(compose_w) * u64::from(compose_h) * 4 {
            return Err(TilePoolError::BufferLengthMismatch);
        }
        let feature_bytes =
            u64::try_from(feature_rgba.len()).map_err(|_| TilePoolError::BufferLengthMismatch)?;
        if feature_bytes != u64::from(FEATURE_THUMB) * u64::from(FEATURE_THUMB) * 4 {
            return Err(TilePoolError::FeatureSizeMismatch);
        }
        let (mean_lab, detail) = analyze_tile_feature(feature_rgba, FEATURE_THUMB, FEATURE_THUMB);
        // 置き換えの場合は既存分を解放したうえで判定する
        let replaced_bytes = self
            .compose_thumbs
            .get(&id)
            .map(|(_, _, buf)| buf.len() as u64)
            .unwrap_or(0);

        // 受入分の寸法: 既に長辺上限が下がっている場合(メモリガードで自動半減
        // 済みのプール)は受入時点で再サンプリングする
        let mut w = compose_w;
        let mut h = compose_h;
        let mut buf = compose_rgba.to_vec();
        if compose_w.max(compose_h) > self.compose_max_edge {
            let (nw, nh, nb) =
                downsample_rgba(compose_rgba, compose_w, compose_h, self.compose_max_edge);
            w = nw;
            h = nh;
            buf = nb;
        }

        // 登録が収まるまで長辺の半減と全サムネイルの再サンプリングを繰り返す
        loop {
            let new_total = self.total_compose_bytes - replaced_bytes + buf.len() as u64;
            if new_total <= self.guard_bytes {
                break;
            }
            let next = (self.compose_max_edge / 2).max(COMPOSE_THUMB_MIN_EDGE);
            if next >= self.compose_max_edge {
                // 下限に達している(これ以上の自動縮小は不可能)
                return Err(TilePoolError::MemoryGuardExceeded {
                    required_bytes: new_total,
                    limit_bytes: self.guard_bytes,
                });
            }
            self.compose_max_edge = next;
            self.downsample_all_thumbs();
            if w.max(h) > self.compose_max_edge {
                let (nw, nh, nb) = downsample_rgba(&buf, w, h, self.compose_max_edge);
                w = nw;
                h = nh;
                buf = nb;
            }
        }

        let feature = TileFeature {
            id,
            thumb_w: w,
            thumb_h: h,
            mean_lab,
            detail,
            usage: 0,
        };
        // k-d 木はタイルの追加・置き換えで無効化する(次のマッチングで再構築)
        self.index = None;
        self.features.insert(id, feature);
        self.compose_thumbs.insert(id, (w, h, buf));
        self.total_compose_bytes =
            self.total_compose_bytes + compose_w_h_bytes(w, h) - replaced_bytes;
        Ok(feature)
    }
    /// メモリガード超過時の応動(自動縮小)は [`Self::add_tile`] の登録ループで
    /// 実装した([`Self::downsample_all_thumbs`] を繰り返し適用する): 旧版の
    /// `shrink_for_guard` は統合により削除
    /// 全タイルの合成用サムネイルを現長辺上限に合わせて面積平均で再サンプリングする
    fn downsample_all_thumbs(&mut self) {
        let updated: Vec<(u64, u32, u32, Vec<u8>)> = self
            .compose_thumbs
            .iter()
            .filter(|(_, (w, h, _))| (*w).max(*h) > self.compose_max_edge)
            .map(|(id, (w, h, buf))| {
                let (nw, nh, nb) = downsample_rgba(buf, *w, *h, self.compose_max_edge);
                (*id, nw, nh, nb)
            })
            .collect();
        for (id, w, h, buf) in updated {
            self.total_compose_bytes -= self.compose_thumbs[&id].2.len() as u64;
            self.compose_thumbs.insert(id, (w, h, buf));
            self.total_compose_bytes += self.compose_thumbs[&id].2.len() as u64;
            if let Some(feature) = self.features.get_mut(&id) {
                feature.thumb_w = w;
                feature.thumb_h = h;
            }
            self.index = None; // 特徴ベクトル(寸法)は不変だが安全側で無効化する
        }
    }

    /// プールからタイルを削除する。該当タイルが割当られていたブロックの
    /// 再マッチ(詳細設計書 4.4 差分再マッチ)は割当表を保持する呼び出し側が行う
    pub fn remove_tile(&mut self, id: u64) -> Result<(), TilePoolError> {
        match self.compose_thumbs.remove(&id) {
            Some((_, _, buf)) => {
                self.total_compose_bytes -= buf.len() as u64;
                self.features.remove(&id);
                self.index = None;
                Ok(())
            }
            None => Err(TilePoolError::UnknownTile { id }),
        }
    }

    /// プールを空にする(リセット操作に対応)
    pub fn clear(&mut self) {
        self.features.clear();
        self.compose_thumbs.clear();
        self.total_compose_bytes = 0;
        self.index = None;
    }

    /// 登録済みタイル数
    pub fn tile_count(&self) -> u32 {
        self.features.len() as u32
    }

    /// 合成用サムネイルの合計バイト数(メモリガードの監視値)
    pub fn total_compose_bytes(&self) -> u64 {
        self.total_compose_bytes
    }

    /// 指定 ID の特徴量を返す
    pub fn feature(&self, id: u64) -> Option<&TileFeature> {
        self.features.get(&id)
    }

    /// 全タイルの特徴量(ID 昇順。決定的な走査順序を P3 マッチングで利用)
    pub fn features(&self) -> impl Iterator<Item = &TileFeature> {
        self.features.values()
    }

    /// 指定 ID の使用回数を 1 加算する(P3 の使用ペナルティ・M4 で使用開始)。
    /// 存在しない ID は無視する(マッチングは登録済み ID のみを扱うため防御的な no-op)
    pub fn bump_usage(&mut self, id: u64) {
        if let Some(feature) = self.features.get_mut(&id) {
            feature.usage = feature.usage.saturating_add(1);
        }
    }

    /// 指定 ID の使用回数を 1 減算する(差分再マッチの差し替え評価用。M6)。
    /// 存在しない ID・既に 0 の場合は no-op(飽和演算)
    pub fn decrease_usage(&mut self, id: u64) {
        if let Some(feature) = self.features.get_mut(&id) {
            feature.usage = feature.usage.saturating_sub(1);
        }
    }

    /// 現割当表から使用回数を再集計する(詳細設計書 4.4 差分再マッチ:
    /// 「使用回数 usage は再マッチ後に現割当表から再集計する。ペナルティの
    /// 連続性を保つ」)。全タイルをリセットしてから割当 1 件ごとに加算する
    pub fn recount_usage(&mut self, assigned: &[Option<u64>]) {
        self.reset_usage();
        for tile_id in assigned.iter().flatten() {
            self.bump_usage(*tile_id);
        }
    }

    /// 全タイルの使用回数が上限 `cap` に達しているか(詳細設計書 4.4)。
    /// `cap == 0` は無制限として常に `false` を返す。プール空も `false`(リセット不要)
    pub fn all_usage_reached(&self, cap: u32) -> bool {
        if cap == 0 {
            return false;
        }
        !self.features.is_empty() && self.features.values().all(|feature| feature.usage >= cap)
    }

    /// 全タイルの使用回数を 0 に戻す(usage cap 到達時の一括リセット、
    /// および初回マッチング前の正規化。詳細設計書 4.4)
    pub fn reset_usage(&mut self) {
        for feature in self.features.values_mut() {
            feature.usage = 0;
        }
    }

    /// 指定 ID の合成用サムネイルを返す(P4 合成用。M4 以降で使用)
    pub fn compose_thumb(&self, id: u64) -> Option<(u32, u32, &[u8])> {
        self.compose_thumbs
            .get(&id)
            .map(|(w, h, buf)| (*w, *h, buf.as_slice()))
    }

    /// 現在の合成用サムネイル長辺上限(メモリガード自動半減で下がる。M7)
    pub fn compose_max_edge(&self) -> u32 {
        self.compose_max_edge
    }

    /// k-d 木を使用中か(タイル数が閾値を超えているか。M7)
    pub fn uses_kd_index(&self) -> bool {
        (self.features.len() as u32) > self.kd_threshold
    }

    /// k-d 木構築の状態(構築回数・累計・最大・平均。計測の常時化: M7)
    pub fn index_build_stats(&self) -> SpanAgg {
        self.index_build_stats
    }

    /// マッチング・差し替え評価に使う候補タイルの ID を返す(昇順・重複なし)。
    ///
    /// - タイル数 <= kd_threshold の場合は空を返す(呼び出し側は総当たり)
    /// - 超える場合は k-d 木で重み付き近傍上位 [`KD_QUERY_K`] 件を取得する
    ///   (構築は遅延。構築時間は index_build_stats へ累積する)
    /// - 候補外のタイルの完全な距離は評価されないため、P3 距離関数順位の
    ///   近似となる(使用ペナルティ・隣接ペナルティは候補取得後の再評価で
    ///   反映 = 詳細設計書 4.5 の規定)
    pub fn candidates_for(
        &mut self,
        block: &crate::grid::BlockFeature,
        config: &crate::config::MosaicConfig,
    ) -> Vec<u64> {
        if !self.uses_kd_index() {
            return Vec::new();
        }
        if self.index.is_none() {
            let t0 = crate::metrics::now_ms();
            let tile_ids: Vec<u64> = self.features.keys().copied().collect();
            let vectors: Vec<[f32; VECTOR_DIMS]> = self
                .features
                .values()
                .map(|f| [f.mean_lab[0], f.mean_lab[1], f.mean_lab[2], f.detail])
                .collect();
            let tree = KdTree::build(&vectors);
            self.index_build_stats.record(crate::metrics::now_ms() - t0);
            self.index = Some(KdIndex { tree, tile_ids });
        }
        let Some(index) = self.index.as_ref() else {
            return Vec::new();
        };
        let query = [
            block.mean_lab[0],
            block.mean_lab[1],
            block.mean_lab[2],
            block.detail,
        ];
        let mut ids: Vec<u64> = index
            .tree
            .query(&query, KD_QUERY_K, config.w_c, config.w_d)
            .into_iter()
            .map(|(_, tile_i)| {
                index.tile_ids[usize::try_from(tile_i).expect("tree index fits usize")]
            })
            .collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    }

    /// 指定 ID リストの特徴量をリストの順に返す(ID 昇順を前提。存在しない ID はスキップ)。
    /// 候補(k-d 木または全体)から完全な距離評価対象を取り出すのに使う
    pub(crate) fn features_for(&self, ids: &[u64]) -> Vec<TileFeature> {
        ids.iter()
            .filter_map(|id| self.features.get(id).copied())
            .collect()
    }
}

impl Default for TilePool {
    fn default() -> Self {
        Self::new()
    }
}

/// 寸法から RGBA バイト数を計算する(w * h * 4。usize 変換の防御を一括化)
#[inline]
fn compose_w_h_bytes(w: u32, h: u32) -> u64 {
    u64::from(w) * u64::from(h) * 4
}

/// 面積平均(ボックスフィルタ)で RGBA を縮小する(アスペクト維持)。
///
/// 各出力ピクセルは旧画素の対応領域の平均(一般比率に対応)。
/// アルファ部分は出力 255 固定(入力は白背景合成済みで不透明)。
/// 合成サムネイル再サンプリングで色味の平均評価として十分な簡易実装
/// (M4 のホスト側縮小と同一の方針: 詳細設計書 4.3)
fn downsample_rgba(rgba: &[u8], w: u32, h: u32, max_edge: u32) -> (u32, u32, Vec<u8>) {
    let scale = f64::from(max_edge) / f64::from(w.max(h));
    let nw = ((f64::from(w) * scale).round() as u32).clamp(1, w);
    let nh = ((f64::from(h) * scale).round() as u32).clamp(1, h);
    if nw == w && nh == h {
        return (w, h, rgba.to_vec());
    }
    let mut out = vec![0_u8; nw as usize * nh as usize * 4];
    let w_f = f64::from(w);
    let h_f = f64::from(h);
    for oy in 0..nh {
        let y_begin = (f64::from(oy) * h_f / f64::from(nh)).floor() as u32;
        let y_end = (((oy + 1) as f64 * h_f / f64::from(nh)).ceil() as u32)
            .max(y_begin + 1)
            .min(h);
        for ox in 0..nw {
            let x_begin = (f64::from(ox) * w_f / f64::from(nw)).floor() as u32;
            let x_end = (((ox + 1) as f64 * w_f / f64::from(nw)).ceil() as u32)
                .max(x_begin + 1)
                .min(w);
            let mut sums = [0_u64; 3];
            for y in y_begin..y_end {
                let row = y as usize * w as usize * 4;
                for x in x_begin..x_end {
                    let offset = row + x as usize * 4;
                    sums[0] += u64::from(rgba[offset]);
                    sums[1] += u64::from(rgba[offset + 1]);
                    sums[2] += u64::from(rgba[offset + 2]);
                }
            }
            let count = u64::from((x_end - x_begin) * (y_end - y_begin));
            let out_o = (oy as usize * nw as usize + ox as usize) * 4;
            out[out_o] = (sums[0] / count) as u8;
            out[out_o + 1] = (sums[1] / count) as u8;
            out[out_o + 2] = (sums[2] / count) as u8;
            out[out_o + 3] = 255;
        }
    }
    (nw, nh, out)
}

#[cfg(test)]
impl TilePool {
    /// テスト用にタイル特徴量を直接登録する(add_tile はサムネイル寸法の
    /// 検証を行うため、距離計算・usage 制御のみの単体テストで使用する)
    pub(crate) fn insert_feature_for_test(&mut self, feature: TileFeature) {
        self.index = None;
        self.features.insert(feature.id, feature);
    }

    /// テスト用に登録済みタイルの特徴量を上書きする
    /// (add_tile はサムネイルから計算するため、距離計算の条件を固定したい
    /// テストで使用する。合成用サムネイルは add_tile 登録分をそのまま使う)
    pub(crate) fn overwrite_feature_for_test(&mut self, feature: TileFeature) {
        self.index = None;
        if let Some(stored) = self.features.get_mut(&feature.id) {
            *stored = feature;
        }
    }

    /// テスト用に k-d 木の切り替え閾値を下げる
    /// (大量タイルを作らず k-d 木経路の等価性を検証する)
    pub(crate) fn set_kd_threshold_for_test(&mut self, threshold: u32) {
        self.kd_threshold = threshold;
    }
}

impl fmt::Debug for TilePool {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // サムネイル実体(大容量)はダンプせず、監視に必要な集計のみを出力する
        f.debug_struct("TilePool")
            .field("tile_count", &self.features.len())
            .field("total_compose_bytes", &self.total_compose_bytes)
            .field("guard_bytes", &self.guard_bytes)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::srgb8_to_lab;

    fn close(a: f64, b: f64, eps: f64) -> bool {
        (a - b).abs() < eps
    }

    /// FEATURE_THUMB 角サイズの RGBA を生成する
    fn feature_rgba(size: u32) -> Vec<u8> {
        vec![128; (size * size * 4) as usize]
    }
    /// 単色(マゼンタ)の特徴量サムネイル
    fn magenta_feature() -> Vec<u8> {
        let mut rgba = Vec::new();
        for _ in 0..FEATURE_THUMB * FEATURE_THUMB {
            rgba.extend_from_slice(&[255, 0, 255, 255]);
        }
        rgba
    }

    /// 指定寸法の合成用サムネイル(RGBA)
    fn compose_rgba(w: u32, h: u32) -> Vec<u8> {
        vec![64; (w * h * 4) as usize]
    }

    #[test]
    fn uniform_tile_matches_srgb_to_lab() {
        // 単色タイル: mean_lab はその色の sRGB→Lab と一致し、detail は 0
        let (mean_lab, detail) =
            analyze_tile_feature(&magenta_feature(), FEATURE_THUMB, FEATURE_THUMB);
        let expected = srgb8_to_lab(255, 0, 255);
        assert!(close(f64::from(mean_lab[0]), expected[0], 1e-3));
        assert!(close(f64::from(mean_lab[1]), expected[1], 1e-3));
        assert!(close(f64::from(mean_lab[2]), expected[2], 1e-3));
        // 単色なので detail は 0(f64 累積の丸め残差が sqrt で増幅されるため 1e-4 許容)
        assert!(close(f64::from(detail), 0.0, 1e-4));
    }

    #[test]
    fn tile_detail_reflects_contrast() {
        // 左半分黒・右半分白のタイルは detail が大きい
        let mut rgba = Vec::new();
        for _y in 0..FEATURE_THUMB {
            for x in 0..FEATURE_THUMB {
                let v = if x < FEATURE_THUMB / 2 { 0 } else { 255 };
                rgba.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let (mean_lab, detail) = analyze_tile_feature(&rgba, FEATURE_THUMB, FEATURE_THUMB);
        // 半々の明度反転なので detail(画素ごとの L* の標準偏差)は 50 前後
        assert!(f64::from(detail) > 40.0, "detail = {detail}");
        // mean_lab は線形 RGB 平均 → Lab の結果(L*(Y=0.5) ≈ 76.07)。
        // sRGB のまま平均した L*(= 50)とは意図的に異なる(P1 と同一手法の確認)
        assert!(close(f64::from(mean_lab[0]), 76.07, 1.0));
    }

    #[test]
    fn non_square_feature_is_supported() {
        // タイルのアスペクトが 1:1 でない場合も寸法どおり計算する(全ピクセル平均)
        let (w, h) = (FEATURE_THUMB, FEATURE_THUMB / 2);
        let mut rgba = Vec::new();
        for _ in 0..w * h {
            rgba.extend_from_slice(&[10, 20, 30, 255]);
        }
        let (mean_lab, _) = analyze_tile_feature(&rgba, w, h);
        let expected = srgb8_to_lab(10, 20, 30);
        assert!(close(f64::from(mean_lab[0]), expected[0], 1e-3));
        assert!(close(f64::from(mean_lab[1]), expected[1], 1e-3));
        assert!(close(f64::from(mean_lab[2]), expected[2], 1e-3));
    }

    #[test]
    fn add_tile_registers_feature_and_bytes() {
        let mut pool = TilePool::new();
        let feature = pool
            .add_tile(1, &magenta_feature(), &compose_rgba(64, 32), 64, 32)
            .expect("add should succeed");
        assert_eq!(feature.id, 1);
        assert_eq!(feature.thumb_w, 64);
        assert_eq!(feature.thumb_h, 32);
        assert_eq!(feature.usage, 0);
        assert_eq!(pool.tile_count(), 1);
        assert_eq!(pool.total_compose_bytes(), 64 * 32 * 4);

        // 登録済み特徴量の参照
        let stored = pool.feature(1).expect("tile exists");
        assert_eq!(stored, &feature);

        // 2 枚追加で合計が加算される
        pool.add_tile(2, &magenta_feature(), &compose_rgba(32, 32), 32, 32)
            .expect("add should succeed");
        assert_eq!(pool.tile_count(), 2);
        assert_eq!(pool.total_compose_bytes(), (64 * 32 + 32 * 32) * 4);

        // ID 昇順で走査できる
        let ids: Vec<u64> = pool.features().map(|f| f.id).collect();
        assert_eq!(ids, vec![1, 2]);
    }

    #[test]
    fn add_tile_replaces_existing_id() {
        let mut pool = TilePool::new();
        pool.add_tile(1, &magenta_feature(), &compose_rgba(64, 64), 64, 64)
            .expect("add should succeed");
        assert_eq!(pool.total_compose_bytes(), 64 * 64 * 4);

        // 同一 id は置き換わる(二重計上されない)
        let smaller = compose_rgba(32, 32);
        let feature = pool
            .add_tile(1, &magenta_feature(), &smaller, 32, 32)
            .expect("replace should succeed");
        assert_eq!(feature.thumb_w, 32);
        assert_eq!(pool.tile_count(), 1);
        assert_eq!(pool.total_compose_bytes(), 32 * 32 * 4);
    }

    #[test]
    fn add_tile_rejects_wrong_feature_size() {
        let mut pool = TilePool::new();
        // 31×31(32×32 以外)は拒否
        let wrong = feature_rgba(31);
        assert_eq!(
            pool.add_tile(1, &wrong, &compose_rgba(32, 32), 32, 32),
            Err(TilePoolError::FeatureSizeMismatch)
        );
        assert_eq!(pool.tile_count(), 0);
    }

    #[test]
    fn add_tile_rejects_buffer_length_mismatch() {
        let mut pool = TilePool::new();
        assert_eq!(
            pool.add_tile(1, &magenta_feature(), &compose_rgba(16, 16), 32, 32),
            Err(TilePoolError::BufferLengthMismatch)
        );
        // 合成サムネイルの寸法 0 も不正
        assert_eq!(
            pool.add_tile(1, &magenta_feature(), &[], 0, 32),
            Err(TilePoolError::ComposeSizeInvalid)
        );
        assert_eq!(pool.tile_count(), 0);
    }

    #[test]
    fn add_tile_rejects_oversized_compose_thumb() {
        let mut pool = TilePool::new();
        // 長辺 65(> compose_thumb_max 64)は拒否
        assert_eq!(
            pool.add_tile(1, &magenta_feature(), &compose_rgba(65, 1), 65, 1),
            Err(TilePoolError::ComposeSizeInvalid)
        );
        assert_eq!(pool.tile_count(), 0);
    }

    #[test]
    fn remove_tile_frees_bytes_and_reports_unknown() {
        let mut pool = TilePool::new();
        pool.add_tile(1, &magenta_feature(), &compose_rgba(64, 64), 64, 64)
            .expect("add should succeed");

        pool.remove_tile(2).expect_err("unknown id must fail");
        assert_eq!(
            pool.remove_tile(2),
            Err(TilePoolError::UnknownTile { id: 2 })
        );

        pool.remove_tile(1).expect("remove should succeed");
        assert_eq!(pool.tile_count(), 0);
        assert_eq!(pool.total_compose_bytes(), 0);
        assert!(pool.feature(1).is_none());
    }

    #[test]
    fn clear_resets_pool() {
        let mut pool = TilePool::new();
        pool.add_tile(1, &magenta_feature(), &compose_rgba(64, 64), 64, 64)
            .expect("add should succeed");
        pool.clear();
        assert_eq!(pool.tile_count(), 0);
        assert_eq!(pool.total_compose_bytes(), 0);
        assert!(pool.compose_thumb(1).is_none());
    }

    #[test]
    fn recount_usage_reflects_assignment_table() {
        // 差分再マッチ(詳細設計書 4.4): 使用回数は現割当表から再集計する
        let mut pool = TilePool::new();
        pool.add_tile(1, &magenta_feature(), &compose_rgba(64, 64), 64, 64)
            .expect("add should succeed");
        pool.add_tile(2, &magenta_feature(), &compose_rgba(64, 64), 64, 64)
            .expect("add should succeed");
        pool.add_tile(3, &magenta_feature(), &compose_rgba(64, 64), 64, 64)
            .expect("add should succeed");

        // 事前状態: bump による usage(旧表と不一致な状態を作る)
        pool.bump_usage(1);
        pool.bump_usage(1);
        pool.bump_usage(2);

        // 割当表(1: 2 件、2: 0 件、3: 1 件、未確定 1 件)から再集計する
        let assigned = [Some(1_u64), Some(3_u64), Some(1_u64), None];
        pool.recount_usage(&assigned);
        assert_eq!(pool.feature(1).expect("tile 1").usage, 2);
        assert_eq!(pool.feature(2).expect("tile 2").usage, 0);
        assert_eq!(pool.feature(3).expect("tile 3").usage, 1);
    }

    #[test]
    fn decrease_usage_saturates_at_zero() {
        let mut pool = TilePool::new();
        pool.add_tile(1, &magenta_feature(), &compose_rgba(64, 64), 64, 64)
            .expect("add should succeed");
        // 0 からの減算は no-op(飽和)
        pool.decrease_usage(1);
        assert_eq!(pool.feature(1).expect("tile 1").usage, 0);
        pool.bump_usage(1);
        pool.decrease_usage(1);
        assert_eq!(pool.feature(1).expect("tile 1").usage, 0);
        // 存在しない ID も no-op
        pool.decrease_usage(999);
    }

    #[test]
    fn memory_guard_auto_shrinks_thumbs_then_rejects_at_floor() {
        // メモリガード拡張(M7): 上限に達すると長辺を自動半減する。
        // 極小ガード(1,000 バイト)では 16×16(1,024 バイト)まで下げても
        // 収まらないため、その時点の所要で拒否される
        let mut pool = TilePool::with_guard(1_000);
        assert_eq!(
            pool.add_tile(1, &magenta_feature(), &compose_rgba(64, 64), 64, 64),
            Err(TilePoolError::MemoryGuardExceeded {
                required_bytes: 1_024,
                limit_bytes: 1_000,
            })
        );
        assert_eq!(pool.tile_count(), 0);
        assert_eq!(pool.total_compose_bytes(), 0);

        // 上限内なら追加でき、超える 2 枚目では長辺 64 → 32 に自動半減して
        // 既存タイル + 追加タイルがともに 32×32 になり収まる(拒否されない)
        let mut pool = TilePool::with_guard(20_000);
        pool.add_tile(1, &magenta_feature(), &compose_rgba(64, 64), 64, 64)
            .expect("add should succeed");
        pool.add_tile(2, &magenta_feature(), &compose_rgba(64, 64), 64, 64)
            .expect("auto-shrunk addition should succeed");
        assert_eq!(pool.tile_count(), 2);
        assert_eq!(pool.compose_max_edge(), 32);
        let feature1 = pool.feature(1).expect("tile 1");
        let feature2 = pool.feature(2).expect("tile 2");
        assert_eq!(feature1.thumb_w, 32, "existing thumb is resampled");
        assert_eq!(feature2.thumb_w, 32, "incoming thumb is resampled");
        assert_eq!(pool.total_compose_bytes(), 2 * 32 * 32 * 4);
        // 合成サムネイルも 32×32 の寸法で残っている(handshake 上寸法整合)
        assert_eq!(
            pool.compose_thumb(1).map(|(w, h, _)| (w, h)),
            Some((32, 32))
        );
    }

    #[test]
    fn memory_guard_allows_replacement_within_limit() {
        // 置き換えは既存分を解放したうえで判定する
        let mut pool = TilePool::with_guard(20_000);
        pool.add_tile(1, &magenta_feature(), &compose_rgba(64, 64), 64, 64)
            .expect("add should succeed");
        // 置き換え(16,384 → 16,384)は同一サイズなのでガード内
        pool.add_tile(1, &magenta_feature(), &compose_rgba(64, 64), 64, 64)
            .expect("replace within limit should succeed");
        assert_eq!(pool.tile_count(), 1);
        assert_eq!(pool.total_compose_bytes(), 16_384);
    }

    /// FNV-1a 64bit(依存なしの決定的ハッシュ。ゴールデン比較用)
    fn fnv1a64(bytes: &[u8]) -> u64 {
        const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
        const PRIME: u64 = 0x0000_0100_0000_01b3;
        let mut hash = OFFSET;
        for &byte in bytes {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(PRIME);
        }
        hash
    }

    fn feature_bytes(features: &[TileFeature]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for f in features {
            bytes.extend_from_slice(&f.id.to_le_bytes());
            bytes.extend_from_slice(&f.thumb_w.to_le_bytes());
            bytes.extend_from_slice(&f.thumb_h.to_le_bytes());
            for v in f.mean_lab {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
            bytes.extend_from_slice(&f.detail.to_le_bytes());
            bytes.extend_from_slice(&f.usage.to_le_bytes());
        }
        bytes
    }

    /// 決定的なテストタイルを生成する(乱数シードなし。x/y の線形組合せのみ)
    fn golden_test_tile(width: u32, height: u32) -> Vec<u8> {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let r = ((x * 7 + y * 13) % 256) as u8;
                let g = ((x * 5 + y * 11 + 64) % 256) as u8;
                let b = ((x * 3 + y * 17 + 128) % 256) as u8;
                rgba.extend_from_slice(&[r, g, b, 255]);
            }
        }
        rgba
    }

    /// ゴールデン検証(詳細設計書 11 章): 固定入力 → 決定的出力をハッシュ比較する。
    /// 出力が変わる変更(意図した仕様変更を含む)では、このハッシュの更新が必要。
    #[test]
    fn golden_hash_of_fixed_input() {
        let tile = golden_test_tile(FEATURE_THUMB, FEATURE_THUMB);
        let (mean_lab, detail) = analyze_tile_feature(&tile, FEATURE_THUMB, FEATURE_THUMB);

        let feature = TileFeature {
            id: 7,
            thumb_w: COMPOSE_THUMB_MAX,
            thumb_h: COMPOSE_THUMB_MAX / 2,
            mean_lab,
            detail,
            usage: 0,
        };

        // 同一入力から同一出力が得られること(決定性)
        let (mean_lab2, detail2) = analyze_tile_feature(&tile, FEATURE_THUMB, FEATURE_THUMB);
        assert_eq!(mean_lab, mean_lab2);
        assert_eq!(detail, detail2);

        // ゴールデンハッシュ
        assert_eq!(
            fnv1a64(&feature_bytes(&[feature])),
            0x52AE_599A_A020_6B5E, // M7: L* 前計算(4,096 分割)の導入で f32 格納値が丸め境界で変化
            "golden hash mismatch: inspect intentional spec changes and update this value"
        );
    }

    #[test]
    fn tile_analyze_performance_budget() {
        // 完了条件(handoff/04 M3): 特徴量が 1 枚あたり数 ms で計算されること。
        // 300 枚(性能計測設計 S-mid 相当)を連続計算し、1 枚あたりの平均を検証する。
        // タイマーは std::time のみに依存し、環境ごとの絶対値は変わるため
        // 本検証は緩い上限(目標の 20 倍)でリグレッション検知とする。
        let tile = golden_test_tile(FEATURE_THUMB, FEATURE_THUMB);
        let start = std::time::Instant::now();
        let runs = 300;
        for _ in 0..runs {
            // 計算結果が最適化で消えないよう black_box で参照する
            let (mean_lab, detail) = analyze_tile_feature(&tile, FEATURE_THUMB, FEATURE_THUMB);
            std::hint::black_box(&mean_lab);
            std::hint::black_box(&detail);
        }
        let per_tile_us = start.elapsed().as_micros() / runs;
        // 目標: 200ms / 300 枚 ≈ 667µs/枚 → CI の環境差を考慮し 20 倍(≈13ms)を上限とする
        assert!(
            per_tile_us < 13_000,
            "tile analyze per tile = {per_tile_us}µs, budget is 13,000µs"
        );
    }
}
