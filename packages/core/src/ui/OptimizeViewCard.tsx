import { useEffect, useRef, useState } from 'react';
import { History, Sparkles, Trash2, X } from 'lucide-react';
import type {
  AiProvider,
  OptimizeDelta,
  OptimizeHistoryEntry,
  OptimizeRequest,
  OptimizeResult,
  PasteResult,
} from '../types';
import type { ToastTone } from './toastText';
import { aiErrorMessage } from './aiProviderForm';
import {
  OPTIMIZE_MODES,
  beginStream,
  copyFailedToast,
  copiedToast,
  degradedHint,
  endStream,
  mergeDelta,
  newRequestId,
  saveDraft,
  stoppedToast,
  takeDraft,
} from './optimizeView';
import type { OptimizeDraft } from './optimizeView';
import { emptyHistoryHint, historySceneLabel, historyTimeLabel, truncateForList } from './optimizeHistory';
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
 *
 * ★ 用户实测反馈（本轮修复）：
 *   1. 慢模型单次优化 20-60 秒，等整段响应看着像卡死 —— 订阅主进程的流式增量，
 *      首字节先到、边收边显示（此时只读），结束后落成可编辑的 textarea。
 *   2. 「优化后」原来是只读 <p>，改不了 —— 改成 textarea，可改完再复制。
 *   3. 「复制」与「直接粘贴」原先是同一个动作 —— 「复制」只写剪贴板，
 *      「直接粘贴」才写剪贴板并贴回目标窗口。
 * 每次点「优化」生成一个 requestId，只接受它的增量（过期 delta 丢弃）。
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
  /** 写剪贴板并按 autoPaste / 目标可用性决定是否自动贴回（「直接粘贴」）。 */
  onCopyAndPaste: (text: string) => Promise<PasteResult>;
  /** 只写剪贴板、不贴回（「复制」）；由 App 注入 platform.clipboard.writeText。 */
  onCopyToClipboard: (text: string) => Promise<void>;
  /** 订阅主进程的流式增量（App 注入 ai.onOptimizeDelta）；返回值用于取消订阅。 */
  onOptimizeDelta: (cb: (delta: OptimizeDelta) => void) => () => void;
  /** 按 requestId 中断在途请求（App 注入 ai.cancelOptimize）；不传时只清本地状态。 */
  onCancel?: (requestId: string) => void;
  onToast: (text: string, tone?: ToastTone) => void;
  onGoSettings: () => void;
  /**
   * 优化历史（v0.5.0）。三个回调都可选：都不传时「历史」按钮根本不渲染，
   * 这样 v0.4 的调用方（含测试与移动端壳）不改一行也不会看到一个点不开的按钮。
   */
  onHistory?: () => Promise<OptimizeHistoryEntry[]>;
  onHistoryRemove?: (id: string) => Promise<void>;
  onHistoryClear?: () => Promise<void>;
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

