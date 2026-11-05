import { useEffect, useState } from 'react';
import { Copy, Play, Save, Square, X } from 'lucide-react';
import type { AiProvider, AssistRequest, AssistResult, CustomAction } from '../types';
import { getPlatform } from '../platform/adapter';
import { aiErrorMessage } from './aiProviderForm';
import {
  ASSIST_ACTION_OPTIONS,
  ASSIST_LANG_OPTIONS,
  assistNeedsLang,
  assistStatusOf,
  defaultTargetLang,
  degradedHint,
  truncateSource,
} from './assistView';
import { customPromptSummary } from './customActions';
import { cn } from './util';

/**
 * 剪贴板 AI 助手面板（v1.0.0 第 ⑤ 项）。
 * 把原来的「提示词优化」扩成右键通用 AI 操作：翻译 / 总结 / 改写 / 解释 / 提取要点，
 * 外加设置里固化的自定义动作（v1.2 D1）。
 *
 * ★ 文件名带 ViewCard 后缀（与 OptimizeViewCard.tsx 同一处理）：纯逻辑模块
 *   assistView.ts 与 "AssistView.tsx" 只差大小写，大小写不敏感的文件系统上 TS 会把
 *   两个名字解析成同一个文件（TS1149）。
 *
 * 与 SettingsView / OptimizeView 同风格：provider 列表与执行动作由 App 注入。
 * ★ 唯一例外（v1.2 D1）：自定义动作列表在挂载时自己经 getPlatform() 读一次——
 *   它是只读快照（面板每次打开都重新挂载），不需要走 App 的全局状态，App.tsx 不必为此接线。
 */
export interface AssistViewProps {
  /** 原文（打开面板时由调用方从记录里取全文本）。 */
  source: string;
  /** 可用的 AI provider（主进程是唯一事实来源）。 */
  providers: AiProvider[];
  /** 执行一次。 */
  onAssist: (req: AssistRequest) => Promise<AssistResult>;
  /** 复制到剪贴板（不粘贴）。 */
  onCopyToClipboard: (text: string) => void;
  /** 把结果存成一条新记录。 */
  onSaveAsItem: (text: string) => void;
  onToast: (message: string, kind?: 'info' | 'warn' | 'error') => void;
  onClose: () => void;
  /** 去设置页配 Key。 */
  onGoSettings: () => void;
}

const SELECT_CLASS =
  'max-w-[190px] shrink-0 rounded-input border border-line bg-surface px-snug py-[4px] text-[11px] text-ink outline-none focus:border-[var(--cc-primary)]';
const GHOST_BUTTON_CLASS =
  'shrink-0 rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60';
const PRIMARY_BUTTON_CLASS =
  'flex items-center gap-[4px] rounded-button bg-[var(--cc-primary)] px-snug py-[4px] text-[11px] text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60';

/** 默认选第一个配好 Key 的 provider；都没有就落到第一个，再没有就是空串。 */
function initialProviderId(providers: AiProvider[]): string {
  const withKey = providers.find((provider) => provider.hasKey);
  return withKey?.id ?? providers[0]?.id ?? '';
}

/** 空列表兜底：读不到（非 Electron / 手机端）就显示空态提示，不打扰用户。 */
const EMPTY_CUSTOM_ACTIONS: CustomAction[] = [];

