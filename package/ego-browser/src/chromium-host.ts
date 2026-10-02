import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Implements the Ego Lite native bindings (docs/native-bindings-api.md) on a
 * stock Chrome/Chromium reached over its DevTools WebSocket, so the runtime can
 * drive a browser on platforms without an Ego Lite build.
 */

type Ownership = "agent" | "user" | "agentDelegatedToUser";

type StoredSpace = {
  id: number;
  name: string;
  createdBy: "agent" | "user";
  ownership: Ownership;
  targets: string[];
  activeTargetId?: string;
  windowId?: number;
  state?: string;
};

type HostState = { nextId: number; spaces: StoredSpace[] };

type EgoErrorResult = { error: string; error_code: string };

type TargetInfo = {
  targetId: string;
  type: string;
  url: string;
  title: string;
  openerId?: string;
};

type AxNode = {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  childIds?: string[];
  backendDOMNodeId?: number;
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
};

type SnapshotOptions = {
  scope?: "full_page" | "only_within_viewport" | "subtree";
  root?: number;
  rootFrameId?: string;
  interactiveOnly?: boolean;
  includeStableLocator?: boolean;
  maxResultLength?: number;
};

const CHROME_CANDIDATES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
];
const CHROME_START_TIMEOUT_MS = 20_000;
const HOST_RESPONSE_TIMEOUT_MS = 30_000;
// Large enough that pages emulating a 1280x800 viewport are not clipped.
const SPACE_WINDOW_SIZE = { width: 1280, height: 960 };
// Two levels up from both dist/src/chromium-host.js and dist/out/index.js.
const EXTENSION_DIR = fileURLToPath(
  new URL("../../chromium-extension/", import.meta.url),
);
const EXTENSION_WORKER = "/ego-host.js";
const EXTENSION_READY_TIMEOUT_MS = 5_000;

