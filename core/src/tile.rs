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
use std::collections::BTreeMap;
use std::fmt;

/// 特徴量算出用サムネイルの 1 辺 px(詳細設計書 5 章 feature_thumb、32×32 固定)
pub const FEATURE_THUMB: u32 = 32;

/// 合成用サムネイルの長辺上限 px(詳細設計書 5 章 compose_thumb_max、固定)
pub const COMPOSE_THUMB_MAX: u32 = 64;

/// 合成用サムネイル合計の上限バイト数(詳細設計書 5 章 memory_guard、既定 512 MB)。
/// 超過時はホストへエラーを通知し、M7 でサムネイル解像度の自動半減へ拡張する
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
/// 合成用サムネイルの合計バイト数はメモリガードで監視し、超過する追加は拒否する。
pub struct TilePool {
    features: BTreeMap<u64, TileFeature>,
    /// 合成用サムネイル(id → (幅, 高さ, RGBA))
    compose_thumbs: BTreeMap<u64, (u32, u32, Vec<u8>)>,
    total_compose_bytes: u64,
    guard_bytes: u64,
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
        }
    }

    /// タイルを解析してプールへ登録する(P2)。
    ///
    /// - `feature_rgba`: 特徴量用サムネイル(32×32 固定。ボックスフィルタ縮小済み)
    /// - `compose_rgba`: 合成用サムネイル(長辺 64 上限、アスペクト維持)
    /// - 同一 `id` が既に存在する場合は置き換える(解析のやり直しに対応)
    /// - 追加によってメモリガードを超える場合は登録せずに拒否する
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

        // 置き換えの場合は既存分を解放したうえでガード判定する
        let replaced_bytes = self
            .compose_thumbs
            .get(&id)
            .map(|(_, _, buf)| buf.len() as u64)
            .unwrap_or(0);
        let new_total = self.total_compose_bytes - replaced_bytes + compose_bytes;
        if new_total > self.guard_bytes {
            return Err(TilePoolError::MemoryGuardExceeded {
                required_bytes: new_total,
                limit_bytes: self.guard_bytes,
            });
        }

        let feature = TileFeature {
            id,
            thumb_w: compose_w,
            thumb_h: compose_h,
            mean_lab,
            detail,
            usage: 0,
        };
        self.features.insert(id, feature);
        self.compose_thumbs
            .insert(id, (compose_w, compose_h, compose_rgba.to_vec()));
        self.total_compose_bytes = new_total;
        Ok(feature)
    }

    /// プールからタイルを削除する。割当中ブロックの再マッチ対象化は M4 以降で扱う
    pub fn remove_tile(&mut self, id: u64) -> Result<(), TilePoolError> {
        match self.compose_thumbs.remove(&id) {
            Some((_, _, buf)) => {
                self.total_compose_bytes -= buf.len() as u64;
                self.features.remove(&id);
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

    /// 指定 ID の合成用サムネイルを返す(P4 合成用。M4 以降で使用)
    pub fn compose_thumb(&self, id: u64) -> Option<(u32, u32, &[u8])> {
        self.compose_thumbs
            .get(&id)
            .map(|(w, h, buf)| (*w, *h, buf.as_slice()))
    }
}

impl Default for TilePool {
    fn default() -> Self {
        Self::new()
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
    fn memory_guard_rejects_addition() {
        // 上限 1,000 バイトのガードで 64×64(16,384 バイト)は即座に超過
        let mut pool = TilePool::with_guard(1_000);
        assert_eq!(
            pool.add_tile(1, &magenta_feature(), &compose_rgba(64, 64), 64, 64),
            Err(TilePoolError::MemoryGuardExceeded {
                required_bytes: 16_384,
                limit_bytes: 1_000,
            })
        );
        assert_eq!(pool.tile_count(), 0);
        assert_eq!(pool.total_compose_bytes(), 0);

        // 上限内なら追加でき、超える 2 枚目は拒否される
        let mut pool = TilePool::with_guard(20_000);
        pool.add_tile(1, &magenta_feature(), &compose_rgba(64, 64), 64, 64)
            .expect("add should succeed");
        assert_eq!(
            pool.add_tile(2, &magenta_feature(), &compose_rgba(64, 64), 64, 64),
            Err(TilePoolError::MemoryGuardExceeded {
                required_bytes: 32_768,
                limit_bytes: 20_000,
            })
        );
        // 拒否後も状態は壊れていない
        assert_eq!(pool.tile_count(), 1);
        assert_eq!(pool.total_compose_bytes(), 16_384);
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
            0x6C85_F20E_407E_D8C6,
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
