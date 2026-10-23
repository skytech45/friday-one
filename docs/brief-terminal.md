You are fixing the terminal/TUI in the FRIDAY One Android app at /home/ubuntu/friday-one.

FIRST read /home/ubuntu/friday-one/docs/SHARED.md fully. It is the contract, and it
explains the Android build quirks on this box.

## The situation

A previous agent was assigned this and FAILED: it downloaded the renderer assets but
wrote ZERO Kotlin files, leaving the package directory empty. Do not repeat that.
Your job is to actually produce working, compiling code.

A crude ANSI-stripping renderer currently lives in
`android/app/src/main/java/com/friday/one/TerminalScreen.kt` (114 lines, inline HTML
string). It renders Ink-based TUIs (Hermes, OpenCode) as garbage because it has no
support for the alternate screen buffer or cursor addressing.

## What already exists (do not re-download)

- `android/app/src/main/assets/terminal/xterm.js`   (289 KB, xterm 5.5.0)
- `android/app/src/main/assets/terminal/xterm.css`  (5.5 KB)

## Deliverable

Create these files (all of them, complete, no stubs, no TODOs):

1. `android/app/src/main/assets/terminal/index.html`
   A self-contained terminal page that:
   - loads `xterm.js` and `xterm.css` as RELATIVE local paths (no CDN, no network)
   - creates an xterm.js Terminal with `allowProposedApi`, a dark theme, and the
     fit addon behaviour implemented inline if no fit addon is vendored
   - opens a WebSocket to the URL passed in via `window.__WS_URL__` (the Kotlin side
     injects this before load, or appends it as a query param - your choice, but
     document it in a comment)
   - pipes socket -> `term.write()` and `term.onData` -> socket
   - sends resize as a control frame: `\u0000resize:<cols>x<rows>`
     (the backend reserves the `\u0000` prefix; `\u0000kill` already exists)
   - handles `term.onResize` and window resize/orientation change
   - reconnects with backoff if the socket drops, and prints a visible message

2. `android/app/src/main/java/com/friday/one/feature/terminal/TerminalWebView.kt`
   A Compose wrapper: `AndroidView` hosting a WebView. Requirements:
   - `javaScriptEnabled = true`, `domStorageEnabled = true`
   - load the page from `file:///android_asset/terminal/index.html`
   - inject the `Authorization: Bearer` token and the WS URL. A WebSocket handshake
     from a WebView cannot set custom headers reliably, so pass the token as a query
     parameter (`?token=...`) and note the tradeoff in a comment - the backend
     already accepts a token query param, so match whatever the backend does. READ
     `server/src/routes/terminal.ts` and match it exactly.
   - destroy the WebView in `onRelease`/`DisposableEffect` so the socket closes

3. `android/app/src/main/java/com/friday/one/feature/terminal/TerminalScreen.kt`
   A public entry point that replaces the crude one and keeps the SAME call shape the
   app already uses, so it is a drop-in:
       TerminalScreen(session: SessionStore, baseUrl: String, kind: String, title: String)
   Include a bottom keyboard row (Esc, Tab, Ctrl-C, Left, Down, Up, Right) that sends
   the right bytes over the socket (use `evaluateJavascript` to call into the page).

4. Update `android/app/src/main/java/com/friday/one/MainActivity.kt` so the Hermes and
   OpenCode tabs use the NEW `com.friday.one.feature.terminal.TerminalScreen`, and
   DELETE the old crude `com/friday/one/TerminalScreen.kt` file entirely.

## Rules

- The `assets/terminal/` directory must NOT be empty when you finish. Files must exist.
- Do NOT edit anything under `feature/files/` or `security/` - other work owns those.
- The WebSocket URL must be derived from the `baseUrl` argument:
  `https://host` -> `wss://host/ws/terminal?kind=<kind>`, `http://host` -> `ws://...`.
- YOU MUST BUILD AND ITERATE UNTIL IT COMPILES:
      cd /home/ubuntu/friday-one/android && flock /tmp/gradle.lock ./build.sh debug
  This is slow (several minutes). Run it, read the `e:` errors, fix them, run again.
  Do not claim success without a `BUILD SUCCESSFUL` line in your own output.
- Report at the end: the files you created, the exact final build result line, and
  anything you could not verify. Never report success you did not observe.
