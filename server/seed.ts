/**
 * 演示数据生成器
 *
 * 首次启动时写入一批历史会话，使管理后台的统计图表、对话记录、
 * 工单列表在零使用状态下即具备可读性。生产部署时可通过
 * SEED_DEMO=false 关闭。
 *
 * 演示场景定位：端侧 AI / IoT 模组解决方案（技术型商务）。
 * 对话对象为企业研发 / 采购 / 项目经理，话题覆盖模组选型、端侧
 * 推理、功耗续航、认证入网、SDK/OTA、量产采购、FAE 对接等。
 */
import { v4 as uuidv4 } from 'uuid';
import * as db from './db.js';
import { classifyIntent } from './intent.js';
import { retrieveFaqs, HIT_THRESHOLD } from './knowledge.js';

interface DemoTurn {
  user: string;
  assistant: string;
}

interface DemoConversation {
  customer: string;
  daysAgo: number;
  hour: number;
  turns: DemoTurn[];
  rating?: number;
  ratingTags?: string[];
  comment?: string;
  handoff?: { reason: string; rule: string; priority: 'low' | 'medium' | 'high' | 'urgent'; status: 'pending' | 'processing' | 'resolved' };
  closed?: boolean;
}

const DEMO: DemoConversation[] = [
  {
    customer: '张工',
    daysAgo: 6,
    hour: 10,
    turns: [
      {
        user: '我们做智能水表，想选一款低功耗广覆盖的蜂窝模组，NB-IoT 和 Cat.1 怎么选？',
        assistant:
          '针对智能水表这类上报频率低、电池供电、部署场景广（含井内/地下）的特点，优先推荐 NB-IoT：① 功耗极低，PSM 下待机电流可低至微安级，一节 8500mAh 电池可用 5-10 年；② 覆盖深，比 GSM 强约 20dB，适合地下表井；③ 资费低，按连接数年费制。若水表还需要偶发大文件（如固件 OTA 整包）或语音，再考虑 Cat.1 bis 降本。建议先用我们的 BC95-CNV 评估板实测功耗曲线，再定方案。',
      },
      { user: '明白了，先申请块开发板', assistant: '好的，我让商务给您寄 BC95-CNV 评估套件（含天线和 SIM 测试卡），并附《NB-IoT 低功耗设计指南》。收到后如需协助跑功耗测试，随时叫我。' },
    ],
    rating: 5,
    ratingTags: ['选型专业', '响应快'],
    comment: '帮我们定了 NB-IoT 方向，少走弯路',
    closed: true,
  },
  {
    customer: '李工',
    daysAgo: 5,
    hour: 14,
    turns: [
      {
        user: '我们的边缘 AI 摄像头想本地跑目标检测，你们哪款模组带 NPU？能跑多大模型，INT8 量化支持吗？',
        assistant:
          '推荐 SG885G（8 TOPS NPU）或更高阶的 SG200X 系列（最高 26 TOPS）。均支持 INT8/INT4 量化，配套我们提供的量化工具链（calibration + timeline），YOLOv8n INT8 在 8 TOPS 上可达 30+ FPS，精度损失通常 < 1%。模型建议控制在 20MB 以内以适配片上内存，超出的走外部 DDR。需要我把《端侧模型部署白皮书》和示例工程发您吗？',
      },
      { user: '发我白皮书吧，顺便问下支持 PyTorch 导出的模型吗', assistant: '已发。支持 PyTorch / TensorFlow 导出的模型经我们转换工具量化后部署；常见 detection / classification / OCR 都有参考工程。您用的具体是哪个检测框架，我让算法同事对接。' },
    ],
    rating: 5,
    ratingTags: ['回答准确', '专业度高'],
    closed: true,
  },
  {
    customer: '王工',
    daysAgo: 4,
    hour: 9,
    turns: [
      {
        user: '我们的北斗+LTE 追踪器待机电流还是偏高，电池撑不到一个月，怎么优化？',
        assistant:
          '待机功耗主要三块：① 模组空闲态——开启 PSM，TAU 设 12h、Active Timer 设 0，可降到微安级；② 定位芯片——北斗冷启动功耗高，建议用「模组唤醒→快速定位→立即休眠」节拍，避免常开；③ MCU——用低功耗核做调度，主核深度睡眠。典型方案下 1000mAh 可支撑 30-45 天。我整理一份《低功耗设计 Checklist》给您，并可安排 FAE 一起看原理图。',
      },
      { user: '好的，先发 Checklist', assistant: '已发《低功耗设计 Checklist》和 PSM 参数配置示例。若看完仍有差距，告诉我目标续航和当前实测值，我拉 FAE 进群一起优化。' },
    ],
    rating: 4,
    ratingTags: ['有参考价值'],
    closed: true,
  },
  {
    customer: '赵经理',
    daysAgo: 3,
    hour: 16,
    turns: [
      {
        user: '我们的带联网功能家电要出口欧盟和北美，需要哪些无线认证，周期大概多久？',
        assistant:
          '出口无线认证清单：欧盟 CE-RED（含 RF / EMC / SAR）、北美 FCC（Part 15/22/24）、加拿大 ISED；国内销售需 SRRC 型号核准 + CCC。周期：CE 约 3-4 周、FCC 约 2-3 周、SRRC 约 4-6 周（含样机测试）。我们的模组已自带 CE / FCC / SRRC 预认证报告，整机可沿用模组报告大幅缩短周期。需要我把认证资料包发您吗？',
      },
      { user: '发吧，我们法务也要看', assistant: '已发《无线认证资料包》（含模组预认证报告、整机补测清单、周期与费用参考）。后续若进入量产，我们可推荐合作实验室走加急。' },
    ],
    rating: 5,
    ratingTags: ['回答准确', '资料有用'],
    closed: true,
  },
  {
    customer: '陈工',
    daysAgo: 2,
    hour: 11,
    turns: [
      {
        user: '基于你们模组的工业网关，固件 OTA 升级经常失败，而且编译环境老是配不通，怎么排查？',
        assistant:
          '两件事分开看：① 编译环境——我们提供 Ubuntu 20.04 一键脚本和 Docker 镜像，避免宿主机依赖冲突，建议直接用容器；② OTA 失败常见三类：差分包空间不足（保证 ≥1.5 倍新固件大小的 scratch 分区）、断电断网中断（建议 A/B 双区 + 断点续传）、签名校验失败（确认用我们发布的公钥）。我拉 FAE 进群一起看你们的升级日志，可以吗？',
      },
      { user: '可以，日志我整理下发群里', assistant: '好的，已建群并拉入 FAE。请把升级失败时的串口日志和当前固件版本号发我，FAE 会先帮您定位是空间还是签名问题。' },
    ],
    handoff: { reason: '客户遇 OTA 升级与编译环境技术难题，需 FAE 深度支持', rule: 'KB_MISS_STREAK', priority: 'high', status: 'processing' },
    rating: 4,
    ratingTags: ['转人工必要'],
    comment: 'FAE 进来后定位很快',
  },
  {
    customer: '刘经理',
    daysAgo: 2,
    hour: 15,
    turns: [
      {
        user: '我们充电桩控制器要上量，Cat.4 模组 5000 片起订，交期多久，含税单价大概多少？',
        assistant:
          'Cat.4 量产参考：① MOQ 通常 3000 片起，5000 片可走批量价；② 标准交期 6-8 周，常青型号有安全库存可缩短至 2-3 周；③ 含税单价随频段与封装不同，主流 Cat.4 大致 45-70 元/片，5000 片量级可下探。具体需确认封装（LCC/LGA）和是否带 GNSS。我让商务给您出一份正式报价单？',
      },
      { user: '出吧，顺便确认下能否带 GNSS', assistant: '已转商务，报价单会标注「含 GNSS 版本」与「纯蜂窝版本」两个选项。GNSS 版交期略长 1 周左右，单价高约 8-12 元/片，看您定位精度需求。' },
    ],
    rating: 4,
    ratingTags: ['报价清晰'],
    closed: true,
  },
  {
    customer: '孙工',
    daysAgo: 1,
    hour: 15,
    turns: [
      { user: '转人工，我要直接和 FAE 对齐一下原理图和天线布局', assistant: '好的，正在为您转接 FAE 技术专家。当前排队第 1 位，预计等待 2 分钟，我已把您的对话摘要同步给专家，接入后可直接看完整记录。' },
    ],
    handoff: { reason: '用户明确要求对接 FAE 技术专家对齐硬件设计', rule: 'EXPLICIT_REQUEST', priority: 'high', status: 'pending' },
  },
  {
    customer: '周经理',
    daysAgo: 1,
    hour: 20,
    turns: [
      {
        user: '你们上批 2000 片 Cat.1 模组交付延迟了两周，而且有 30 片开机不识卡，太影响我们产线了！',
        assistant:
          '非常抱歉给贵司产线带来损失。我已将该批次问题升级为加急工单，安排质量 + FAE 联合排查：① 交付延迟——下批优先排产并锁定交期；② 不识卡——疑似 SIM 卡座来料批次问题，我们免费补发良品并承担往返运费，同步提供来料检验指导。专属客户经理将在 1 小时内联系您给出补偿方案。',
      },
    ],
    handoff: { reason: '批量交付延迟 + 批次不良，识别为重大客诉，升级客户经理 + 质量', rule: 'COMPLAINT', priority: 'urgent', status: 'processing' },
    rating: 2,
    ratingTags: ['处理太慢', '批次问题'],
    comment: '希望尽快给补偿方案并排查根因',
  },
  {
    customer: '吴经理',
    daysAgo: 0,
    hour: 10,
    turns: [
      {
        user: '我们要开增值税专用发票，合同流程怎么走？',
        assistant:
          '增值税专票流程：① 提供开票资料（单位名称、税号、地址电话、开户行及账号）；② 订单付款后财务 3 个工作日内开票寄出（运费到付）；③ 合同方面，5000 片以上建议签年度框架协议锁定价格与交期，我可安排商务同事发模板。需要的话我直接转商务对接。',
      },
      { user: '行，转商务吧', assistant: '已转商务同事，会在一个工作日内与您联系，发送框架协议模板并核对开票资料。您也可随时问我模组技术参数，不影响商务对接。' },
    ],
    rating: 5,
    ratingTags: ['回答准确', '响应快'],
    closed: true,
  },
];

