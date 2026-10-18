import { useCallback, useEffect, useState } from 'react';
import { acceleratorLabel, keyEventToAccelerator } from './settingsHotkey';

export interface HotkeyRecorderProps {
  value: string;
  onChange: (accelerator: string) => void;
  /** 清空时上层回落到这个默认值（避免存空串把热键弄没）。 */
  defaultValue: string;
  label: string;
}

/**
 * 快捷键录制控件：常态显示当前组合 +「修改」，录制态接管全局 keydown。
 * ★ 非法组合不停留在录制态里静默吞掉：要么给出可读提示，要么根本不产生值。
 */
export function HotkeyRecorder({ value, onChange, defaultValue, label }: HotkeyRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [rejected, setRejected] = useState(false);

  const stop = useCallback(() => {
    setRecording(false);
    setRejected(false);
  }, []);

  useEffect(() => {
    if (!recording) return;

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        stop();
        return;
      }
      if (event.key === 'Backspace') {
        // 交给上层回落默认值：这里只报空，不自己决定默认值是什么。
        onChange('');
        stop();
        return;
      }

      const accelerator = keyEventToAccelerator(event);
      if (accelerator === '') {
        setRejected(true);
        return;
      }
      onChange(accelerator);
      stop();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, onChange, stop]);

  const kbdClass =
    'rounded-input border border-line bg-surface-2 px-snug py-[3px] font-mono text-[11px] text-ink-2';
  const actionClass =
    'shrink-0 rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2';

  if (!recording) {
    return (
      <div className="flex shrink-0 items-center gap-tight">
        <kbd className={kbdClass}>{acceleratorLabel(value) || acceleratorLabel(defaultValue)}</kbd>
        <button
          type="button"
          onClick={() => {
            setRejected(false);
            setRecording(true);
          }}
          aria-label={'修改' + label + '快捷键'}
          className={actionClass}
        >
          修改
        </button>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-[2px]">
      <div className="flex items-center gap-tight">
        <span className="text-[11px] text-[var(--cc-primary)]">按下组合键…</span>
        <button type="button" onClick={stop} className={actionClass}>
          取消
        </button>
      </div>
      {rejected ? (
        <p className="text-[11px] leading-[1.6] text-ink-3">不支持这个组合，请带 Ctrl/Alt/Shift</p>
      ) : null}
    </div>
  );
}
