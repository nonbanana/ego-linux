import { execFile, spawn } from "node:child_process";
import type { Writable } from "node:stream";

export type ClipboardTransactionStatus = "restored" | "changed";

export type ClipboardTransaction = {
  finish(): Promise<ClipboardTransactionStatus>;
};

export type ClipboardContent = {
  text: string;
  html?: string;
};

type ClipboardInput = string | ClipboardContent;

type ClipboardTransactionOptions = {
  beginTransaction?: (content: ClipboardInput) => Promise<ClipboardTransaction>;
};

type ClipboardHostMessage = {
  state: "ready" | "restored" | "changed" | "error";
  message?: string;
};

export class ClipboardRestoreError extends Error {
  readonly code = "EGO_CLIPBOARD_RESTORE_FAILED";
  readonly pasteCompleted = true;

  constructor(cause: unknown) {
    super(
      "The paste completed, but ego-browser could not restore the clipboard. Do not retry the paste.",
      { cause },
    );
    this.name = "ClipboardRestoreError";
  }
}

let transactionQueue: Promise<void> = Promise.resolve();

/**
 * Run one action while the system clipboard temporarily contains `text`.
 * Transactions are serialized within the process because the pasteboard is a
 * single user resource shared by every Page.
 */
export async function withTemporaryClipboardText<T>(
  text: ClipboardInput,
  action: () => Promise<T>,
  options: ClipboardTransactionOptions = {},
): Promise<T> {
  const content = validateClipboardInput(text);
  if (typeof action !== "function") {
    throw new TypeError("clipboard action must be a function");
  }

  let releaseQueue!: () => void;
  const previous = transactionQueue;
  transactionQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previous;

  try {
    const beginTransaction =
      options.beginTransaction ??
      (process.platform === "linux"
        ? beginLinuxClipboardTransaction
        : beginDarwinClipboardTransaction);
    const transaction = await beginTransaction(content);
    let value!: T;
    let actionError: unknown;
    try {
      value = await action();
    } catch (error) {
      actionError = error;
    }

    let restoreError: unknown;
    try {
      await transaction.finish();
    } catch (error) {
      restoreError = error;
    }

    if (actionError !== undefined) {
      if (restoreError !== undefined) {
        throw new AggregateError(
          [actionError, restoreError],
          "The paste action failed and ego-browser could not restore the clipboard.",
        );
      }
      throw actionError;
    }
    if (restoreError !== undefined) {
      throw new ClipboardRestoreError(restoreError);
    }
    return value;
  } finally {
    releaseQueue();
  }
}

/** Temporarily publish multiple representations of the same clipboard value. */
export async function withTemporaryClipboardContent<T>(
  content: ClipboardContent,
  action: () => Promise<T>,
  options: ClipboardTransactionOptions = {},
): Promise<T> {
  return withTemporaryClipboardText(content, action, options);
}

/**
 * Keep the original NSPasteboard items inside a short-lived JXA process. The
 * data never crosses stdout or enters the Node heap, and every readable format
 * is restored unless another process changes the clipboard first.
 */
async function beginDarwinClipboardTransaction(
  input: ClipboardInput,
): Promise<ClipboardTransaction> {
  if (process.platform !== "darwin") {
    throw new Error(
      "page.keyboard.paste currently requires macOS or Linux clipboard support",
    );
  }

  const child = spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", DARWIN_CLIPBOARD_HOST],
    { stdio: ["pipe", "pipe", "pipe", "pipe"] },
  );
  const messages = clipboardMessages(child.stdout);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 16_384) stderr += chunk;
  });
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  child.stdin.end(JSON.stringify(input), "utf8");
  const first = await nextHostMessage(messages, exit, () => stderr);
  if (first.state !== "ready") {
    throw new Error(first.message || "could not prepare the macOS clipboard");
  }

  let finished = false;
  return {
    async finish() {
      if (finished) throw new Error("clipboard transaction already finished");
      finished = true;
      const signalPipe = child.stdio[3] as Writable | null;
      if (!signalPipe) {
        throw new Error("clipboard restore pipe is unavailable");
      }
      signalPipe.end("1");
      const result = await nextHostMessage(messages, exit, () => stderr);
      const completion = await exit;
      if (completion.code !== 0) {
        throw clipboardHostExitError(completion, stderr);
      }
      if (result.state === "restored" || result.state === "changed") {
        return result.state;
      }
      throw new Error(
        result.message || "could not restore the macOS clipboard",
      );
    },
  };
}

