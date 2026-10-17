import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { AiProvider, OptimizeRequest, OptimizeResult, PasteResult } from '../types';
import type { ToastTone } from './toastText';
import { aiErrorMessage } from './aiProviderForm';
import { OPTIMIZE_MODES, degradedHint } from './optimizeView';
import { pasteToast } from './toastText';
import { cn } from './util';

/**
 * 优化面板（计划 Task 7 Step 5）。
 * ★ 文件名带 ViewCard 后缀（与 AiProviderFormCard.tsx 同一处理）：纯函数模块
 *   optimizeView.ts 是计划钉死的路径（Step 1 的命令就是跑 optimizeView.spec.ts），
 *   而 "OptimizeView.tsx" 与它仅差大小写——在大小写不敏感的文件系统上 TS 会把两个
 *   名字解析成同一个文件（TS1149，且 './OptimizeView' 会被解析到 optimizeView.ts
 *   导致 TS2305），所以组件文件名必须与那个纯模块不同名。
 * 与 SettingsView 同风格：平台动作（scenes / optimize / copyAndPaste）与 provider 列表
 * 全部由 App 注入，组件自己不 getPlatform()，便于移动端复用与静态检查。
 *
 * 已配好的模型（providers）为空时不白屏，直接引导去设置页。
 */
export interface OptimizeScene {
  id: string;
  name: string;
  description: string;
}

export interface OptimizeViewProps {
  /** 打开面板时带出的原文（store.optimizeSource）。 */
  source: string;
  /** 已保存的模型（Key 已掩码，渲染层拿不到明文）。 */
  providers: AiProvider[];
  /** 场景由主进程投影：只回 id / name / description（rules 不出主进程）。 */
  onScenes: () => Promise<OptimizeScene[]>;
  onOptimize: (req: OptimizeRequest) => Promise<OptimizeResult>;
  /** 写剪贴板并按 autoPaste / 目标可用性决定是否自动贴回。 */
  onCopyAndPaste: (text: string) => Promise<PasteResult>;
  onToast: (text: string, tone?: ToastTone) => void;
  onGoSettings: () => void;
}

const SELECT_CLASS =
  'max-w-[190px] shrink-0 rounded-input border border-line bg-surface px-snug py-[4px] text-[11px] text-ink outline-none focus:border-[var(--cc-primary)]';
const GHOST_BUTTON_CLASS =
  'rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60';
const PRIMARY_BUTTON_CLASS =
  'flex items-center gap-[4px] rounded-button bg-[var(--cc-primary)] px-snug py-[4px] text-[11px] text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60';

/** 右栏 loading 期间的骨架块。 */
function Skeleton() {
  return (
    <div className="flex flex-col gap-snug" aria-hidden>
      {[92, 78, 84, 60].map((width) => (
        <div key={width} className="h-[10px] animate-pulse rounded-button bg-surface-2" style={{ width: width + '%' }} />
      ))}
    </div>
  );
}

/** 模式切换：与 SettingsView 的 Segmented 同一套视觉（那个组件是模块私有的）。 */
function ModePicker({ value, onChange }: { value: OptimizeRequest['mode']; onChange: (mode: OptimizeRequest['mode']) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-[2px] rounded-button border border-line bg-surface-2 p-[2px]">
      {OPTIMIZE_MODES.map((mode) => (
        <button
          key={mode.key}
          type="button"
          onClick={() => onChange(mode.key)}
          className={cn(
            'rounded-[9px] px-snug py-[3px] text-[11px] transition-colors',
            value === mode.key ? 'bg-surface text-ink shadow-card' : 'text-ink-2 hover:text-ink',
          )}
        >
          {mode.label}
        </button>
      ))}
    </div>
  );
}

