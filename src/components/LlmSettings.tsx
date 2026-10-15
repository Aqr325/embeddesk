import { useState, useEffect, useCallback } from 'react';
import {
  Bot,
  Save,
  FlaskConical,
  RotateCcw,
  Loader2,
  AlertCircle,
  CheckCircle2,
  KeyRound,
  Thermometer,
  Type,
  Cpu,
  Sparkles,
  Eye,
  EyeOff,
  Search,
  Settings2,
  PlugZap,
  Activity,
  RefreshCw,
} from 'lucide-react';
import { api, type LlmConfigPublic, type LlmConfigTestResult, type ProviderMeta, type ProviderPreset, type LlmMetrics } from '../hooks/useApi';

const TEMP_MIN = 0;
const TEMP_MAX = 1;
const MAX_REPLY_MIN = 100;
const MAX_REPLY_MAX = 2000;
const TOKEN_MIN = 256;
const TOKEN_MAX = 2000000;

/** 能力开关复选（高级配置） */
function CapCheckbox({
  label,
  checked,
  onChange,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  title?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer select-none" title={title}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 rounded accent-accent"
      />
      {label}
    </label>
  );
}

/** 引擎标识 → 展示名（调用监控） */
function engineLabel(provider: string): string {
  const map: Record<string, string> = {
    openai: 'OpenAI 兼容',
    anthropic: 'Anthropic',
    gemini: 'Gemini',
    sdk: 'CodeBuddy SDK',
    knowledge_base: '知识库直答',
    unknown: '未知',
  };
  return map[provider] || provider;
}

/** 调用状态徽章（ok=正常 / degraded=降级 / error=失败） */
function statusLabel(status: string): string {
  const map: Record<string, string> = { ok: '正常', degraded: '降级', error: '失败' };
  return map[status] || status;
}

function statusClass(status: string): string {
  const map: Record<string, string> = {
    ok: 'bg-success/15 text-success',
    degraded: 'bg-warning/15 text-warning',
    error: 'bg-destructive/15 text-destructive',
  };
  return map[status] || 'bg-muted text-muted-foreground';
}

