//! パラメータ・閾値の既定値と範囲検証(詳細設計書 5 章)。
//!
//! 「コード内定数はこの表を単一の情報源とする」ため、マッチング・合成の
//! パラメータはすべてこの構造体に集約する。既定値は `Default`、
//! 上書きはホストからの `setConfig`(JSON)経由で行い、[`MosaicConfig::validate`]
//! で詳細設計書 5 章の「範囲」列どおり検証する。
//!
//! 設計書で「固定」とされているパラメータ(`identical_de`)も参照の一貫性のため
//! 構造体に含めるが、検証は正値のみを行う(既定値から変える想定はない)。

/// マッチング(P3)と合成(P4)のパラメータ(詳細設計書 5 章)。
///
/// フィールド名は詳細設計書 5 章のパラメータ名と一致させる
/// (w_c / w_d / λ=usage_penalty / n_p=neighbor_penalty / α=color_correct)。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MosaicConfig {
    /// 色距離 (ΔE76) の重み w_c。既定 1.0、範囲 0.5〜2.0
    pub w_c: f32,
    /// ディテール差の重み w_d。既定 0.25、範囲 0〜1.0
    pub w_d: f32,
    /// 使用回数ペナルティ係数 λ(usage_penalty)。既定 0.35、範囲 0〜1.0
    pub usage_penalty: f32,
    /// 直上/直左と近いタイルのペナルティ n_p(neighbor_penalty、ΔE 換算)。
    /// 既定 0.5、範囲 0〜1.0。近さの度合い(nearness)に乗じて加算する
    pub neighbor_penalty: f32,
    /// 隣接ペナルティが効く色距離の半径 neighbor_de(ΔE76 換算)。
    /// 既定 8.0、範囲 2〜16。候補タイルと直上・直左タイルの代表色距離がこの値
    /// 以内のとき、近いほど大きいペナルティ(距離 0 で n_p の最大値)を加算する
    /// (詳細設計書 4.4: 似たタイル同士の隣接配置を抑制する)
    pub neighbor_de: f32,
    /// 「視覚上同一」とみなす ΔE76 閾値。固定(2.0)
    pub identical_de: f32,
    /// 差分再マッチ(タイル追加時)の差し替え判定マージン improve_margin。
    /// 現割当の距離が候補の距離よりこの値以上悪いときだけ差し替える(ΔE 換算)。
    /// 既定 1.0、範囲 0.5〜2.0
    pub improve_margin: f32,
    /// 類似タイルの同一視閾値 duplicate_de(ΔE76 換算)。既定 2.0、範囲 0.5〜8.0。
    /// 代表色の距離がこの値以下のタイル同士は「重複グループ」にまとめられ、
    /// 使用ペナルティと usage_cap のリセット判定がグループ単位になる
    /// (同一写真の複製・至近バーストが個別の usage で使われ続けるのを防ぐ)。
    /// 隣接配置の抑制は duplicate_de とは別の neighbor_de(近さペナルティ)で行う
    pub duplicate_de: f32,
    /// 類似タイルの同一視閾値 duplicate_detail(detail 差)。既定 4.0、範囲 0〜32。
    /// duplicate_de と併せて満たすときだけ同一視する(同色でも平坦/複雑は別物)
    pub duplicate_detail: f32,
    /// 1 グループの最大使用回数 usage_cap。既定 1 回、0 = 無制限。
    /// no_reuse OFF のときは、全グループが上限に達するまで未使用グループだけを
    /// 候補にし、到達後に usage をリセットして次の周期を開始する(ローリング)。
    pub usage_cap: u32,
    /// 同一特徴量グループの再利用を禁止する no_reuse。既定 true。
    /// true の場合、重複グループ(似た特徴量のタイル)は最大 1 回だけ使用され、
    /// 未使用タイルがなくなったブロックは未確定のまま残る(背景)。
    pub no_reuse: bool,
    /// ブロック平均色へのトーン補正強度 α(color_correct)。既定 0.85、範囲 0〜1.0。
    /// 0.7 → 0.85 への引き上げは、タイル代表色の周囲重み付き平均化(詳細設計書
    /// 4.3)と組み合わせて背景の継ぎ目・粒状感(つぶつぶ)を抑える趣旨
    pub color_correct: f32,
    /// メイン画像のブレンド不透明度 main_blend(詳細設計書 4.6)。既定 0.2、範囲 0〜0.8。
    /// 合成済みブロック画素の上に元のメイン画像を不透明度 main_blend で重ねる
    /// (0 でブレンドなし=純モザイク。値が大きいほどメイン画像が強く現れ、
    /// タイルの模様は薄れる)
    pub main_blend: f32,
    /// 進捗・部分描画の行バッチ単位 row_batch。既定 8 行、範囲 4〜32
    pub row_batch: u32,
}

