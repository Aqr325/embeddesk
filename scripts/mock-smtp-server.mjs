#!/usr/bin/env node
/**
 * 极简 Mock SMTP 服务端（纯 Node，无第三方依赖）。
 *
 * 用途：在隔离环境里真实起一个 SMTP 服务，承接 nodemailer 的 SMTP 投递，
 *       验证「发送 → 接收 → 失败重试 → 超时」全链路（无需外网 / 真实邮箱）。
 *
 * 模式：
 *   capture         正常接收并捕获邮件正文（写入 out 文件 + 内存 + HTTP /received）
 *   fail-transient  对 MAIL FROM 返回 451（瞬时可恢复 → 触发客户端重试）
 *   fail-permanent  对 MAIL FROM 返回 550（永久错误 → 客户端立即放弃，不重试）
 *   slow            对 MAIL FROM 延迟很久才响应（用于触发客户端 socket/连接超时 → 重试）
 *
 * HTTP 管理接口（仅本地测试用）：
 *   GET  /health    -> 200
 *   GET  /received  -> JSON 数组（已捕获邮件：from/to/subject/text/time）
 *   DELETE /received -> 清空捕获（重置）
 *
 * 启动：node mock-smtp-server.mjs --smtp 3201 --http 3202 --mode capture --out /tmp/smtp_recv.jsonl
 */
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[++i] ?? 'true');
}
const SMTP_PORT = Number(args.get('smtp') || 3201);
const HTTP_PORT = Number(args.get('http') || 3202);
const MODE = args.get('mode') || 'capture';
const OUT = args.get('out') || '/tmp/smtp_received.jsonl';

/** @type {Array<{from:string,to:string,subject:string,text:string,time:string}>} */
const received = [];

function appendOut(rec) {
  try {
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
  } catch (e) {
    /* ignore */
  }
}

// 解码 quoted-printable 正文（nodemailer 对含非 ASCII 的 text 默认用 QP 编码）
function decodeQP(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '=' && /[A-Fa-f0-9]{2}/.test(text.substr(i + 1, 2))) {
      bytes.push(parseInt(text.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// 解码 Subject 的 =?UTF-8?B?...?= 形式
function decodeSubject(s) {
  const m = /=\?UTF-8\?B\?(.+?)\?=/i.exec(s);
  if (m) {
    try {
      return Buffer.from(m[1], 'base64').toString('utf8');
    } catch {}
  }
  return s;
}

function handleSmtp() {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buf = '';
    let authed = false;
    let mailFrom = '';
    let rcptTo = '';
    let dataMode = false;
    let dataBuf = '';

    socket.write('220 mock-smtp ready\r\n');

    const respond = (code, msg) => socket.write(`${code} ${msg}\r\n`);
    const respondMulti = (lines) => socket.write(lines.join('\r\n') + '\r\n');

    const finishData = () => {
      // 解析 MIME：提取 Subject 与正文，并按 Content-Transfer-Encoding 解码正文
      const raw = dataBuf.replace(/\r\n/g, '\n');
      const lines = raw.split('\n');
      let subject = '';
      let bodyStart = lines.length;
      let inHeaders = true;
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (inHeaders) {
          const sm = /^Subject:\s*(.*)$/i.exec(ln);
          if (sm) subject = sm[1];
          if (ln.trim() === '') {
            inHeaders = false;
            bodyStart = i + 1;
          }
          continue;
        }
      }
      const encMatch = raw.match(/Content-Transfer-Encoding:\s*(\w+)/i);
      const enc = (encMatch && encMatch[1] ? encMatch[1] : '').toLowerCase();
      let body = lines.slice(bodyStart).join('\n').trim();
      if (enc === 'base64') {
        try {
          body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
        } catch {}
      } else if (enc === 'quoted-printable') {
        body = decodeQP(body);
      }
      subject = decodeSubject(subject);
      const rec = {
        from: mailFrom,
        to: rcptTo,
        subject,
        text: body,
        time: new Date().toISOString(),
      };
      received.push(rec);
      appendOut(rec);
      respond(250, 'OK: message queued');
    };

    socket.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        if (dataMode) {
          if (line === '.') {
            dataMode = false;
            finishData();
          } else {
            dataBuf += line + '\r\n';
          }
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          respondMulti(['250-mock-smtp ESMTP', '250 AUTH LOGIN PLAIN']);
        } else if (upper.startsWith('AUTH')) {
          authed = true;
          respond(235, 'Authentication successful');
        } else if (upper.startsWith('MAIL FROM:')) {
          mailFrom = (line.match(/<(.+?)>/) || [])[1] || '';
          if (MODE === 'fail-transient') {
            respond(451, 'Temporary local error, please try again');
          } else if (MODE === 'fail-permanent') {
            respond(550, 'Mailbox unavailable / policy rejection');
          } else if (MODE === 'slow') {
            // 故意延迟，触发客户端 socket/connection 超时
            setTimeout(() => respond(250, 'OK (late)'), 9000);
          } else {
            respond(250, 'OK');
          }
        } else if (upper.startsWith('RCPT TO:')) {
          rcptTo = (line.match(/<(.+?)>/) || [])[1] || '';
          respond(250, 'OK');
        } else if (upper.startsWith('DATA')) {
          respond(354, 'End data with <CR><LF>.<CR><LF>');
          dataMode = true;
          dataBuf = '';
        } else if (upper.startsWith('RSET')) {
          respond(250, 'OK');
        } else if (upper.startsWith('NOOP')) {
          respond(250, 'OK');
        } else if (upper.startsWith('QUIT')) {
          respond(221, 'Bye');
          socket.end();
        } else {
          respond(250, 'OK');
        }
      }
    });

    socket.on('error', () => {
      /* 客户端超时断开等情况，忽略 */
    });
  });

  server.listen(SMTP_PORT, '127.0.0.1', () => {
    console.log(`[mock-smtp] listening on 127.0.0.1:${SMTP_PORT} mode=${MODE}`);
  });
}

function handleHttp() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'GET' && req.url === '/received') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(received));
      return;
    }
    if (req.method === 'DELETE' && req.url === '/received') {
      received.length = 0;
      try {
        fs.writeFileSync(OUT, '');
      } catch (e) {
        /* ignore */
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cleared: true }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`[mock-smtp] http admin on 127.0.0.1:${HTTP_PORT}`);
  });
}

handleSmtp();
handleHttp();
