const B = 'http://localhost:3000';
const ADMIN_PWD = 'uc0UR5OPz5gZ';

async function j(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const r = await fetch(B + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

const results = [];
const ok = (n, c, extra='') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`);

// 1. 固定密码登录 admin
const login = await j('POST', '/api/admin/login', { username: 'admin', password: ADMIN_PWD });
ok('admin 固定密码登录', login.status === 200 && login.data?.role === 'admin', `role=${login.data?.role}`);
const token = login.data?.token;

// 2. 错误密码应 401
const bad = await j('POST', '/api/admin/login', { username: 'admin', password: 'wrong-pwd' });
ok('错误密码被拒绝(401)', bad.status === 401);

// 3. 带 token 列出员工
const emp = await j('GET', '/api/employees', null, token);
ok('admin 读取员工列表', emp.status === 200 && Array.isArray(emp.data?.employees), `count=${emp.data?.employees?.length}`);

// 4. 无 token 应 401
const empNo = await j('GET', '/api/employees');
ok('未授权读取员工被拒(401)', empNo.status === 401);

// 5. 创建坐席（接口返回 201；用户名带时间戳保证可重复执行）
const newAgent = `va_${Date.now()}`;
const create = await j('POST', '/api/employees', { username: newAgent, display_name: '验证坐席', role: 'agent', password: 'agent123' }, token);
ok('admin 创建坐席', (create.status === 200 || create.status === 201) && create.data?.employee?.role === 'agent', `status=${create.status}`);

// 6. 坐席登录
const loginA = await j('POST', '/api/admin/login', { username: newAgent, password: 'agent123' });
ok('坐席登录', loginA.status === 200 && loginA.data?.role === 'agent');
const tokenA = loginA.data?.token;

// 7. 坐席读取员工列表应 403
const empA = await j('GET', '/api/employees', null, tokenA);
ok('坐席越权读员工被拒(403)', empA.status === 403);

// 8. 客户长期画像 读写
const cid = 'verify_cust_001';
const putP = await j('PUT', `/api/customers/${cid}/profile`, { name: '李工', company: '某某科技', industry: '智能家居', tags: 'VIP,技术决策人' }, token);
ok('写入客户画像', putP.status === 200 && putP.data?.profile?.name === '李工');
// 关联一个会话，验证 session_count 自增（跨会话记忆链路）
const sess = await j('POST', '/api/sessions', { customerId: cid });
ok('创建会话并关联客户', sess.status === 200 && !!sess.data?.session?.id);
const getP = await j('GET', `/api/customers/${cid}/profile`, null, token);
ok('读取客户画像且会话计数自增', getP.status === 200 && getP.data?.profile?.company === '某某科技' && getP.data?.profile?.session_count >= 1, `session_count=${getP.data?.profile?.session_count}`);

// 9. 导入 IoT FAQ CSV
import { readFileSync } from 'fs';
const csv = readFileSync('seed/faqs.csv', 'utf8');
const imp = await j('POST', '/api/admin/import/faqs', { format: 'csv', data: csv }, token);
ok('批量导入 FAQ(CSV)', imp.status === 200 && (imp.data?.imported ?? 0) > 0, `imported=${imp.data?.imported}, errors=${imp.data?.errors?.length ?? 0}`);

// 10. faqCount 增长
const meta = await j('GET', '/api/meta');
const fc = meta.data?.faqCount ?? 0;
ok('知识库 FAQ 数量增长', fc > 18, `faqCount=${fc}`);

// 11. 知识库命中
const search = await j('POST', '/api/faqs/search', { query: 'SG865W 模组支持哪些操作系统' });
const top = search.data?.hits?.[0];
ok('知识库命中导入的 IoT 问题', search.status === 200 && !!top && /SG865W/.test(top.question || ''), `top="${top?.question}" score=${top?.score?.toFixed?.(3)}`);

// 12. 清理：删除验证坐席
const del = await j('DELETE', `/api/employees/${create.data?.employee?.id}`, null, token);
ok('清理验证坐席', del.status === 200);

console.log('\n===== 全链路验证结果 =====');
console.log(results.join('\n'));
const failed = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n合计 ${results.length} 项，失败 ${failed} 项。`);
process.exit(failed > 0 ? 1 : 0);
