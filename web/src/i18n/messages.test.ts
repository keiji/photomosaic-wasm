import { describe, expect, it } from 'vitest';
import { messages, phaseLabelFor } from './messages';

describe('進捗フェーズ文言', () => {
  it('合成完了は「合成中…」ではなく「合成終了」を表示する', () => {
    expect(messages.phaseCompose).toBe('合成中…');
    expect(messages.phaseDone).toBe('合成終了');
    expect(phaseLabelFor('done')).toBe(messages.phaseDone);
  });

  it('既知のコア phase_code を文言へ変換する', () => {
    expect(phaseLabelFor('main_analyze')).toBe(messages.phaseMainAnalyze);
    expect(phaseLabelFor('tile_analyze')).toBe(messages.phaseTileAnalyze);
    expect(phaseLabelFor('match')).toBe(messages.phaseMatch);
    expect(phaseLabelFor('compose')).toBe(messages.phaseCompose);
  });

  it('オフラインバッジ文言を持たず、メトリクスを閉じる文言を持つ', () => {
    expect('offlineBadge' in messages).toBe(false);
    expect(messages.metricsCloseLabel).toBe('メトリクスを閉じる');
  });
});
