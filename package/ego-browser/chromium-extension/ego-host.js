// Browser-side UI for task spaces driven by src/chromium-host.ts. The host
// calls `egoHost.*` through CDP; user choices are queued in storage until the
// host's next call collects them.

const RETURN_MENU = "ego-return-control";
const TAKEOVER_MENU = "ego-take-over";
const HIGHLIGHT_HOLD_MS = 250;
const HIGHLIGHT_FADE_MS = 350;

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
    const [tab] = await chrome.tabs.query({ windowId, active: true });
    if (!tab) return;
    await chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        args: [x, y, HIGHLIGHT_HOLD_MS, HIGHLIGHT_FADE_MS],
        func: (left, top, hold, fade) => {
          const dot = document.createElement("div");
          dot.style.cssText =
            `position:fixed;left:${left - 12}px;top:${top - 12}px;width:24px;height:24px;` +
            "border-radius:50%;background:rgba(37,99,235,.35);border:2px solid #2563eb;" +
            `pointer-events:none;z-index:2147483647;transition:transform ${fade}ms,opacity ${fade}ms;`;
          document.documentElement.append(dot);
          setTimeout(() => {
            dot.style.transform = "scale(1.6)";
            dot.style.opacity = "0";
          }, hold);
          setTimeout(() => dot.remove(), hold + fade);
        },
      })
      .catch(() => {});
  },
};