type ClipboardCommandRunner = (
  command: string,
  args: string[],
  input?: string | Buffer,
) => Promise<Buffer>;

type LinuxClipboardOptions = {
  env?: NodeJS.ProcessEnv;
  run?: ClipboardCommandRunner;
};

const X11_META_TARGETS = new Set([
  "TARGETS",
  "TIMESTAMP",
  "MULTIPLE",
  "SAVE_TARGETS",
  "DELETE",
  "INCR",
]);
const PREFERRED_RESTORE_TYPES = [
  "text/plain;charset=utf-8",
  "UTF8_STRING",
  "text/plain",
];

/**
 * wl-copy and xclip offer a single MIME type, so only one representation of
 * the user's clipboard is restored and `{ text, html }` is offered as HTML.
 */
// ponytail: no cross-process lock like the macOS host; concurrent ego-browser
// processes can interleave pastes. Add a lock file if that shows up in practice.
export async function beginLinuxClipboardTransaction(
  input: ClipboardInput,
  { env = process.env, run = runClipboardCommand }: LinuxClipboardOptions = {},
): Promise<ClipboardTransaction> {
  const tool = linuxClipboardTool(env, run);
  const content = typeof input === "string" ? { text: input } : input;
  const temporary =
    content.html === undefined
      ? { type: tool.textType, data: Buffer.from(content.text) }
      : { type: "text/html", data: Buffer.from(content.html) };

  const types = await tool.list();
  const savedType =
    PREFERRED_RESTORE_TYPES.find((type) => types.includes(type)) ??
    types.find((type) => !X11_META_TARGETS.has(type));
  const saved =
    savedType === undefined
      ? undefined
      : { type: savedType, data: await tool.read(savedType) };

  await tool.write(temporary.type, temporary.data);
  // wl-copy and xclip take ownership in a forked child after the parent exits,
  // so a paste sent immediately can still read the previous clipboard.
  const deadline = Date.now() + 2000;
  while (
    !(await tool.read(temporary.type).catch(() => undefined))?.equals(
      temporary.data,
    )
  ) {
    if (Date.now() >= deadline) {
      throw new Error(
        `the clipboard did not take the temporary ${temporary.type} content`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  let finished = false;
  return {
    async finish() {
      if (finished) throw new Error("clipboard transaction already finished");
      finished = true;
      const current = await tool.read(temporary.type).catch(() => undefined);
      if (!current?.equals(temporary.data)) return "changed";
      if (saved) await tool.write(saved.type, saved.data);
      else await tool.clear();
      return "restored";
    },
  };
}

function linuxClipboardTool(
  env: NodeJS.ProcessEnv,
  run: ClipboardCommandRunner,
) {
  if (env.WAYLAND_DISPLAY) {
    return {
      textType: "text/plain",
      async list() {
        try {
          return splitLines(await run("wl-paste", ["--list-types"]));
        } catch (error) {
          if (/nothing is copied|no selection/i.test(String(error))) return [];
          throw error;
        }
      },
      read: (type: string) => run("wl-paste", ["--no-newline", "--type", type]),
      write: async (type: string, data: Buffer) => {
        await run("wl-copy", ["--type", type], data);
      },
      clear: async () => {
        await run("wl-copy", ["--clear"], "");
      },
    };
  }
  if (env.DISPLAY) {
    const selection = ["-selection", "clipboard"];
    const write = async (type: string, data: Buffer) => {
      await run("xclip", [...selection, "-t", type, "-i"], data);
    };
    return {
      textType: "UTF8_STRING",
      async list() {
        try {
          return splitLines(
            await run("xclip", [...selection, "-o", "-t", "TARGETS"]),
          );
        } catch (error) {
          if (/no owner for the CLIPBOARD selection/i.test(String(error))) {
            return [];
          }
          throw error;
        }
      },
      read: (type: string) => run("xclip", [...selection, "-o", "-t", type]),
      write,
      // xclip cannot release the selection; an empty string is the closest state.
      clear: () => write("UTF8_STRING", Buffer.alloc(0)),
    };
  }
  throw new Error(
    "page.keyboard.paste on Linux requires a Wayland or X11 display (WAYLAND_DISPLAY or DISPLAY)",
  );
}

function splitLines(output: Buffer): string[] {
  return output
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function runClipboardCommand(
  command: string,
  args: string[],
  input?: string | Buffer,
): Promise<Buffer> {
  if (input === undefined) {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);
          reject(
            clipboardCommandError(command, error, stderr.toString("utf8")),
          );
        },
      );
    });
  }
  // wl-copy and xclip fork a background owner that keeps inherited pipes
  // open, so the output streams must not be piped back to this process.
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", (error) =>
      reject(clipboardCommandError(command, error)),
    );
    // A failed spawn closes stdin early; the exit or error event reports it.
    child.stdin.on("error", () => {});
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(Buffer.alloc(0));
      else
        reject(
          new Error(
            `${command} exited ${signal ? `on ${signal}` : `with code ${code}`}`,
          ),
        );
    });
    child.stdin.end(input);
  });
}