export function OptimizeView({ source, providers, onScenes, onOptimize, onCopyAndPaste, onToast, onGoSettings }: OptimizeViewProps) {
  const [scenes, setScenes] = useState<OptimizeScene[]>([]);
  const [sceneId, setSceneId] = useState('');
  const [sceneFailed, setSceneFailed] = useState(false);
  const [mode, setMode] = useState<OptimizeRequest['mode']>('user');
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [text, setText] = useState(source);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 场景目录：主进程投影，失败时把错误摊在工具条上，不静默留个空下拉。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await onScenes();
        if (!alive) return;
        setScenes(list);
        setSceneId((prev) => (prev && list.some((s) => s.id === prev) ? prev : (list[0]?.id ?? '')));
        setSceneFailed(false);
      } catch {
        if (!alive) return;
        setScenes([]);
        setSceneId('');
        setSceneFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [onScenes]);

  // 模型列表由 App 维护：删掉当前选中的模型后要落到还存在的第一个，避免拿着空 id 去优化。
  useEffect(() => {
    setProviderId((prev) => (providers.some((p) => p.id === prev) ? prev : (providers[0]?.id ?? '')));
  }, [providers]);

  // 换一条记录重新打开面板：原文与上一次的输出一起换掉（不留旧结果）。
  useEffect(() => {
    setText(source);
    setResult(null);
    setError(null);
  }, [source]);

  const optimized = result?.optimized ?? '';
  const degraded = result ? degradedHint(result.degraded) : null;
  const canRun = !loading && providerId !== '' && sceneId !== '' && text.trim().length > 0;

  async function run(): Promise<void> {
    if (!canRun) return;
    setLoading(true);
    setError(null);
    try {
      const res = await onOptimize({ providerId, text, sceneId, mode });
      setResult(res);
    } catch (err) {
      // 失败不白屏：把结构化错误翻成中文摊在右栏，原结果保留可重试。
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  /** 「复制」与「直接粘贴」是同一条通道（是否自动贴回由主进程按 autoPaste / 目标可用性决定）。 */
  async function copyOut(): Promise<void> {
    if (optimized === '') return;
    const res = await onCopyAndPaste(optimized);
    const toast = pasteToast(res);
    onToast(toast.text, toast.tone);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-snug border-b border-line px-base py-snug">
        <select
          value={sceneId}
          onChange={(event) => setSceneId(event.target.value)}
          className={SELECT_CLASS}
          title={scenes.find((s) => s.id === sceneId)?.description ?? ''}
          aria-label="优化场景"
        >
          {scenes.length === 0 ? <option value="">{sceneFailed ? '场景加载失败' : '加载场景中…'}</option> : null}
          {scenes.map((scene) => (
            <option key={scene.id} value={scene.id} title={scene.description}>
              {scene.name}
            </option>
          ))}
        </select>

        <ModePicker value={mode} onChange={setMode} />

        <select
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
          className={SELECT_CLASS}
          aria-label="优化模型"
        >
          {providers.length === 0 ? <option value="">未配置模型</option> : null}
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name + ' · ' + provider.model}
            </option>
          ))}
        </select>

        <button type="button" className={PRIMARY_BUTTON_CLASS} disabled={!canRun} onClick={() => void run()}>
          <Sparkles size={13} aria-hidden />
          {loading ? '优化中…' : '优化'}
        </button>
        {sceneFailed ? <span className="text-[11px] text-red-400">场景加载失败，重开面板再试</span> : null}
      </div>

      {degraded ? (
        <p className="shrink-0 border-b border-line bg-[var(--cc-accent-soft)] px-base py-tight text-[11px] leading-[1.6] text-[var(--cc-accent)]">
          {degraded}
        </p>
      ) : null}

      {providers.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-snug px-base">
          <p className="text-[12px] text-ink-2">请先在设置里添加 AI 模型</p>
          <button type="button" className={PRIMARY_BUTTON_CLASS} onClick={onGoSettings}>
            去设置
          </button>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-snug px-base py-snug">
          <label className="flex min-h-0 flex-col gap-tight">
            <span className="text-[12px] font-semibold text-ink">原文</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="要优化的提示词，可直接改或清空重输"
              className="cc-scroll min-h-0 flex-1 resize-none rounded-input border border-line bg-surface px-snug py-tight text-[12px] leading-[1.7] text-ink outline-none placeholder:text-ink-3 focus:border-[var(--cc-primary)]"
            />
          </label>

          <div className="flex min-h-0 flex-col gap-tight">
            <span className="text-[12px] font-semibold text-ink">优化后</span>
            <div className="cc-scroll min-h-0 flex-1 overflow-y-auto rounded-input border border-line bg-surface px-snug py-tight">
              {loading ? (
                <Skeleton />
              ) : error !== null ? (
                <div className="flex flex-col gap-snug">
                  <p className="text-[11px] leading-[1.6] text-red-400">{error}</p>
                  <button type="button" className={GHOST_BUTTON_CLASS} onClick={() => void run()}>
                    重试
                  </button>
                </div>
              ) : optimized !== '' ? (
                <p className="whitespace-pre-wrap break-all text-[12px] leading-[1.7] text-ink">{optimized}</p>
              ) : (
                <p className="text-[11px] leading-[1.6] text-ink-3">选好场景与模式，点「优化」生成。</p>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex shrink-0 flex-col gap-tight border-t border-line px-base py-snug">
        {result && result.notes.length > 0 ? (
          <ul className="flex flex-col gap-[2px]">
            {result.notes.map((note, index) => (
              <li key={index} className="text-[11px] leading-[1.6] text-ink-2">
                · {note}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center gap-snug">
          <button type="button" className={GHOST_BUTTON_CLASS} disabled={optimized === ''} onClick={() => void copyOut()}>
            复制
          </button>
          <button type="button" className={GHOST_BUTTON_CLASS} disabled={optimized === ''} onClick={() => void copyOut()}>
            直接粘贴
          </button>
          <button type="button" className={GHOST_BUTTON_CLASS} disabled={!canRun} onClick={() => void run()}>
            重试
          </button>
        </div>
      </div>
    </div>
  );
}
