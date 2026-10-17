import { useState } from 'react';
import type { AiError, AiProtocol, AiProvider, AiProviderInput } from '../types';
import { DEFAULT_BASE_URL, PROTOCOL_OPTIONS, aiErrorMessage, validateProvider } from './aiProviderForm';
import { cn } from './util';

/**
 * 单个 provider 的编辑表单（计划 Task 6 Step 3）。
 * 文件名带 Card 后缀：与同目录的纯函数模块 aiProviderForm.ts 仅差大小写时，
 * TypeScript 在大小写不敏感的文件系统上会把两个名字认成同一个文件（TS1149 /
 * 解析落到 .ts 上导致 TS2724），故刻意让组件文件名与它不同名。
 * 组件不直接 getPlatform()：provider 列表与网络动作全部由 App 通过 props 注入，
 * 与 SettingsView 的 props 驱动风格一致，也方便以后换宿主。
 */

/** 「没拉到模型列表」的降级提示（Review Focus 2：接口不存在也要能手输）。 */
export const LIST_FAILED_HINT = '没拉到模型列表，可直接手输模型名';

const INPUT_CLASS =
  'w-full rounded-input border border-line bg-surface px-snug py-[5px] text-[12px] text-ink outline-none placeholder:text-ink-3 focus:border-[var(--cc-primary)]';
const GHOST_BUTTON_CLASS =
  'rounded-button border border-line px-snug py-[4px] text-[11px] text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60';
const PRIMARY_BUTTON_CLASS =
  'rounded-button bg-[var(--cc-primary)] px-snug py-[4px] text-[11px] text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60';

export interface AiProviderFormProps {
  /** 有值 = 编辑既有 provider；无值 = 新增（不传 id，Key 必须填）。 */
  provider?: AiProvider;
  onSave: (input: AiProviderInput) => Promise<void>;
  onRemove?: (id: string) => Promise<void>;
  onTest: (id: string) => Promise<{ ok: boolean; error?: AiError; model?: string }>;
  onListModels: (id: string) => Promise<string[]>;
  onCancel: () => void;
}

