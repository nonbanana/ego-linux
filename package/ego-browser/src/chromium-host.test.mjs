import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
