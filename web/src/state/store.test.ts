import { describe, expect, it } from 'vitest';
import { AppStore, initialStoreData, transition } from './store';
import type { AppEvent } from './store';

describe('transition(状態遷移モデル: 基本設計書 1.4)', () => {
  it('EMPTY でメイン画像を設定すると MAIN_READY になる', () => {
    expect(transition('EMPTY', { type: 'MAIN_IMAGE_SET' })).toBe('MAIN_READY');
  });

  it('TILES_READY でメイン画像を設定すると即座に GENERATING になる(生成の自動開始)', () => {
    expect(transition('TILES_READY', { type: 'MAIN_IMAGE_SET' })).toBe('GENERATING');
  });

  it('EMPTY で構成画像を追加すると TILES_READY になる', () => {
    expect(transition('EMPTY', { type: 'TILES_ADDED', count: 3 })).toBe('TILES_READY');
  });

  it('count 0 の追加は無視される', () => {
    expect(transition('EMPTY', { type: 'TILES_ADDED', count: 0 })).toBe('EMPTY');
  });

  it('TILES_READY で構成画像をすべて削除すると EMPTY へ戻る', () => {
    expect(transition('TILES_READY', { type: 'TILES_REMOVED', remaining: 0 })).toBe('EMPTY');
  });

  it('タイルが 0 枚に戻った場合、GENERATING は MAIN_READY へ戻る', () => {
    expect(transition('GENERATING', { type: 'TILES_REMOVED', remaining: 0 })).toBe('MAIN_READY');
    expect(transition('DONE', { type: 'TILES_REMOVED', remaining: 0 })).toBe('MAIN_READY');
  });

  it('remaining が残っている削除は状態を変えない', () => {
    expect(transition('TILES_READY', { type: 'TILES_REMOVED', remaining: 2 })).toBe('TILES_READY');
  });

  it('MAIN_READY で生成を開始すると GENERATING になる', () => {
    expect(transition('MAIN_READY', { type: 'GENERATION_STARTED' })).toBe('GENERATING');
  });

  it('EMPTY から生成は開始できない(構成画像 0 枚の生成要求は無視)', () => {
    expect(transition('EMPTY', { type: 'GENERATION_STARTED' })).toBe('EMPTY');
    expect(transition('MAIN_READY', { type: 'GENERATION_FINISHED' })).toBe('MAIN_READY');
  });

  it('GENERATING で生成が完了すると DONE になる', () => {
    expect(transition('GENERATING', { type: 'GENERATION_FINISHED' })).toBe('DONE');
  });

  it('GENERATING で生成をキャンセルすると MAIN_READY に戻る(M5)', () => {
    expect(transition('GENERATING', { type: 'GENERATION_CANCELED' })).toBe('MAIN_READY');
    // 実行していない状態でのキャンセルは状態を変えない
    expect(transition('MAIN_READY', { type: 'GENERATION_CANCELED' })).toBe('MAIN_READY');
  });

  it('リセットは常に EMPTY へ戻す', () => {
    const states = ['EMPTY', 'TILES_READY', 'MAIN_READY', 'GENERATING', 'DONE'] as const;
    for (const state of states) {
      expect(transition(state, { type: 'RESET' })).toBe('EMPTY');
    }
  });

  it('メイン画像設定後の MAIN_READY にメイン画像設定を繰り返しても変化しない', () => {
    expect(transition('MAIN_READY', { type: 'MAIN_IMAGE_SET' })).toBe('MAIN_READY');
    expect(transition('DONE', { type: 'MAIN_IMAGE_SET' })).toBe('DONE');
  });
});

describe('AppStore', () => {
  it('初期状態は EMPTY', () => {
    const store = new AppStore();
    expect(store.getData()).toEqual(initialStoreData);
  });

  it('ディスパッチで状態が更新され、購読者へ通知される', () => {
    const store = new AppStore();
    const seen: string[] = [];
    store.subscribe((data) => seen.push(data.state));
    store.dispatch({ type: 'MAIN_IMAGE_SET' });
    expect(store.getData().state).toBe('MAIN_READY');
    expect(seen).toEqual(['MAIN_READY']);
  });

  it('未定義遷移は通知しない', () => {
    const store = new AppStore();
    let notified = 0;
    store.subscribe(() => notified++);
    store.dispatch({ type: 'GENERATION_STARTED' }); // EMPTY からの開始は無視
    expect(notified).toBe(0);
    expect(store.getData().state).toBe('EMPTY');
  });

  it('setBlockCounts で全体ブロック数と割当数を更新する(状態は不変)', () => {
    const store = new AppStore();
    store.dispatch({ type: 'MAIN_IMAGE_SET' });
    store.setBlockCounts(30000, 12480);
    expect(store.getData()).toMatchObject({
      state: 'MAIN_READY',
      totalBlocks: 30000,
      assignedBlocks: 12480,
    });
  });

  it('リセットで初期データへ戻る', () => {
    const store = new AppStore();
    store.dispatch({ type: 'MAIN_IMAGE_SET' });
    store.setBlockCounts(100, 50);
    store.dispatch({ type: 'RESET' });
    expect(store.getData()).toEqual(initialStoreData);
  });

  it('subscribe の解除関数で通知が止まる', () => {
    const store = new AppStore();
    let notified = 0;
    const unsubscribe = store.subscribe(() => notified++);
    store.dispatch({ type: 'MAIN_IMAGE_SET' });
    unsubscribe();
    store.dispatch({ type: 'RESET' });
    expect(notified).toBe(1);
  });
});

describe('遷移網羅の整合(リセット後の再一巡)', () => {
  it('メイン画像設定 → グリッド表示 → リセットの一巡が成立する', () => {
    const store = new AppStore();
    const events: AppEvent[] = [{ type: 'MAIN_IMAGE_SET' }, { type: 'RESET' }];
    for (const event of events) {
      store.dispatch(event);
    }
    expect(store.getData().state).toBe('EMPTY');
  });
});
