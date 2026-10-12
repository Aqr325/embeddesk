import { useState } from 'react';
import { Database, Upload, Loader2, AlertCircle, CheckCircle2, FileJson, FileSpreadsheet } from 'lucide-react';

const JSON_SAMPLE = `[
  {
    "category": "端侧AI模组",
    "question": "SG865W-WF 模组支持哪些操作系统？",
    "answer": "支持 Linux / Android / RTOS 等主流嵌入式系统，提供标准 SDK 与例程。",
    "keywords": "SG865W,操作系统,SDK",
    "tags": "硬件规格,模组"
  },
  {
    "category": "物流查询",
    "question": "如何查询模组发货物流？",
    "answer": "提供订单号后可在「我的订单」中查看物流轨迹，或联系对应销售获取运单号。",
    "keywords": "物流,发货,运单",
    "tags": "售后,订单"
  }
]`;

const CSV_SAMPLE = `category,question,answer,keywords,tags
端侧AI模组,SG865W-WF 模组支持哪些操作系统？,支持 Linux / Android / RTOS 等主流嵌入式系统，提供标准 SDK 与例程。,SG865W 操作系统 SDK,硬件规格 模组
物流查询,如何查询模组发货物流？,提供订单号后可在「我的订单」中查看物流轨迹，或联系对应销售获取运单号。,物流 发货 运单,售后 订单`;

interface ImportResult {
  imported: number;
  errors: string[];
}

interface Props {
  onImport: (format: 'json' | 'csv', data: unknown) => Promise<ImportResult>;
}

export function DataImport({ onImport }: Props) {
  const [format, setFormat] = useState<'json' | 'csv'>('json');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const fillSample = () => {
    setText(format === 'json' ? JSON_SAMPLE : CSV_SAMPLE);
    setResult(null);
    setErr(null);
  };

  const submit = async () => {
    setErr(null);
    setResult(null);
    if (!text.trim()) return setErr('请粘贴要导入的内容，或点击「填充示例」');
    let payload: unknown;
    if (format === 'json') {
      try {
        payload = JSON.parse(text);
      } catch (e) {
        return setErr('JSON 解析失败：' + (e as Error).message);
      }
      if (!Array.isArray(payload)) return setErr('JSON 模式需为对象数组');
    } else {
      payload = text; // CSV 直接传原始文本，后端按字段名解析
    }
    setBusy(true);
    try {
      const r = await onImport(format, payload);
      setResult(r);
    } catch (e: any) {
      setErr(e?.message || '导入失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <Database size={16} className="text-accent" />
          <h3 className="text-sm font-medium">知识库批量导入（FAQ）</h3>
        </div>

        {/* 格式切换 */}
        <div className="flex items-center gap-2 mb-3">
          <div className="inline-flex rounded-lg border border-border overflow-hidden">
            <button
              onClick={() => {
                setFormat('json');
                setResult(null);
                setErr(null);
              }}
              className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 transition-base ${
                format === 'json' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <FileJson size={13} /> JSON
            </button>
            <button
              onClick={() => {
                setFormat('csv');
                setResult(null);
                setErr(null);
              }}
              className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 transition-base ${
                format === 'csv' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <FileSpreadsheet size={13} /> CSV
            </button>
          </div>
          <button
            onClick={fillSample}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-border text-muted-foreground hover:border-accent hover:text-accent transition-base"
          >
            填充示例
          </button>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={format === 'json' ? '粘贴 FAQ 对象数组 JSON…' : '粘贴带表头的 CSV（category,question,answer,keywords,tags）…'}
          className="w-full h-56 text-xs font-mono px-3 py-2 rounded-lg bg-input border border-border outline-none focus:border-accent resize-y leading-relaxed"
          spellCheck={false}
        />

        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={submit}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-xs px-4 py-2 min-h-[44px] rounded-lg bg-accent text-accent-foreground hover:opacity-90 transition-base disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {busy ? '导入中…' : '开始导入'}
          </button>
          <span className="text-[11px] text-muted-foreground">
            {format === 'json'
              ? '字段：category / question / answer 必填，keywords / tags 可选'
              : '首行表头：category,question,answer,keywords,tags（亦支持中文表头）'}
          </span>
        </div>

        {err && (
          <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 text-destructive text-xs px-3 py-2 mt-3">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span>{err}</span>
          </div>
        )}

        {result && (
          <div
            className={`mt-3 rounded-xl border px-3 py-2.5 text-xs ${
              result.errors.length === 0
                ? 'border-success/40 bg-success/10 text-success'
                : 'border-amber-400/40 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300'
            }`}
          >
            <div className="flex items-center gap-1.5 font-medium">
              <CheckCircle2 size={14} /> 导入成功 {result.imported} 条
              {result.errors.length > 0 && `，跳过/错误 ${result.errors.length} 条`}
            </div>
            {result.errors.length > 0 && (
              <ul className="mt-1.5 list-disc pl-5 space-y-0.5 max-h-32 overflow-y-auto">
                {result.errors.slice(0, 20).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
