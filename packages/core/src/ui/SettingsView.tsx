import { useEffect, useState, type ReactNode } from 'react';
import { Download, FolderOpen, Ghost } from 'lucide-react';
import type {
  AiError,
  AiProvider,
  AiProviderInput,
  Capabilities,
  GhostState,
  HotkeyStatus,
  Settings,
  ThemeMode,
} from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { cn, formatClock, formatRemaining } from './util';
import { autoStartClick, autoStartSettle, initialAutoStartToggle } from './autoStartToggle';
import { HotkeyRecorder } from './HotkeyRecorder';
import { AiProviderForm } from './AiProviderFormCard';
import { aiErrorMessage, protocolLabel } from './aiProviderForm';

/**
 * 设置页（spec §6.7）：快捷键 / 外观 / 历史 / 小组件 / 数据 五个分区。
 * 所有改动直接写回 store（store 负责落库与乐观回滚），这里只管交互与文案。
 */

/** 历史条数上限：滑块 100–9900 步长 100；数字输入框可填到 9999（spec §6.7）。 */
export const HISTORY_SLIDER_MIN = 100;
export const HISTORY_SLIDER_MAX = 9900;
export const HISTORY_SLIDER_STEP = 100;
export const HISTORY_INPUT_MAX = 9999;
/** 图片磁盘预算档位（MB）。 */
export const IMAGE_BUDGET_OPTIONS = [256, 512, 1024, 2048] as const;
/** 小组件宽度范围（spec §6.6）。 */
export const WIDGET_SIZE_MIN = 240;
export const WIDGET_SIZE_MAX = 400;
/** 幽灵模式上限 720 分钟（spec §6.8）。 */
export const GHOST_MAX_MINUTES = 720;
export const GHOST_PRESETS = [5, 10, 30, 60] as const;
/** 底部展示的版本号。 */
export const APP_VERSION = '0.2.0';

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line px-comfortable py-base last:border-b-0">
      <h3 className="mb-snug text-[12px] font-semibold text-ink">{title}</h3>
      <div className="flex flex-col gap-snug">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-snug">
      <div className="min-w-0 flex-1">
        <p className="text-[12px] text-ink">{label}</p>
        {hint ? <p className="mt-[2px] text-[11px] leading-[1.6] text-ink-3">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-[2px] rounded-button border border-line bg-surface-2 p-[2px]">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-[9px] px-snug py-[3px] text-[11px] transition-colors',
            option.value === value
              ? 'bg-surface text-ink shadow-card'
              : 'text-ink-2 hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={cn(
        'relative h-[20px] w-[36px] shrink-0 rounded-full transition-colors',
        on ? 'bg-[var(--cc-primary)]' : 'bg-[var(--cc-border-strong)]',
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] h-4 w-4 rounded-full bg-white transition-all',
          on ? 'left-[18px]' : 'left-[2px]',
        )}
      />
    </button>
  );
}