function isoAt(daysAgo: number, hour: number, minuteOffset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minuteOffset, 0, 0);
  return d.toISOString();
}

/**
 * 写入演示数据
 * @param force 为 true 时忽略「已有数据」判断
 * @returns 写入的会话数
 */
export function seedDemoData(force = false): number {
  if (process.env.SEED_DEMO === 'false' && !force) return 0;
  if (!force && db.getAllSessions().length > 0) return 0;

  DEMO.forEach((conv) => {
    const sessionId = uuidv4();
    const createdAt = isoAt(conv.daysAgo, conv.hour);
    const firstIntent = classifyIntent(conv.turns[0].user);

    db.createSession({
      id: sessionId,
      title: conv.turns[0].user.slice(0, 24),
      model: 'claude-sonnet-4',
      customer_name: conv.customer,
      channel: 'web',
      status: conv.handoff ? 'waiting_human' : conv.closed ? 'closed' : 'active',
      primary_intent: firstIntent.intent,
      handoff: conv.handoff ? 1 : 0,
      handoff_reason: conv.handoff?.reason ?? null,
      resolved: conv.rating && conv.rating >= 4 ? 1 : 0,
      created_at: createdAt,
      updated_at: isoAt(conv.daysAgo, conv.hour, conv.turns.length * 3),
    });

    conv.turns.forEach((turn, idx) => {
      const intent = classifyIntent(turn.user, idx > 0 ? firstIntent.intent : null);
      const hits = retrieveFaqs(turn.user, intent.intent, 3);
      const hitIds = hits.filter((h) => h.score >= HIT_THRESHOLD).map((h) => h.id);
      const userMsgId = uuidv4();

      db.createMessage({
        id: userMsgId,
        session_id: sessionId,
        role: 'user',
        content: turn.user,
        created_at: isoAt(conv.daysAgo, conv.hour, idx * 3),
        intent: intent.intent,
        intent_confidence: intent.confidence,
        faq_ids: JSON.stringify(hitIds),
        source: 'user',
      });

      db.createIntentLog({
        id: uuidv4(),
        session_id: sessionId,
        message_id: userMsgId,
        text: turn.user,
        intent: intent.intent,
        confidence: intent.confidence,
        matched_keywords: intent.matchedKeywords.join(','),
        hit_faq: hitIds.length ? 1 : 0,
      });

      db.createMessage({
        id: uuidv4(),
        session_id: sessionId,
        role: 'assistant',
        content: turn.assistant,
        model: 'claude-sonnet-4',
        created_at: isoAt(conv.daysAgo, conv.hour, idx * 3 + 1),
        intent: intent.intent,
        intent_confidence: intent.confidence,
        faq_ids: JSON.stringify(hitIds),
        source: conv.handoff && idx === conv.turns.length - 1 ? 'handoff' : hitIds.length ? 'agent' : 'knowledge_base',
        latency_ms: 900 + Math.floor(Math.random() * 2200),
      });
    });

    if (conv.handoff) {
      db.createTicket({
        id: uuidv4(),
        session_id: sessionId,
        customer_name: conv.customer,
        intent: firstIntent.intent,
        reason: conv.handoff.reason,
        trigger_rule: conv.handoff.rule,
        summary: conv.turns.map((t) => t.user).join(' / ').slice(0, 200),
        priority: conv.handoff.priority,
        status: conv.handoff.status,
        assignee: conv.handoff.status === 'pending' ? null : 'FAE · 小林',
        created_at: isoAt(conv.daysAgo, conv.hour, conv.turns.length * 3),
      });
    }

    if (conv.rating) {
      db.createSatisfaction({
        id: uuidv4(),
        session_id: sessionId,
        rating: conv.rating,
        tags: (conv.ratingTags ?? []).join(','),
        comment: conv.comment ?? '',
        resolved: conv.rating >= 4 ? 1 : 0,
        created_at: isoAt(conv.daysAgo, conv.hour, conv.turns.length * 3 + 2),
      });
    }
  });

  return DEMO.length;
}
