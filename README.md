# Antigravity Notes (`antigravity-notes`)

<p>
  <a href="https://www.npmjs.com/package/antigravity-notes"><img src="https://img.shields.io/npm/v/antigravity-notes?logo=npm&color=cb3837" alt="npm version" height="20"></a>
  <a href="https://github.com/arthurcavallari/antigravity-notes/actions/workflows/test.yml"><img src="https://github.com/arthurcavallari/antigravity-notes/actions/workflows/test.yml/badge.svg" alt="Tests" height="20"></a>
  <img src="https://img.shields.io/badge/Antigravity-2.0%E2%80%932.34.0-4285F4?logo=google&logoColor=white" alt="Antigravity 2.0–2.34.0" height="20">
  <img src="https://img.shields.io/node/v/antigravity-notes?logo=nodedotjs&logoColor=white&color=339933" alt="Node.js version" height="20">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" height="20"></a>
  <a href="https://github.com/sponsors/arthurcavallari"><img src="https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=githubsponsors&logoColor=white" alt="Sponsor on GitHub" height="20"></a>
</p>

> Workspace-aware **Prompt Stash**, colored `#tags`, and **Markdown Scratchpad** sidecar for **Google Antigravity**.

Mounts natively in Antigravity's Auxiliary (right-hand) Pane (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) or inside [**Antigravity Hangar**](https://github.com/arthurcavallari/antigravity-hangar), syncing automatically with your active project, conversation switches, and Onyx editor theme (dark, light, high-contrast, and custom theme seeds).

