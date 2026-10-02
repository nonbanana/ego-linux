# Install ego lite

Read this file only when ego lite isn't installed yet, or when the user asks to install ego lite. For day-to-day browser work, go back to `SKILL.md`.

The ego-browser skill depends on the ego lite browser: the `ego-browser` command is provided by the ego lite app. Once ego lite is installed and you've completed onboarding, no additional setup is normally needed.

ego lite website: https://lite.ego.app/

## Install steps (macOS only)

The install script lives at `scripts/install.sh` in this skill and supports macOS only. It will:

- Download the ego lite installer (a DMG) for your CPU architecture (arm64 / x64).
- Install `ego lite.app` to `/Applications` (falling back to `~/Applications` when needed).
- Strip the quarantine attribute to keep Gatekeeper from blocking the first launch.
- After installing, launch the `ego lite` app.

Run the script (use the script's actual path under this skill's directory):

```bash
sh skills/ego-browser/scripts/install.sh
```

After installing, the script opens the ego lite app directly. If ego lite is already installed, the script skips the download and opens the app directly.

After the script opens the ego lite app, the user completes the first-run onboarding in the app:

- Choose to import data from Chrome or another browser as needed.
- Onboarding registers the `ego-browser` command on the PATH (usually under `~/.local/bin`).

Onboarding is a step the user completes in the GUI. After the script opens ego lite, wait for the user to confirm they've finished onboarding before continuing.

## Linux: run against a local Chrome

There is no ego lite build for Linux. Instead, the SDK built from the
[ego-browser repository](https://github.com/citrolabs/ego-lite) drives a local
Google Chrome or Chromium through the DevTools protocol. Task spaces open as
separate windows in a dedicated Chrome profile under
`~/.local/share/ego-browser` (override with `EGO_BROWSER_DATA_DIR`), so sign in
to sites in that profile once.

Requirements: Node.js 22+, `google-chrome-stable`, `google-chrome`, `chromium`,
or `chromium-browser` on the PATH (or set `EGO_BROWSER_CHROME`), and
`wl-clipboard` (Wayland) or `xclip` (X11) for `keyboard.paste()`.

```bash
cd package/ego-browser
npm ci
npm run build
mkdir -p ~/.local/bin
ln -sf "$PWD/scripts/ego-browser-linux.sh" ~/.local/bin/ego-browser
```

The first browser call starts Chrome and keeps it running for later
invocations. Rebuild after pulling changes; the link always runs the current
build.

A bundled extension shows each task space as a tab group: blue with the agent's
current step while it works, orange when the task is handed to the user. A
handoff also raises a desktop notification. Right-click any page in the space
and choose **Return control to the agent** when done, or **Take over from the
agent** to interrupt it.

Chrome's DevTools port listens on `127.0.0.1` without authentication, so any
process of any local user can control this browser profile. Use it on a
single-user machine.

## After installing: confirm `ego-browser` is available

Once the user has finished onboarding, confirm the command is ready:

```bash
command -v ego-browser
```

If it reports that the command isn't found, `~/.local/bin` is most likely not on the current PATH. Fix it temporarily and retry:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
```

Once the command exists, verify the runtime with a minimal heredoc:

```bash
ego-browser nodejs <<'EOF'
console.log('ego-browser ready')
EOF
```

Printing `ego-browser ready` means the environment is ready.

## After that, return to the original task

Once the environment is ready, return to the user's original task and continue with the task space flow in `SKILL.md` — start from `taskSpace(name)` and proceed as usual.

## Troubleshooting

- **Not macOS**: the script supports macOS only (`uname -s` is `Darwin`). On Linux, follow the Linux section above. On other platforms, have the user download and install from the ego lite website at https://lite.ego.app/.
- **Download failed**: the script retries 3 times automatically; if it still fails, it's usually a network issue — have the user check their network and retry.
- **Gatekeeper still blocks it**: the script already tries to strip quarantine; if the first launch is still blocked, have the user allow ego lite manually under System Settings → Privacy & Security.
- **Command still unavailable after onboarding**: confirm `~/.local/bin` is on the PATH (see above); or have the user reopen ego lite, finish onboarding, and retry.
