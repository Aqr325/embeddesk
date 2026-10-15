import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 语音交互 Hook（零依赖，浏览器原生 Web Speech API）
 *
 * 两条能力：
 *   ① 语音输入：SpeechRecognition（Chrome/Edge 前缀 webkitSpeechRecognition）→ 实时转写填入输入框
 *   ② 语音播报：speechSynthesis → 把 AI 回复读出来，支持「自动播报」开关
 *
 * 兼容性策略：能力探测失败（如 Safari 部分版本 / 非安全上下文）时静默降级——
 * 返回 supported=false，调用方隐藏按钮即可，绝不抛错影响主流程。
 */

/* ---------- Web Speech API 的最小类型声明（非标准 API，TS 无内置类型） ---------- */
interface SpeechAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechResult {
  readonly length: number;
  isFinal: boolean;
  item(index: number): SpeechAlternative;
  [index: number]: SpeechAlternative;
}
interface SpeechResultList {
  readonly length: number;
  item(index: number): SpeechResult;
  [index: number]: SpeechResult;
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechResultList;
}
interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message?: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function ttsAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.speechSynthesis?.speak === 'function';
}

export interface UseVoiceOptions {
  /** 识别语言，默认中文（普通话） */
  lang?: string;
  /** 一次识别结束（用户停顿/静音）时回调，参数为最终转写文本 */
  onFinal?: (transcript: string) => void;
}

export interface UseVoiceResult {
  /** 语音输入是否可用（浏览器不支持时为 false，UI 应隐藏入口） */
  speechSupported: boolean;
  /** 语音播报是否可用 */
  ttsSupported: boolean;
  /** 是否正在录音 */
  listening: boolean;
  /** 实时转写中的文本（用于输入框内联提示） */
  interim: string;
  /** 开始/停止录音 */
  startListening: () => void;
  stopListening: () => void;
  /** 自动播报开关（新 AI 回复自动朗读） */
  autoSpeak: boolean;
  setAutoSpeak: (v: boolean) => void;
  /** 当前正在播报的消息 id（null 表示未在播报） */
  speakingId: string | null;
  /** 朗读指定消息；再次调用同 id 或传 null 表示停止 */
  speak: (id: string | null, text: string) => void;
  stopSpeaking: () => void;
}

export function useVoice(options: UseVoiceOptions = {}): UseVoiceResult {
  const { lang = 'zh-CN', onFinal } = options;

  const [speechSupported] = useState(() => getRecognitionCtor() !== null);
  const [ttsSupported] = useState(ttsAvailable);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef('');
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  /* ---------- 语音输入 ---------- */
  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
    setInterim('');
  }, []);

  const startListening = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    // 复用同一个实例：重复 start 会抛 InvalidStateError
    if (!recognitionRef.current) {
      const rec = new Ctor();
      rec.lang = lang;
      rec.continuous = false; // 单段识别，用户停顿即结束（更适合"说一句问一句"）
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onstart = () => {
        finalRef.current = '';
        setInterim('');
        setListening(true);
      };
      rec.onresult = (e) => {
        let live = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const alt = r[0];
          if (!alt) continue;
          if (r.isFinal) finalRef.current += alt.transcript;
          else live += alt.transcript;
        }
        setInterim(live);
      };
      rec.onerror = (e) => {
        // not-allowed = 用户拒绝麦克风权限；no-speech = 静音超时。均属正常交互，不弹错。
        if (e.error !== 'not-allowed' && e.error !== 'no-speech' && e.error !== 'aborted') {
          console.warn('[voice] 语音识别错误:', e.error, e.message || '');
        }
      };
      rec.onend = () => {
        setListening(false);
        setInterim('');
        const text = finalRef.current.trim();
        if (text) onFinalRef.current?.(text);
        finalRef.current = '';
      };
      recognitionRef.current = rec;
    }
    try {
      recognitionRef.current.start();
    } catch {
      /* 已在录音中：忽略 */
    }
  }, [lang]);

  // 卸载时释放识别与播报，避免离开页面后仍在录音/朗读
  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.abort();
      } catch {
        /* 忽略 */
      }
      if (ttsAvailable()) window.speechSynthesis.cancel();
    };
  }, []);

  /* ---------- 语音播报 ---------- */
  const stopSpeaking = useCallback(() => {
    if (!ttsAvailable()) return;
    window.speechSynthesis.cancel();
    setSpeakingId(null);
  }, []);

  const speak = useCallback(
    (id: string | null, text: string) => {
      if (!ttsAvailable()) return;
      const clean = text.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!clean) return;
      // 同一条消息再次点击 = 停止（播放器语义）
      if (id && speakingId === id) {
        stopSpeaking();
        return;
      }
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(clean.slice(0, 2000));
      utter.lang = 'zh-CN';
      utter.rate = 1;
      utter.pitch = 1;
      // 优先选中文语音，找不到则用系统默认
      const voices = window.speechSynthesis.getVoices?.() || [];
      const zh = voices.find((v) => /zh|cmn|中文|Chinese/i.test(v.lang + v.name));
      if (zh) utter.voice = zh;
      utter.onend = () => setSpeakingId((cur) => (cur === id ? null : cur));
      utter.onerror = () => setSpeakingId(null);
      setSpeakingId(id);
      window.speechSynthesis.speak(utter);
    },
    [speakingId, stopSpeaking],
  );

  // 部分浏览器语音列表异步加载： voiceschanged 后无需重播，仅预热避免首次 speak 无声
  useEffect(() => {
    if (!ttsAvailable()) return;
    try {
      window.speechSynthesis.getVoices?.();
    } catch {
      /* 忽略 */
    }
  }, []);

  return {
    speechSupported,
    ttsSupported,
    listening,
    interim,
    startListening,
    stopListening,
    autoSpeak,
    setAutoSpeak,
    speakingId,
    speak,
    stopSpeaking,
  };
}