function clipboardCommandError(
  command: string,
  error: Error & { code?: string | number | null },
  stderr = "",
) {
  if (error.code === "ENOENT") {
    return new Error(
      `${command} is not installed; page.keyboard.paste on Linux requires wl-clipboard (Wayland) or xclip (X11)`,
      { cause: error },
    );
  }
  return new Error(`${command} failed: ${stderr.trim() || error.message}`, {
    cause: error,
  });
}

function validateClipboardInput(input: ClipboardInput): ClipboardInput {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(
      "page.keyboard.paste requires a string or { text, html? }",
    );
  }
  const keys = Object.keys(input);
  const unknown = keys.find((key) => key !== "text" && key !== "html");
  if (unknown) {
    throw new TypeError(
      `page.keyboard.paste received unknown content field: ${unknown}`,
    );
  }
  if (typeof input.text !== "string") {
    throw new TypeError("page.keyboard.paste content.text must be a string");
  }
  if (input.html !== undefined && typeof input.html !== "string") {
    throw new TypeError("page.keyboard.paste content.html must be a string");
  }
  return input.html === undefined
    ? { text: input.text }
    : { text: input.text, html: input.html };
}

function clipboardMessages(stream: NodeJS.ReadableStream) {
  const queued: ClipboardHostMessage[] = [];
  const waiters: Array<{
    resolve: (message: ClipboardHostMessage) => void;
    reject: (error: unknown) => void;
  }> = [];
  let buffer = "";
  let ended = false;
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk) => {
    buffer += String(chunk);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: ClipboardHostMessage;
      try {
        message = JSON.parse(line);
      } catch (error) {
        rejectWaiter(new Error(`invalid clipboard host response: ${line}`));
        continue;
      }
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else queued.push(message);
    }
  });
  stream.on("error", rejectWaiter);
  stream.on("end", () => {
    ended = true;
    rejectWaiter(new Error("clipboard host closed without a response"));
  });

  function rejectWaiter(error: unknown) {
    const waiter = waiters.shift();
    if (waiter) waiter.reject(error);
  }

  return {
    next(): Promise<ClipboardHostMessage> {
      const message = queued.shift();
      if (message) return Promise.resolve(message);
      if (ended) {
        return Promise.reject(
          new Error("clipboard host closed without a response"),
        );
      }
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
  };
}

async function nextHostMessage(
  messages: ReturnType<typeof clipboardMessages>,
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  stderr: () => string,
): Promise<ClipboardHostMessage> {
  try {
    // Child `exit` may be emitted before its stdout pipe drains. Read the
    // protocol message first so a successful restore cannot race with exit.
    return await messages.next();
  } catch (error) {
    const completion = await exit;
    if (completion.code !== 0 || completion.signal) {
      throw clipboardHostExitError(completion, stderr());
    }
    throw error;
  }
}