const ROLE_NAMES: Record<string, string> = {
  RootWebArea: "root",
  WebArea: "root",
  generic: "container",
  none: "container",
  GenericContainer: "container",
  StaticText: "text",
  Iframe: "iframe",
  img: "image",
};
const HIDDEN_ROLES = new Set(["InlineTextBox", "LineBreak"]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "iframe",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

export type ChromiumEgo = Record<string, any> & { close(): void };

export function createChromiumEgo(
  env: NodeJS.ProcessEnv = process.env,
): ChromiumEgo {
  const dataDir =
    env.EGO_BROWSER_DATA_DIR ||
    join(
      env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
      "ego-browser",
    );
  const profileDir = join(dataDir, "chrome-profile");
  const statePath = join(dataDir, "task-spaces.json");

  let selectedId: number | undefined;
  let browserUrl: Promise<string> | undefined;
  let host: Promise<HostConnection> | undefined;
  let channel: Promise<WebSocket> | undefined;

  const resolveBrowserUrl = () =>
    (browserUrl ??= connectOrLaunchChrome(env, profileDir));
  const hostCdp = () =>
    (host ??= resolveBrowserUrl().then((url) => HostConnection.open(url)));
  let extension: Promise<ExtensionHost> | undefined;
  const extensionHost = () =>
    (extension ??= hostCdp().then((cdp) => attachExtension(cdp)));

  function readState(): HostState {
    if (!existsSync(statePath)) return { nextId: 1, spaces: [] };
    return JSON.parse(readFileSync(statePath, "utf8"));
  }

  // ponytail: last writer wins across concurrent ego-browser processes; add a
  // lock file if parallel agents start racing on task-space bookkeeping.
  function writeState(state: HostState) {
    mkdirSync(dataDir, { recursive: true });
    const temporary = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, statePath);
  }

  function updateSpace(id: number, change: (space: StoredSpace) => void) {
    const state = readState();
    const space = state.spaces.find((candidate) => candidate.id === id);
    if (!space) return undefined;
    change(space);
    writeState(state);
    return space;
  }

  /** Resolve the selected space, or the error the native host would report. */
  function selectedSpace({ allowDelegated = false } = {}):
    | StoredSpace
    | EgoErrorResult {
    if (selectedId === undefined) {
      return egoError("Task space not selected", "EGO_TASK_SPACE_NOT_SELECTED");
    }
    const space = readState().spaces.find((item) => item.id === selectedId);
    if (!space) {
      return egoError(
        `Task space not found: ${selectedId}`,
        "EGO_TASK_SPACE_NOT_FOUND",
      );
    }
    if (space.ownership === "agentDelegatedToUser" && !allowDelegated) {
      return egoError("manual_takeover", "EGO_TASK_SPACE_USER_IN_CONTROL");
    }
    if (space.ownership === "user") {
      return egoError(
        `Task space ${space.id} has not been claimed by the agent`,
        "EGO_TASK_SPACE_INACTIVE",
      );
    }
    return space;
  }

  /**
   * Apply take-over/return choices made in the browser UI, then redraw it.
   * Runs before ownership checks so a user's return is seen immediately.
   */
  async function syncUi() {
    const ui = await extensionHost();
    const actions: Array<{ spaceId: number; action: string }> =
      await ui.call("takeUserActions");
    if (actions.length > 0) {
      const state = readState();
      for (const { spaceId, action } of actions) {
        const space = state.spaces.find((item) => item.id === spaceId);
        if (
          action === "return" &&
          space?.ownership === "agentDelegatedToUser"
        ) {
          space.ownership = "agent";
        } else if (action === "takeover" && space?.ownership === "agent") {
          space.ownership = "agentDelegatedToUser";
        }
      }
      writeState(state);
    }
    await ui.call(
      "render",
      readState().spaces.map(({ id, name, ownership, state, windowId }) => ({
        id,
        name,
        ownership,
        state,
        windowId,
      })),
    );
  }

  // CDP sends go through one queue so hiding the overlay before a screenshot
  // cannot reorder the agent's messages.
  let sendQueue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    sendQueue = sendQueue.then(task);
  };
  const pendingShots = new Map<number, number>();

  // The agent cursor and frame are for the user, not for the agent's own
  // screenshots. A failure here only means the overlay may show in the shot.
  async function setOverlayHidden(windowId: number, hidden: boolean) {
    await extensionHost()
      .then((ui) => ui.call("setOverlayHidden", windowId, hidden))
      .catch(() => {});
  }

  function revealAfterShot(data: string) {
    const id = JSON.parse(data).id;
    const windowId = pendingShots.get(id);
    if (windowId === undefined) return;
    pendingShots.delete(id);
    if ([...pendingShots.values()].includes(windowId)) return;
    enqueue(() => setOverlayHidden(windowId, false));
  }

  async function windowOf(targetId: string): Promise<number | undefined> {
    const cdp = await hostCdp();
    const result = await cdp
      .send("Browser.getWindowForTarget", { targetId })
      .catch(() => undefined);
    return result?.windowId;
  }

  async function liveSpaceTabs(space: StoredSpace): Promise<TargetInfo[]> {
    const cdp = await hostCdp();
    const { targetInfos } = await cdp.send("Target.getTargets");
    const pages = (targetInfos as TargetInfo[]).filter(
      (target) => target.type === "page",
    );
    const members = new Set(
      space.targets.filter((id) => pages.some((page) => page.targetId === id)),
    );
    // Popups opened from a space tab belong to that space.
    let grew = true;
    while (grew) {
      grew = false;
      for (const page of pages) {
        if (
          !members.has(page.targetId) &&
          page.openerId &&
          members.has(page.openerId)
        ) {
          members.add(page.targetId);
          grew = true;
        }
      }
    }
    const targets = [...members];
    if (
      targets.length !== space.targets.length ||
      targets.some((id, index) => space.targets[index] !== id)
    ) {
      updateSpace(space.id, (stored) => {
        stored.targets = targets;
        if (stored.activeTargetId && !members.has(stored.activeTargetId)) {
          stored.activeTargetId = targets.at(-1);
        }
      });
      space.targets = targets;
    }
    return targets.map((id) => pages.find((page) => page.targetId === id)!);
  }

  async function describe(space: StoredSpace) {
    const tabs =
      space.targets.length > 0
        ? await liveSpaceTabs(space).catch(() => [])
        : [];
    return {
      ...spaceDescriptor(space),
      recentTabTitles: tabs.map((tab) => tab.title).filter(Boolean),
    };
  }

  const ego: ChromiumEgo = {
    // backendNodeIds repeat across renderers, so subtree roots name their frame.
    acceptsSnapshotRootFrameId: true,
    onCDPMessage: undefined,
    onSendCDPMessageError: undefined,

    async listProfiles(...args: unknown[]) {
      if (args.length > 0)
        throw invalidArgument("listProfiles takes no arguments");
      return {
        profiles: [{ id: "Default", name: "Default", isDefault: true }],
      };
    },

    async listTaskSpaces(...args: unknown[]) {
      if (args.length > 0) {
        throw invalidArgument("listTaskSpaces takes no arguments");
      }
      await syncUi();
      const spaces = readState().spaces;
      return { taskSpaces: await Promise.all(spaces.map(describe)) };
    },

    async createTaskSpace(
      name: unknown,
      profileId?: unknown,
      ...rest: unknown[]
    ) {
      if (typeof name !== "string" || name.length === 0 || rest.length > 0) {
        throw invalidArgument("createTaskSpace requires a non-empty name");
      }
      if (profileId !== undefined && typeof profileId !== "string") {
        throw invalidArgument("createTaskSpace profileId must be a string");
      }
      if (profileId && !["default", "Default"].includes(profileId as string)) {
        return egoError("Profile not found", "EGO_PROFILE_NOT_FOUND");
      }
      // Each space opens in its own window with one default tab, like Ego Lite.
      const { targetId } = await (
        await hostCdp()
      ).send("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
        ...SPACE_WINDOW_SIZE,
      });
      const windowId = await windowOf(targetId);
      const state = readState();
      const space: StoredSpace = {
        id: state.nextId++,
        name,
        createdBy: "agent",
        ownership: "agent",
        targets: [targetId],
        activeTargetId: targetId,
        windowId,
      };
      state.spaces.push(space);
      writeState(state);
      await syncUi();
      return { ...spaceDescriptor(space), recentTabTitles: [] };
    },

    async claimTaskSpace(id: unknown, name?: unknown, ...rest: unknown[]) {
      if (typeof id !== "number" || rest.length > 0) {
        throw invalidArgument("claimTaskSpace requires a numeric id");
      }
      if (name !== undefined && typeof name !== "string") {
        throw invalidArgument("claimTaskSpace name must be a string");
      }
      const space = updateSpace(id, (stored) => {
        stored.ownership = "agent";
        stored.createdBy = "agent";
        if (name) stored.name = name as string;
      });
      if (!space) {
        return egoError(
          `Task space not found: ${id}`,
          "EGO_TASK_SPACE_NOT_FOUND",
        );
      }
      await syncUi();
      return spaceDescriptor(space);
    },

    useTaskSpace(id: unknown, ...rest: unknown[]) {
      if (typeof id !== "number" || rest.length > 0) {
        throw invalidArgument("useTaskSpace requires a numeric id");
      }
      selectedId = id;
      return id;
    },

    async createTab(url: unknown, ...rest: unknown[]) {
      if (typeof url !== "string" || rest.length > 0) {
        throw invalidArgument("createTab requires a url string");
      }
      await syncUi();
      const space = selectedSpace();
      if ("error" in space) return space;
      const cdp = await hostCdp();
      const firstTab = (await liveSpaceTabs(space)).length === 0;
      // Activating a tab of the space first makes Chrome open the new tab in its window.
      if (!firstTab && space.activeTargetId) {
        await cdp
          .send("Target.activateTarget", { targetId: space.activeTargetId })
          .catch(() => {});
      }
      const { targetId } = await cdp.send("Target.createTarget", {
        url,
        ...(firstTab ? { newWindow: true, ...SPACE_WINDOW_SIZE } : {}),
      });
      const windowId = firstTab ? await windowOf(targetId) : space.windowId;
      const stored = updateSpace(space.id, (item) => {
        item.targets.push(targetId);
        item.activeTargetId = targetId;
        item.windowId = windowId;
      })!;
      await syncUi();
      return {
        targetId,
        url,
        title: "",
        index: stored.targets.length - 1,
        active: true,
      };
    },

    async listTabs(...args: unknown[]) {
      if (args.length > 0) throw invalidArgument("listTabs takes no arguments");
      await syncUi();
      const space = selectedSpace();
      if ("error" in space) return space;
      const tabs = await liveSpaceTabs(space);
      const activeId = readState().spaces.find(
        (item) => item.id === space.id,
      )?.activeTargetId;
      return {
        tabs: tabs.map((tab, index) => ({
          index,
          targetId: tab.targetId,
          url: tab.url,
          title: tab.title,
          active: tab.targetId === activeId,
        })),
      };
    },

    async snapshot(options: SnapshotOptions = {}) {
      await syncUi();
      const space = selectedSpace();
      if ("error" in space) throw rejectedEgoError(space);
      const tabs = await liveSpaceTabs(space);
      const activeId = readState().spaces.find(
        (item) => item.id === space.id,
      )?.activeTargetId;
      const tab =
        tabs.find((item) => item.targetId === activeId) ?? tabs.at(-1);
      if (!tab) {
        throw rejectedEgoError(
          egoError("Task space has no tab", "EGO_WEB_CONTENTS_UNAVAILABLE"),
        );
      }
      try {
        return await captureSnapshot(await hostCdp(), tab.targetId, options);
      } catch (error) {
        throw rejectedEgoError(
          egoError(String(error?.message || error), "EGO_SNAPSHOT_FAILED"),
        );
      }
    },

    async closeTaskSpace(...args: unknown[]) {
      if (args.length > 0)
        throw invalidArgument("closeTaskSpace takes no arguments");
      await syncUi();
      const space = selectedSpace();
      if ("error" in space) return space;
      const tabs = await liveSpaceTabs(space);
      const cdp = await hostCdp();
      await Promise.all(
        tabs.map((tab) =>
          cdp.send("Target.closeTarget", { targetId: tab.targetId }),
        ),
      );
      const state = readState();
      state.spaces = state.spaces.filter((item) => item.id !== space.id);
      writeState(state);
      await syncUi();
      return `${space.id} task space closed.`;
    },

    async completeTaskSpace(...args: unknown[]) {
      if (args.length > 0) {
        throw invalidArgument("completeTaskSpace takes no arguments");
      }
      await syncUi();
      const space = selectedSpace();
      if ("error" in space) return space;
      updateSpace(space.id, (item) => {
        item.ownership = "user";
        delete item.state;
      });
      await syncUi();
      return `${space.id} task space completed.`;
    },

    async handOffTaskSpace(...args: unknown[]) {
      if (args.length > 0) {
        throw invalidArgument("handOffTaskSpace takes no arguments");
      }
      await syncUi();
      const space = selectedSpace({ allowDelegated: true });
      if ("error" in space) return space;
      updateSpace(space.id, (item) => {
        item.ownership = "agentDelegatedToUser";
      });
      if (space.activeTargetId) {
        const cdp = await hostCdp();
        await cdp
          .send("Target.activateTarget", { targetId: space.activeTargetId })
          .catch(() => {});
      }
      await syncUi();
      // Wayland does not let Chrome raise its own window; the notification can.
      await (
        await extensionHost()
      ).call("notifyHandOff", { name: space.name, windowId: space.windowId });
      return `${space.id} has been handed off to the user.`;
    },

    async takeOverTaskSpace(...args: unknown[]) {
      if (args.length > 0) {
        throw invalidArgument("takeOverTaskSpace takes no arguments");
      }
      await syncUi();
      const space = selectedSpace({ allowDelegated: true });
      if ("error" in space) return space;
      updateSpace(space.id, (item) => {
        item.ownership = "agent";
      });
      await syncUi();
      return `${space.id} has been taken over by the agent.`;
    },

    async setAgentTaskState(state: unknown, ...rest: unknown[]) {
      if (typeof state !== "string" || rest.length > 0) {
        throw invalidArgument("setAgentTaskState requires a state string");
      }
      await syncUi();
      const space = selectedSpace();
      if ("error" in space) return space;
      updateSpace(space.id, (item) => {
        item.state = state;
      });
      await syncUi();
      return `${space.id} state updated.`;
    },

    async animationHighlightMouseToPosition(
      x: unknown,
      y: unknown,
      ...rest: unknown[]
    ) {
      if (typeof x !== "number" || typeof y !== "number" || rest.length > 0) {
        throw invalidArgument(
          "animationHighlightMouseToPosition requires numeric x and y",
        );
      }
      const space = selectedSpace();
      if ("error" in space) return space;
      await (await extensionHost()).call("highlight", space.windowId, x, y);
      return `${space.id} mouse highlight shown.`;
    },

    sendCDPMessage(message: unknown, ...rest: unknown[]) {
      if (typeof message !== "string" || rest.length > 0) {
        throw invalidArgument("sendCDPMessage requires a JSON string");
      }
      const space = selectedSpace();
      if ("error" in space) {
        setImmediate(() =>
          ego.onSendCDPMessageError?.(space.error, space.error_code),
        );
        return undefined;
      }
      const parsed = JSON.parse(message);
      if (
        parsed.method === "Target.activateTarget" &&
        typeof parsed.params?.targetId === "string"
      ) {
        updateSpace(space.id, (item) => {
          item.activeTargetId = parsed.params.targetId;
        });
      }
      channel ??= resolveBrowserUrl().then((url) =>
        openRawChannel(url, (data) => {
          if (pendingShots.size > 0) revealAfterShot(data);
          ego.onCDPMessage?.(data);
        }),
      );
      const socketReady = channel;
      const hideForShot =
        parsed.method === "Page.captureScreenshot" &&
        space.windowId !== undefined;
      enqueue(async () => {
        try {
          const socket = await socketReady;
          if (hideForShot) {
            pendingShots.set(parsed.id, space.windowId!);
            await setOverlayHidden(space.windowId!, true);
          }
          socket.send(message);
        } catch (error) {
          ego.onSendCDPMessageError?.(
            String(error?.message || error),
            "EGO_CDP_CHANNEL_UNAVAILABLE",
          );
        }
      });
      return undefined;
    },

    close() {
      void host?.then(
        (connection) => connection.close(),
        () => {},
      );
      void channel?.then(
        (socket) => socket.close(),
        () => {},
      );
    },
  };
  return ego;
}

