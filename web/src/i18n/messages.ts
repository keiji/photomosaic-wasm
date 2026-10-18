/**
 * UI 文言リソース(日本語)。
 * 基本設計書 5 章(国際化)の方針に従い、文言はここに分離する。
 * コアの進捗イベントが持つのは code のみで、文言化は本リソースで行う。
 */
export const messages = {
  appTitle: 'フォトモザイク メーカー',
  offlineBadge: 'オフライン',
  privacyNotice: '※ 画像はこの端末内でだけ処理されます',

  // S1 開始画面
  mainDropHint: 'クリックまたはここにドロップ(メイン画像を 1 枚)',
  tileHeading: '構成画像(タイル)',
  tileDropHint: '追加した画像がここにドロップできます(複数可)',

  // S2 編集画面
  editTitle: 'フォトモザイク編集',
  back: '← 戻る',
  save: '保存',
  blockSizeLabel: 'ブロックサイズ',
  blockSizeUnit: 'px',
  tileSummary: (count: number): string => `構成画像: ${count} 枚`,
  previewAriaLabel: 'フォトモザイクのプレビュー',

  // 進捗表示領域
  progressTitle: '進捗表示',
  progressHide: '非表示 ▲',
  progressShow: '表示 ▼',
  progressBlocksLabel: (assigned: number, total: number, percent: number): string =>
    `${assigned.toLocaleString('ja-JP')} / ${total.toLocaleString('ja-JP')} ブロック (${percent}%)`,

  // フェーズ文言(フェーズ ID → UI 文言。詳細設計書 7.1 の対応表)
  phaseIdle: '待機中',
  phaseLoadMain: '画像を読み込み中…',
  phaseMainAnalyze: 'メイン画像を解析中…',
  phaseTileAnalyze: 'タイルを解析中…',
  phaseMatch: 'タイルをマッチング中…',
  phaseCompose: '合成中…',
  phaseExport: '保存中…',

  // エラー(インライン表示)
  errorInvalidFile: '対応していないファイル形式です(画像ファイルを指定してください)',
  errorLoadFailed: '画像の読み込みに失敗しました',
  errorStartup: 'アプリケーションの起動に失敗しました(詳細は開発者コンソールを参照)',
} as const;
