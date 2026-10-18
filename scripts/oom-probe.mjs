// OOM 复现探针：并发 chat 压测 + 内存曲线采样
const BASE = 'http://localhost:4602';
const CONCURRENCY = 5;
const TURNS = 60;

const QUESTIONS = [
  '你们哪款模组带NPU？想采购一批',          // 命中 FAQ + 采购意图
  ' Cat.1 bis 模组的功耗怎么样？',           // 命中 FAQ
  '请问支持OpenCPU吗？',                     // 命中 FAQ
  '今天天气真不错啊',                       // 闲聊
  '我订的订单还没发货，帮我查一下',           // 订单查询意图
  '模组能不能用在农业无人机上？续航多久',      // 未命中长尾
  '价格能便宜点吗，我们要长期合作',           // 商务意图
  '模组的尺寸封装规格给一下',                // 命中 FAQ
  '你好',                                   // 闲聊
  '这个模组信号怎么样，在山区能用吗',          // 未命中长尾
  '5G模组有哪几款？',                        // 命中 FAQ
  '我要退货，上次买的模组有问题',             // 售后/负面情绪
];

async function chat(sessionId, message) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  });
  if (!res.ok) return { ok: false, status: res.status };
  const text = await res.text();
  return { ok: true, bytes: text.length, done: text.includes('"type":"done"') };
}

async function sampleMemory() {
  try {
    const res = await fetch(`${BASE}/api/health`);
    const j = await res.json();
    return j.memory;
  } catch {
    return null;
  }
}

const rows = [];
let stop = false;
const sampler = setInterval(async () => {
  const m = await sampleMemory();
  if (m) {
    rows.push({ t: new Date().toISOString().slice(11, 19), ...m });
    console.log(`[${rows[rows.length - 1].t}] rss=${m.rssMb}MB heapUsed=${m.heapUsedMb}MB external=${m.externalMb}MB`);
  }
}, 2000);

async function worker(id) {
  const sessionId = `oom-probe-${id}-${Date.now()}`;
  let okCount = 0;
  for (let turn = 0; turn < TURNS; turn++) {
    if (stop) break;
    const q = QUESTIONS[(id * TURNS + turn) % QUESTIONS.length];
    try {
      const r = await chat(sessionId, q);
      if (r.ok) okCount++;
    } catch (e) {
      // 连接错误计入
    }
  }
  return okCount;
}

(async () => {
  const base = await sampleMemory();
  console.log(`BASELINE rss=${base?.rssMb}MB heapUsed=${base?.heapUsedMb}MB external=${base?.externalMb}MB`);
  console.log(`--- starting ${CONCURRENCY} workers x ${TURNS} turns ---`);
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  clearInterval(sampler);
  console.log(`--- done: ${results.reduce((a, b) => a + b, 0)}/${CONCURRENCY * TURNS} requests ok in ${elapsed}s ---`);
  // 收尾后再采 3 次，看 GC 后是否回落
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const m = await sampleMemory();
    console.log(`POST-GC-${i + 1} rss=${m?.rssMb}MB heapUsed=${m?.heapUsedMb}MB external=${m?.externalMb}MB`);
  }
  process.exit(0);
})();