function spaceDescriptor(space: StoredSpace) {
  return {
    taskId: space.name,
    id: space.id,
    name: space.name,
    createdBy: space.createdBy,
    ownership: space.ownership,
    profileId: "Default",
    profileName: "Default",
  };
}

function egoError(error: string, code: string): EgoErrorResult {
  return { error, error_code: code };
}

function rejectedEgoError(result: EgoErrorResult) {
  return Object.assign(new Error(result.error), {
    error_code: result.error_code,
  });
}

function invalidArgument(message: string) {
  return Object.assign(new TypeError(message), {
    error_code: "EGO_INVALID_ARGUMENT",
  });
}

type ExtensionHost = {
  call(name: string, ...args: unknown[]): Promise<any>;
};

/** Load the task-space UI extension if needed and connect to its worker. */
async function attachExtension(
  cdp: Pick<HostConnection, "send">,
): Promise<ExtensionHost> {
  if (!existsSync(join(EXTENSION_DIR, "manifest.json"))) {
    throw new Error(`ego-browser extension not found at ${EXTENSION_DIR}`);
  }
  const files = readdirSync(EXTENSION_DIR).sort();
  const hash = createHash("sha256");
  for (const file of files)
    hash.update(file).update(readFileSync(join(EXTENSION_DIR, file)));
  const build = hash.digest("hex");
  const { name } = JSON.parse(
    readFileSync(join(EXTENSION_DIR, "manifest.json"), "utf8"),
  );

  const findWorker = async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    return (targetInfos as TargetInfo[]).find(
      (target) =>
        target.type === "service_worker" &&
        target.url.startsWith("chrome-extension://") &&
        target.url.endsWith(EXTENSION_WORKER),
    );
  };
  const deadline = Date.now() + EXTENSION_READY_TIMEOUT_MS;
  const waitUntil = async <T>(probe: () => Promise<T>, what: string) => {
    while (true) {
      const value = await probe();
      if (value) return value;
      if (Date.now() >= deadline) {
        throw new Error(`ego-browser extension: ${what} timed out`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const connect = async (worker: TargetInfo) => {
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId: worker.targetId,
      flatten: true,
    });
    const evaluate = async (expression: string) => {
      const { result, exceptionDetails } = await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (exceptionDetails) {
        throw new Error(
          `ego-browser extension: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
        );
      }
      return result.value;
    };
    await waitUntil(
      async () =>
        (await evaluate("typeof egoHost").catch(() => undefined)) === "object",
      "worker initialization",
    );
    return evaluate;
  };
  const installedBuild = `chrome.storage.local.get("build").then((r) => r.build)`;

  const existing = await findWorker();
  let evaluate = existing ? await connect(existing) : undefined;
  if (!evaluate || (await evaluate(installedBuild)) !== build) {
    // Replace any older, disabled, or other-checkout copy: Chrome neither
    // restarts a lost worker on load nor reloads changed files by itself.
    const installed = await cdp
      .send("Extensions.getExtensions")
      .catch(() => ({ extensions: [] }));
    for (const stale of installed.extensions as Array<{
      id: string;
      name: string;
    }>) {
      if (stale.name === name) {
        await cdp.send("Extensions.uninstall", { id: stale.id });
      }
    }
    await cdp
      .send("Extensions.loadUnpacked", { path: EXTENSION_DIR })
      .catch((error) => {
        throw new Error(
          `Could not load the ego-browser extension (${error.message}). Quit the ego-browser Chrome so the next call restarts it with extension debugging enabled.`,
        );
      });
    evaluate = await connect(await waitUntil(findWorker, "worker startup"));
    await evaluate(
      `chrome.storage.local.set({ build: ${JSON.stringify(build)} })`,
    );
  }
  return {
    call: (method, ...args) =>
      evaluate(`egoHost.${method}(...${JSON.stringify(args)})`),
  };
}

function findChrome(env: NodeJS.ProcessEnv): string {
  if (env.EGO_BROWSER_CHROME) return env.EGO_BROWSER_CHROME;
  const dirs = (env.PATH || "").split(delimiter).filter(Boolean);
  for (const name of CHROME_CANDIDATES) {
    for (const dir of dirs) {
      if (existsSync(join(dir, name))) return join(dir, name);
    }
  }
  throw new Error(
    `No Chrome or Chromium found on PATH (looked for ${CHROME_CANDIDATES.join(", ")}). Install one or set EGO_BROWSER_CHROME.`,
  );
}

async function connectOrLaunchChrome(
  env: NodeJS.ProcessEnv,
  profileDir: string,
): Promise<string> {
  const portFile = join(profileDir, "DevToolsActivePort");
  const existing = readDevToolsUrl(portFile);
  if (existing && (await isReachable(existing))) return existing;

  const chrome = findChrome(env);
  mkdirSync(profileDir, { recursive: true });
  rmSync(portFile, { force: true });
  const child = spawn(
    chrome,
    [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      // Lets the host install the task-space UI extension over CDP.
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { detached: true, stdio: "ignore" },
  );
  let launchError: Error | undefined;
  child.once("error", (error) => {
    launchError = error;
  });
  child.unref();

  const deadline = Date.now() + CHROME_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (launchError) {
      throw new Error(`Could not start ${chrome}: ${launchError.message}`);
    }
    const url = readDevToolsUrl(portFile);
    if (url && (await isReachable(url))) return url;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `${chrome} did not open its DevTools endpoint within ${CHROME_START_TIMEOUT_MS / 1000}s (profile ${profileDir})`,
  );
}

function readDevToolsUrl(portFile: string): string | undefined {
  if (!existsSync(portFile)) return undefined;
  const [port, path] = readFileSync(portFile, "utf8").split("\n");
  if (!port?.trim() || !path?.trim()) return undefined;
  return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
}

async function isReachable(url: string): Promise<boolean> {
  try {
    const socket = await openSocket(url);
    socket.close();
    return true;
  } catch {
    return false;
  }
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`Could not connect to Chrome DevTools at ${url}`)),
      { once: true },
    );
  });
}

async function openRawChannel(
  url: string,
  onMessage: (data: string) => void,
): Promise<WebSocket> {
  const socket = await openSocket(url);
  socket.addEventListener("message", (event) => onMessage(String(event.data)));
  return socket;
}

class HostConnection {
  #socket: WebSocket;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();

  static async open(url: string) {
    return new HostConnection(await openSocket(url));
  }

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(`${message.error.message} (${message.error.code})`),
        );
      } else {
        pending.resolve(message.result);
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("Chrome DevTools connection closed"));
      }
      this.#pending.clear();
    });
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ) {
    const id = this.#nextId++;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, HOST_RESPONSE_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }

  close() {
    this.#socket.close();
  }
}

// JSON-quoted names escape NUL, so this marker never collides with page text.
const REF_MARK = "\u0000";
const REF_PATTERN = /\u0000(\d+)\u0000/g;

type SnapshotPiece = string | { text: string };

export type FrameTree = {
  nodes: AxNode[];
  frameId?: string;
  children: Map<number, FrameTree>;
};

export async function captureSnapshot(
  cdp: Pick<HostConnection, "send">,
  targetId: string,
  options: SnapshotOptions = {},
) {
  const sessions: string[] = [];
  const attach = async (target: string) => {
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId: target,
      flatten: true,
    });
    sessions.push(sessionId);
    return sessionId;
  };
  try {
    const pageSession = await attach(targetId);
    const frame = await loadFrameTree(cdp, pageSession, undefined, attach);
    const visible =
      options.scope === "only_within_viewport"
        ? await viewportBackendNodeIds(cdp, pageSession)
        : undefined;
    return renderAxTree(frame, { ...options, visible });
  } finally {
    await Promise.all(
      sessions.map((sessionId) =>
        cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {}),
      ),
    );
  }
}

/** Read one frame's AX tree and, recursively, the trees of its iframes. */
async function loadFrameTree(
  cdp: Pick<HostConnection, "send">,
  sessionId: string,
  frameId: string | undefined,
  attach: (targetId: string) => Promise<string>,
  { ownSession = false } = {},
): Promise<FrameTree> {
  const { nodes } = await cdp.send(
    "Accessibility.getFullAXTree",
    frameId && !ownSession ? { frameId } : {},
    sessionId,
  );
  const tree: FrameTree = { nodes, frameId, children: new Map() };
  for (const node of nodes as AxNode[]) {
    const backendNodeId = node.backendDOMNodeId;
    if (node.ignored || node.role?.value !== "Iframe" || !backendNodeId) {
      continue;
    }
    const owner = await cdp
      .send("DOM.describeNode", { backendNodeId }, sessionId)
      .catch(() => undefined);
    const childFrameId: string | undefined = owner?.node?.frameId;
    if (!childFrameId) continue;
    // Same-process frames share the parent session; an OOPIF is its own target.
    const child = await loadFrameTree(cdp, sessionId, childFrameId, attach)
      .then((loaded) => (loaded.nodes.length > 0 ? loaded : undefined))
      .catch(() => undefined)
      .then(
        async (loaded) =>
          loaded ??
          loadFrameTree(cdp, await attach(childFrameId), childFrameId, attach, {
            ownSession: true,
          }),
      )
      .catch(() => undefined);
    if (child) tree.children.set(backendNodeId, child);
  }
  return tree;
}

async function viewportBackendNodeIds(
  cdp: Pick<HostConnection, "send">,
  sessionId: string,
): Promise<Set<number>> {
  const [{ documents }, { cssVisualViewport: viewport }] = await Promise.all([
    cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: [] }, sessionId),
    cdp.send("Page.getLayoutMetrics", {}, sessionId),
  ]);
  const document = documents[0];
  const left = viewport.pageX;
  const top = viewport.pageY;
  const right = left + viewport.clientWidth;
  const bottom = top + viewport.clientHeight;
  const ids = new Set<number>();
  document.layout.nodeIndex.forEach((nodeIndex: number, index: number) => {
    const [x, y, width, height] = document.layout.bounds[index];
    if (
      width > 0 &&
      height > 0 &&
      x < right &&
      x + width > left &&
      y < bottom &&
      y + height > top
    ) {
      ids.add(document.nodes.backendNodeId[nodeIndex]);
    }
  });
  return ids;
}

// ponytail: frame contents are kept whenever their iframe is visible; clip
// them against the viewport too if large embedded documents bloat snapshots.
export function renderAxTree(
  frame: FrameTree,
  options: SnapshotOptions & { visible?: Set<number> } = {},
) {
  const roleOf = (node: AxNode) => {
    const role = node.role?.value ?? "";
    return ROLE_NAMES[role] ?? role.toLowerCase();
  };
  const nameOf = (node: AxNode) => (node.name?.value ?? "").trim();
  const urlOf = (node: AxNode) => {
    const url = node.properties?.find((property) => property.name === "url")
      ?.value?.value;
    return typeof url === "string" && url ? url : undefined;
  };
  // Links are located by href (path or absolute URL), everything else by role and name.
  const locatorOf = (node: AxNode) => {
    const url = roleOf(node) === "link" ? urlOf(node) : undefined;
    if (url) {
      try {
        const parsed = new URL(url);
        return `href:${parsed.pathname}${parsed.search}${parsed.hash}`;
      } catch {
        return `href:${url}`;
      }
    }
    const name = nameOf(node);
    return name
      ? `role:${roleOf(node)}[name=${JSON.stringify(name)}]`
      : undefined;
  };

  const frames: FrameTree[] = [];
  const collect = (tree: FrameTree) => {
    frames.push(tree);
    for (const child of tree.children.values()) collect(child);
  };
  collect(frame);
  // Counted across frames: a locator is only advertised when it is unique on the page.
  const locatorCounts = new Map<string, number>();
  for (const tree of frames) {
    for (const node of tree.nodes) {
      const locator = node.ignored ? undefined : locatorOf(node);
      if (locator) {
        locatorCounts.set(locator, (locatorCounts.get(locator) ?? 0) + 1);
      }
    }
  }

  const refs: Array<Record<string, unknown>> = [];
  const refsByTemporaryId = new Map<number, number>();
  let nextRefId = 1;
  const renderFrame = (
    tree: FrameTree,
    root: AxNode,
    depth: number,
    visible: Set<number> | undefined,
  ): string[] => {
    const byId = new Map(tree.nodes.map((node) => [node.nodeId, node]));
    // Pages often split one sentence across many text nodes (one per word or
    // even per character), so text stays raw until its rendered parent joins
    // adjacent runs into a single line.
    const toLines = (
      pieces: SnapshotPiece[],
      depth: number,
      parentName: string,
    ): string[] => {
      const lines: string[] = [];
      let run = "";
      const flush = () => {
        const text = run.replace(/\s+/g, " ").trim();
        run = "";
        if (text && text !== parentName) {
          lines.push(`${"  ".repeat(depth)}text ${JSON.stringify(text)}`);
        }
      };
      for (const piece of pieces) {
        if (typeof piece === "string") {
          flush();
          lines.push(piece);
        } else {
          run += piece.text;
        }
      }
      flush();
      return lines;
    };
    const render = (
      node: AxNode | undefined,
      depth: number,
    ): SnapshotPiece[] => {
      if (!node || HIDDEN_ROLES.has(node.role?.value ?? "")) return [];
      const role = roleOf(node);
      const name = nameOf(node);
      const backendNodeId = node.backendDOMNodeId;
      const childPieces = (childDepth: number) =>
        (node.childIds ?? []).flatMap((child) =>
          render(byId.get(child), childDepth),
        );
      if (node.ignored) return childPieces(depth);
      if (role === "text") {
        const raw = String(node.name?.value ?? "");
        const offscreen =
          visible &&
          raw.trim() !== "" &&
          !(backendNodeId !== undefined && visible.has(backendNodeId));
        return offscreen ? [] : [{ text: raw }];
      }

      const childFrame =
        backendNodeId === undefined
          ? undefined
          : tree.children.get(backendNodeId);
      const children = toLines(childPieces(depth + 1), depth + 1, name);
      if (
        role !== "root" &&
        visible &&
        children.length === 0 &&
        !(backendNodeId !== undefined && visible.has(backendNodeId))
      ) {
        return [];
      }
      if (childFrame?.nodes[0]) {
        children.push(
          ...renderFrame(childFrame, childFrame.nodes[0], depth + 1, undefined),
        );
      }

      const focusable = node.properties?.some(
        (property) => property.name === "focusable" && property.value?.value,
      );
      const actionable =
        backendNodeId !== undefined &&
        role !== "root" &&
        (INTERACTIVE_ROLES.has(role) || focusable);
      const metadata: string[] = [];
      if (actionable) {
        const refId = nextRefId++;
        refsByTemporaryId.set(refId, refs.length);
        const ref: Record<string, unknown> = {
          refId,
          backendNodeId,
          role,
          name,
          ...(tree.frameId ? { frameId: tree.frameId } : {}),
        };
        metadata.push(`ref=${REF_MARK}${refId}${REF_MARK}`);
        const locator = locatorOf(node);
        if (
          options.includeStableLocator &&
          locator &&
          locatorCounts.get(locator) === 1
        ) {
          ref.loc = locator;
          metadata.push(`loc=${locator}`);
        }
        const url = role === "link" ? urlOf(node) : undefined;
        if (url) metadata.push(`url=${url}`);
        refs.push(ref);
      }
      if (options.interactiveOnly && !actionable && role !== "root") {
        return children;
      }
      const line =
        "  ".repeat(depth) +
        role +
        (name ? ` ${JSON.stringify(name)}` : "") +
        (metadata.length ? ` [${metadata.join(", ")}]` : "");
      return [line, ...children];
    };
    return toLines(render(root, depth), depth, "");
  };

  let start: { tree: FrameTree; node: AxNode } | undefined;
  if (options.scope === "subtree") {
    const matches = frames
      .filter(
        (tree) =>
          options.rootFrameId === undefined ||
          (tree.frameId ?? "") === options.rootFrameId,
      )
      .flatMap((tree) =>
        tree.nodes
          .filter((node) => node.backendDOMNodeId === options.root)
          .map((node) => ({ tree, node })),
      );
    if (matches.length > 1) {
      throw new Error(
        `Snapshot root ${options.root} is ambiguous across frames`,
      );
    }
    start = matches[0];
    if (!start) throw new Error(`Snapshot root not found: ${options.root}`);
  } else if (frame.nodes[0]) {
    start = { tree: frame, node: frame.nodes[0] };
  } else {
    throw new Error("Page has no accessibility tree");
  }
  const visible = start.tree === frame ? options.visible : undefined;
  // Children render before their parent line, so number refs in document order.
  let printed = 0;
  let content = renderFrame(start.tree, start.node, 0, visible)
    .join("\n")
    .replace(REF_PATTERN, (_, temporaryId) => {
      const refId = ++printed;
      refs[refsByTemporaryId.get(Number(temporaryId))!].refId = refId;
      return String(refId);
    });
  refs.sort((a, b) => (a.refId as number) - (b.refId as number));
  if (options.maxResultLength && options.maxResultLength > 0) {
    content = content.slice(0, options.maxResultLength);
  }
  return { content, refs };
}
