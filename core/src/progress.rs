//! 進捗イベント・スロットリング(詳細設計書 7 章)。
//!
//! - フェーズ ID と全体進捗の固定配分を提供する
//! - 実行に含まれないフェーズがある場合は、含まれるフェーズの配分を総和で正規化する
//! - イベント発火は「16ms 以上の経過」または「overall_ratio が 1% 以上の変化」のとき

/// 処理の大区分(詳細設計書 4.1 / 7.1)。コア進捗に含まれるのは P1〜P4
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    /// P1 メイン画像解析
    MainAnalyze,
    /// P2 タイル解析
    TileAnalyze,
    /// P3 マッチング
    Match,
    /// P4 合成
    Compose,
}

impl Phase {
    /// 固定配分(重み)。P1 10% / P2 20% / P3 55% / P4 15%
    pub fn weight(self) -> f32 {
        match self {
            Phase::MainAnalyze => 0.10,
            Phase::TileAnalyze => 0.20,
            Phase::Match => 0.55,
            Phase::Compose => 0.15,
        }
    }

    /// UI 文言化のための安定識別子(コアは文言を持たない。詳細設計書 7.2)
    pub fn code(self) -> &'static str {
        match self {
            Phase::MainAnalyze => "main_analyze",
            Phase::TileAnalyze => "tile_analyze",
            Phase::Match => "match",
            Phase::Compose => "compose",
        }
    }
}

/// 進捗イベント(詳細設計書 3 章 ProgressEvent)
#[derive(Clone, Debug, PartialEq)]
pub struct ProgressEvent {
    pub phase: Phase,
    /// 0.0..1.0(フェーズ内の進捗)
    pub phase_ratio: f32,
    /// 0.0..1.0(全フェーズ通し)
    pub overall_ratio: f32,
    /// マッチ済みブロック数(match 中のみ有効)
    pub assigned_blocks: u32,
    pub total_blocks: u32,
}

/// 実行に含まれるフェーズの列(P2 スキップ時は P1+P3+P4 など)
#[derive(Clone, Debug)]
pub struct PhasePlan {
    phases: Vec<Phase>,
}

impl PhasePlan {
    /// 全フェーズを含む標準プラン
    pub fn full() -> Self {
        PhasePlan {
            phases: vec![
                Phase::MainAnalyze,
                Phase::TileAnalyze,
                Phase::Match,
                Phase::Compose,
            ],
        }
    }

    /// 含まれるフェーズを指定して生成。順序はフェーズ ID 順に正規化する
    pub fn new(mut phases: Vec<Phase>) -> Self {
        let order = [
            Phase::MainAnalyze,
            Phase::TileAnalyze,
            Phase::Match,
            Phase::Compose,
        ];
        phases.retain(|p| order.contains(p));
        phases.sort_by_key(|p| {
            order
                .iter()
                .position(|o| o == p)
                .expect("retained phases are in order")
        });
        PhasePlan { phases }
    }

    /// スキップされたフェーズの再配分後の overall_ratio を計算する(詳細設計書 7.1)
    ///
    /// 例: 標準プランで P3 が 50% → (0.10 + 0.20 + 0.55 * 0.5) = 0.575
    /// 例: P2 スキップで P3 が 50% → (0.10 + 0.55 * 0.5) / 0.80 = 0.46875
    pub fn overall_ratio(&self, phase: Phase, phase_ratio: f32) -> f32 {
        assert!(
            (0.0..=1.0).contains(&phase_ratio),
            "phase_ratio must be in 0.0..1.0"
        );
        let total_weight: f32 = self.phases.iter().map(|p| p.weight()).sum();
        let before: f32 = self
            .phases
            .iter()
            .take_while(|p| **p != phase)
            .map(|p| p.weight())
            .sum();
        (before + phase_ratio * phase.weight()) / total_weight
    }
}

/// 進捗発火のスロットラー(詳細設計書 7.2)。
///
/// 「前回発火から 16ms 以上の経過」または「overall_ratio が 1% 以上の変化」のときに発火する。
/// 時刻はホストから渡す(コア内部で時計を持たない。Android のサンドボックスでは
/// `performance` が無い場合があるため。handoff/05 参照)。
#[derive(Debug)]
pub struct ProgressThrottle {
    min_interval_ms: f64,
    min_delta: f32,
    last_ms: Option<f64>,
    last_ratio: Option<f32>,
}

impl ProgressThrottle {
    /// 既定のスロットラー(16ms / 1%)
    pub fn new() -> Self {
        ProgressThrottle {
            min_interval_ms: 16.0,
            min_delta: 0.01,
            last_ms: None,
            last_ratio: None,
        }
    }

    /// カスタム閾値のスロットラー(テスト用)
    pub fn with_thresholds(min_interval_ms: f64, min_delta: f32) -> Self {
        ProgressThrottle {
            min_interval_ms,
            min_delta,
            last_ms: None,
            last_ratio: None,
        }
    }

