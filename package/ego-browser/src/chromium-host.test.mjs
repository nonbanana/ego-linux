import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createChromiumEgo, renderAxTree } from "../dist/src/chromium-host.js";
import { snapshot } from "../dist/src/driver/observe.js";

function ax(nodeId, role, name, extra = {}) {
  return {
    nodeId,
    role: { value: role },
    ...(name === undefined ? {} : { name: { value: name } }),
    ...extra,
  };
}

function hostFrame() {
  const child = {
    frameId: "FRAME-1",
    children: new Map(),
    nodes: [
      ax("c1", "RootWebArea", "Inner", {
        childIds: ["c2"],
        backendDOMNodeId: 1,
      }),
      ax("c2", "button", "Save", { backendDOMNodeId: 11 }),
    ],
  };
  return {
    children: new Map([[30, child]]),
    nodes: [
      ax("1", "RootWebArea", "Host", {
        childIds: ["2", "3", "4", "5", "6"],
        backendDOMNodeId: 1,
      }),
      ax("2", "heading", "Title", { childIds: ["7"], backendDOMNodeId: 5 }),
      ax("7", "StaticText", "Title"),
      ax("3", "link", "First", {
        backendDOMNodeId: 11,
        properties: [{ name: "url", value: { value: "https://a.test/same" } }],
      }),
      ax("4", "link", "Second", {
        backendDOMNodeId: 12,
        properties: [{ name: "url", value: { value: "https://a.test/same" } }],
      }),
      ax("5", "button", "Save", { backendDOMNodeId: 20 }),
      ax("6", "Iframe", "Embedded", { backendDOMNodeId: 30 }),
    ],
  };
}

test("Chrome snapshots print refs in document order and keep frame provenance", () => {
  const { content, refs } = renderAxTree(hostFrame(), {
    includeStableLocator: true,
  });

  assert.equal(
    content,
    [
      'root "Host"',
      '  heading "Title"',
      '  link "First" [ref=1, url=https://a.test/same]',
      '  link "Second" [ref=2, url=https://a.test/same]',
      '  button "Save" [ref=3]',
      '  iframe "Embedded" [ref=4, loc=role:iframe[name="Embedded"]]',
      '    root "Inner"',
      '      button "Save" [ref=5]',
    ].join("\n"),
  );
  assert.deepEqual(
    refs.map(({ refId, backendNodeId, frameId }) => [
      refId,
      backendNodeId,
      frameId,
    ]),
    [
      [1, 11, undefined],
      [2, 12, undefined],
      [3, 20, undefined],
      [4, 30, undefined],
      [5, 11, "FRAME-1"],
    ],
  );
});

test("Chrome subtree snapshots use the root frame to disambiguate backend ids", () => {
  assert.throws(
    () => renderAxTree(hostFrame(), { scope: "subtree", root: 11 }),
    /ambiguous across frames/,
  );
  assert.equal(
    renderAxTree(hostFrame(), {
      scope: "subtree",
      root: 11,
      rootFrameId: "FRAME-1",
    }).content,
    'button "Save" [ref=1]',
  );
  assert.match(
    renderAxTree(hostFrame(), { scope: "subtree", root: 11, rootFrameId: "" })
      .content,
    /^link "First"/,
  );
});

test("Chrome host reports native task errors without starting Chrome", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ego-chromium-host-"));
  writeFileSync(
    join(dataDir, "task-spaces.json"),
    JSON.stringify({
      nextId: 3,
      spaces: [
        {
          id: 2,
          name: "handed",
          createdBy: "agent",
          ownership: "agentDelegatedToUser",
          targets: [],
        },
      ],
    }),
  );
  const ego = createChromiumEgo({
    EGO_BROWSER_DATA_DIR: dataDir,
    EGO_BROWSER_CHROME: "/nonexistent/chrome",
  });
  try {
    const sendError = new Promise((resolve) => {
      ego.onSendCDPMessageError = (message, code) => resolve(code);
    });
    ego.sendCDPMessage(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    assert.equal(await sendError, "EGO_TASK_SPACE_NOT_SELECTED");

    assert.throws(() => ego.useTaskSpace("2"), {
      error_code: "EGO_INVALID_ARGUMENT",
    });
    assert.equal(ego.useTaskSpace(2), 2);
    const delegatedError = new Promise((resolve) => {
      ego.onSendCDPMessageError = (message, code) => resolve([message, code]);
    });
    ego.sendCDPMessage(JSON.stringify({ id: 2, method: "Browser.getVersion" }));
    assert.deepEqual(await delegatedError, [
      "manual_takeover",
      "EGO_TASK_SPACE_USER_IN_CONTROL",
    ]);
    assert.deepEqual(await ego.createTaskSpace("x", "Profile 9"), {
      error: "Profile not found",
      error_code: "EGO_PROFILE_NOT_FOUND",
    });
  } finally {
    ego.close();
  }
});

