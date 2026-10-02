import test from "node:test";
import assert from "node:assert/strict";

import {
  beginLinuxClipboardTransaction,
  ClipboardRestoreError,
  withTemporaryClipboardContent,
  withTemporaryClipboardText,
} from "../dist/src/clipboard.js";

test("temporary clipboard text is restored after the action", async () => {
  const events = [];
  const value = await withTemporaryClipboardText(
    "temporary",
    async () => {
      events.push("action");
      return 42;
    },
    {
      async beginTransaction(text) {
        events.push(["begin", text]);
        return {
          async finish() {
            events.push("finish");
            return "restored";
          },
        };
      },
    },
  );

  assert.equal(value, 42);
  assert.deepEqual(events, [["begin", "temporary"], "action", "finish"]);
});

test("temporary clipboard content keeps text and HTML representations together", async () => {
  const content = {
    text: "A\tB",
    html: "<table><tr><td>A</td><td>B</td></tr></table>",
  };
  let prepared;

  await withTemporaryClipboardContent(content, async () => {}, {
    async beginTransaction(value) {
      prepared = value;
      return {
        async finish() {
          return "restored";
        },
      };
    },
  });

  assert.deepEqual(prepared, content);
});

test("temporary clipboard text is restored when the action throws", async () => {
  let finished = false;
  const primary = new Error("paste input failed");

  await assert.rejects(
    () =>
      withTemporaryClipboardText(
        "temporary",
        async () => {
          throw primary;
        },
        {
          async beginTransaction() {
            return {
              async finish() {
                finished = true;
                return "restored";
              },
            };
          },
        },
      ),
    (error) => error === primary,
  );
  assert.equal(finished, true);
});

test("a restore failure reports that the paste action already completed", async () => {
  await assert.rejects(
    () =>
      withTemporaryClipboardText("temporary", async () => "done", {
        async beginTransaction() {
          return {
            async finish() {
              throw new Error("pasteboard unavailable");
            },
          };
        },
      }),
    (error) => {
      assert.ok(error instanceof ClipboardRestoreError);
      assert.equal(error.code, "EGO_CLIPBOARD_RESTORE_FAILED");
      assert.equal(error.pasteCompleted, true);
      assert.match(error.message, /paste completed.*do not retry/i);
      return true;
    },
  );
});

test("an external clipboard change is respected instead of restoring stale data", async () => {
  const value = await withTemporaryClipboardText("temporary", async () => 7, {
    async beginTransaction() {
      return {
        async finish() {
          return "changed";
        },
      };
    },
  });

  assert.equal(value, 7);
});

test("clipboard transactions are serialized within one runtime", async () => {
  const events = [];
  let releaseFirst;
  const firstHold = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const beginTransaction = async (text) => {
    events.push(`begin:${text}`);
    return {
      async finish() {
        events.push(`finish:${text}`);
        return "restored";
      },
    };
  };

  const first = withTemporaryClipboardText(
    "first",
    async () => {
      events.push("action:first");
      markFirstStarted();
      await firstHold;
    },
    { beginTransaction },
  );
  await firstStarted;
  const second = withTemporaryClipboardText(
    "second",
    async () => {
      events.push("action:second");
    },
    { beginTransaction },
  );
  await Promise.resolve();
  assert.deepEqual(events, ["begin:first", "action:first"]);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "begin:first",
    "action:first",
    "finish:first",
    "begin:second",
    "action:second",
    "finish:second",
  ]);
});

function fakeLinuxClipboard(initial) {
  let owner = initial;
  const calls = [];
  const run = async (command, args, input) => {
    calls.push([command, ...args]);
    const type = args[args.indexOf(command === "xclip" ? "-t" : "--type") + 1];
    if (args.includes("--list-types") || type === "TARGETS") {
      if (!owner) throw new Error("Nothing is copied");
      return Buffer.from(Object.keys(owner).join("\n") + "\n");
    }
    if (args.includes("--clear")) {
      owner = undefined;
      return Buffer.alloc(0);
    }
    if (input !== undefined) {
      owner = { [type]: Buffer.from(input) };
      return Buffer.alloc(0);
    }
    if (!owner?.[type]) throw new Error(`No suitable type: ${type}`);
    return owner[type];
  };
  return { run, calls, current: () => owner };
}

test("Linux paste restores the plain-text representation of the user's clipboard", async () => {
  const clipboard = fakeLinuxClipboard({
    "chromium/x-web-custom-data": Buffer.from("internal"),
    "text/html": Buffer.from("<b>user</b>"),
    "text/plain": Buffer.from("user"),
  });
  let pasted;

  await withTemporaryClipboardText(
    "temporary",
    async () => {
      pasted = clipboard.current()["text/plain"].toString();
    },
    {
      beginTransaction: (content) =>
        beginLinuxClipboardTransaction(content, {
          env: { WAYLAND_DISPLAY: "wayland-0" },
          run: clipboard.run,
        }),
    },
  );

  assert.equal(pasted, "temporary");
  assert.deepEqual(Object.keys(clipboard.current()), ["text/plain"]);
  assert.equal(clipboard.current()["text/plain"].toString(), "user");
});

test("Linux paste offers HTML content and clears an initially empty clipboard", async () => {
  const clipboard = fakeLinuxClipboard(undefined);
  const transaction = await beginLinuxClipboardTransaction(
    { text: "A", html: "<b>A</b>" },
    { env: { WAYLAND_DISPLAY: "wayland-0" }, run: clipboard.run },
  );

  assert.equal(clipboard.current()["text/html"].toString(), "<b>A</b>");
  assert.equal(await transaction.finish(), "restored");
  assert.equal(clipboard.current(), undefined);
});

test("Linux paste leaves a clipboard changed by another process alone", async () => {
  const clipboard = fakeLinuxClipboard({ UTF8_STRING: Buffer.from("user") });
  const run = clipboard.run;
  const transaction = await beginLinuxClipboardTransaction("temporary", {
    env: { DISPLAY: ":0" },
    run,
  });
  await run(
    "xclip",
    ["-selection", "clipboard", "-t", "UTF8_STRING", "-i"],
    "other",
  );

  assert.equal(await transaction.finish(), "changed");
  assert.equal(clipboard.current().UTF8_STRING.toString(), "other");
});

test("Linux paste fails loudly without a display", async () => {
  await assert.rejects(
    () =>
      beginLinuxClipboardTransaction("x", {
        env: {},
        run: async () => Buffer.alloc(0),
      }),
    /requires a Wayland or X11 display/,
  );
});