    /// この時点で発火すべきかを判定し、内部状態を更新する。
    /// 発火すべき場合のみ `true` を返す。
    pub fn should_emit(&mut self, now_ms: f64, ratio: f32) -> bool {
        match (self.last_ms, self.last_ratio) {
            (None, _) => {
                self.last_ms = Some(now_ms);
                self.last_ratio = Some(ratio);
                true
            }
            (Some(last_ms), Some(last_ratio)) => {
                let time_ok = now_ms - last_ms >= self.min_interval_ms;
                let delta_ok = (ratio - last_ratio).abs() >= self.min_delta;
                if time_ok || delta_ok {
                    self.last_ms = Some(now_ms);
                    self.last_ratio = Some(ratio);
                    true
                } else {
                    false
                }
            }
            (_, _) => unreachable!("last_ms and last_ratio are updated together"),
        }
    }
}

impl Default for ProgressThrottle {
    fn default() -> Self {
        ProgressThrottle::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn phase_weights_match_spec() {
        assert_close(Phase::MainAnalyze.weight(), 0.10);
        assert_close(Phase::TileAnalyze.weight(), 0.20);
        assert_close(Phase::Match.weight(), 0.55);
        assert_close(Phase::Compose.weight(), 0.15);
    }

    fn assert_close(a: f32, b: f32) {
        assert!(
            close(a, b),
            "expected {b}, got {a} (diff {})",
            (a - b).abs()
        );
    }

    #[test]
    fn phase_codes_are_stable_identifiers() {
        assert_eq!(Phase::MainAnalyze.code(), "main_analyze");
        assert_eq!(Phase::TileAnalyze.code(), "tile_analyze");
        assert_eq!(Phase::Match.code(), "match");
        assert_eq!(Phase::Compose.code(), "compose");
    }

    #[test]
    fn overall_ratio_full_plan() {
        let plan = PhasePlan::full();
        // P1 の開始は 0、完了で 10%
        assert!(close(plan.overall_ratio(Phase::MainAnalyze, 0.0), 0.0));
        assert!(close(plan.overall_ratio(Phase::MainAnalyze, 1.0), 0.10));
        // P3 50% で 57.5%
        assert!(close(plan.overall_ratio(Phase::Match, 0.5), 0.575));
        // P4 の完了で 100%
        assert!(close(plan.overall_ratio(Phase::Compose, 1.0), 1.0));
    }

    #[test]
    fn overall_ratio_normalizes_skipped_phase() {
        // P2 スキップ: P1+P3+P4 = 80% を総和で正規化(詳細設計書 7.1 の数値例)
        let plan = PhasePlan::new(vec![Phase::MainAnalyze, Phase::Match, Phase::Compose]);
        assert!(close(plan.overall_ratio(Phase::MainAnalyze, 1.0), 0.125));
        assert!(close(plan.overall_ratio(Phase::Match, 1.0), 0.8125));
        assert!(close(plan.overall_ratio(Phase::Compose, 1.0), 1.0));
    }

    #[test]
    fn plan_normalizes_phase_order() {
        let plan = PhasePlan::new(vec![Phase::Compose, Phase::MainAnalyze]);
        assert_eq!(plan.phases.len(), 2);
        assert!(close(plan.overall_ratio(Phase::MainAnalyze, 1.0), 0.40));
    }

    #[test]
    fn throttle_emits_first_event_immediately() {
        let mut throttle = ProgressThrottle::new();
        assert!(throttle.should_emit(0.0, 0.0));
    }

    #[test]
    fn throttle_suppresses_below_16ms_and_1_percent() {
        let mut throttle = ProgressThrottle::new();
        assert!(throttle.should_emit(0.0, 0.0));
        // 8ms 経過・0.5% 変化 → 抑制
        assert!(!throttle.should_emit(8.0, 0.005));
        // さらに 8ms(合計 16ms)経過 → 時間条件で発火
        assert!(throttle.should_emit(16.0, 0.008));
    }

    #[test]
    fn throttle_emits_on_1_percent_delta_even_if_time_is_short() {
        let mut throttle = ProgressThrottle::new();
        assert!(throttle.should_emit(0.0, 0.0));
        // 1ms 経過でも 1% 以上の変化があれば発火
        assert!(throttle.should_emit(1.0, 0.02));
    }

    #[test]
    fn throttle_is_monotonic_on_regression() {
        let mut throttle = ProgressThrottle::new();
        assert!(throttle.should_emit(0.0, 0.5));
        // 後退(0.4)でも 1% 以上の差なら発火する(リセット後の再実行を想定)
        assert!(throttle.should_emit(1.0, 0.4));
    }

    #[test]
    fn custom_thresholds_are_applied() {
        let mut throttle = ProgressThrottle::with_thresholds(100.0, 0.5);
        assert!(throttle.should_emit(0.0, 0.0));
        assert!(!throttle.should_emit(99.0, 0.4));
        assert!(throttle.should_emit(100.0, 0.4));
    }
}
