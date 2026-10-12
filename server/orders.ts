/**
 * 订单数据模拟层
 *
 * 生产环境应替换为真实订单中心 API（HTTP / gRPC）。
 * 对外统一入口 resolveOrderContext 已设计为 async，便于后续无缝替换为远程调用；
 * 当前为内存检索，且对查询异常做兜底，确保订单查询失败不会中断主对话链路。
 */
import { logger } from './logger.js';

export interface OrderTrace {
  time: string;
  node: string;
}

export interface Order {
  orderNo: string;
  customerName: string;
  phoneTail: string;
  product: string;
  amount: number;
  status: '待付款' | '待发货' | '已发货' | '运输中' | '已签收' | '已完成' | '退款中' | '已退款';
  createdAt: string;
  shippedAt?: string;
  carrier?: string;
  trackingNo?: string;
  refundable: boolean;
  traces: OrderTrace[];
}

const ORDERS: Order[] = [
  {
    orderNo: 'SO20260712001',
    customerName: '张先生',
    phoneTail: '8821',
    product: '智能网关 EC200-Pro ×1',
    amount: 1299.0,
    status: '运输中',
    createdAt: '2026-07-12 10:24',
    shippedAt: '2026-07-12 19:40',
    carrier: '顺丰速运',
    trackingNo: 'SF1234567890123',
    refundable: true,
    traces: [
      { time: '2026-07-12 19:40', node: '【深圳分拨中心】已收件' },
      { time: '2026-07-13 03:15', node: '【深圳分拨中心】已发出，下一站【郑州分拨中心】' },
      { time: '2026-07-14 08:02', node: '【郑州分拨中心】已到达' },
      { time: '2026-07-14 11:30', node: '【郑州金水营业点】派件中，快递员：李师傅 138****6621' },
    ],
  },
  {
    orderNo: 'SO20260705114',
    customerName: '李女士',
    phoneTail: '3390',
    product: '边缘计算盒子 AI-Box T3 ×2',
    amount: 5960.0,
    status: '已签收',
    createdAt: '2026-07-05 15:08',
    shippedAt: '2026-07-06 09:12',
    carrier: '京东物流',
    trackingNo: 'JD9988776655',
    refundable: true,
    traces: [
      { time: '2026-07-06 09:12', node: '【上海仓】订单已出库' },
      { time: '2026-07-07 14:26', node: '【郑州站】已签收，签收人：本人' },
    ],
  },
  {
    orderNo: 'SO20260718077',
    customerName: '王先生',
    phoneTail: '5512',
    product: '4G Cat.1 通信模组 ×50',
    amount: 3450.0,
    status: '待发货',
    createdAt: '2026-07-18 09:41',
    refundable: true,
    traces: [{ time: '2026-07-18 09:41', node: '订单已支付，等待仓库拣货' }],
  },
  {
    orderNo: 'SO20260620305',
    customerName: '赵女士',
    phoneTail: '7734',
    product: '工业级路由器 R500 ×1',
    amount: 2180.0,
    status: '退款中',
    createdAt: '2026-06-20 20:15',
    shippedAt: '2026-06-21 10:00',
    carrier: '中通快递',
    trackingNo: 'ZT5566778899',
    refundable: false,
    traces: [
      { time: '2026-06-21 10:00', node: '【杭州仓】已发货' },
      { time: '2026-06-23 16:40', node: '已签收' },
      { time: '2026-07-16 11:20', node: '买家申请退货退款，审核通过' },
      { time: '2026-07-19 09:05', node: '退货包裹已揽收，等待仓库质检' },
    ],
  },
];

/**
 * 按订单号精确查询。入参会先做规范化（去除空白、转大写），容忍用户输入习惯。
 * @param rawOrderNo 原始订单号（可能含空格）
 * @returns 命中的订单；未命中或入参为空返回 undefined
 */
export function findOrder(rawOrderNo: string): Order | undefined {
  const orderNo = String(rawOrderNo || '').replace(/\s+/g, '').toUpperCase();
  if (!orderNo) return undefined;
  return ORDERS.find((o) => o.orderNo.toUpperCase() === orderNo);
}

/** 返回全部订单（管理后台调试 / 演示用） */
export function listOrders(): Order[] {
  return ORDERS;
}

/**
 * 将命中的订单结构化为注入 LLM 的上下文文本。
 * 字段顺序遵循「概要 → 物流 → 可退性 → 轨迹」的信息密度递减。
 */
export function formatOrderContext(order: Order): string {
  const lines = [
    `订单号：${order.orderNo}`,
    `商品：${order.product}`,
    `金额：¥${order.amount.toFixed(2)}`,
    `状态：${order.status}`,
    `下单时间：${order.createdAt}`,
  ];
  if (order.carrier) lines.push(`承运商：${order.carrier}，运单号：${order.trackingNo}`);
  lines.push(`是否可退：${order.refundable ? '是' : '否（已在退款流程中）'}`);
  lines.push('物流轨迹：');
  order.traces.forEach((t) => lines.push(`  · ${t.time} ${t.node}`));
  return lines.join('\n');
}

/**
 * 订单未命中时生成上下文提示，引导 Agent 礼貌提示客户核对，而非编造信息。
 */
export function formatOrderNotFound(rawOrderNo: string): string {
  const safeNo = String(rawOrderNo || '').replace(/\s+/g, '').toUpperCase() || '（未解析）';
  return `（注意：客户提供的订单号 ${safeNo} 未在订单系统中查询到。请勿编造物流或金额信息，应礼貌提示客户核对订单号是否正确，或提供下单手机号后四位以便人工协助查询。）`;
}

/**
 * 解析订单上下文（对外统一入口）。
 * 设计为 async 以便未来替换为远程订单中心调用；当前为内存检索。
 * 任何异常均被吞掉并返回 found=false，确保订单查询失败不影响主对话链路。
 *
 * @returns { found: boolean; context: string }
 *   - found=true：context 为标准订单上下文；
 *   - found=false：context 为「未命中 / 查询失败」引导文案。
 */
export async function resolveOrderContext(rawOrderNo: string): Promise<{ found: boolean; context: string }> {
  try {
    const order = findOrder(rawOrderNo);
    if (order) return { found: true, context: formatOrderContext(order) };
    return { found: false, context: formatOrderNotFound(rawOrderNo) };
  } catch (e) {
    logger.warn(`[orders] 订单查询异常（降级为未命中）: ${(e as any)?.message || e}`);
    return { found: false, context: formatOrderNotFound(rawOrderNo) };
  }
}

/**
 * Promise 超时包裹：在 ms 内未决议则 reject，便于对外部依赖（远程订单中心）设定上限，
 * 避免慢调用拖垮主对话链路。当前 resolveOrderContext 为内存实现瞬时返回，包裹为「零行为」，
 * 但为生产替换为 HTTP/gRPC 远程调用提前兜底的可靠性基础。
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（>${ms}ms）`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