Leaves zero files in your repository working tree, runs with zero third-party npm dependencies (powered solely by [`antigravity-sidecar-kit`](https://github.com/arthurcavallari/antigravity-sidecar-kit)), and consumes **`0` context tokens** by default.

---

## Features

### 1. Prompt Stash
Park follow-up prompts, bug repros, and edge cases mid-turn without interrupting a running agent turn, then dispatch them deliberately when ready:

- **IME-Safe Quick Capture & Smart Lists**: Auto-growing composer supporting `Enter` (`Shift+Enter` newline) or `Ctrl/Cmd+Enter` (`Enter` newline) submit modes, plus smart Markdown list continuation (`- `, `- [ ] `, `1.`, `a.`, `i.`) and `Tab` / `Shift+Tab` outline cycling (`1.` → `   a.` → `      i.`) without trapping `Tab` focus on plain prose.
- **Explicit Save Destination (`📁 <Project>` ↔ `🌐 General`)**: Choose per-card whether to park to the active Antigravity **Project** (continuity across multi-repo project roots, worktrees, and new `_new` chats) or as an unattached **General** note.
- **Pure View Filter (`Project | Chat | All`)**: Filter visible cards between the active **Project**, current **Chat**, or **All** (every project + General notes) without implicitly changing where new cards save or switching your open Scratchpad.
- **Rendered Markdown Cards & Tall Card Clamp**: Idle cards render formatted Markdown (nested lists, interactive `- [ ]` task checkboxes that toggle in place, inline/fenced code, links, and `#tag` pills), while clicking card text edits the lossless raw Markdown. Cards taller than `~7` lines clamp cleanly with a bottom fade and **`▾ Show more` / `▴ Show less`** toggle without stretching neighboring Grid cards.
- **Automatic `#tag` Onyx Colors**: Inline `#tags` map to Antigravity's 6 theme-adaptive `--chart-1..6` Onyx tokens (`rose`, `amber`, `emerald`, `blue`, `violet`, `cyan`) via `oklab` mixing. Right-click any `#tag` pill to recolor it globally, set per-card overrides (`Auto`, 6 swatches, `None`), and switch card tint styles between **Wash**, **Stripe**, and **Sticky**.
- **Manual Dispatch, Multi-Select Combine & Sent Archive**:
  - **Send `↵`** dispatches to the active conversation; **Start New Chat** spawns a fresh conversation in the current workspace.
  - Multi-select (`>= 2` cards) opens **Combine & Preview** (`<dialog closedby="any">`) to edit framing context before sending or copying.
  - Dispatched cards move to **Sent** (`300`-card FIFO archive) with an **Undo** toast and 1-click jump back to the origin or destination conversation.
- **60fps Ghost + 2D FLIP Card Reorder**: Drag cards via a compositor-tracked floating ghost with live placeholder slot preview, WAAPI FLIP neighbor animations across List and multi-column Grid layouts, edge auto-scroll, `Escape` cancel, and `prefers-reduced-motion` support.

### 2. Markdown Scratchpad
Continuous auto-saving Markdown workspace (`1 MB` per pad) for rough notes, checklists, and multi-step prompt drafting:

- **Unified Header & Multi-Pad Strip**: `[Project | Global]` leads the Scratchpad tab strip (`[Project | Global] │ Tabs [⋯] [+]`), merging with `[Edit | Split | Preview]` into a single `34px` bar at `>= 640px` and wrapping cleanly into 2 rows on narrow panes.
- **Multi-Pad Tabs with Overflow Menu**: Supports inline tab rename (`dblclick` or on creation), pointer drag-reorder, horizontal wheel scrolling, `⋯` overflow menu for instant tab switching, and `×` delete.
- **`Edit | Split | Preview`**:
  - **Edit**: Monospace Markdown editor with smart `- ` / `- [ ] ` / `1.` / `a.` / `i.` continuation, `Tab` / `Shift+Tab` `1. → a. → i.` outline cycling and sibling renumbering, `Escape` blur, and `400ms` debounced save with synchronous flush on tab, pad, scope, or visibility transitions.
  - **Preview**: XSS-safe rendered Markdown with interactive `- [ ]` task checkboxes that toggle the underlying Markdown line.
  - **Split** (`>= 680px` Scratchpad width): Live `50% / 50%` side-by-side editor + preview, automatically falling back to `Edit` if resized narrower than `680px`.
- **Markdown Export Menu (`Save As…` / `Downloads` / `Copy`)**: Export any Scratchpad or Stash via native OS `Save As…` file dialog, collision-safe `~/Downloads` write (with full path + **Copy Path** toast), or instant clipboard Markdown copy.
- **Zero-Jump Snippet Actions**: Highlighting text swaps `[Saved] [⬇]` in place for `[→ Stash] [Send ↵] [↗ New Chat]` inside the fixed-height toolbar (`0px` vertical shift). Promoting a snippet to **Stash** parses `#tags` and leaves the Scratchpad text intact.

### 3. Responsive Layout Continuum
Nested CSS `@container` contexts (`notes-pane`, `stash-pane`, `stash-card`, `stash-composer`, `scratchpad-pane`) adapt layout density across every host container:

| Container Size | Layout Adaptation |
| --- | --- |
| `240px–519px` width (Aux Pane) | Compact 2-row Stash filter bar (`Project \| Chat \| All` + `Active \| Sent` above search) and hover-disclosed card actions |
| `<= 260px` height (Hangar Split) | `30px` chrome bar and collapsible `[🔍]` + `[Sent]` Stash filter bar alongside the 1-row composer |
| `>= 380px` Card width (`stash-card`) | Keeps secondary card actions (`🎨 ↗ 📋 ✏️`) persistently visible without truncating conversation chips |
| `>= 520px` Stash width | Single-row Stash filter controls (`Project \| Chat \| All` + search + `Active \| Sent`) |
| `>= 620px` Stash width | Unlocks `Grid \| List` toggle with full-width `minmax(280px, 1fr)` grid (`minmax(320px, 1fr)` at `>= 1080px`) or centered `780px` list |
| `>= 640px` Scratchpad width | Merges `[Project \| Global] │ Tabs [+]` and `[Saved] [Edit \| Split \| Preview] [⬇]` into one `34px` header |
| `>= 680px` Scratchpad width | Unlocks side-by-side `Split` preview and centers single-pane prose at `~78ch` |
| `>= 780px` Stash width | Merges color dots & `#tag` filter strip inline into the filter row |
| `>= 860px` width (Maximized) | Unlocks **Workbench** mode: side-by-side **Stash + Scratchpad** separated by a draggable `<agy-split-sash>` |

### 4. Opt-In Agent MCP & Privacy
MCP is **off by default** (`mcpRead: false`, `mcpWrite: false`, `disabled: true` in `mcp_config.json`), consuming **`0` context tokens** until explicitly enabled in `⚙` Settings or via `setup.mjs`:

- **Agent Read** (`~380 tok` when enabled):
  - `list_stash` — Filter stashed cards by `scope`, `workspacePath`, `conversationId`, `status`, `tag`, `color`, or `query`.
  - `read_scratchpad` — Read scratchpads by `id`, `title`, `scope`, or `workspacePath`.
  - `search_notes` — Search across both Prompt Stash cards and Scratchpads.
- **Agent Write** (`~460 tok` when enabled):
  - `stash_prompt` — Park a draft prompt card with optional `color` and `#tags` (returns minimal write acknowledgement without echoing private notes).
  - `update_stash_card` — Update card `text`, `color`, or `status`.
  - `append_scratchpad` / `replace_scratchpad` — Append or replace Scratchpad Markdown without reading back pre-existing content.

Both HTTP (`/api/mcp`, `/mcp`) and stdio (`mcp.mjs`, including offline fallback when Hangar hibernates the sidecar) pass through `lib/mcp-guard.mjs`, which enforces per-direction tool gating and unconditionally blocks `StateSync`'s generic `get_state` tool.

---

## Requirements

- **Google Antigravity** `2.0` – `2.34.0` (Desktop / IDE with `SidecarManager` support)
- **Node.js** `>= 20.13.0` (one runtime dependency, [`antigravity-sidecar-kit`](https://github.com/arthurcavallari/antigravity-sidecar-kit), plus Antigravity's built-in `sidecar_sdk`)

---

## Installation

### Option A: 1-Click Install via Antigravity Hangar (Recommended)

If you use [**Antigravity Hangar**](https://github.com/arthurcavallari/antigravity-hangar) (`npx antigravity-hangar`), open the **`🧩 Extensions -> Discover`** tab inside Hangar and click **Install** on **Notes**—or sideload a local checkout in **`🧩 Extensions -> Sideload`**.

### Option B: Standalone CLI (`npx` or `git clone`)

```bash
# 1-command install via npx
npx antigravity-notes

# Or clone and link locally
git clone https://github.com/arthurcavallari/antigravity-notes.git
cd antigravity-notes
npm install
npm run setup
```

Then select **Notes** from the Antigravity Auxiliary Pane dropdown.

What `setup` does:
1. Validates all required sidecar manifests (`sidecar.json`, `hub-manifest.json`), backend entrypoints, and UI assets.
2. Persists your initial state (`~/.gemini/antigravity/sidecar_data/notes/data/state.json`) and optional MCP flags atomically.
3. Links `~/.gemini/config/sidecars/notes` to your package checkout (using an NTFS directory junction on Windows or directory symlink on macOS/Linux, copying out of ephemeral `_npx` caches automatically).
4. Enables `sidecars["notes"]` in `~/.gemini/config/config.json` (preserving any existing `projectId` and writing UTF-8 without BOM) and syncs `~/.gemini/antigravity/mcp_config.json`.
5. Hot-reloads the sidecar via the Language Server `ManageSidecar` RPC when invoked inside an active Antigravity session.

### Setup CLI Flags

| Flag | Effect |
| --- | --- |
| *(default)* | Registers the `notes` sidecar with MCP disabled (`0` context tokens) |
| `--mcp-read` / `--no-mcp-read` | Enable or disable Agent Read MCP tools (`list_stash`, `read_scratchpad`, `search_notes`) |
| `--mcp-write` / `--no-mcp-write` | Enable or disable Agent Write MCP tools (`stash_prompt`, `update_stash_card`, `append_scratchpad`, `replace_scratchpad`) |
| `--with-mcp` | Enable both `mcpRead` and `mcpWrite` |
| `--no-mcp` | Disable both `mcpRead` and `mcpWrite` (`disabled: true` in `mcp_config.json`) |
| `--uninstall` | Remove the `notes` sidecar registration and clean up `mcp_config.json` |

### Uninstallation

```bash
npm run uninstall
```

Removes the `~/.gemini/config/sidecars/notes` link, disables `sidecars["notes"]` in `~/.gemini/config/config.json` (preserving `projectId`), removes the `antigravity-notes` entry from `mcp_config.json`, and stops the sidecar via RPC.

---

## Development & Testing

Run the automated test suite, manifest validator, and packed tarball smoke check:

```bash
npm test
npm run validate:manifest
npm run test:pack
```

### Project Layout

```text
antigravity-notes/
├── package.json
├── sidecar.json                  # Antigravity Auxiliary Pane sidecar manifest
├── hub-manifest.json             # Hangar Marketplace & capability-tier manifest
├── launch.mjs                    # Self-healing sidecar launcher (fallback port 52325)
├── server.mjs                    # Thin SidecarApp + StateSync + guarded MCP HTTP entrypoint
├── mcp.mjs                       # Guarded stdio MCP bridge with offline state.json fallback
├── setup.mjs                     # Cross-platform junction/symlink installer & MCP CLI flags
├── lib/
│   ├── constants.mjs             # Sidecar IDs, limits, Onyx palette & default state schema
│   ├── context-resolver.mjs      # Trajectory, workspace URI & multi-root Project resolver
│   ├── dispatcher.mjs            # Safe agentapi send-message / new-conversation dispatcher
│   ├── exporter.mjs              # Native OS Save As picker & collision-safe Downloads writer
│   ├── mcp-config.mjs            # BOM-safe mcp_config.json sync & RefreshMcpServers RPC
│   ├── mcp-guard.mjs             # Per-direction read/write MCP gate (blocks get_state)
│   ├── mcp-tools.mjs             # 7 opt-in MCP tool definitions & handlers
│   └── notes-store.mjs           # Pure state reducer, #tag parser, FIFOSent cap & search
├── scripts/
│   ├── pack-smoke.mjs            # Tarball pack + isolated install/setup/server smoke test
│   └── validate-manifest.mjs     # sidecar.json & hub-manifest.json schema validator
├── ui/
│   ├── index.html                # Auxiliary Pane & Hangar semantic shell markup
│   ├── styles.css                # Onyx tokens, responsive @container shell & Scratchpad styles
│   ├── components.css            # Composer, Stash cards, wash/stripe/bold tints & dialogs
│   ├── markdown.js               # Zero-dep XSS-safe Markdown renderer & smart list editor
│   ├── core.js                   # StateSync SSE client, Hangar postMessage & Export helpers
│   ├── app.js                    # Chrome bar, Settings popover, Workbench sash & boot wiring
│   └── components/
│       ├── stash-tab.js          # Prompt Stash composer, filters, cards & 60fps FLIP drag
│       ├── scratchpad-tab.js     # Multi-pad strip, Edit/Split/Preview & snippet promotion
│       ├── combine-modal.js      # Light-dismiss Combine & Preview <dialog closedby="any">
│       └── swatch-picker.js      # Floating 6-swatch Onyx color picker menu
└── test/
    ├── context-resolver.test.mjs
    ├── dispatcher.test.mjs
    ├── exporter.test.mjs
    ├── manifest-schema.test.mjs
    ├── markdown.test.mjs
    ├── mcp-config.test.mjs
    ├── mcp-guard.test.mjs
    ├── notes-store.test.mjs
    ├── scratchpad-ui.test.mjs
    ├── server.test.mjs
    └── stash-ui.test.mjs
```

---

## Support

Built and maintained in my spare time (with constant keyboard supervision from my three cats, **Snow** 🤍, **Eevee** 🦊, and **Merlin** 🧙‍♂️).

If **Antigravity Notes** helps keep your prompts and scratchpads organized across workspaces, consider [❤️ sponsoring me on GitHub Sponsors](https://github.com/sponsors/arthurcavallari) to help fund ongoing maintenance, new Antigravity sidecar extensions, and the household Churu treat budget!

---

## License

[MIT](./LICENSE)
