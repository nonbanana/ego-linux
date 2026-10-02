// Browser-side UI for task spaces driven by src/chromium-host.ts. The host
// calls `egoHost.*` through CDP; user choices are queued in storage until the
// host's next call collects them.

const RETURN_MENU = "ego-return-control";
const TAKEOVER_MENU = "ego-take-over";

// Events reset the service worker idle timer, so the host can always reach it.
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: RETURN_MENU,
      title: "Return control to the agent",
      contexts: ["page", "frame", "selection", "link", "editable", "image"],
    });
    chrome.contextMenus.create({
      id: TAKEOVER_MENU,
      title: "Take over from the agent",
      contexts: ["page", "frame", "selection", "link", "editable", "image"],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const space = await spaceForWindow(tab?.windowId);
  if (!space) return;
  if (
    info.menuItemId === RETURN_MENU &&
    space.ownership === "agentDelegatedToUser"
  ) {
    await queueAction(space, "return", "agent");
  } else if (info.menuItemId === TAKEOVER_MENU && space.ownership === "agent") {
    await queueAction(space, "takeover", "agentDelegatedToUser");
  }
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const windowId = Number(notificationId.split(":")[1]);
  if (Number.isInteger(windowId)) {
    await chrome.windows.update(windowId, { focused: true }).catch(() => {});
  }
  chrome.notifications.clear(notificationId);
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "ego-overlay-hello") return undefined;
  overlayState(sender.tab?.windowId).then(respond);
  return true;
});

async function overlayState(windowId) {
  const space = await spaceForWindow(windowId);
  if (!space) return { ownership: undefined };
  const { cursors = {} } = await chrome.storage.session.get("cursors");
  return {
    ownership: space.ownership,
    state: space.state,
    cursor: cursors[windowId],
  };
}

async function pushOverlay(tabId, state) {
  const message = { type: "ego-overlay", state };
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Tabs that loaded before the extension have no content script yet.
    await chrome.scripting
      .executeScript({ target: { tabId }, files: ["overlay.js"] })
      .catch(() => {});
    return chrome.tabs.sendMessage(tabId, message).catch(() => false);
  }
}

async function pushWindow(windowId, state) {
  if (!Number.isInteger(windowId)) return;
  const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
  await Promise.all(tabs.map((tab) => pushOverlay(tab.id, state)));
}

async function spaceForWindow(windowId) {
  const { spaces = [] } = await chrome.storage.local.get("spaces");
  return spaces.find((space) => space.windowId === windowId);
}

async function queueAction(space, action, ownership) {
  const { actions = [], spaces = [] } = await chrome.storage.local.get([
    "actions",
    "spaces",
  ]);
  actions.push({ spaceId: space.id, action });
  const updated = spaces.map((item) =>
    item.id === space.id ? { ...item, ownership } : item,
  );
  await chrome.storage.local.set({ actions, spaces: updated });
  await renderSpace({ ...space, ownership });
  await pushWindow(space.windowId, { ownership });
}

function groupStyle(space) {
  // Chrome truncates group chips after a few words, so lead with what changes.
  if (space.ownership === "agent") {
    return { title: `🤖 ${space.state || space.name}`, color: "blue" };
  }
  if (space.ownership === "agentDelegatedToUser") {
    return { title: `👤 Your turn · ${space.name}`, color: "orange" };
  }
  return { title: space.name, color: "grey" };
}

async function renderSpace(space) {
  if (!Number.isInteger(space.windowId)) return;
  const tabs = await chrome.tabs
    .query({ windowId: space.windowId })
    .catch(() => []);
  if (tabs.length === 0) return;
  const [existing] = await chrome.tabGroups.query({ windowId: space.windowId });
  const groupId = await chrome.tabs.group({
    tabIds: tabs.map((tab) => tab.id),
    ...(existing
      ? { groupId: existing.id }
      : { createProperties: { windowId: space.windowId } }),
  });
  await chrome.tabGroups.update(groupId, {
    ...groupStyle(space),
    collapsed: false,
  });
}

globalThis.egoHost = {
  /** Return and clear the take-over/return choices the user made. */
  async takeUserActions() {
    const { actions = [] } = await chrome.storage.local.get("actions");
    await chrome.storage.local.set({ actions: [] });
    return actions;
  },

  async render(spaces) {
    await chrome.storage.local.set({ spaces });
    await Promise.all(
      spaces.map((space) => renderSpace(space).catch(() => {})),
    );
    // Not awaited: page overlays catch up on their own and must not slow
    // every host call down by a paint.
    for (const space of spaces) {
      void pushWindow(space.windowId, {
        ownership: space.ownership,
        state: space.state,
      });
    }
  },

  /** Hide or restore the overlay in a window; resolves once it is painted. */
  async setOverlayHidden(windowId, hidden) {
    await pushWindow(windowId, { hidden });
  },

  async notifyHandOff(space) {
    const id = `handoff:${space.windowId}`;
    // Reusing an id only updates the old notification without showing it again.
    await chrome.notifications.clear(id);
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icon.png",
      title: `The agent needs you: ${space.name}`,
      message:
        "When you are done, right-click the page and choose “Return control to the agent”.",
      requireInteraction: true,
    });
  },

  async highlight(windowId, x, y) {
    const { cursors = {} } = await chrome.storage.session.get("cursors");
    cursors[windowId] = { x, y, at: Date.now() };
    await chrome.storage.session.set({ cursors });
    const [tab] = await chrome.tabs.query({ windowId, active: true });
    if (tab) void pushOverlay(tab.id, { cursor: cursors[windowId] });
  },
};
