// Agent cursor, action label, and control indicators drawn inside task-space
// pages. Everything lives in a closed, aria-hidden shadow root with
// pointer-events:none, so page hit-testing and accessibility snapshots ignore it.

(() => {
  if (globalThis.__egoAgentOverlay) return;
  globalThis.__egoAgentOverlay = true;

  const CURSOR_SVG =
    '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8.5-6.6 1.6L8 18.5z" fill="#2563eb" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const STYLE = `
    :host { all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
    .frame { position: fixed; inset: 0; box-shadow: inset 0 0 0 3px rgba(37,99,235,.85), inset 0 0 18px rgba(37,99,235,.45); }
    .cursor { position: fixed; left: 0; top: 0; transition: transform .35s cubic-bezier(.2,.8,.2,1); will-change: transform; }
    .cursor svg { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
    .label { position: absolute; left: 20px; top: 18px; max-width: 280px; padding: 4px 9px; border-radius: 10px;
      background: #2563eb; color: #fff; font: 600 12px/1.35 system-ui, sans-serif; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 6px rgba(0,0,0,.25); }
    .ripple { position: absolute; left: -9px; top: -9px; width: 22px; height: 22px; border-radius: 50%;
      border: 2px solid #2563eb; opacity: 0; }
    .ripple.on { animation: ripple .55s ease-out; }
    @keyframes ripple { from { transform: scale(.4); opacity: .9; } to { transform: scale(1.9); opacity: 0; } }
    .banner { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); max-width: calc(100vw - 32px);
      padding: 8px 14px; border-radius: 10px; background: #ea580c; color: #fff;
      font: 600 13px/1.4 system-ui, sans-serif; box-shadow: 0 3px 10px rgba(0,0,0,.3); }
    [hidden] { display: none !important; }
  `;

  let host;
  let parts;
  let state = {};

  function ensure() {
    if (host?.isConnected) return;
    host = document.createElement("ego-agent-overlay");
    host.setAttribute("aria-hidden", "true");
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>${STYLE}</style>
      <div class="frame" hidden></div>
      <div class="banner" hidden>Your turn. When you are done, right-click the page and choose “Return control to the agent”.</div>
      <div class="cursor" hidden>${CURSOR_SVG}<div class="ripple"></div><div class="label" hidden></div></div>`;
    parts = {
      frame: shadow.querySelector(".frame"),
      banner: shadow.querySelector(".banner"),
      cursor: shadow.querySelector(".cursor"),
      ripple: shadow.querySelector(".ripple"),
      label: shadow.querySelector(".label"),
    };
    document.documentElement.append(host);
  }

  function apply(previousCursor) {
    ensure();
    const agent = state.ownership === "agent";
    host.style.display = state.hidden ? "none" : "";
    parts.frame.hidden = !agent;
    parts.banner.hidden = state.ownership !== "agentDelegatedToUser";
    parts.cursor.hidden = !agent || !state.cursor;
    parts.label.hidden = !state.state;
    parts.label.textContent = state.state || "";
    if (state.cursor) {
      const { x, y } = state.cursor;
      parts.cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
      const moved =
        !previousCursor ||
        previousCursor.x !== x ||
        previousCursor.y !== y ||
        state.cursor.at !== previousCursor.at;
      if (moved && agent) {
        parts.ripple.classList.remove("on");
        void parts.ripple.offsetWidth;
        parts.ripple.classList.add("on");
      }
    }
  }

  // Answer once the change is on screen, so a screenshot taken next matches it.
  // Background tabs skip animation frames, hence the timeout.
  function afterPaint(respond) {
    let done = false;
    const finish = () => {
      if (!done) respond(true);
      done = true;
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 100);
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== "ego-overlay") return undefined;
    const previousCursor = state.cursor;
    state = { ...state, ...message.state };
    apply(previousCursor);
    afterPaint(respond);
    return true;
  });

  chrome.runtime.sendMessage({ type: "ego-overlay-hello" }, (initial) => {
    if (chrome.runtime.lastError || !initial) return;
    state = initial;
    apply(state.cursor);
  });
})();