export function AiProviderForm({
  provider,
  onSave,
  onRemove,
  onTest,
  onListModels,
  onCancel,
}: AiProviderFormProps) {
  const [name, setName] = useState(provider?.name ?? '');
  const [protocol, setProtocol] = useState<AiProtocol>(provider?.protocol ?? 'openai-compat');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? DEFAULT_BASE_URL['openai-compat']);
  const [model, setModel] = useState(provider?.model ?? '');
  const [apiKey, setApiKey] = useState('');
  // 已有 Key 时默认沿用（不显示输入框），点「重新填写」才露出输入框。
  const [reenterKey, setReenterKey] = useState(!provider?.hasKey);
  const [errors, setErrors] = useState<string[]>([]);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [listHint, setListHint] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const busy = saving || testLoading || listLoading;

  function changeProtocol(next: AiProtocol) {
    setProtocol(next);
    // 「切换协议时若输入框为空则填入默认值」：非空内容一律不动，避免抹掉用户手输的地址。
    setBaseUrl((current) => (current.trim() ? current : DEFAULT_BASE_URL[next]));
    setModelOptions([]);
    setListHint(null);
  }

  async function pullModels() {
    if (!provider) return;
    setListLoading(true);
    setListHint(null);
    try {
      const list = await onListModels(provider.id);
      if (list.length === 0) {
        setModelOptions([]);
        setListHint(LIST_FAILED_HINT);
      } else {
        setModelOptions(list);
        if (!model.trim()) setModel(list[0] ?? '');
      }
    } catch {
      // 接口不存在/网络不通都走同一条降级路径：不报错弹窗，直接允许手输。
      setModelOptions([]);
      setListHint(LIST_FAILED_HINT);
    } finally {
      setListLoading(false);
    }
  }

  async function sendTest() {
    if (!provider) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const result = await onTest(provider.id);
      setTestResult(
        result.ok
          ? `${result.model ?? provider.model} 可用`
          : result.error
            ? aiErrorMessage(result.error)
            : '测试失败',
      );
    } catch (err) {
      setTestResult(aiErrorMessage(err));
    } finally {
      setTestLoading(false);
    }
  }

  async function submit() {
    const found = validateProvider({ name, protocol, baseUrl, model });
    setErrors(found);
    if (found.length > 0) return;
    setSaving(true);
    try {
      await onSave({
        ...(provider ? { id: provider.id } : {}),
        name: name.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        // 留空 = 沿用原 Key（主进程按 apiKey 缺省处理）。
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
    } catch (err) {
      setErrors([aiErrorMessage(err)]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-snug rounded-card border border-line bg-surface-2 px-snug py-snug">
      <p className="text-[12px] font-semibold text-ink">{provider ? '编辑模型' : '添加模型'}</p>

      <label className="flex flex-col gap-[4px]">
        <span className="text-[12px] text-ink">名称</span>
        <input
          className={INPUT_CLASS}
          value={name}
          placeholder="例如 我的 GPT-4o"
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <div className="flex flex-col gap-[4px]">
        <span className="text-[12px] text-ink">协议</span>
        <div className="flex shrink-0 items-center gap-[2px] self-start rounded-button border border-line bg-surface-2 p-[2px]">
          {PROTOCOL_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => changeProtocol(option.value)}
              className={cn(
                'rounded-[9px] px-snug py-[3px] text-[11px] transition-colors',
                option.value === protocol ? 'bg-surface text-ink shadow-card' : 'text-ink-2 hover:text-ink',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <label className="flex flex-col gap-[4px]">
        <span className="text-[12px] text-ink">Base URL</span>
        <input
          className={INPUT_CLASS}
          value={baseUrl}
          placeholder={DEFAULT_BASE_URL[protocol]}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>

      <div className="flex flex-col gap-[4px]">
        <span className="text-[12px] text-ink">API Key</span>
        {provider?.hasKey && !reenterKey ? (
          <div className="flex items-center gap-snug">
            <code className="min-w-0 flex-1 truncate rounded-input border border-line bg-surface px-snug py-[5px] font-mono text-[12px] text-ink-2">
              {provider.keyMask}
            </code>
            <button type="button" className={GHOST_BUTTON_CLASS} onClick={() => setReenterKey(true)}>
              重新填写
            </button>
          </div>
        ) : (
          <input
            className={INPUT_CLASS}
            type="password"
            value={apiKey}
            placeholder={provider?.hasKey ? '留空则沿用原 Key' : '粘贴 API Key'}
            onChange={(e) => setApiKey(e.target.value)}
          />
        )}
      </div>

      <div className="flex flex-col gap-[4px]">
        <span className="text-[12px] text-ink">默认模型</span>
        <div className="flex items-center gap-snug">
          <input
            className={INPUT_CLASS}
            value={model}
            placeholder="例如 gpt-4o"
            onChange={(e) => setModel(e.target.value)}
          />
          <button
            type="button"
            className={GHOST_BUTTON_CLASS}
            disabled={!provider || listLoading}
            title={provider ? '从服务端拉取模型列表' : '先保存一次才能拉取列表'}
            onClick={() => void pullModels()}
          >
            {listLoading ? '拉取中…' : '拉取列表'}
          </button>
        </div>
        {modelOptions.length > 0 ? (
          <select
            className={INPUT_CLASS}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {modelOptions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        ) : null}
        {listHint ? <p className="text-[11px] leading-[1.6] text-ink-3">{listHint}</p> : null}
      </div>

      <div className="flex items-center gap-snug">
        <button
          type="button"
          className={GHOST_BUTTON_CLASS}
          disabled={!provider || testLoading}
          onClick={() => void sendTest()}
        >
          {testLoading ? '测试中…' : '发送测试消息'}
        </button>
        {testResult ? <p className="min-w-0 flex-1 text-[11px] text-ink-3">{testResult}</p> : null}
      </div>

      {errors.length > 0 ? (
        <ul className="flex flex-col gap-[2px]">
          {errors.map((message) => (
            <li key={message} className="text-[11px] leading-[1.6] text-red-400">
              {message}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center gap-snug">
        <button type="button" className={PRIMARY_BUTTON_CLASS} disabled={busy} onClick={() => void submit()}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button type="button" className={GHOST_BUTTON_CLASS} onClick={onCancel}>
          取消
        </button>
        {provider && onRemove ? (
          <button
            type="button"
            className={cn(GHOST_BUTTON_CLASS, 'ml-auto text-red-400')}
            onClick={() => void onRemove(provider.id)}
          >
            删除
          </button>
        ) : null}
      </div>
    </div>
  );
}
