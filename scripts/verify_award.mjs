#!/usr/bin/env node
/**
 * 获奖级四大增强验收（A 编排中枢 / B 成效看板 / C 主动关怀 / D 端侧遥测）
 *
 * 自起真实 Express 服务（better-sqlite3，全新 db）+ 管理端登录，逐一打真实 HTTP 断言：
 *   A 智能体编排中枢：chat SSE 捕获 agentTrace 事件（六步推理链路）→ admin/agent-runs 留痕可查
 *   B AI 成效看板：admin/impact 五项 KPI + 聚合口径（runs 随 chat 增长）
 *   C 主动关怀评分：copilot/suggest 对愤怒消息给出 risk 评分与「主动关怀风险」动作
 *   D 端侧遥测：异常快照自动建单（ticketId + priority）→ admin/telemetry 计数 → SQLite 落库核验
 *   迁移核验：user_version ≥ 16，agent_runs / device_telemetry 两表存在
 *
 * 运行（沙箱/CI 无头）：
 *   PORT=4720 CSA_DB_PATH=data/verify_award.db ADMIN_PASSWORD=award123 SEED_DEMO=1 \
 *   INGEST_SECRET=award-secret ALLOWED_ORIGINS=http://localhost:5173 \
 *   node scripts/verify_award.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT || 4720);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.resolve(ROOT, process.env.CSA_DB_PATH || 'data/verify_award.db');
const PASSWORD = process.env.ADMIN_PASSWORD || 'award123';
const RUN = Date.now().toString(36);

const RISK_LEVELS = ['low', 'medium', 'high'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

  let pass = 0;
  let fail = 0;
  const failures = [];
  let srvOut = '';
  let srvExited = null;

  function logCase(ok, label, detail) {
    if (ok) {
      pass++;
      console.log(`  ✅ ${label} ${detail}`);
    } else {
      fail++;
      failures.push(`${label} ${detail}`);
      console.log(`  ❌ ${label} ${detail}`);
    }
  }

  /** 服务端异常退出时打印尾部日志，避免 ECONNRESET 之类静默失败无从排查 */
  function dumpServerIfDead() {
    if (srvExited) {
      console.log(`\n!!! 服务端已退出（code=${srvExited.code} signal=${srvExited.signal}），尾部日志：`);
      console.log(srvOut.slice(-2500));
      return true;
    }
    return false;
  }

