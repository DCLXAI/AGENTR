(function () {
  var scriptTag = document.currentScript;
  if (!scriptTag) {
    return;
  }

  var apiBaseUrl = (scriptTag.getAttribute("data-api-base-url") || "").trim();
  var tenantId = (scriptTag.getAttribute("data-tenant-id") || "").trim();
  var title = (scriptTag.getAttribute("data-title") || "AI FAQ").trim();
  var placeholder = (scriptTag.getAttribute("data-placeholder") || "질문을 입력하세요").trim();
  var openLabel = (scriptTag.getAttribute("data-open-label") || "FAQ").trim();
  var welcome = (
    scriptTag.getAttribute("data-welcome") ||
    "안녕하세요. 배송/반품/교환/상품 문의를 도와드릴게요."
  ).trim();

  if (!apiBaseUrl || !tenantId) {
    console.error("[faq_widget] data-api-base-url and data-tenant-id are required.");
    return;
  }

  var style = document.createElement("style");
  style.textContent = [
    ".faqw-root{position:fixed;right:20px;bottom:20px;z-index:2147483647;font-family:Arial,sans-serif}",
    ".faqw-button{background:#111;color:#fff;border:0;border-radius:999px;padding:12px 16px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.18)}",
    ".faqw-panel{width:360px;max-width:calc(100vw - 24px);height:520px;max-height:calc(100vh - 100px);background:#fff;border:1px solid #ddd;border-radius:14px;display:none;flex-direction:column;box-shadow:0 16px 40px rgba(0,0,0,.2);overflow:hidden}",
    ".faqw-header{padding:12px 14px;background:#111;color:#fff;font-weight:700;display:flex;justify-content:space-between;align-items:center}",
    ".faqw-close{background:transparent;border:0;color:#fff;font-size:18px;cursor:pointer}",
    ".faqw-messages{flex:1;overflow:auto;padding:12px;background:#f7f7f8}",
    ".faqw-msg{margin:8px 0;max-width:85%;padding:10px 12px;border-radius:10px;line-height:1.4;font-size:14px;white-space:pre-wrap;word-break:break-word}",
    ".faqw-msg-user{margin-left:auto;background:#111;color:#fff}",
    ".faqw-msg-bot{margin-right:auto;background:#fff;border:1px solid #ddd;color:#111}",
    ".faqw-footer{display:flex;gap:8px;padding:10px;border-top:1px solid #eee;background:#fff}",
    ".faqw-input{flex:1;border:1px solid #ccc;border-radius:8px;padding:10px;font-size:14px}",
    ".faqw-send{border:0;border-radius:8px;padding:10px 12px;background:#111;color:#fff;cursor:pointer}",
    ".faqw-meta{margin-top:6px;font-size:11px;color:#666}"
  ].join("");
  document.head.appendChild(style);

  var root = document.createElement("div");
  root.className = "faqw-root";

  var openBtn = document.createElement("button");
  openBtn.className = "faqw-button";
  openBtn.type = "button";
  openBtn.textContent = openLabel;

  var panel = document.createElement("div");
  panel.className = "faqw-panel";

  var header = document.createElement("div");
  header.className = "faqw-header";
  header.textContent = title;

  var closeBtn = document.createElement("button");
  closeBtn.className = "faqw-close";
  closeBtn.type = "button";
  closeBtn.textContent = "x";
  header.appendChild(closeBtn);

  var messages = document.createElement("div");
  messages.className = "faqw-messages";

  var footer = document.createElement("div");
  footer.className = "faqw-footer";

  var input = document.createElement("input");
  input.className = "faqw-input";
  input.type = "text";
  input.placeholder = placeholder;

  var sendBtn = document.createElement("button");
  sendBtn.className = "faqw-send";
  sendBtn.type = "button";
  sendBtn.textContent = "전송";

  footer.appendChild(input);
  footer.appendChild(sendBtn);

  panel.appendChild(header);
  panel.appendChild(messages);
  panel.appendChild(footer);
  root.appendChild(openBtn);
  root.appendChild(panel);
  document.body.appendChild(root);

  function getSessionId() {
    var key = "faqw_session_" + tenantId;
    var existing = window.localStorage.getItem(key);
    if (existing) {
      return existing;
    }
    var sid = "shop-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    window.localStorage.setItem(key, sid);
    return sid;
  }

  function addMessage(text, role, meta) {
    var msg = document.createElement("div");
    msg.className = "faqw-msg " + (role === "user" ? "faqw-msg-user" : "faqw-msg-bot");
    msg.textContent = text;
    if (meta) {
      var metaEl = document.createElement("div");
      metaEl.className = "faqw-meta";
      metaEl.textContent = meta;
      msg.appendChild(metaEl);
    }
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
  }

  async function ask(question) {
    var payload = {
      tenant_id: tenantId,
      session_id: getSessionId(),
      user_message: question
    };
    var res = await fetch(apiBaseUrl.replace(/\/+$/, "") + "/v1/chat/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }
    return res.json();
  }

  async function onSend() {
    var q = (input.value || "").trim();
    if (!q) {
      return;
    }
    input.value = "";
    addMessage(q, "user");
    try {
      var data = await ask(q);
      var meta = "intent=" + (data.intent || "-");
      if (data.why_fallback) {
        meta += " | why_fallback=" + data.why_fallback;
      }
      addMessage(data.answer || "응답 없음", "bot", meta);
    } catch (err) {
      addMessage("일시적으로 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.", "bot", "error");
    }
  }

  openBtn.addEventListener("click", function () {
    panel.style.display = "flex";
    openBtn.style.display = "none";
    input.focus();
  });

  closeBtn.addEventListener("click", function () {
    panel.style.display = "none";
    openBtn.style.display = "inline-block";
  });

  sendBtn.addEventListener("click", onSend);
  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      onSend();
    }
  });

  addMessage(welcome, "bot");
})();