/// 設定検証のエラー(どのパラメータが範囲外かを UI へ返す)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConfigError {
    /// 範囲外のパラメータ名(getConfig/setConfig の JSON キーと一致)
    pub field: &'static str,
    /// 人間可読な範囲の説明(UI 文言化せず、開発者向けログに使用)
    pub requirement: &'static str,
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "config field '{}' {}", self.field, self.requirement)
    }
}

impl std::error::Error for ConfigError {}

impl Default for MosaicConfig {
    fn default() -> Self {
        MosaicConfig {
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
        }
    }
}

impl MosaicConfig {
    /// 詳細設計書 5 章の「範囲」列に従い全パラメータを検証する。
    ///
    /// 非有限値(NaN / 無限大)は範囲比較が成立しないため範囲外として扱う。
    pub fn validate(&self) -> Result<(), ConfigError> {
        fn finite_in_range(
            value: f32,
            min: f32,
            max: f32,
            field: &'static str,
            requirement: &'static str,
        ) -> Result<(), ConfigError> {
            if value.is_finite() && (min..=max).contains(&value) {
                return Ok(());
            }
            Err(ConfigError { field, requirement })
        }

        finite_in_range(self.w_c, 0.5, 2.0, "w_c", "must be in 0.5..=2.0")?;
        finite_in_range(self.w_d, 0.0, 1.0, "w_d", "must be in 0.0..=1.0")?;
        finite_in_range(
            self.usage_penalty,
            0.0,
            1.0,
            "usage_penalty",
            "must be in 0.0..=1.0",
        )?;
        finite_in_range(
            self.neighbor_penalty,
            0.0,
            1.0,
            "neighbor_penalty",
            "must be in 0.0..=1.0",
        )?;
        finite_in_range(
            self.neighbor_de,
            2.0,
            16.0,
            "neighbor_de",
            "must be in 2.0..=16.0",
        )?;
        if !(self.identical_de.is_finite() && self.identical_de > 0.0) {
            return Err(ConfigError {
                field: "identical_de",
                requirement: "must be a positive number",
            });
        }
        finite_in_range(
            self.improve_margin,
            0.5,
            2.0,
            "improve_margin",
            "must be in 0.5..=2.0",
        )?;
        finite_in_range(
            self.duplicate_de,
            0.5,
            8.0,
            "duplicate_de",
            "must be in 0.5..=8.0",
        )?;
        finite_in_range(
            self.duplicate_detail,
            0.0,
            32.0,
            "duplicate_detail",
            "must be in 0.0..=32.0",
        )?;
        if !(self.color_correct.is_finite() && (0.0..=1.0).contains(&self.color_correct)) {
            return Err(ConfigError {
                field: "color_correct",
                requirement: "must be in 0.0..=1.0",
            });
        }
        finite_in_range(
            self.main_blend,
            0.0,
            0.8,
            "main_blend",
            "must be in 0.0..=0.8",
        )?;
        if !(4..=32).contains(&self.row_batch) {
            return Err(ConfigError {
                field: "row_batch",
                requirement: "must be in 4..=32",
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_matches_spec_table() {
        // 詳細設計書 5 章の既定値
        let config = MosaicConfig::default();
        assert_eq!(config.w_c, 1.0);
        assert_eq!(config.w_d, 0.25);
        assert_eq!(config.usage_penalty, 0.35);
        assert_eq!(config.neighbor_penalty, 0.5);
        assert_eq!(config.neighbor_de, 8.0);
        assert_eq!(config.identical_de, 2.0);
        assert_eq!(config.improve_margin, 1.0);
        assert_eq!(config.duplicate_de, 2.0);
        assert_eq!(config.duplicate_detail, 4.0);
        assert_eq!(config.usage_cap, 1);
        assert!(config.no_reuse);
        assert_eq!(config.color_correct, 0.85);
        assert_eq!(config.main_blend, 0.2);
        assert_eq!(config.row_batch, 8);
    }

    #[test]
    fn default_config_is_valid() {
        assert_eq!(MosaicConfig::default().validate(), Ok(()));
    }

    #[test]
    fn validate_rejects_out_of_range() {
        let cases = [
            (
                MosaicConfig {
                    w_c: 0.4,
                    ..MosaicConfig::default()
                },
                "w_c",
            ),
            (
                MosaicConfig {
                    w_c: 2.1,
                    ..MosaicConfig::default()
                },
                "w_c",
            ),
            (
                MosaicConfig {
                    w_d: -0.1,
                    ..MosaicConfig::default()
                },
                "w_d",
            ),
            (
                MosaicConfig {
                    usage_penalty: f32::NAN,
                    ..MosaicConfig::default()
                },
                "usage_penalty",
            ),
            (
                MosaicConfig {
                    color_correct: 1.1,
                    ..MosaicConfig::default()
                },
                "color_correct",
            ),
            (
                MosaicConfig {
                    row_batch: 3,
                    ..MosaicConfig::default()
                },
                "row_batch",
            ),
            (
                MosaicConfig {
                    improve_margin: 0.4,
                    ..MosaicConfig::default()
                },
                "improve_margin",
            ),
            (
                MosaicConfig {
                    neighbor_de: 1.9,
                    ..MosaicConfig::default()
                },
                "neighbor_de",
            ),
            (
                MosaicConfig {
                    duplicate_de: 0.4,
                    ..MosaicConfig::default()
                },
                "duplicate_de",
            ),
            (
                MosaicConfig {
                    duplicate_detail: 40.0,
                    ..MosaicConfig::default()
                },
                "duplicate_detail",
            ),
            (
                MosaicConfig {
                    main_blend: 0.9,
                    ..MosaicConfig::default()
                },
                "main_blend",
            ),
        ];
        for (config, field) in cases {
            let err = config.validate().expect_err("must be rejected");
            assert_eq!(err.field, field);
        }
    }

    #[test]
    fn validate_accepts_boundary_values() {
        // 範囲の両端と usage_cap = 0(無制限)は有効
        let config = MosaicConfig {
            w_c: 0.5,
            w_d: 0.0,
            usage_penalty: 1.0,
            neighbor_penalty: 0.0,
            neighbor_de: 2.0,
            identical_de: f32::MIN_POSITIVE,
            improve_margin: 0.5,
            duplicate_de: 0.5,
            duplicate_detail: 0.0,
            usage_cap: 0,
            no_reuse: false,
            color_correct: 1.0,
            main_blend: 0.0,
            row_batch: 32,
        };
        assert_eq!(config.validate(), Ok(()));
        let config = MosaicConfig {
            w_c: 2.0,
            improve_margin: 2.0,
            duplicate_de: 8.0,
            duplicate_detail: 32.0,
            neighbor_de: 16.0,
            main_blend: 0.8,
            row_batch: 4,
            ..MosaicConfig::default()
        };
        assert_eq!(config.validate(), Ok(()));
    }
}