function clipboardHostExitError(
  completion: { code: number | null; signal: NodeJS.Signals | null },
  stderr: string,
) {
  const detail = stderr.trim();
  return new Error(
    `clipboard host exited ${
      completion.signal
        ? `on ${completion.signal}`
        : `with code ${completion.code}`
    }${detail ? `: ${detail}` : ""}`,
  );
}

const DARWIN_CLIPBOARD_HOST = String.raw`
ObjC.import("AppKit");
ObjC.import("Foundation");

const pasteboard = $.NSPasteboard.generalPasteboard;
const transactionLock = $.NSDistributedLock.alloc.initWithPath(
  $(ObjC.unwrap($.NSTemporaryDirectory()) + "ego-browser-clipboard.lock")
);

function acquireTransactionLock() {
  const deadline = Date.now() + 5000;
  while (!transactionLock.tryLock) {
    const lockDate = transactionLock.lockDate;
    const lockAge = lockDate
      ? Date.now() - Number(lockDate.timeIntervalSince1970) * 1000
      : 0;
    if (lockAge > 30000) {
      transactionLock.breakLock;
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error("another ego-browser process is using the clipboard");
    }
    $.NSThread.sleepForTimeInterval(0.02);
  }
}

function emit(message) {
  const line = $(JSON.stringify(message) + "\n").dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(line);
}

function snapshotPasteboard() {
  const snapshot = [];
  const sourceItems = pasteboard.pasteboardItems;
  for (let itemIndex = 0; itemIndex < Number(sourceItems.count); itemIndex += 1) {
    const sourceItem = sourceItems.objectAtIndex(itemIndex);
    const values = [];
    const types = sourceItem.types;
    for (let typeIndex = 0; typeIndex < Number(types.count); typeIndex += 1) {
      const type = types.objectAtIndex(typeIndex);
      const data = sourceItem.dataForType(type);
      if (data) values.push({ type, data });
    }
    snapshot.push(values);
  }
  return snapshot;
}

function restorePasteboard(snapshot) {
  pasteboard.clearContents;
  if (snapshot.length === 0) return;
  const restoredItems = [];
  for (const values of snapshot) {
    const item = $.NSPasteboardItem.alloc.init;
    for (const value of values) item.setDataForType(value.data, value.type);
    restoredItems.push(item);
  }
  if (!pasteboard.writeObjects($(restoredItems))) {
    throw new Error("NSPasteboard rejected the saved clipboard items");
  }
}

const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const serialized = ObjC.unwrap(
  $.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)
);
const parsed = JSON.parse(serialized);
const content = typeof parsed === "string" ? { text: parsed } : parsed;
acquireTransactionLock();
const saved = snapshotPasteboard();

try {
  pasteboard.clearContents;
  if (!pasteboard.setStringForType($(content.text), $.NSPasteboardTypeString)) {
    throw new Error("NSPasteboard rejected the temporary text");
  }
  if (
    content.html !== undefined &&
    !pasteboard.setStringForType($(content.html), $.NSPasteboardTypeHTML)
  ) {
    throw new Error("NSPasteboard rejected the temporary HTML");
  }
} catch (error) {
  try { restorePasteboard(saved); } catch (_) {}
  emit({ state: "error", message: String(error.message || error) });
  transactionLock.unlock;
  throw error;
}

const temporaryChangeCount = Number(pasteboard.changeCount);
emit({ state: "ready" });

const restoreSignal = $.NSFileHandle.alloc.initWithFileDescriptorCloseOnDealloc(3, false);
restoreSignal.readDataOfLength(1);

try {
  try {
    if (Number(pasteboard.changeCount) !== temporaryChangeCount) {
      emit({ state: "changed" });
    } else {
      restorePasteboard(saved);
      emit({ state: "restored" });
    }
  } catch (error) {
    emit({ state: "error", message: String(error.message || error) });
    throw error;
  }
} finally {
  transactionLock.unlock;
}
`;
