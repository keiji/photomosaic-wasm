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
    /// 直上/直左と同一タイルのペナルティ n_p(neighbor_penalty、ΔE 換算)。
    /// 既定 0.5、範囲 0〜1.0
    pub neighbor_penalty: f32,
    /// 「視覚上同一」とみなす ΔE76 閾値。固定(2.0)
    pub identical_de: f32,
    /// 1 タイルの最大使用回数 usage_cap。既定 4 回、0 = 無制限
    pub usage_cap: u32,
    /// ブロック平均色へのトーン補正強度 α(color_correct)。既定 0.7、範囲 0〜1.0
    pub color_correct: f32,
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
            identical_de: 2.0,
            usage_cap: 4,
            color_correct: 0.7,
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
        if !(self.identical_de.is_finite() && self.identical_de > 0.0) {
            return Err(ConfigError {
                field: "identical_de",
                requirement: "must be a positive number",
            });
        }
        if !(self.color_correct.is_finite() && (0.0..=1.0).contains(&self.color_correct)) {
            return Err(ConfigError {
                field: "color_correct",
                requirement: "must be in 0.0..=1.0",
            });
        }
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
        assert_eq!(config.identical_de, 2.0);
        assert_eq!(config.usage_cap, 4);
        assert_eq!(config.color_correct, 0.7);
        assert_eq!(config.row_batch, 8);
    }

    #[test]
    fn default_config_is_valid() {
        assert_eq!(MosaicConfig::default().validate(), Ok(()));
    }

    #[test]
    fn validate_rejects_out_of_range() {
        let cases: [(MosaicConfig, &'static str); 6] = [
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
            identical_de: f32::MIN_POSITIVE,
            usage_cap: 0,
            color_correct: 1.0,
            row_batch: 32,
        };
        assert_eq!(config.validate(), Ok(()));
        let config = MosaicConfig {
            w_c: 2.0,
            row_batch: 4,
            ..MosaicConfig::default()
        };
        assert_eq!(config.validate(), Ok(()));
    }
}