test("snapshot root frame hints reach only hosts that accept them", async () => {
  const previous = globalThis.ego;
  const seen = [];
  try {
    for (const accepts of [false, true]) {
      globalThis.ego = {
        ...(accepts ? { acceptsSnapshotRootFrameId: true } : {}),
        async snapshot(options) {
          seen.push(options);
          return { content: "", refs: [] };
        },
      };
      await snapshot({ scope: "subtree", root: 4, rootFrameId: "F" });
    }
  } finally {
    globalThis.ego = previous;
  }
  assert.deepEqual(seen, [
    { scope: "subtree", root: 4 },
    { scope: "subtree", root: 4, rootFrameId: "F" },
  ]);
});

test("Chrome snapshots join text split across many nodes", () => {
  const letters = ["H", "i", " ", "t", "h", "e", "r", "e"];
  const frame = {
    children: new Map(),
    nodes: [
      ax("1", "RootWebArea", "Doc", {
        childIds: ["2", "9"],
        backendDOMNodeId: 1,
      }),
      ax("2", "paragraph", "", {
        childIds: letters.map((_, index) => `w${index}`),
      }),
      ...letters.map((_, index) =>
        ax(`w${index}`, "generic", undefined, {
          ignored: true,
          childIds: [`t${index}`],
        }),
      ),
      ...letters.map((letter, index) => ax(`t${index}`, "StaticText", letter)),
      ax("9", "button", "Save", { childIds: ["10"], backendDOMNodeId: 9 }),
      ax("10", "StaticText", "Save"),
    ],
  };

  assert.equal(
    renderAxTree(frame).content,
    [
      'root "Doc"',
      "  paragraph",
      '    text "Hi there"',
      '  button "Save" [ref=1]',
    ].join("\n"),
  );
});

const chromeAvailable = Boolean(
  process.env.EGO_BROWSER_CHROME ||
  (process.env.PATH || "")
    .split(":")
    .some((dir) =>
      ["google-chrome", "google-chrome-stable", "chromium"].some((name) =>
        existsSync(join(dir, name)),
      ),
    ),
);

test(
  "tabs opened with a URL send the Mac Edge UA and Client Hints on the first request",
  { skip: !chromeAvailable, timeout: 60_000 },
  async () => {
    const requests = [];
    const server = createServer((req, res) => {
      if (req.url === "/favicon.ico") return res.end();
      requests.push({
        url: req.url,
        ua: req.headers["user-agent"],
        ch: req.headers["sec-ch-ua"],
      });
      res.setHeader("content-type", "text/html");
      res.end("ok");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const dataDir = mkdtempSync(join(tmpdir(), "ego-ua-test-"));
    const ego = createChromiumEgo({
      ...process.env,
      EGO_BROWSER_DATA_DIR: dataDir,
    });
    try {
      const space = await ego.createTaskSpace("ua-first-request");
      ego.useTaskSpace(space.id);
      const origin = `http://127.0.0.1:${server.address().port}`;
      await ego.createTab(`${origin}/first-tab`);
      await ego.createTab(`${origin}/second-tab`);
      const deadline = Date.now() + 10_000;
      while (requests.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.match(request.ua, /Macintosh.*Edg\/145/, request.url);
        assert.match(request.ch, /Microsoft Edge/, request.url);
      }
    } finally {
      ego.close();
      server.close();
      await closeChrome(dataDir);
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

async function closeChrome(dataDir) {
  try {
    const [port, path] = readFileSync(
      join(dataDir, "chrome-profile", "DevToolsActivePort"),
      "utf8",
    ).split("\n");
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise((resolve) => {
      socket.onopen = () => {
        socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
        resolve();
      };
      socket.onerror = resolve;
    });
  } catch {}
}