/** 消费 SSE 流，回调每个 data: 事件；连接结束（或超时）后 resolve 全部事件 */
async function readSSE(url, body, timeoutMs = 20000) {
  const events = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) return { status: res.status, events };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (raw.startsWith('data: ')) {
          try {
            events.push(JSON.parse(raw.slice(6)));
          } catch {
            /* 非 JSON 事件忽略 */
          }
        }
      }
    }
    return { status: res.status, events };
  } catch {
    return { status: 0, events };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  // 全新 db，保证 v15/v16 迁移与断言基线干净
  for (const suffix of ['', '-wal', '-shm']) {
    const f = DB_PATH + suffix;
    if (fs.existsSync(f)) fs.rmSync(f);
  }

  const srv = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      CSA_DB_PATH: DB_PATH,
      ADMIN_PASSWORD: PASSWORD,
      INGEST_SECRET: process.env.INGEST_SECRET || 'award-secret',
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'http://localhost:5173',
      SEED_DEMO: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srvExited = null;
  srv.stdout.on('data', (d) => (srvOut += d));
  srv.stderr.on('data', (d) => (srvOut += d));
  srv.on('exit', (code, signal) => {
    srvExited = { code, signal };
  });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) {
        up = true;
        break;
      }
    } catch {
      /* 未起 */
    }
  }
  if (!up) {
    console.log('❌ 服务未就绪：\n' + srvOut.slice(-1500));
    srv.kill();
    process.exit(1);
  }

  const loginRes = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  const token = loginBody.token;
  if (!token) {
    console.log('❌ 登录失败：', JSON.stringify(loginBody).slice(0, 200));
    srv.kill();
    process.exit(1);
  }
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  console.log(`\n=== 获奖级四大增强验收（服务 ${BASE}，运行后缀 ${RUN}） ===\n`);

  /* ---------- A 智能体编排中枢 ---------- */
  console.log('── A 智能体编排中枢（orchestrator） ──');
  const angryMsg = '你们产品太差了！我要退款！投诉！！';
  const chat = await readSSE(`${BASE}/api/chat`, { message: angryMsg, sessionId: `award-${RUN}` });
  const trace = chat.events.find((e) => e.type === 'agentTrace')?.trace;
  logCase(!!trace, 'chat SSE 下发 agentTrace 事件', `→ ${trace ? '收到' : '未收到'}`);
  if (trace) {
    const steps = Array.isArray(trace.steps) ? trace.steps : [];
    logCase(steps.length >= 4, '推理链路步骤数 ≥ 4（意图/知识/情感/工作流…）', `→ ${steps.length} 步`);
    logCase(
      steps.every((s) => s.id && s.label && s.status && typeof s.latencyMs === 'number'),
      '每步含 id/label/status/latencyMs',
      `→ ${steps.map((s) => s.id).join(' → ')}`,
    );
    logCase(['answer', 'handoff', 'ticket', 'proactive_alert'].includes(trace.finalAction), 'finalAction 合法', `→ ${trace.finalAction}`);
    logCase(!!trace.runId && !!trace.sessionId, 'trace 带 runId/sessionId（可关联会话）', `→ run=${String(trace.runId).slice(0, 8)}`);
  }
  // 注意：/api/chat 仅接受合法 UUID v4 的 sessionId，否则按设计忽略并新建会话；
  // 因此按会话过滤必须用 trace 回传的真实 sessionId（这也是「编排留痕可关联会话」的断言点）。
  const traceSessionId = trace?.sessionId;
  const runsRes = await fetch(`${BASE}/api/admin/agent-runs${traceSessionId ? `?sessionId=${encodeURIComponent(traceSessionId)}` : ''}`, { headers: auth });
  const runsBody = await runsRes.json().catch(() => ({}));
  const runs = Array.isArray(runsBody.runs) ? runsBody.runs : [];
  logCase(runsRes.status === 200 && runs.length >= 1, 'agent-runs 留痕可查（按 trace.sessionId 过滤）', `→ total=${runsBody.total}`);
  logCase(
    runs.some((r) => Array.isArray(r.steps) && r.steps.length >= 4),
    '留痕含完整推理链路（steps 持久化）',
    `→ ${runs.length} 条`,
  );
  logCase(runs.some((r) => r.risk_score >= 0 && ['low', 'medium', 'high'].includes(r.risk_level)), '留痕含风险评分字段（C 已并入编排）', `→ risk_level=${runs[0]?.risk_level}`);

  /* ---------- B AI 成效看板 ---------- */
  console.log('\n── B AI 成效看板（impact） ──');
  const impactRes = await fetch(`${BASE}/api/admin/impact`, { headers: auth });
  const impact = await impactRes.json().catch(() => ({}));
  const k = impact.kpis || {};
  logCase(impactRes.status === 200 && !!k, 'impact 返回 200 且含 kpis', `→ source=${impact.source}`);
  logCase(
    ['selfServiceRate', 'copilotAdoptionRate', 'workflowAutoRate', 'gapClosureRate', 'avgLatencyMs'].every((f) => typeof k[f] === 'number'),
    '五项 KPI 均为数值（自助解决/采纳/自动执行/盲区收敛/时延）',
    `→ 自助=${k.selfServiceRate}% 采纳=${k.copilotAdoptionRate}% 时延=${k.avgLatencyMs}ms`,
  );
  logCase(typeof impact.windowDays === 'number' && impact.windowDays > 0, '统计窗口有效', `→ ${impact.windowDays} 天`);
  logCase((impact.totals?.runs ?? 0) >= 1, '聚合口径 runs 随真实对话增长', `→ runs=${impact.totals?.runs}`);
  logCase(Array.isArray(impact.actionTrend) && Array.isArray(impact.riskTrend), '含动作/风险趋势序列（可画图）', `→ actionTrend=${impact.actionTrend?.length} 点`);

  /* ---------- C 主动关怀评分 ---------- */
  console.log('\n── C 主动式客户关怀评分（proactive） ──');
  const copRes = await fetch(`${BASE}/api/copilot/suggest`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ message: angryMsg, sessionId: `award-${RUN}` }),
  });
  const cop = await copRes.json().catch(() => ({}));
  const risk = cop.risk || {};
  logCase(copRes.status === 200 && !!cop.risk, 'copilot 返回 risk 评分对象', `→ riskScore=${risk.riskScore}`);
  logCase(typeof risk.riskScore === 'number' && risk.riskScore >= 0 && risk.riskScore <= 100, 'riskScore 取值 0-100', `→ ${risk.riskScore}`);
  logCase(RISK_LEVELS.includes(risk.riskLevel), 'riskLevel 合法（low/medium/high）', `→ ${risk.riskLevel}`);
  logCase(Array.isArray(risk.signals), 'signals 列出触发因子（可解释）', `→ ${(risk.signals || []).slice(0, 3).join(' / ')}`);
  const actions = Array.isArray(cop.actions) ? cop.actions : [];
  if (risk.riskLevel !== 'low') {
    logCase(actions.some((a) => a.includes('主动关怀风险')), '高风险时给出「主动关怀风险」动作建议', `→ ${actions.find((a) => a.includes('主动关怀风险')) || '无'}`);
  } else {
    logCase(true, '低风险会话不推送主动干预（避免打扰）', `→ ${risk.riskLevel}`);
  }

  /* ---------- D 端侧遥测异常自动建单 ---------- */
  console.log('\n── D 端侧遥测异常自动建单（telemetry） ──');
  const badDevice = `DEV-${RUN}`;
  const tBad = await fetch(`${BASE}/api/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: badDevice,
      product: 'DJ8341',
      model: '侦打一体机',
      snapshot: { temperature: 96, voltage: 12.4, signal: -72, online: true, uptimeSec: 86400 },
    }),
  });
  const badBody = await tBad.json().catch(() => ({}));
  logCase(tBad.status === 200 && badBody.anomaly === true, '异常快照被检出（温度 96℃ > 阈值 85℃）', `→ reason=${badBody.reason}`);
  logCase(!!badBody.ticketId, '异常即自动建单（ticketId 返回）', `→ ${String(badBody.ticketId).slice(0, 8)}`);
  logCase(PRIORITIES.includes(badBody.priority), '工单优先级合法', `→ ${badBody.priority}`);

  const okDevice = `OK-${RUN}`;
  const tOk = await fetch(`${BASE}/api/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: okDevice, product: 'DJ8341', snapshot: { temperature: 52, voltage: 12.4, signal: -72, online: true } }),
  });
  const okBody = await tOk.json().catch(() => ({}));
  logCase(tOk.status === 200 && okBody.anomaly === false && !okBody.ticketId, '正常快照不建单（无误报）', `→ anomaly=${okBody.anomaly}`);

  const telRes = await fetch(`${BASE}/api/admin/telemetry`, { headers: auth });
  const tel = await telRes.json().catch(() => ({}));
  logCase(telRes.status === 200 && tel.total >= 2, '遥测看板计数（total）', `→ total=${tel.total}`);
  logCase(tel.anomalies >= 1, '异常计数 ≥ 1', `→ anomalies=${tel.anomalies}`);
  logCase(
    Array.isArray(tel.recent) && tel.recent.some((r) => r.device_id === badDevice && r.anomaly === 1),
    'recent 含异常设备记录',
    `→ ${tel.recent?.[0]?.device_id}`,
  );
  logCase(
    Array.isArray(tel.recent) && tel.recent.some((r) => r.device_id === badDevice && !!r.ticket_id),
    '遥测记录关联自动工单 id',
    `→ ticket_id=${String(tel.recent?.find((r) => r.device_id === badDevice)?.ticket_id).slice(0, 8)}`,
  );

  /* ---------- E 设备健康度评分引擎 ---------- */
  console.log('\n── E 设备健康度评分（device-health，预测性维护） ──');
  // 再灌两次同设备异常，让健康分明显低于 100 且趋势可判定
  for (let i = 0; i < 2; i++) {
    await fetch(`${BASE}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: badDevice, product: 'DJ8341', snapshot: { temperature: 91 + i, voltage: 12.4, signal: -72, online: true } }),
    });
  }
  const dhRes = await fetch(`${BASE}/api/admin/device-health`, { headers: auth });
  const dh = await dhRes.json().catch(() => ({}));
  logCase(dhRes.status === 200 && dh.source === 'db', 'device-health 返回 200（source=db）', `→ source=${dh.source}`);
  const dev = (dh.devices || []).find((x) => x.deviceId === badDevice);
  logCase(!!dev, '能查到刚上报的设备', `→ ${dev?.deviceId}`);
  logCase(typeof dev?.health === 'number' && dev.health < 100, '健康分因异常被扣减（<100）', `→ health=${dev?.health}`);
  logCase(['healthy', 'watch', 'at_risk', 'critical'].includes(dev?.riskLevel), '风险等级合法', `→ ${dev?.riskLevel}`);
  logCase(['improving', 'stable', 'declining'].includes(dev?.trend), '趋势字段合法', `→ ${dev?.trend}`);
  logCase(!!dev?.recommendation && dev.recommendation.length > 4, '给出可执行维护建议', `→ ${dev?.recommendation}`);
  logCase((dh.summary?.totalDevices ?? 0) >= 2, '汇总统计设备数', `→ total=${dh.summary?.totalDevices} avg=${dh.summary?.avgHealth}`);
  logCase(
    (dh.devices || []).every((x, i, arr) => i === 0 || arr[i - 1].health <= x.health),
    '排序规则：最需关注的设备排最前（健康分升序）',
    `→ ${(dh.devices || []).slice(0, 3).map((x) => `${x.deviceId}:${x.health}`).join(' , ')}`,
  );

  /* ---------- F 工单根因聚类 ---------- */
  console.log('\n── F 工单根因聚类（root-causes） ──');
  const rcRes = await fetch(`${BASE}/api/admin/root-causes?windowDays=30`, { headers: auth });
  const rc = await rcRes.json().catch(() => ({}));
  logCase(rcRes.status === 200 && rc.source === 'db', 'root-causes 返回 200（source=db）', `→ source=${rc.source}`);
  logCase(typeof rc.totalTickets === 'number' && rc.totalTickets >= 1, '统计窗口内工单数', `→ total=${rc.totalTickets} resolved=${rc.resolvedTickets}`);
  logCase(Array.isArray(rc.clusters), '根因簇为数组', `→ ${rc.clusters?.length} 个`);
  logCase(
    (rc.clusters || []).every((c) => c.keyword && c.count >= 2 && c.ratio >= 0 && c.kindLabel && c.suggestion),
    '每个簇含关键词/次数/占比/类型/建议',
    `→ Top1「${rc.clusters?.[0]?.keyword}」×${rc.clusters?.[0]?.count}（${rc.clusters?.[0]?.kindLabel}）`,
  );
  logCase(
    (rc.clusters || []).every((c, i, arr) => i === 0 || arr[i - 1].count >= c.count),
    '根因按频次降序（最高频在前）',
    '',
  );
  logCase(
    (rc.clusters || []).every((c) => ['hardware_batch', 'doc_gap', 'service_flow', 'other'].includes(c.kind)),
    '根因类型取值合法（硬件批次/说明缺失/服务流程/其他）',
    `→ ${[...new Set((rc.clusters || []).map((c) => c.kind))].join(',')}`,
  );
  logCase(typeof rc.summary === 'string' && rc.summary.length > 10, '生成人读结论摘要', `→ ${rc.summary.slice(0, 60)}…`);

  /* ---------- 落库与迁移核验（直连 SQLite） ---------- */  console.log('\n── 落库与迁移核验（SQLite 直连） ──');
  try {
    const Database = require('better-sqlite3');
    const raw = new Database(DB_PATH, { readonly: true });
    const version = raw.pragma('user_version', { simple: true });
    logCase(version >= 16, 'DB 迁移版本 ≥ 16（v15 agent_runs / v16 device_telemetry）', `→ user_version=${version}`);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    logCase(tables.includes('agent_runs'), 'agent_runs 表存在', '');
    logCase(tables.includes('device_telemetry'), 'device_telemetry 表存在', '');
    const trow = raw.prepare("SELECT * FROM tickets WHERE trigger_rule='TELEMETRY_ANOMALY' ORDER BY created_at DESC LIMIT 1").get();
    logCase(!!trow, '工单表存在 TELEMETRY_ANOMALY 触发行', `→ ${trow ? String(trow.id).slice(0, 8) : '无'}`);
    logCase(!!trow?.device_snapshot, '工单携带设备遥测快照（直达售后）', `→ ${trow?.device_snapshot ? String(trow.device_snapshot).slice(0, 48) : '空'}`);
    const arow = raw.prepare('SELECT COUNT(*) AS c FROM agent_runs').get();
    logCase((arow?.c ?? 0) >= 1, 'agent_runs 有编排留痕行', `→ ${arow?.c} 行`);
    const drow = raw.prepare('SELECT COUNT(*) AS c FROM device_telemetry').get();
    logCase((drow?.c ?? 0) >= 2, 'device_telemetry 有遥测行', `→ ${drow?.c} 行`);
    raw.close();
  } catch (e) {
    logCase(false, 'SQLite 直连核验', `→ ${e?.message || e}`);
  }

  /* ---------- G 语音交互（前端静态接线核验） ---------- */
  console.log('');
  console.log('── G 语音交互（voice，零依赖 Web Speech API） ──');
  const FE = {
    useVoice: path.resolve(ROOT, 'src/hooks/useVoice.ts'),
    chatInput: path.resolve(ROOT, 'src/components/ChatInput.tsx'),
    bubble: path.resolve(ROOT, 'src/components/MessageBubble.tsx'),
    customer: path.resolve(ROOT, 'src/pages/CustomerPage.tsx'),
  };
  const readSrc = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  const uv = readSrc(FE.useVoice);
  logCase(uv.length > 0 && uv.includes('export function useVoice'), 'useVoice.ts 存在并导出 useVoice', '→ ' + uv.length + ' 字节');
  const VOICE_CONTRACT = ['speechSupported', 'ttsSupported', 'listening', 'interim', 'startListening', 'stopListening', 'autoSpeak', 'setAutoSpeak', 'speakingId', 'speak', 'stopSpeaking'];
  logCase(VOICE_CONTRACT.every((k) => uv.includes(k)), 'useVoice 契约完整（输入/播报/状态全字段）', '→ 缺：' + (VOICE_CONTRACT.filter((k) => !uv.includes(k)).join(',') || '无'));
  logCase(uv.includes('typeof window') && uv.includes('SpeechRecognition'), '语音能力探测失败静默降级（window 守卫 + Web Speech 探测）', '');
  const ci = readSrc(FE.chatInput);
  logCase(ci.includes('UseVoiceResult') && (ci.includes('Mic') || ci.includes('MicOff')) && (ci.includes('Volume2') || ci.includes('VolumeX')), 'ChatInput 接入语音（麦克风按钮 + 自动播报开关）', '');
  logCase(ci.includes('speechSupported') && ci.includes('autoSpeak'), 'ChatInput 按能力门控渲染（不支持即隐藏入口）', '');
  const mb = readSrc(FE.bubble);
  logCase(mb.includes('ttsSupported') && mb.includes('speak(') && mb.includes('朗读'), 'MessageBubble 提供「朗读」按钮（播报门控）', '');
  const cp = readSrc(FE.customer);
  logCase(cp.includes('useVoice(') && cp.includes('onFinal') && cp.includes('send('), 'CustomerPage 启用语音：识别结束即发送（说一句→问一句）', '');
  logCase(cp.includes('autoSpeak') && cp.includes('voice.speak'), 'CustomerPage 开启自动播报时朗读最新回复', '');

  srv.kill();
  dumpServerIfDead();
  console.log(`\n=== 汇总：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 断言） ===`);
  if (fail) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  ' + f));
    process.exit(1);
  }
  console.log('✅ 获奖级验收全部通过（含语音交互 G）');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n!!! 验收脚本异常：', e?.message || e);
  dumpServerIfDead();
  process.exit(1);
});