export function AssistView({
  source,
  providers,
  onAssist,
  onCopyToClipboard,
  onSaveAsItem,
  onToast,
  onClose,
  onGoSettings,
}: AssistViewProps) {
  const [providerId, setProviderId] = useState(() => initialProviderId(providers));
  const [action, setAction] = useState<AssistRequest['action']>('translate');
  /** 自定义动作的选中 id；null = 选中的是内置动作（与 action 互斥，两态只活一个）。 */
  const [customId, setCustomId] = useState<string | null>(null);
  /** 目标语言：只在翻译时渲染，切换动作时保留原值（用户切回来还在）。 */
  const [targetLang, setTargetLang] = useState(() => defaultTargetLang(source));
  const [extra, setExtra] = useState('');
  const [result, setResult] = useState<AssistResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  /**
   * 自定义动作列表：null = 还没读到（不渲染那一组，避免闪「空态提示」），
   * [] = 读到了但用户还没配（显示静默提示），有值 = 渲染按钮。
   */
  const [customActions, setCustomActions] = useState<CustomAction[] | null>(null);

  // provider 列表由 App 维护：删掉当前选中的那个之后要落到还存在的第一个。
  useEffect(() => {
    setProviderId((prev) => (providers.some((p) => p.id === prev) ? prev : initialProviderId(providers)));
  }, [providers]);

  // 自定义动作（v1.2 D1）：面板每次打开都重新挂载，挂载时读一次就够。
  // 读不到（浏览器预览 / 手机端如实 reject）就当空列表，走空态提示而不是报错。
  useEffect(() => {
    let alive = true;
    getPlatform()
      .ai.listCustomActions()
      .then((list) => {
        if (alive) setCustomActions(list);
      })
      .catch(() => {
        if (alive) setCustomActions(EMPTY_CUSTOM_ACTIONS);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 换一条记录重新打开面板：原文变了就把上一次的结果与语言猜测一起换掉。
  useEffect(() => {
    setResult(null);
    setError(null);
    setRunning(false);
    setTargetLang(defaultTargetLang(source));
  }, [source]);

  // Esc 关闭。★ 焦点在输入框里时不抢：用户可能只是想把输入框清掉/取消输入法候选。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const status = assistStatusOf(running, result, error);
  const degraded = result !== null ? degradedHint(result.degraded) : '';
  const canRun = !running && providerId !== '' && source.trim() !== '';
  const resultText = result?.text ?? '';

  async function run(): Promise<void> {
    if (!canRun) return;
    setResult(null);
    setError(null);
    setRunning(true);
    try {
      const custom = customId !== null ? (customActions?.find((c) => c.id === customId) ?? null) : null;
      // v1.2 D1：自定义动作与内置动作走同一条 runAssist 流水线（错误路径共用），
      // 只是请求里 action='custom' 且带上固化的提示词；targetLang / extra 都不往下传。
      const req: AssistRequest = custom
        ? { providerId, action: 'custom', text: source, custom: { name: custom.name, prompt: custom.prompt } }
        : { providerId, action, text: source };
      if (!custom) {
        // 只有翻译带目标语言；其余动作主进程会忽略，传了反而容易让人以为它生效了。
        if (assistNeedsLang(action)) req.targetLang = targetLang;
        const trimmedExtra = extra.trim();
        if (trimmedExtra !== '') req.extra = trimmedExtra;
      }
      const res = await onAssist(req);
      setResult(res);
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  function copyOut(): void {
    if (resultText === '') return;
    onCopyToClipboard(resultText);
    onToast('已复制到剪贴板', 'info');
  }

  function saveOut(): void {
    if (resultText.trim() === '') return;
    onSaveAsItem(resultText);
    onToast('已存为一条新记录', 'info');
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-snug border-b border-line px-base py-snug">
        <h2 className="truncate text-[12px] font-medium text-ink">AI 助手</h2>
        <button
          type="button"
          title="关闭（Esc）"
          onClick={onClose}
          className="shrink-0 rounded-full p-micro text-ink-3 transition-colors hover:text-[var(--cc-accent)]"
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      {/* 原文预览：只给个上下文，最多两行；全文由调用方在打开时取好传进来。 */}
      <p className="mx-base mt-snug shrink-0 line-clamp-2 whitespace-pre-wrap break-words rounded-input bg-surface-2 px-snug py-tight text-[11px] leading-[1.6] text-ink-2 select-text">
        {truncateSource(source)}
      </p>

      {providers.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-snug px-base">
          <p className="text-[12px] text-ink-2">还没有配置 AI 服务</p>
          <button type="button" className={PRIMARY_BUTTON_CLASS} onClick={onGoSettings}>
            去设置
          </button>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-snug px-base pt-snug">
            <select
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
              className={SELECT_CLASS}
              aria-label="AI 服务"
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name + ' · ' + provider.model}
                </option>
              ))}
            </select>

            {/* 五个内置动作：横向一排，选中态用 accent（与 Toast 的 warn 同一套配色）。 */}
            <div className="flex shrink-0 items-center gap-[2px] rounded-button border border-line bg-surface-2 p-[2px]">
              {ASSIST_ACTION_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  title={option.hint}
                  onClick={() => {
                    setAction(option.id);
                    setCustomId(null);
                  }}
                  className={cn(
                    'rounded-[9px] px-snug py-[3px] text-[11px] transition-colors',
                    customId === null && action === option.id
                      ? 'bg-[var(--cc-accent-soft)] font-medium text-[var(--cc-accent)]'
                      : 'text-ink-2 hover:text-ink',
                  )}
                >
                  {option.name}
                </button>
              ))}
            </div>

            {/* 自定义动作（v1.2 D1）：单独一组，按钮文字就是动作名，没有目标语言。
                列表还没读到时不渲染（避免闪空态）；读到但为空给一条静默提示。 */}
            {customActions === null ? null : customActions.length === 0 ? (
              <p className="shrink-0 text-[11px] text-ink-3">在设置 → AI 自定义动作里添加你的专属动作</p>
            ) : (
              <div className="flex shrink-0 items-center gap-[2px] rounded-button border border-line bg-surface-2 p-[2px]">
                {customActions.map((custom) => (
                  <button
                    key={custom.id}
                    type="button"
                    title={customPromptSummary(custom.prompt)}
                    onClick={() => setCustomId(custom.id)}
                    className={cn(
                      'rounded-[9px] px-snug py-[3px] text-[11px] transition-colors',
                      customId === custom.id
                        ? 'bg-[var(--cc-accent-soft)] font-medium text-[var(--cc-accent)]'
                        : 'text-ink-2 hover:text-ink',
                    )}
                  >
                    {custom.name}
                  </button>
                ))}
              </div>
            )}

            {/* 只有内置的翻译用得到目标语言；切到别的动作时这个 select 只是不渲染，值还留着。 */}
            {customId === null && assistNeedsLang(action) ? (
              <select
                value={targetLang}
                onChange={(event) => setTargetLang(event.target.value)}
                className={SELECT_CLASS}
                aria-label="目标语言"
              >
                {ASSIST_LANG_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-snug px-base pt-tight">
            {customId === null ? (
              <input
                value={extra}
                onChange={(event) => setExtra(event.target.value)}
                placeholder="可选的额外要求（例如：更口语一点）"
                className="min-w-0 flex-1 rounded-input border border-line bg-surface px-snug py-[5px] text-[12px] text-ink outline-none placeholder:text-ink-3 focus:border-[var(--cc-border-strong)]"
                aria-label="额外要求"
              />
            ) : (
              // 自定义动作的提示词在设置里固化：额外要求框对它不生效，不如藏起来不误导。
              <p className="min-w-0 flex-1 truncate text-[11px] text-ink-3">
                提示词在设置 → AI 自定义动作里维护
              </p>
            )}
            {/* ★ 不做真取消：主进程这版没有 cancel 通道，所以运行中只置灰并写明正在处理，不骗用户。 */}
            <button
              type="button"
              className={PRIMARY_BUTTON_CLASS}
              disabled={!canRun}
              title={running ? '这一版还不能中途取消，等它跑完' : '开始'}
              onClick={() => void run()}
            >
              {running ? <Square size={11} aria-hidden /> : <Play size={11} aria-hidden />}
              {running ? '停止' : '开始'}
            </button>
            {running ? <span className="shrink-0 text-[11px] text-ink-3">正在处理…</span> : null}
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-tight px-base py-snug">
            {status === 'error' && error !== null ? (
              <div className="cc-scroll flex min-h-0 flex-1 flex-col gap-snug overflow-y-auto rounded-input border border-line bg-surface px-snug py-tight">
                <p className="text-[11px] leading-[1.6] text-[var(--cc-accent)]">{error}</p>
                <div>
                  <button type="button" className={GHOST_BUTTON_CLASS} onClick={() => void run()}>
                    重试
                  </button>
                </div>
              </div>
            ) : status === 'running' ? (
              <p className="flex min-h-0 flex-1 items-center justify-center text-[11px] text-ink-3">正在处理…</p>
            ) : status === 'done' ? (
              <>
                {/* degraded：模型没按 <result> 契约返回，正文是整段回复的兜底，得让用户知道。 */}
                {degraded !== '' ? (
                  <p className="shrink-0 rounded-input bg-[var(--cc-accent-soft)] px-snug py-tight text-[11px] leading-[1.6] text-[var(--cc-accent)]">
                    {degraded}
                  </p>
                ) : null}
                <div className="flex shrink-0 items-center justify-end gap-snug">
                  <button
                    type="button"
                    className={cn(GHOST_BUTTON_CLASS, 'flex items-center gap-[4px]')}
                    disabled={resultText === ''}
                    onClick={copyOut}
                  >
                    <Copy size={11} aria-hidden />
                    复制
                  </button>
                  <button
                    type="button"
                    className={cn(GHOST_BUTTON_CLASS, 'flex items-center gap-[4px]')}
                    disabled={resultText.trim() === ''}
                    onClick={saveOut}
                  >
                    <Save size={11} aria-hidden />
                    存为记录
                  </button>
                </div>
                <pre className="cc-scroll max-h-[45vh] min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-input border border-line bg-surface px-snug py-tight font-mono text-[12px] leading-[1.7] text-ink select-text">
                  {resultText}
                </pre>
              </>
            ) : (
              <p className="flex min-h-0 flex-1 items-center justify-center text-[11px] text-ink-3">
                选好动作后点「开始」
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