export function SettingsView({
  settings,
  ghost,
  capabilities,
  hotkeys,
  autoStart,
  onUpdate,
  onGhost,
  onClearUnpinned,
  onClearAll,
  onOpenDataFolder,
  onExportAll,
  onSetAutoStart,
  onToggleMode,
  mode,
  aiProviders,
  onAiSave,
  onAiRemove,
  onAiTest,
  onAiListModels,
}: {
  settings: Settings;
  ghost: GhostState;
  capabilities: Capabilities;
  hotkeys: HotkeyStatus;
  /** 开机自启动的当前值；null = 尚未读到。 */
  autoStart: boolean | null;
  onUpdate: (patch: Partial<Settings>) => void;
  onGhost: (minutes: number) => void;
  onClearUnpinned: () => void;
  onClearAll: () => void;
  onOpenDataFolder: () => void;
  /** 导出全部记录为 JSON；结果（含失败）由 store 统一 toast。 */
  onExportAll: () => void;
  /** 返回 false 表示写入没成功（例如注册表被拒），此时开关要回滚，不能假装成功。 */
  onSetAutoStart: (on: boolean) => void | Promise<boolean>;
  onToggleMode: () => void;
  mode: 'main' | 'widget';
  /** 已保存的模型列表（Key 已掩码，渲染层拿不到明文）。 */
  aiProviders: AiProvider[];
  /** 保存（apiKey 留空则沿用主进程里存的原 Key）。 */
  onAiSave: (input: AiProviderInput) => Promise<void>;
  onAiRemove: (id: string) => Promise<void>;
  /** 连通性测试：结果由主进程返回，这里只负责显示。 */
  onAiTest: (id: string) => Promise<{ ok: boolean; error?: AiError; model?: string }>;
  /** 拉取模型列表；返回空数组或抛错时降级为手输，不报错。 */
  onAiListModels: (id: string) => Promise<string[]>;
}) {
  // 危险操作两次点击确认（spec §6.7）：第一次点变成"再点一次"，3 秒后自动复位。
  const [pendingClear, setPendingClear] = useState<'unpinned' | 'all' | null>(null);
  const [customMinutes, setCustomMinutes] = useState('15');

  /**
   * ★ 自启动开关必须自己留一份现值（状态推进见 autoStartToggle.ts，带回归单测）。
   * autoStart 由 usePlatformValue 在挂载时只读一次、且没有任何刷新通道，
   * 若直接用 onChange(!autoStart)，第一次点击写入 true 之后 prop 仍是 false，
   * 之后每一次点击都继续算成 true —— 开关只能打开、永远关不掉。
   */
  const [autoStartOn, setAutoStartOn] = useState<boolean>(() => initialAutoStartToggle(autoStart).on);
  useEffect(() => {
    setAutoStartOn(initialAutoStartToggle(autoStart).on);
  }, [autoStart]);

  useEffect(() => {
    if (!pendingClear) return;
    const timer = setTimeout(() => setPendingClear(null), 3000);
    return () => clearTimeout(timer);
  }, [pendingClear]);

  const historyValue = Math.min(HISTORY_SLIDER_MAX, Math.max(HISTORY_SLIDER_MIN, settings.historyLimit));
  const custom = Number(customMinutes);
  const customValid = Number.isFinite(custom) && custom > 0 && custom <= GHOST_MAX_MINUTES;

  // 「AI 模型」区：'new' = 新增中，字符串 = 正在编辑的 provider id，null = 都没展开。
  const [aiEditing, setAiEditing] = useState<'new' | string | null>(null);
  const [aiTesting, setAiTesting] = useState<string | null>(null);
  const [aiTestText, setAiTestText] = useState<Record<string, string>>({});

  const aiEditingProvider = aiProviders.find((p) => p.id === aiEditing) ?? null;

  async function testProvider(id: string) {
    setAiTesting(id);
    try {
      const result = await onAiTest(id);
      setAiTestText((prev) => ({
        ...prev,
        [id]: result.ok ? `${result.model ?? '模型'} 可用` : aiErrorMessage(result.error),
      }));
    } catch (err) {
      setAiTestText((prev) => ({ ...prev, [id]: aiErrorMessage(err) }));
    } finally {
      setAiTesting(null);
    }
  }

  async function removeProvider(id: string) {
    await onAiRemove(id);
    setAiEditing((current) => (current === id ? null : current));
  }

  return (
    <div className="cc-scroll flex min-h-0 flex-1 flex-col overflow-y-auto pb-base">
      <Section title="快捷键">
        <Row
          label="唤起面板"
          hint={
            hotkeys.activate
              ? '已生效'
              : hotkeys.conflicts.length > 0
                ? '与系统或其他程序冲突：' + hotkeys.conflicts.join('、')
                : '注册失败'
          }
        >
          <HotkeyRecorder
            label="唤起面板"
            value={settings.hotkeyActivate}
            defaultValue={DEFAULT_SETTINGS.hotkeyActivate}
            onChange={(v) => onUpdate({ hotkeyActivate: v === '' ? DEFAULT_SETTINGS.hotkeyActivate : v })}
          />
        </Row>
        <Row label="切换小组件" hint={hotkeys.widget ? '已生效' : '注册失败'}>
          <HotkeyRecorder
            label="切换小组件"
            value={settings.hotkeyWidget}
            defaultValue={DEFAULT_SETTINGS.hotkeyWidget}
            onChange={(v) => onUpdate({ hotkeyWidget: v === '' ? DEFAULT_SETTINGS.hotkeyWidget : v })}
          />
        </Row>
        <Row label="拼接选中项" hint="按住 Ctrl 或 Shift 多选几条后按下">
          <kbd className="rounded-input border border-line bg-surface-2 px-snug py-[3px] font-mono text-[11px] text-ink-2">
            Ctrl+M
          </kbd>
        </Row>
        <Row
          label="Enter 自动粘贴"
          hint="关闭后双击记录只复制到剪贴板，不自动贴回原窗口"
        >
          <Toggle on={settings.autoPaste} onChange={(autoPaste) => onUpdate({ autoPaste })} />
        </Row>
        <Row label="开机自启动" hint="登录 Windows 后自动在托盘运行">
          <Toggle
            on={autoStartOn}
            onChange={() => {
              const step = autoStartClick({ on: autoStartOn });
              setAutoStartOn(step.state.on);
              void Promise.resolve(onSetAutoStart(step.requested))
                .then((ok) => (ok === false ? false : ok === true ? true : undefined))
                .then((ok) => {
                  setAutoStartOn(autoStartSettle(step.state, step.requested, ok).on);
                });
            }}
          />
        </Row>
      </Section>

      <Section title="外观">
        <Row label="主题">
          <Segmented
            value={settings.theme}
            options={THEME_OPTIONS}
            onChange={(theme) => onUpdate({ theme })}
          />
        </Row>
        <Row
          label="毛玻璃"
          hint={
            capabilities.frostedGlass
              ? '已启用：窗口使用系统真毛玻璃'
              : 'Win10 的系统模糊会铺满整个矩形、裁不出圆角（四边会发白），因此改为真圆角 + 88% 半透明'
          }
        >
          <span className={cn('text-[11px]', capabilities.frostedGlass ? 'text-[var(--cc-primary)]' : 'text-ink-3')}>
            {capabilities.frostedGlass ? '已启用' : '半透明'}
          </span>
        </Row>
      </Section>

      <Section title="历史">
        <Row
          label="条数上限"
          hint={'当前上限 ' + settings.historyLimit + ' 条，超出后最旧的未收藏记录会被清理'}
        >
          <div className="flex shrink-0 items-center gap-tight">
            <input
              type="range"
              min={HISTORY_SLIDER_MIN}
              max={HISTORY_SLIDER_MAX}
              step={HISTORY_SLIDER_STEP}
              value={historyValue}
              onChange={(event) => onUpdate({ historyLimit: Number(event.target.value) })}
              className="w-[150px] accent-[var(--cc-primary)]"
            />
            <input
              type="number"
              min={HISTORY_SLIDER_MIN}
              max={HISTORY_INPUT_MAX}
              value={settings.historyLimit}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (!Number.isFinite(next)) return;
                onUpdate({ historyLimit: Math.min(HISTORY_INPUT_MAX, Math.max(HISTORY_SLIDER_MIN, Math.round(next))) });
              }}
              className="w-[70px] rounded-input border border-line bg-surface px-tight py-[4px] text-right text-[12px] text-ink outline-none focus:border-[var(--cc-border-strong)]"
            />
          </div>
        </Row>
        <Row label="图片磁盘预算" hint={'当前占用 ' + settings.imageBudgetMB + ' MB 上限内的已用空间由主进程统计'}>
          <Segmented
            value={settings.imageBudgetMB}
            options={IMAGE_BUDGET_OPTIONS.map((mb) => ({ value: mb as number, label: mb + ' MB' }))}
            onChange={(imageBudgetMB) => onUpdate({ imageBudgetMB })}
          />
        </Row>
      </Section>

      <Section title="小组件">
        <Row label="小组件宽度" hint={settings.widgetSize + ' px（240–400）'}>
          <input
            type="range"
            min={WIDGET_SIZE_MIN}
            max={WIDGET_SIZE_MAX}
            step={1}
            value={settings.widgetSize}
            onChange={(event) => onUpdate({ widgetSize: Number(event.target.value) })}
            className="w-[150px] accent-[var(--cc-primary)]"
          />
        </Row>
        <Row label="出现位置">
          <Segmented
            value={settings.widgetCorner}
            options={[
              { value: 'remember' as const, label: '记住上次' },
              { value: 'bottom-right' as const, label: '右下角' },
            ]}
            onChange={(widgetCorner) => onUpdate({ widgetCorner })}
          />
        </Row>
        <Row label="失焦自动隐藏" hint="点走焦点后小组件自动收起">
          <Toggle on={settings.hideOnBlur} onChange={(hideOnBlur) => onUpdate({ hideOnBlur })} />
        </Row>
        <Row label="当前形态">
          <button
            type="button"
            onClick={onToggleMode}
            className="rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2"
          >
            {mode === 'widget' ? '切回主面板' : '切换到小组件'}
          </button>
        </Row>
      </Section>

      <Section title="AI 模型">
        {aiProviders.length === 0 ? (
          <p className="text-[11px] leading-[1.6] text-ink-3">
            还没有配置模型。添加一个之后，就能在优化提示词时用它改写内容。
          </p>
        ) : null}

        {aiProviders.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-snug rounded-card border border-line bg-surface-2 px-snug py-tight"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] text-ink">{p.name}</p>
              <p className="truncate text-[11px] text-ink-3">
                {protocolLabel(p.protocol)} · {p.model}
              </p>
              {aiTestText[p.id] ? (
                <p className="mt-[2px] text-[11px] leading-[1.6] text-ink-3">{aiTestText[p.id]}</p>
              ) : null}
            </div>
            <button
              type="button"
              disabled={aiTesting === p.id}
              onClick={() => void testProvider(p.id)}
              className="shrink-0 rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {aiTesting === p.id ? '测试中…' : '测试'}
            </button>
            <button
              type="button"
              onClick={() => setAiEditing(p.id)}
              className="shrink-0 rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2"
            >
              编辑
            </button>
            <button
              type="button"
              onClick={() => void removeProvider(p.id)}
              className="shrink-0 rounded-button border border-line px-snug py-[4px] text-[11px] text-red-400 hover:bg-surface-2"
            >
              删除
            </button>
          </div>
        ))}

        {aiEditing === 'new' || aiEditingProvider ? (
          <AiProviderForm
            {...(aiEditingProvider ? { provider: aiEditingProvider } : {})}
            onSave={async (input) => {
              await onAiSave(input);
              setAiEditing(null);
            }}
            onRemove={async (id) => {
              await removeProvider(id);
            }}
            onTest={onAiTest}
            onListModels={onAiListModels}
            onCancel={() => setAiEditing(null)}
          />
        ) : (
          <Row label="添加模型" hint="支持 OpenAI 兼容 / Anthropic / Gemini 三种协议">
            <button
              type="button"
              onClick={() => setAiEditing('new')}
              className="shrink-0 rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2"
            >
              添加模型
            </button>
          </Row>
        )}
      </Section>

      <Section title="数据">
        <Row label="清空未收藏" hint="保留已收藏的记录">
          <button
            type="button"
            onClick={() => {
              if (pendingClear === 'unpinned') {
                setPendingClear(null);
                onClearUnpinned();
              } else {
                setPendingClear('unpinned');
              }
            }}
            className={cn(
              'shrink-0 rounded-button border px-snug py-[4px] text-[11px]',
              pendingClear === 'unpinned'
                ? 'border-[var(--cc-accent)] bg-[var(--cc-accent)] text-white'
                : 'border-line text-ink-2 hover:bg-surface-2',
            )}
          >
            {pendingClear === 'unpinned' ? '再点一次确认' : '清空未收藏'}
          </button>
        </Row>
        <Row label="清空全部" hint="含已收藏记录，不可恢复">
          <button
            type="button"
            onClick={() => {
              if (pendingClear === 'all') {
                setPendingClear(null);
                onClearAll();
              } else {
                setPendingClear('all');
              }
            }}
            className={cn(
              'shrink-0 rounded-button border px-snug py-[4px] text-[11px]',
              pendingClear === 'all'
                ? 'border-[var(--cc-accent)] bg-[var(--cc-accent)] text-white'
                : 'border-line text-ink-2 hover:bg-surface-2',
            )}
          >
            {pendingClear === 'all' ? '再点一次确认' : '清空全部'}
          </button>
        </Row>

        <div className="rounded-card border border-line bg-surface-2 px-snug py-tight">
          <div className="flex items-center gap-tight">
            <Ghost size={14} className="text-[var(--cc-accent)]" aria-hidden />
            <span className="text-[12px] text-ink">幽灵模式</span>
            <div className="flex-1" />
            {ghost.active ? (
              <span className="text-[11px] text-[var(--cc-accent)]">
                剩余 {formatRemaining(ghost.remainingMs)}
                {ghost.until ? '（到 ' + formatClock(ghost.until) + '）' : ''}
              </span>
            ) : (
              <span className="text-[11px] text-ink-3">未启用</span>
            )}
            <button
              type="button"
              onClick={() => onGhost(0)}
              disabled={!ghost.active}
              className={cn(
                'rounded-button border border-line px-snug py-[3px] text-[11px]',
                ghost.active ? 'text-ink-2 hover:bg-surface' : 'cursor-not-allowed text-ink-3 opacity-60',
              )}
            >
              关闭
            </button>
          </div>
          <div className="mt-tight flex flex-wrap items-center gap-tight">
            {GHOST_PRESETS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                onClick={() => onGhost(minutes)}
                className="rounded-button border border-line bg-surface px-snug py-[3px] text-[11px] text-ink-2 hover:bg-surface-2"
              >
                {minutes} 分钟
              </button>
            ))}
            <input
              type="number"
              min={1}
              max={GHOST_MAX_MINUTES}
              value={customMinutes}
              onChange={(event) => setCustomMinutes(event.target.value)}
              className="w-[64px] rounded-input border border-line bg-surface px-tight py-[3px] text-right text-[11px] text-ink outline-none focus:border-[var(--cc-border-strong)]"
            />
            <button
              type="button"
              disabled={!customValid}
              onClick={() => onGhost(custom)}
              className={cn(
                'rounded-button border border-line px-snug py-[3px] text-[11px]',
                customValid ? 'text-ink-2 hover:bg-surface-2' : 'cursor-not-allowed text-ink-3 opacity-60',
              )}
            >
              自定义开启
            </button>
          </div>
          <p className="mt-tight text-[11px] leading-[1.7] text-[var(--cc-accent)]">
            幽灵模式会彻底停止剪贴板监听：期间复制的内容不会记录，结束后也不会补录；重启后不保留。
          </p>
        </div>

        <Row label="导出备份" hint="把全部记录写成 JSON 文件，存到数据目录">
          <button
            type="button"
            onClick={onExportAll}
            className="flex shrink-0 items-center gap-[4px] rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2"
          >
            <Download size={12} aria-hidden />
            导出 JSON
          </button>
        </Row>

        <Row label="存储位置" hint="数据库与图片缓存的存放目录">
          <button
            type="button"
            onClick={onOpenDataFolder}
            className="flex shrink-0 items-center gap-[4px] rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2"
          >
            <FolderOpen size={12} aria-hidden />
            打开文件夹
          </button>
        </Row>
      </Section>

      <p className="pt-base text-center text-[11px] text-ink-3">剪贴板酱 v{APP_VERSION}</p>
    </div>
  );
}
