const EDGE_VERSION = "145.0.3800.82";
const CHROMIUM_VERSION = "145.0.7049.52";

// Values match teams-for-linux's emulateMacNativeClient (macTeamsConstants.js)
// minus the Teams-only `Teams/…` UA token, which general sites should not see.
export const USER_AGENT_OVERRIDE = {
  userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_VERSION} Safari/537.36 Edg/${EDGE_VERSION}`,
  platform: "MacIntel",
  userAgentMetadata: {
    brands: [
      { brand: "Microsoft Edge", version: "145" },
      { brand: "Not/A)Brand", version: "8" },
      { brand: "Chromium", version: "145" },
    ],
    fullVersionList: [
      { brand: "Microsoft Edge", version: EDGE_VERSION },
      { brand: "Not/A)Brand", version: "8.0.0.0" },
      { brand: "Chromium", version: CHROMIUM_VERSION },
    ],
    platform: "macOS",
    platformVersion: "10.15.7",
    architecture: "x86",
    bitness: "64",
    model: "",
    mobile: false,
  },
};

// Runs as a detached `node -e` process for as long as Chrome lives: every page
// target, including tabs the user opens, pauses at start until it has the
// override. Writes its pid file only after auto-attach is active.
export const IDENTITY_DAEMON_SOURCE = `
const [url, pidFile] = process.argv.slice(1);
const fs = require("node:fs");
const override = ${JSON.stringify(USER_AGENT_OVERRIDE)};
const ws = new WebSocket(url);
let id = 0;
const send = (method, params = {}, sessionId) => ws.send(JSON.stringify({ id: ++id, method, params, sessionId }));
const attachId = 1;
ws.onopen = () => send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "page" }] });
ws.onclose = () => process.exit(0);
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id === attachId) {
    if (m.error) { console.error("Target.setAutoAttach failed:", m.error.message); process.exit(1); }
    fs.writeFileSync(pidFile, String(process.pid));
  } else if (m.error) {
    console.error(m.error.message);
  } else if (m.method === "Target.attachedToTarget") {
    send("Emulation.setUserAgentOverride", override, m.params.sessionId);
    if (m.params.waitingForDebugger) send("Runtime.runIfWaitingForDebugger", {}, m.params.sessionId);
  }
};
`;