export function OptimizeView({
  source,
  providers,
  onScenes,
  onOptimize,
  onCopyAndPaste,
  onCopyToClipboard,
  onOptimizeDelta,
  onCancel,
  onToast,
  onGoSettings,
  onHistory,
  onHistoryRemove,
  onHistoryClear,
}: OptimizeViewProps) {
  // 切走再回来（App 条件渲染会卸载本组件）：先取回上次的草稿，没有才用传入的原文。
  // ★ 用 ref 守卫而不是 useState 惰性初始化：StrictMode 下渲染函数会跑两遍，
  //   而 takeDraft 取过就清空了，第二遍会拿到 null 把草稿丢掉。
  const restoredRef = useRef<OptimizeDraft | null | undefined>(undefined);
  if (restoredRef.current === undefined) restoredRef.current = takeDraft();
  const restored = restoredRef.current;
  const [scenes, setScenes] = useState<OptimizeScene[]>([]);
  const [sceneId, setSceneId] = useState(restored?.sceneId ?? '');
  const [sceneFailed, setSceneFailed] = useState(false);
  const [mode, setMode] = useState<OptimizeRequest['mode']>(restored?.mode ?? 'user');
  const [providerId, setProviderId] = useState(() =>
    restored !== null && providers.some((p) => p.id === restored.providerId)
      ? restored.providerId
      : (providers[0]?.id ?? ''),
  );
  // ★ 恢复时以草稿为准：用户没写完的原文不该被传入的 source 覆盖。
  const [text, setText] = useState(restored?.input ?? source);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  /** 优化后的文本：流式期间是增量预览（只读），结束后是最终结果（可改后再复制）。 */
  const [output, setOutput] = useState(restored?.output ?? '');
  /** 结果提示：独立于 result 存活（那个对象只活在一次请求里，草稿恢复时已经没有它了）。 */
  const [notes, setNotes] = useState<string[]>(restored?.output ? restored.notes : []);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** 在途请求的 requestId：只认它的增量，过期请求的 delta 一律丢弃。 */
  const activeRequest = useRef<string | null>(null);
  /** 草稿挂靠的原文：跟着当前记录走，切到别的记录时才换。 */
  const draftSource = useRef(restored?.source ?? source);
  /** 历史抽屉：只在调用方给了 onHistory 时才可能打开（按钮也不渲染）。 */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<OptimizeHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  /** 「清空全部」的二次确认：就地变成「确认清空 / 取消」，不弹原生对话框。 */
  const [historyConfirming, setHistoryConfirming] = useState(false);

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

  // 流式增量：订阅主进程，只接受在途请求（requestId 匹配）的那条。
  // 返回值就是取消函数——切换视图会卸载本组件，清理由此完成（App 只注入订阅入口）。
  useEffect(() => {
    return onOptimizeDelta((delta) => {
      setOutput((prev) => mergeDelta(prev, delta, activeRequest.current));
    });
  }, [onOptimizeDelta]);

  // 换一条记录重新打开面板：原文与上一次的输出一起换掉（不留旧结果），
  // 在途请求一并作废（它的增量与结果都不该落到新记录上）。
  // ★ 挂载那次跳过：此时文本来自草稿（或本来就是 source），再覆盖一次就把草稿冲掉了。
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    activeRequest.current = null;
    draftSource.current = source;
    setText(source);
    setResult(null);
    setOutput('');
    setNotes([]);
    setError(null);
    setLoading(false);
  }, [source]);

  // 切走就丢的状态全部落进草稿：输入、场景、模式、模型、已生成结果与提示。
  useEffect(() => {
    saveDraft({ source: draftSource.current, sceneId, mode, providerId, input: text, output, notes });
  }, [sceneId, mode, providerId, text, output, notes]);

  const degraded = result ? degradedHint(result.degraded) : null;
  const canRun = !loading && providerId !== '' && sceneId !== '' && text.trim().length > 0;

  async function run(): Promise<void> {
    if (!canRun) return;
    // 本轮请求的 requestId：清空上一次的预览，之后只认这个 id 的流式增量。
    const stream = beginStream(newRequestId());
    activeRequest.current = stream.requestId;
    setOutput(stream.text);
    setResult(null);
    setNotes([]);
    setError(null);
    setLoading(true);
    try {
      const res = await onOptimize({ providerId, text, sceneId, mode, requestId: stream.requestId });
      if (activeRequest.current !== stream.requestId) return; // 途中换了记录 / 已被停止：这次结果作废
      setResult(res);
      setOutput(res.optimized);
      setNotes(res.notes);
    } catch (err) {
      if (activeRequest.current !== stream.requestId) return;
      // 失败不白屏：把结构化错误翻成中文摊在右栏，原结果保留可重试。
      setError(aiErrorMessage(err));
    } finally {
      if (activeRequest.current === stream.requestId) {
        // ★ 收尾即作废在途 id：结束后迟到的增量不能再追加到（此时可编辑的）最终文本上。
        activeRequest.current = endStream();
        setLoading(false);
      }
    }
  }

  /**
   * 「停止」：通知主进程按 requestId 中断，再就地收尾。
   * ★ 先作废在途 id（endStream）再置 loading=false：迟到的增量与结果都不会再落到
   *   已经保留下来、且马上变成可编辑的文本上。
   */
  function stop(): void {
    const requestId = activeRequest.current;
    if (requestId === null) return;
    onCancel?.(requestId);
    activeRequest.current = endStream();
    setLoading(false);
    const toast = stoppedToast();
    onToast(toast.text, toast.tone);
  }

  /** 「复制」：只写剪贴板，不贴回目标窗口（★ 与「直接粘贴」拆分，原先是同一个动作）。 */
  async function copyOut(): Promise<void> {
    if (output === '') return;
    try {
      await onCopyToClipboard(output);
      const toast = copiedToast();
      onToast(toast.text, toast.tone);
    } catch (err) {
      // 剪贴板写失败也要出声，不假装复制成功。
      const toast = copyFailedToast(err);
      onToast(toast.text, toast.tone);
    }
  }

  /** 「直接粘贴」：写剪贴板 + 按 autoPaste / 目标可用性决定是否贴回（由主进程判断）。 */
  async function copyAndPasteOut(): Promise<void> {
    if (output === '') return;
    const res = await onCopyAndPaste(output);
    const toast = pasteToast(res);
    onToast(toast.text, toast.tone);
  }

  /**
   * 拉历史。失败不白屏：抽屉里留空列表 + 一条中文提示，同时用 toast 出声，
   * 因为抽屉可能是半遮挡的，用户未必盯着它看。
   */
  async function loadHistory(): Promise<void> {
    if (onHistory === undefined) return;
    setHistoryLoading(true);
    try {
      setHistory(await onHistory());
    } catch {
      setHistory([]);
      onToast('读取优化历史失败，请重试', 'warn');
    } finally {
      setHistoryLoading(false);
    }
  }

  function toggleHistory(): void {
    if (historyOpen) {
      setHistoryOpen(false);
      setHistoryConfirming(false);
      return;
    }
    setHistoryOpen(true);
    setHistoryConfirming(false);
    void loadHistory();
  }

  /** 点一条历史：原文 / 结果 / 场景 / 模式一起还原，再把上一次请求的残留清掉。 */
  function applyHistory(entry: OptimizeHistoryEntry): void {
    setText(entry.source);
    setOutput(entry.output);
    setSceneId(entry.sceneId);
    setMode(entry.mode);
    setResult(null);
    setNotes([]);
    setError(null);
    setHistoryOpen(false);
    setHistoryConfirming(false);
  }

  async function removeHistory(id: string): Promise<void> {
    if (onHistoryRemove === undefined) return;
    try {
      await onHistoryRemove(id);
      await loadHistory();
    } catch {
      onToast('删除历史记录失败，请重试', 'warn');
    }
  }

  async function clearHistory(): Promise<void> {
    if (onHistoryClear === undefined) return;
    try {
      await onHistoryClear();
      setHistoryConfirming(false);
      await loadHistory();
    } catch {
      onToast('清空历史失败，请重试', 'warn');
    }
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
        {/* 慢模型单次要 20-60 秒：生成中必须有出口，点了保留已生成的文本。 */}
        {loading ? (
          <button type="button" className={GHOST_BUTTON_CLASS} onClick={stop}>
            停止
          </button>
        ) : null}
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

          <div className="relative flex min-h-0 flex-col gap-tight">
            <div className="flex shrink-0 items-center justify-between gap-snug">
              <span className="text-[12px] font-semibold text-ink">优化后</span>
              {/* 只有调用方接了历史回调才出现：旧调用方看到一个点不开的按钮比看不到更糟。 */}
              {onHistory !== undefined ? (
                <button
                  type="button"
                  className={cn(GHOST_BUTTON_CLASS, 'flex items-center gap-[4px]')}
                  aria-expanded={historyOpen}
                  onClick={toggleHistory}
                >
                  <History size={12} aria-hidden />
                  历史
                </button>
              ) : null}
            </div>
            {loading ? (
              <span className="shrink-0 text-[11px] text-ink-3">优化中：内容会实时显示在下面，结束后可直接修改</span>
            ) : null}
            {error !== null ? (
              <div className="cc-scroll flex min-h-0 flex-1 flex-col gap-snug overflow-y-auto rounded-input border border-line bg-surface px-snug py-tight">
                <p className="text-[11px] leading-[1.6] text-red-400">{error}</p>
                <button type="button" className={GHOST_BUTTON_CLASS} onClick={() => void run()}>
                  重试
                </button>
              </div>
            ) : loading && output === '' ? (
              <div className="cc-scroll min-h-0 flex-1 overflow-y-auto rounded-input border border-line bg-surface px-snug py-tight">
                <Skeleton />
              </div>
            ) : (
              /* ★ 从只读 <p> 改成 textarea：生成完可以直接改，改完再复制/直接粘贴。 */
              <textarea
                value={output}
                readOnly={loading}
                onChange={(event) => setOutput(event.target.value)}
                placeholder="选好场景与模式，点「优化」生成；生成后可以在这里直接修改再复制。"
                className="cc-scroll min-h-0 flex-1 resize-none rounded-input border border-line bg-surface px-snug py-tight text-[12px] leading-[1.7] text-ink outline-none placeholder:text-ink-3 focus:border-[var(--cc-primary)]"
              />
            )}

            {/* 历史抽屉：盖在「优化后」这一栏上而不是新开一层浮层——点一条就是为了把它填回这栏。 */}
            {historyOpen ? (
              <div className="absolute inset-0 z-10 flex min-h-0 flex-col overflow-hidden rounded-input border border-line bg-surface shadow-card">
                <div className="flex shrink-0 items-center justify-between gap-snug border-b border-line px-snug py-tight">
                  <span className="text-[11px] font-semibold text-ink-2">优化历史</span>
                  <button
                    type="button"
                    title="关闭"
                    onClick={toggleHistory}
                    className="shrink-0 rounded-full p-micro text-ink-3 transition-colors hover:text-[var(--cc-accent)]"
                  >
                    <X size={13} aria-hidden />
                  </button>
                </div>

                <div className="cc-scroll min-h-0 flex-1 overflow-y-auto px-[6px] py-tight">
                  {historyLoading ? (
                    <Skeleton />
                  ) : history.length === 0 ? (
                    <p className="px-snug py-comfortable text-center text-[11px] text-ink-3">{emptyHistoryHint()}</p>
                  ) : (
                    <ul className="flex flex-col gap-[2px]">
                      {history.map((entry) => (
                        <li key={entry.id} className="flex items-start gap-[2px]">
                          <button
                            type="button"
                            onClick={() => applyHistory(entry)}
                            className="min-w-0 flex-1 rounded-button px-snug py-[5px] text-left transition-colors hover:bg-surface-2"
                          >
                            <span className="flex items-center gap-[6px] text-[10px] text-ink-3">
                              <span className="shrink-0">{historyTimeLabel(entry.createdAt)}</span>
                              <span className="truncate">{historySceneLabel(entry, scenes)}</span>
                            </span>
                            <span className="mt-[2px] block truncate text-[11px] leading-[1.6] text-ink-2">
                              {truncateForList(entry.source)}
                            </span>
                          </button>
                          {/* 删除是逐项的，所以不放进主按钮里：误点主按钮会替换掉当前原文，误点删除只是少一条历史。 */}
                          {onHistoryRemove !== undefined ? (
                            <button
                              type="button"
                              title="删除这条历史"
                              onClick={() => void removeHistory(entry.id)}
                              className="mt-[3px] shrink-0 rounded-full p-micro text-ink-3 transition-colors hover:text-red-400"
                            >
                              <Trash2 size={12} aria-hidden />
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {onHistoryClear !== undefined && history.length > 0 ? (
                  <div className="flex shrink-0 items-center justify-end gap-snug border-t border-line px-snug py-tight">
                    {historyConfirming ? (
                      <>
                        <span className="text-[10px] text-ink-3">清空后不可恢复</span>
                        <button
                          type="button"
                          className="rounded-button px-snug py-[3px] text-[11px] text-red-400 hover:bg-surface-2"
                          onClick={() => void clearHistory()}
                        >
                          确认清空
                        </button>
                        <button
                          type="button"
                          className={GHOST_BUTTON_CLASS}
                          onClick={() => setHistoryConfirming(false)}
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className={GHOST_BUTTON_CLASS}
                        onClick={() => setHistoryConfirming(true)}
                      >
                        清空全部
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      )}

      <div className="flex shrink-0 flex-col gap-tight border-t border-line px-base py-snug">
        {notes.length > 0 ? (
          <ul className="flex flex-col gap-[2px]">
            {notes.map((note, index) => (
              <li key={index} className="text-[11px] leading-[1.6] text-ink-2">
                · {note}
              </li>
            ))}
          </ul>
        ) : null}
        {/* ★ 三个按钮常显（不折叠、不悬停才出现）；无文本时 disabled。
            ★ 「复制」只写剪贴板，「直接粘贴」才贴回目标窗口——原先是同一个动作。 */}
        <div className="flex items-center gap-snug">
          <button type="button" className={GHOST_BUTTON_CLASS} disabled={output === ''} onClick={() => void copyOut()}>
            复制
          </button>
          <button
            type="button"
            className={GHOST_BUTTON_CLASS}
            disabled={output === ''}
            onClick={() => void copyAndPasteOut()}
          >
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
