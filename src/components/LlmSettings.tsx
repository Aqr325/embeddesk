import { useState, useEffect, useCallback } from 'react';
import { Bot, Save, FlaskConical, RotateCcw, Loader2, AlertCircle, CheckCircle2, KeyRound, Thermometer, Type, Cpu } from 'lucide-react';
import { api, type LlmConfigPublic, type LlmConfigTestResult } from '../hooks/useApi';

const TEMP_MIN = 0;
const TEMP_MAX = 1;
const MAX_REPLY_MIN = 100;
const MAX_REPLY_MAX = 2000;

export function LlmSettings() {
  const [config, setConfig] = useState<LlmConfigPublic | null>(null);
  const [models, setModels] = useState<Array<{ modelId: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTip, setSavedTip] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<LlmConfigTestResult | null>(null);

  // 表单（与后端字段对齐）
  const [model, setModel] = useState('auto');
  const [apiKey, setApiKey] = useState(''); // 仅在用户主动填写时发送；不回显明文
  const [endpoint, setEndpoint] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [maxReplyLength, setMaxReplyLength] = useState(600);
  const [systemPrompt, setSystemPrompt] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfgRes, modelsRes] = await Promise.all([api.getLlmConfig(), api.getModels()]);
      const c = cfgRes.config;
      setConfig(c);
      setModels(modelsRes.models);
      setModel(c.model || 'auto');
      setEndpoint(c.endpoint || '');
      setTemperature(c.temperature ?? 0.7);
      setMaxReplyLength(c.maxReplyLength ?? 600);
      setSystemPrompt(c.systemPrompt || ''); // 空 = 使用系统默认提示词
    } catch (e: any) {
      setError(e?.message || '加载配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSavedTip(null);
    try {
      const payload: Record<string, unknown> = {
        model,
        endpoint,
        temperature,
        maxReplyLength,
        systemPrompt,
      };
      // apiKey 仅在用户填写时才发送（空字符串表示清除）
      if (apiKey.length > 0) payload.apiKey = apiKey;
      const res = await api.saveLlmConfig(payload);
      setConfig(res.config);
      setSavedTip('配置已保存并立即生效');
      setApiKey(''); // 清空输入框，避免重复提交明文
    } catch (e: any) {
      setError(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      setTestResult(await api.testLlmConfig());
    } catch (e: any) {
      setError(e?.message || '测试连接失败');
    } finally {
      setTesting(false);
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

      {/* 模型类型 */}
      <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Cpu size={16} className="text-accent" />
          <h3 className="text-sm font-medium">模型类型</h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-muted-foreground mb-1.5">对话模型</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm focus:border-accent outline-none"
            >
              {models.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {m.name}
                </option>
              ))}
              {!models.some((m) => m.modelId === model) && <option value={model}>{model}</option>}
            </select>
            <p className="text-xs text-muted-foreground mt-1.5">AI 自动应答、意图识别与工具调用均运行于该模型。</p>
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1.5">自定义端点（可选）</label>
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://your-llm-endpoint （留空使用默认）"
              className="w-full min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm focus:border-accent outline-none"
            />
            <p className="text-xs text-muted-foreground mt-1.5">仅自建/私有化部署需要；留空即使用平台默认接入点。</p>
          </div>
        </div>
      </div>

      {/* API 密钥 */}
      <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 space-y-2">
        <div className="flex items-center gap-2">
          <KeyRound size={16} className="text-accent" />
          <h3 className="text-sm font-medium">API 密钥</h3>
          {config?.hasApiKey && <span className="text-xs px-1.5 py-0.5 rounded-full bg-success/15 text-success">已设置</span>}
        </div>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={config?.hasApiKey ? '如需更换请填写新密钥，留空保持不变' : '填写后保存即生效（明文仅存储于数据库）'}
          className="w-full min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm focus:border-accent outline-none"
        />
        <p className="text-xs text-muted-foreground">
          留空表示不更改现有密钥。密钥经环境变量透传至模型网关（best-effort，取决于部署形态）。
        </p>
      </div>

      {/* 温度 + 最大回复长度 */}
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
          <p className="text-xs text-muted-foreground mt-1.5">越低越稳定精准，越高越发散有创意。经 CLI 参数透传（best-effort）。</p>
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

      {/* 系统提示词 */}
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

      {/* 操作区 */}
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
      </div>

      {/* 测试结果 */}
      {testResult && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            testResult.ok
              ? 'border-success/40 bg-success/10 text-success'
              : 'border-destructive/40 bg-destructive/10 text-destructive'
          }`}
        >
          {testResult.ok ? (
            <p>
              连接成功 · 模型 <span className="font-medium">{testResult.usedModel}</span> · 耗时 {testResult.latencyMs}ms
            </p>
          ) : (
            <p>连接失败：{testResult.error}</p>
          )}
        </div>
      )}
    </div>
  );
}
