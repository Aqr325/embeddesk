/**
 * 中科佳晨 · 嵌入式客服浮动窗（无框架，原生 JS）
 * 用法（第三方网站）：
 *   <script
 *     src="https://你的服务器地址/embed.js"
 *     data-site-id="site_xxxxxxxx"
 *     data-token="嵌入码中的 token"
 *     data-color="#1e3a8a"
 *     data-title="在线客服"
 *     data-server="https://你的服务器地址"></script>
 * 说明：
 *   - 样式经 Shadow DOM 隔离，不会污染宿主网站，也不受宿主 CSS 影响。
 *   - 访客标识（visitorId）持久化在 localStorage，刷新页面可续接对话。
 *   - 通过 fetch + SSE 流式接收，复用本站 /api/embed/chat 端点，所有会话同步进客服后台。
 */
(function () {
  'use strict';
  var script = document.currentScript;
  var SITE_ID = (script && script.getAttribute('data-site-id')) || '';
  var TOKEN = (script && script.getAttribute('data-token')) || '';
  var COLOR = (script && script.getAttribute('data-color')) || '#1e3a8a';
  var TITLE = (script && script.getAttribute('data-title')) || '在线客服';
  var SERVER = (script && script.getAttribute('data-server')) ||
    (script ? new URL(script.src).origin : '');

  if (!SITE_ID || !TOKEN) {
    if (window.console) console.warn('[embed.js] 缺少 data-site-id 或 data-token，客服窗口未初始化');
    return;
  }

  var vidKey = 'csa_vid_' + SITE_ID;
  var sidKey = 'csa_sid_' + SITE_ID;

  function getVisitorId() {
    try {
      var v = localStorage.getItem(vidKey);
      if (!v) {
        v = (crypto.randomUUID ? crypto.randomUUID() : 'v_' + Date.now() + Math.random().toString(16).slice(2));
        localStorage.setItem(vidKey, v);
      }
      return v;
    } catch (e) {
      return 'v_' + Date.now();
    }
  }
  function getSessionId() {
    try { return localStorage.getItem(sidKey) || ''; } catch (e) { return ''; }
  }
  function setSessionId(id) {
    try { if (id) localStorage.setItem(sidKey, id); } catch (e) {}
  }

  // ---------- 构建 Shadow DOM ----------
  var host = document.createElement('div');
  host.id = 'csa-widget';
  // 固定层级，避免被宿主 z-index 覆盖；pointer-events 由内部元素控制
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;';
  document.documentElement.appendChild(host);

  var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host; // 兼容极旧环境

  var style = document.createElement('style');
  style.textContent = [
    ':host,*{box-sizing:border-box;}',
    '.csa-fab{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;background:' + COLOR + ';color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);transition:transform .2s;border:none;z-index:1;}',
    '.csa-fab:hover{transform:scale(1.06);}',
    '.csa-panel{position:fixed;right:20px;bottom:88px;width:360px;max-width:calc(100vw - 40px);height:540px;max-height:calc(100vh - 120px);background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.22);display:flex;flex-direction:column;overflow:hidden;z-index:1;}',
    '.csa-header{background:' + COLOR + ';color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;}',
    '.csa-header .csa-title{font-size:15px;font-weight:600;}',
    '.csa-header .csa-close{background:transparent;border:none;color:#fff;cursor:pointer;font-size:20px;line-height:1;opacity:.9;}',
    '.csa-body{flex:1;overflow-y:auto;padding:14px;background:#f7f8fa;}',
    '.csa-msg{margin-bottom:12px;max-width:82%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.5;word-break:break-word;white-space:pre-wrap;}',
    '.csa-msg.user{margin-left:auto;background:' + COLOR + ';color:#fff;border-bottom-right-radius:4px;}',
    '.csa-msg.bot{margin-right:auto;background:#fff;color:#1f2937;border:1px solid #eef0f3;border-bottom-left-radius:4px;}',
    '.csa-msg.handoff{margin-right:auto;background:#fff7ed;color:#9a3412;border:1px solid #fed7aa;}',
    '.csa-msg.err{margin-right:auto;background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;}',
    '.csa-typing{display:inline-block;width:6px;height:6px;border-radius:50%;background:#b6bcc6;margin:0 2px;animation:csa-blink 1.2s infinite both;}',
    '.csa-typing:nth-child(2){animation-delay:.2s;}.csa-typing:nth-child(3){animation-delay:.4s;}',
    '@keyframes csa-blink{0%,80%,100%{opacity:.3;}40%{opacity:1;}}',
    '.csa-input{display:flex;border-top:1px solid #eef0f3;background:#fff;padding:10px;gap:8px;}',
    '.csa-input textarea{flex:1;resize:none;border:1px solid #e2e5ea;border-radius:10px;padding:9px 11px;font-size:14px;outline:none;font-family:inherit;max-height:90px;}',
    '.csa-input textarea:focus{border-color:' + COLOR + ';}',
    '.csa-send{background:' + COLOR + ';color:#fff;border:none;border-radius:10px;padding:0 16px;font-size:14px;cursor:pointer;}',
    '.csa-send:disabled{opacity:.5;cursor:default;}',
    '.csa-foot{font-size:11px;color:#9aa1ad;text-align:center;padding:6px 0 2px;}',
    '.csa-foot a{color:#9aa1ad;text-decoration:none;}',
  ].join('\n');
  shadow.appendChild(style);

  var fab = document.createElement('button');
  fab.className = 'csa-fab';
  fab.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
  fab.setAttribute('aria-label', '打开在线客服');
  shadow.appendChild(fab);

  var panel = document.createElement('div');
  panel.className = 'csa-panel';
  panel.style.display = 'none';
  panel.innerHTML =
    '<div class="csa-header"><span class="csa-title">' + TITLE + '</span><button class="csa-close" aria-label="关闭">×</button></div>' +
    '<div class="csa-body"></div>' +
    '<div class="csa-input"><textarea rows="1" placeholder="请输入您的问题…"></textarea><button class="csa-send">发送</button></div>' +
    '<div class="csa-foot">由 中科佳晨 智能客服 提供技术支持</div>';
  shadow.appendChild(panel);

  var body = panel.querySelector('.csa-body');
  var textarea = panel.querySelector('textarea');
  var sendBtn = panel.querySelector('.csa-send');
  var closeBtn = panel.querySelector('.csa-close');

  var streaming = false;
  var currentBot = null; // 当前流式助手消息元素
  var greetingShown = false;

  function scrollBottom() { body.scrollTop = body.scrollHeight; }

  function addMessage(text, role, extraClass) {
    var el = document.createElement('div');
    el.className = 'csa-msg ' + (role === 'user' ? 'user' : 'bot') + (extraClass ? ' ' + extraClass : '');
    el.textContent = text;
    body.appendChild(el);
    scrollBottom();
    return el;
  }

  function showTyping() {
    var el = document.createElement('div');
    el.className = 'csa-msg bot';
    el.innerHTML = '<span class="csa-typing"></span><span class="csa-typing"></span><span class="csa-typing"></span>';
    body.appendChild(el);
    return el;
  }

  function openPanel() {
    panel.style.display = 'flex';
    fab.style.display = 'none';
    if (!greetingShown) {
      greetingShown = true;
      addMessage('您好，我是' + TITLE + '的智能助手，很高兴为您服务。请问有什么可以帮您？', 'bot');
    }
    setTimeout(function () { textarea.focus(); }, 50);
  }
  function closePanel() {
    panel.style.display = 'none';
    fab.style.display = 'flex';
  }

  fab.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', closePanel);

  function setBusy(b) {
    streaming = b;
    sendBtn.disabled = b;
    textarea.disabled = b;
  }

  function handleEvent(ev) {
    if (ev.type === 'init') {
      if (ev.sessionId) setSessionId(ev.sessionId);
      if (ev.visitorId) { try { localStorage.setItem(vidKey, ev.visitorId); } catch (e) {} }
      if (currentBot && currentBot.dataset.typing) { currentBot.remove(); }
      currentBot = addMessage('', 'bot');
      currentBot.dataset.stream = '1';
    } else if (ev.type === 'text') {
      if (!currentBot || !currentBot.dataset.stream) {
        currentBot = addMessage('', 'bot');
        currentBot.dataset.stream = '1';
      }
      currentBot.textContent += ev.content;
      scrollBottom();
    } else if (ev.type === 'done') {
      if (currentBot) { currentBot.dataset.stream = ''; currentBot = null; }
    } else if (ev.type === 'handoff') {
      if (currentBot) { currentBot.dataset.stream = ''; currentBot = null; }
      addMessage('您的请求已转接人工客服，专员会尽快为您处理（服务时间 09:00–21:00）。', 'bot', 'handoff');
    } else if (ev.type === 'notice') {
      // 轻量提示，不单独成条（避免刷屏）；可在此扩展 toast
    } else if (ev.type === 'error') {
      if (currentBot) { currentBot.remove(); currentBot = null; }
      addMessage(ev.message || '服务异常，请稍后再试。', 'bot', 'err');
    }
  }

  async function sendMessage(text) {
    if (streaming || !text.trim()) return;
    addMessage(text, 'user');
    setBusy(true);
    var typing = showTyping();
    currentBot = typing;
    currentBot.dataset.typing = '1';

    var payload = {
      siteId: SITE_ID,
      token: TOKEN,
      message: text,
      visitorId: getVisitorId(),
      sessionId: getSessionId(),
    };

    try {
      var resp = await fetch(SERVER + '/api/embed/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        var errText = '请求失败（' + resp.status + '）';
        try { var ej = await resp.json(); if (ej && ej.error) errText = ej.error; } catch (e) {}
        if (typing) { typing.remove(); currentBot = null; }
        addMessage(errText, 'bot', 'err');
        return;
      }
      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        buf += decoder.decode(r.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          var chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          var dataLine = chunk.split('\n').find(function (l) { return l.indexOf('data: ') === 0; });
          if (!dataLine) continue;
          var raw = dataLine.slice(6).trim();
          if (!raw) continue;
          try { handleEvent(JSON.parse(raw)); } catch (e) {}
        }
      }
      if (typing && currentBot === typing && !currentBot.dataset.stream) {
        // 已切换到正式消息
      } else if (typing && currentBot === typing) {
        // 极端情况：没有任何文本事件，清理占位
        if (!typing.textContent) typing.remove();
      }
    } catch (e) {
      if (typing) { typing.remove(); currentBot = null; }
      addMessage('网络异常，消息发送失败，请稍后重试。', 'bot', 'err');
    } finally {
      setBusy(false);
      scrollBottom();
    }
  }

  sendBtn.addEventListener('click', function () {
    var t = textarea.value;
    textarea.value = '';
    sendMessage(t);
  });
  textarea.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      var t = textarea.value;
      textarea.value = '';
      sendMessage(t);
    }
  });

  // 暴露给宿主页面（可选）：window.CsaEmbed.open()
  window.CsaEmbed = {
    open: openPanel,
    close: closePanel,
    send: sendMessage,
  };
})();
