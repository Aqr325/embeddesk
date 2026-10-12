/** 应用全局配置 */
export const APP_CONFIG = {
  name: '智能客服 Agent',
  nameInitial: '中',
  brand: '中科佳晨',
  description: '多轮对话 · 知识库检索 · 意图识别 · 智能转人工',
  version: '1.0.0',
  /** 满意度评价可选标签 */
  ratingTags: ['回答准确', '响应快', '态度好', '未解决问题', '答非所问', '处理太慢', '需要转人工'],
  /** 客服工作台快捷问法 */
  quickAsks: [
    { icon: 'package', text: '查询订单 SO20260712001 的物流进度' },
    { icon: 'refund', text: '我想申请退款，需要什么条件？' },
    { icon: 'wrench', text: '设备连不上 WiFi，一直配网失败' },
    { icon: 'file', text: '发票怎么开？支持补开吗' },
  ],
};

export default APP_CONFIG;