/** ISO 时间 → MM-DD HH:mm（调用监控列表） */
function formatLogTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function LlmSettings() {
  const [config, setConfig] = useState<LlmConfigPublic | null>(null);
  const [models, setModels] = useState<Array<{ modelId: string; name: string }>>([]);
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTip, setSavedTip] = useState<string | null>(null);
  const [discoverNote, setDiscoverNote] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<LlmConfigTestResult | null>(null);

  // 表单（与后端字段对齐）
  const [preset, setPreset] = useState('custom'); // 供应商预设 id
  const [provider, setProvider] = useState('auto'); // 接入协议（自定义协议展开时可选）
  const [model, setModel] = useState('auto');
  const [apiKey, setApiKey] = useState(''); // 仅在用户主动填写时发送；不回显明文
  const [showKey, setShowKey] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [maxReplyLength, setMaxReplyLength] = useState(600);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [discoveredModels, setDiscoveredModels] = useState<Array<{ modelId: string; name: string }>>([]);

  // 调用监控（llm_call_logs 聚合）
  const [metrics, setMetrics] = useState<LlmMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);

  const loadMetrics = useCallback(async () => {
    setMetricsLoading(true);
    try {
      setMetrics(await api.getLlmMetrics(7));
    } catch {
      // 监控数据加载失败不阻塞配置面板（best-effort）
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  // 高级配置
  const [toolCalling, setToolCalling] = useState(true);
  const [imageInput, setImageInput] = useState(false);
  const [thinkingMode, setThinkingMode] = useState(false);
  const [customProtocol, setCustomProtocol] = useState(false);
  const [maxInputTokens, setMaxInputTokens] = useState(''); // 空 = 使用提供商默认值
  const [maxOutputTokens, setMaxOutputTokens] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfgRes, modelsRes] = await Promise.all([api.getLlmConfig(), api.getModels()]);
      const c = cfgRes.config;
      const presetList = modelsRes.presets || [];
      setConfig(c);
      setModels(modelsRes.models);
      setProviders(modelsRes.providers || []);
      setPresets(presetList);
      setProvider(c.provider || 'auto');
      setModel(c.model || 'auto');
      setEndpoint(c.endpoint || '');
      setTemperature(c.temperature ?? 0.7);
      setMaxReplyLength(c.maxReplyLength ?? 600);
      setSystemPrompt(c.systemPrompt || ''); // 空 = 使用系统默认提示词
      setToolCalling(c.toolCalling ?? true);
      setImageInput(c.imageInput ?? false);
      setThinkingMode(c.thinkingMode ?? false);
      setCustomProtocol(c.customProtocol ?? false);
      setMaxInputTokens(c.maxInputTokens ? String(c.maxInputTokens) : '');
      setMaxOutputTokens(c.maxOutputTokens ? String(c.maxOutputTokens) : '');
      // 按已存端点反查供应商预设（精确匹配才回显，否则「自定义」）
      const matched = presetList.find((p) => p.endpoint && p.endpoint === c.endpoint);
      setPreset(matched?.id ?? 'custom');
      setDiscoveredModels([]);
      setDiscoverNote(null);
      setTestResult(null);
      setApiKey('');
    } catch (e: any) {
      setError(e?.message || '加载配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    loadMetrics();
  }, [load, loadMetrics]);

  /* ---------- 供应商预设（仅 OpenAI 兼容协议 API） ---------- */
  const handlePresetChange = (id: string) => {
    setPreset(id);
    const p = presets.find((x) => x.id === id);
    const prev = presets.find((x) => x.id === preset);
    setDiscoverNote(null);
    setDiscoveredModels([]);
    setSavedTip(null);
    if (p?.endpoint) {
      setEndpoint(p.endpoint);
      // 模型名：为空或正等于上一个预设的默认模型时才覆盖，避免冲掉用户手填
      if (!model.trim() || (prev && model === prev.defaultModel)) setModel(p.defaultModel);
    }
  };

  /* ---------- 高级配置：自定义协议 ---------- */
  const handleCustomProtocolToggle = (on: boolean) => {
    setCustomProtocol(on);
    setDiscoverNote(null);
    setDiscoveredModels([]);
    setSavedTip(null);
    if (on) {
      const meta = providers.find((p) => p.id === provider);
      if (!endpoint.trim() && meta?.defaultEndpoint) setEndpoint(meta.defaultEndpoint);
    }
  };

  const handleProviderChange = (next: string) => {
    setProvider(next);
    const meta = providers.find((p) => p.id === next);
    if (!endpoint.trim() && meta?.defaultEndpoint) setEndpoint(meta.defaultEndpoint);
    setDiscoverNote(null);
    setDiscoveredModels([]);
    setSavedTip(null);
  };

  /* ---------- 生效协议（未勾选「自定义协议」时固定 OpenAI 兼容） ---------- */
  const onPlatformDefault = (config?.provider || 'auto') === 'auto';
  const nothingConfigured = !endpoint.trim() && !model.trim() && apiKey.length === 0 && !config?.hasApiKey;
  const effectiveProvider = customProtocol ? provider : 'openai';
  const providerToSave =
    nothingConfigured && !customProtocol ? config?.provider || 'auto' : effectiveProvider;
  const meta = providers.find((p) => p.id === providerToSave);
  const activePreset = presets.find((p) => p.id === preset);

  /* ---------- 探测可用模型（填接口地址后自动拉取） ---------- */
  const handleDiscover = async () => {
    if (!endpoint.trim()) {
      setError('请先填写接口地址');
      return;
    }
    setDiscovering(true);
    setDiscoverNote(null);
    setError(null);
    try {
      const res = await api.discoverModels({ provider: providerToSave, endpoint, apiKey: apiKey || undefined });
      if (res.ok && res.models?.length) {
        setDiscoveredModels(res.models);
        if (!res.models.some((m) => m.modelId === model)) setModel(res.models[0].modelId);
        setDiscoverNote(`已发现 ${res.models.length} 个可用模型，已自动填充下拉`);
      } else if (res.ok) {
        setDiscoverNote('该端点未返回可用模型列表');
      } else {
        setDiscoverNote(`探测失败：${res.error || '未知错误'}`);
      }
    } catch (e: any) {
      setError(e?.message || '探测失败');
    } finally {
      setDiscovering(false);
    }
  };

  /* ---------- 测试连接（用表单当前值，无需先保存） ---------- */
  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      setTestResult(
        await api.testLlmConfig({
          provider: providerToSave,
          endpoint,
          apiKey: apiKey || undefined,
          model,
        }),
      );
    } catch (e: any) {
      setError(e?.message || '测试连接失败');
    } finally {
      setTesting(false);
      loadMetrics();
    }
  };

  const handleSave = async () => {
    // 前端守卫：显式协议必须填齐模型与接口地址
    if (providerToSave !== 'auto') {
      if (!model.trim()) {
        setError('请填写模型名称（如 gpt-4o）');
        return;
      }
      if (!endpoint.trim()) {
        setError('请填写接口地址');
        return;
      }
    }
    setSaving(true);
    setError(null);
    setSavedTip(null);
    try {
      const payload: Record<string, unknown> = {
        provider: providerToSave,
        model: model.trim() || (providerToSave === 'auto' ? 'auto' : ''),
        endpoint,
        temperature,
        maxReplyLength,
        systemPrompt,
        toolCalling,
        imageInput,
        thinkingMode,
        customProtocol,
        maxInputTokens: maxInputTokens.trim() ? Number(maxInputTokens) : null,
        maxOutputTokens: maxOutputTokens.trim() ? Number(maxOutputTokens) : null,
      };
      // apiKey 仅在用户填写时才发送（空字符串表示清除）
      if (apiKey.length > 0) payload.apiKey = apiKey;
      const res = await api.saveLlmConfig(payload);
      setConfig(res.config);
      setSavedTip('配置已保存并立即生效');
      setApiKey(''); // 清空输入框，避免重复提交明文
      setTestResult(null);
      loadMetrics();
    } catch (e: any) {
      setError(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  /* ---------- 恢复平台默认接入 ---------- */
  const handleResetPlatform = async () => {
    setSaving(true);
    setError(null);
    setSavedTip(null);
    try {
      const res = await api.saveLlmConfig({ provider: 'auto', model: 'auto', endpoint: '' });
      setConfig(res.config);
      setSavedTip('已恢复平台默认接入（CodeBuddy Agent SDK）');
      await load();
      loadMetrics();
    } catch (e: any) {
      setError(e?.message || '恢复失败');
    } finally {
      setSaving(false);
    }
  };

  const handleResetPrompt = () => {
    setSystemPrompt(''); // 清空即恢复系统默认 persona 提示词
    setSavedTip(null);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
        <Loader2 size={16} className="animate-spin" /> 加载模型配置中…
      </div>
    );
  }

  const canDiscover = providerToSave !== 'auto' && endpoint.trim().length > 0 && Boolean(meta?.discoverable);

  return (
    <div className="space-y-5">
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 text-destructive text-sm px-4 py-3">
          <AlertCircle size={16} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {savedTip && (
        <div className="flex items-start gap-2 rounded-xl border border-success/40 bg-success/10 text-success text-sm px-4 py-3">
          <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
          <span>{savedTip}</span>
        </div>
      )}

      {/* ============ 模型配置（WorkBuddy 式接入面板） ============ */}
      <div className="rounded-2xl border border-border bg-card p-4 sm:p-6 space-y-5 shadow-sm">
        <div className="flex items-start gap-2">
          <Cpu size={18} className="text-accent mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold">模型配置</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              接入自定义大模型端点（OpenAI 兼容协议），保存后立即生效；未配置时使用平台默认接入。
            </p>
          </div>
        </div>

        {onPlatformDefault && nothingConfigured && (
          <div className="rounded-xl border border-border bg-muted/40 text-xs text-muted-foreground px-4 py-2.5">
            当前使用<b className="text-foreground">平台默认接入</b>（CodeBuddy Agent SDK）。填写下方自定义模型并保存后切换。
          </div>
        )}

        {/* 供应商（仅支持 OpenAI 兼容协议 API） */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1.5">供应商（仅支持 OpenAI 兼容协议 API）</label>
          <select
            value={preset}
            onChange={(e) => handlePresetChange(e.target.value)}
            className="w-full min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm focus:border-accent outline-none"
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === 'custom' ? `✦ ${p.label}` : p.label}
              </option>
            ))}
            {!presets.some((p) => p.id === preset) && <option value={preset}>{preset}</option>}
          </select>
          {activePreset?.hint && <p className="text-xs text-muted-foreground mt-1.5">{activePreset.hint}</p>}
        </div>

        {/* 接口地址 */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1.5">接口地址</label>
          <input
            value={endpoint}
            onChange={(e) => {
              setEndpoint(e.target.value);
              setSavedTip(null);
            }}
            placeholder="https://api.example.com/v1/chat/completions"
            className="w-full min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm focus:border-accent outline-none"
          />
          <p className="text-xs text-muted-foreground mt-1.5">
            填完整接口地址（至 /chat/completions）；也支持 /v1 层级或根地址，系统自动拼接路径。
          </p>
        </div>

        {/* API Key + 测试连接 */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1.5">API Key</label>
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={config?.hasApiKey ? '如需更换请填写新密钥，留空保持不变' : '输入你的 API Key'}
                className="w-full min-h-[44px] rounded-lg border border-border bg-background px-3 pr-10 text-sm focus:border-accent outline-none"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground hover:text-foreground"
                title={showKey ? '隐藏密钥' : '显示密钥'}
              >
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <button
              onClick={handleTest}
              disabled={testing}
              className="inline-flex items-center justify-center gap-1.5 text-sm px-4 min-h-[44px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50 shrink-0"
            >
              {testing ? <Loader2 size={15} className="animate-spin" /> : <PlugZap size={15} />}
              {testing ? '测试中…' : '测试连接'}
            </button>
          </div>
          {testResult && (
            <p
              className={`text-xs mt-1.5 ${
                testResult.ok ? 'text-success' : 'text-destructive'
              }`}
            >
              {testResult.ok
                ? `连接成功 · 模型 ${testResult.usedModel} · 耗时 ${testResult.latencyMs}ms${testResult.reply ? ` · 回复「${testResult.reply}」` : ''}`
                : `连接失败：${testResult.error}`}
            </p>
          )}
        </div>

        {/* 模型名称 + 探测 */}
        <div>
          <label className="block text-xs text-muted-foreground mb-1.5">模型名称</label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setSavedTip(null);
              }}
              placeholder="输入模型参数，例如 gpt-4o 或 openai/gpt-4o"
              className="flex-1 min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm focus:border-accent outline-none"
            />
            <button
              onClick={handleDiscover}
              disabled={discovering || !canDiscover}
              className="inline-flex items-center justify-center gap-1.5 text-sm px-4 min-h-[44px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50 shrink-0"
              title={canDiscover ? '按接口地址自动拉取可用模型' : '请先填写接口地址（auto 模式无需探测）'}
            >
              {discovering ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
              {discovering ? '探测中…' : '探测可用模型'}
            </button>
          </div>
          {discoverNote && (
            <p
              className={`text-xs mt-1.5 ${
                discoverNote.startsWith('探测失败') ? 'text-destructive' : 'text-accent'
              }`}
            >
              {discoverNote}
            </p>
          )}
          {discoveredModels.length > 0 && (
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full mt-2 min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm focus:border-accent outline-none"
            >
              {discoveredModels.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {m.name}
                </option>
              ))}
              {model && !discoveredModels.some((m) => m.modelId === model) && <option value={model}>{model}</option>}
            </select>
          )}
          <p className="text-xs text-muted-foreground mt-1.5">AI 自动应答、意图识别与工具调用均运行于该模型。</p>
        </div>

        {/* 高级配置 */}
        <div className="border-t border-border pt-4 space-y-3">
          <div className="flex items-center gap-2">
            <Settings2 size={14} className="text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">高级配置</span>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <CapCheckbox
              label="工具调用"
              checked={toolCalling}
              onChange={setToolCalling}
              title="关闭后模型以纯对话模式运行，不注入知识库/订单/建单工具"
            />
            <CapCheckbox
              label="图片输入"
              checked={imageInput}
              onChange={setImageInput}
              title="允许向支持视觉的模型传递图片（多模态客服场景预留）"
            />
            <CapCheckbox
              label="思考模式"
              checked={thinkingMode}
              onChange={setThinkingMode}
              title="对支持思考的模型生效（如智谱 GLM-4.5+）"
            />
            <CapCheckbox
              label="自定义协议"
              checked={customProtocol}
              onChange={handleCustomProtocolToggle}
              title="展开后可切换 Anthropic / Gemini 等非 OpenAI 兼容协议"
            />
          </div>

          {customProtocol && (
            <div>
              <label className="block text-xs text-muted-foreground mb-1.5">接入协议</label>
              <select
                value={provider}
                onChange={(e) => handleProviderChange(e.target.value)}
                className="w-full min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm focus:border-accent outline-none"
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              {meta?.hint && <p className="text-xs text-muted-foreground mt-1.5">{meta.hint}</p>}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-muted-foreground mb-1.5">输入</label>
              <input
                type="number"
                min={TOKEN_MIN}
                max={TOKEN_MAX}
                value={maxInputTokens}
                onChange={(e) => setMaxInputTokens(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="使用提供商默认值"
                className="w-full min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm focus:border-accent outline-none"
              />
              <p className="text-xs text-muted-foreground mt-1.5">最大输入 Tokens（上下文预算，超出自动裁剪早期对话）</p>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1.5">输出</label>
              <input
                type="number"
                min={TOKEN_MIN}
                max={TOKEN_MAX}
                value={maxOutputTokens}
                onChange={(e) => setMaxOutputTokens(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="使用提供商默认值"
                className="w-full min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm focus:border-accent outline-none"
              />
              <p className="text-xs text-muted-foreground mt-1.5">最大输出 Tokens（单次回复上限）</p>
            </div>
          </div>
        </div>

        {/* 页脚：恢复平台默认 / 取消 / 保存 */}
        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <div>
            {!onPlatformDefault && (
              <button
                onClick={handleResetPlatform}
                disabled={saving}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 min-h-[36px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
                title="清空自定义模型，回到平台默认 SDK 接入"
              >
                <RotateCcw size={13} /> 恢复平台默认
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={load}
              disabled={saving}
              className="inline-flex items-center text-sm px-4 min-h-[44px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-1.5 text-sm px-5 min-h-[44px] rounded-lg bg-accent text-accent-foreground hover:opacity-90 transition-base disabled:opacity-50"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>

      {/* ============ 生成参数 ============ */}
      <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 space-y-5">
        <div className="flex items-center gap-2">
          <Thermometer size={16} className="text-accent" />
          <h3 className="text-sm font-medium">生成参数</h3>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs text-muted-foreground">温度（Temperature）：{temperature.toFixed(1)}</label>
            <span className="text-xs text-muted-foreground">{TEMP_MIN} – {TEMP_MAX}</span>
          </div>
          <input
            type="range"
            min={TEMP_MIN}
            max={TEMP_MAX}
            step={0.1}
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value))}
            className="w-full accent-accent"
          />
          <p className="text-xs text-muted-foreground mt-1.5">越低越稳定精准，越高越发散有创意。经透传参数生效（best-effort）。</p>
        </div>

        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <Type size={14} className="text-muted-foreground" />
            <label className="text-xs text-muted-foreground">最大回复长度：{maxReplyLength} 字</label>
          </div>
          <input
            type="number"
            min={MAX_REPLY_MIN}
            max={MAX_REPLY_MAX}
            value={maxReplyLength}
            onChange={(e) => setMaxReplyLength(Number(e.target.value))}
            className="w-32 min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm focus:border-accent outline-none"
          />
          <p className="text-xs text-muted-foreground mt-1.5">应用层硬截断 + 系统提示词双保险，超出将自动截断（转人工标记不被截断）。</p>
        </div>
      </div>

      {/* ============ 系统提示词 ============ */}
      <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Bot size={16} className="text-accent" />
            <h3 className="text-sm font-medium">系统提示词（Persona）</h3>
          </div>
          <button
            onClick={handleResetPrompt}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 min-h-[36px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base"
            title="清空即恢复系统默认提示词"
          >
            <RotateCcw size={13} /> 恢复默认
          </button>
        </div>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={8}
          placeholder="留空则使用系统默认提示词。可在此定制客服助手的语气、品牌名与角色设定（支持 {BRAND} 占位符）。"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed focus:border-accent outline-none resize-y"
        />
        <p className="text-xs text-muted-foreground">
          仅「角色设定 / 语气」可自定义；工具调用许可、转人工规则、知识库与订单上下文注入由系统强制拼接，保障安全与业务正确性。
        </p>
      </div>

      {/* ============ 调用监控（llm_call_logs 聚合） ============ */}
      <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity size={16} className="text-accent" />
            <h3 className="text-sm font-medium">调用监控</h3>
            <span className="text-xs text-muted-foreground">最近 {metrics?.summary.sinceDays ?? 7} 天</span>
          </div>
          <button
            onClick={loadMetrics}
            disabled={metricsLoading}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 min-h-[36px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
            title="刷新调用监控数据"
          >
            {metricsLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            刷新
          </button>
        </div>

        {metrics && metrics.summary.totalCalls > 0 ? (
          <>
            {/* 汇总瓦片 */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                { label: '总调用', value: metrics.summary.totalCalls.toLocaleString(), sub: `成功率 ${(metrics.summary.successRate * 100).toFixed(1)}%` },
                { label: '平均延迟', value: `${metrics.summary.avgLatencyMs} ms`, sub: `峰值 ${metrics.summary.maxLatencyMs} ms` },
                { label: '降级次数', value: metrics.summary.degradedCount.toLocaleString(), sub: `降级率 ${(metrics.summary.fallbackRate * 100).toFixed(1)}%` },
                { label: 'Token 用量', value: `${(metrics.summary.totalPromptTokens + metrics.summary.totalCompletionTokens).toLocaleString()}`, sub: `入 ${metrics.summary.totalPromptTokens.toLocaleString()} / 出 ${metrics.summary.totalCompletionTokens.toLocaleString()}` },
              ].map((tile) => (
                <div key={tile.label} className="rounded-xl border border-border bg-background px-3 py-2.5">
                  <div className="text-xs text-muted-foreground">{tile.label}</div>
                  <div className="text-lg font-semibold mt-0.5">{tile.value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{tile.sub}</div>
                </div>
              ))}
            </div>

            {/* 引擎明细 */}
            {metrics.byEngine.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      <th className="text-left font-medium py-1.5 pr-3">引擎</th>
                      <th className="text-right font-medium py-1.5 px-2">调用</th>
                      <th className="text-right font-medium py-1.5 px-2">正常</th>
                      <th className="text-right font-medium py-1.5 px-2">降级</th>
                      <th className="text-right font-medium py-1.5 px-2">失败</th>
                      <th className="text-right font-medium py-1.5 px-2">平均延迟</th>
                      <th className="text-right font-medium py-1.5 pl-2">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.byEngine.map((e) => (
                      <tr key={e.provider} className="border-b border-border/50">
                        <td className="py-1.5 pr-3 font-medium">{engineLabel(e.provider)}</td>
                        <td className="text-right py-1.5 px-2">{e.calls.toLocaleString()}</td>
                        <td className="text-right py-1.5 px-2 text-success">{e.okCount.toLocaleString()}</td>
                        <td className="text-right py-1.5 px-2 text-warning">{e.degradedCount.toLocaleString()}</td>
                        <td className="text-right py-1.5 px-2 text-destructive">{e.errorCount.toLocaleString()}</td>
                        <td className="text-right py-1.5 px-2">{e.avgLatencyMs} ms</td>
                        <td className="text-right py-1.5 pl-2">{e.totalTokens.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* 最近调用 */}
            <div>
              <div className="text-xs text-muted-foreground mb-1.5">最近调用</div>
              <div className="max-h-64 overflow-y-auto rounded-xl border border-border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card">
                    <tr className="text-muted-foreground border-b border-border">
                      <th className="text-left font-medium py-1.5 px-2.5">时间</th>
                      <th className="text-left font-medium py-1.5 px-2">引擎</th>
                      <th className="text-left font-medium py-1.5 px-2">模型</th>
                      <th className="text-left font-medium py-1.5 px-2">渠道</th>
                      <th className="text-left font-medium py-1.5 px-2">状态</th>
                      <th className="text-right font-medium py-1.5 px-2">延迟</th>
                      <th className="text-right font-medium py-1.5 px-2.5">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.recent.map((r) => (
                      <tr key={r.id} className="border-b border-border/50">
                        <td className="py-1.5 px-2.5 text-muted-foreground whitespace-nowrap">{formatLogTime(r.time)}</td>
                        <td className="py-1.5 px-2">{engineLabel(r.provider)}</td>
                        <td className="py-1.5 px-2 font-mono text-muted-foreground max-w-[180px] truncate" title={r.model}>{r.model}</td>
                        <td className="py-1.5 px-2 text-muted-foreground">{r.channel || '—'}</td>
                        <td className="py-1.5 px-2">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded ${statusClass(r.status)}`} title={r.error || ''}>
                            {statusLabel(r.status)}
                          </span>
                        </td>
                        <td className="text-right py-1.5 px-2">{r.latencyMs} ms</td>
                        <td className="text-right py-1.5 px-2.5 text-muted-foreground">
                          {(r.promptTokens ?? 0) + (r.completionTokens ?? 0) || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {metricsLoading ? '加载中…' : '暂无调用记录。发起一次对话（或点上方「测试连接」）后，此处将展示引擎、延迟、降级与 Token 用量。'}
          </p>
        )}
      </div>

      {/* ============ 底部操作区 ============ */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 text-sm px-4 py-2 min-h-[44px] rounded-lg bg-accent text-accent-foreground hover:opacity-90 transition-base disabled:opacity-50"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          {saving ? '保存中…' : '保存配置'}
        </button>
        <button
          onClick={handleTest}
          disabled={testing}
          className="inline-flex items-center gap-1.5 text-sm px-4 py-2 min-h-[44px] rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base disabled:opacity-50"
        >
          {testing ? <Loader2 size={15} className="animate-spin" /> : <FlaskConical size={15} />}
          {testing ? '测试中…' : '测试连接'}
        </button>
        <span className="text-xs text-muted-foreground">保存后立即生效；测试连接使用表单当前值，无需先保存。</span>
      </div>
    </div>
  );
}
