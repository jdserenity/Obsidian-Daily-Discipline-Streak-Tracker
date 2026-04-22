# Streak Tracker — Architecture

## Overview

Streak Tracker is an Obsidian plugin (no build step) consisting of three files deployed directly into vault plugin directories:

- `main.js` — all plugin logic (one class)
- `styles.css` — all UI styles
- `manifest.json` — Obsidian plugin metadata

`push_to_prod.sh` copies those three files into three vault locations (local, ProtonDrive, iCloud).

---

## Single-class structure (`main.js`)

Everything lives in `StreakTrackerPlugin extends Plugin`. There is no module bundler or transpilation. A companion `StreakTrackerSettingTab` class handles the settings UI.

### Lifecycle

```
onload()
  └── loadPluginData()
        ├── migrateJsonToMd()       — one-time path migration
        └── loadVaultData()         — reads streak-tracker-data.md
  └── recalculateAllStats()
  └── registerMarkdownCodeBlockProcessor("streak-tracker")
        └── renderTracker(el)       — called on every code block render
  └── registerInterval → checkDayChange()
  └── app.vault.on("modify") → onFileModified()
  └── onLayoutReady → retry loadVaultData if it failed at startup
```

### Data storage: two files

**`streak-tracker-config.md`** (JSON inside a .md file)
- Stores activity definitions: id, name, frequency, weeklyTarget, scheduledDays, canFail, description
- Written only when the user edits an activity description in-place
- Loaded fresh on every `renderTracker()` call

**`streak-tracker-data.md`** (JSON inside a .md file)
- Stores: `logs`, `stats`, `activityStartDates`, `pausedActivities`
- `logs`: `{ "YYYY-MM-DD": { activityId: "success" | "failed" } }`
- `stats`: cached streak/rate calculations, recalculated from logs on every save
- `activityStartDates`: `{ activityId: "YYYY-MM-DD" }` — earliest tracked date per activity
- `pausedActivities`: `{ activityId: "YYYY-MM-DD" }` — date the activity was paused

Both files use `.md` extension so they appear in Obsidian's file browser and sync normally.

Obsidian's own `data.json` (plugin storage) holds only `settings`.

### Cross-device sync

The plugin is designed to work across devices via cloud sync (ProtonDrive, iCloud). The sync strategy is:

- **`loadVaultData()`** — called at startup. Merges the on-disk file into in-memory state. For conflicts, it keeps the in-memory value (assumed more recent). For `activityStartDates` it keeps the earliest date.
- **`saveVaultData()`** — called after every user action. Reads the current file first and merges past-day log data to avoid overwriting changes from another device. **In-memory state always wins** for the current day and for `pausedActivities` (see below).
- **`incomingSyncFromFile()`** — called when Obsidian's `vault.on("modify")` fires for the data file and the content hash differs from what this device last wrote. This means another device wrote the file. The incoming file is treated as authoritative for all past days; today's in-memory log is merged on top.
- **Hash deduplication** — `_lastDataWriteHash` and `_lastConfigWriteHash` prevent the plugin from reacting to its own writes bouncing back from cloud sync.

### Pause/unpause — important invariant

`pausedActivities` uses **in-memory-wins** semantics during `saveVaultData()`. The on-disk value is intentionally **not** merged back in during a save. This is because:

- The user just took an explicit action (pause or unpause) on this device
- If unpause deleted the key from `this.data.pausedActivities`, merging from disk would immediately restore the key before the file is written, making unpause impossible
- Cross-device sync (load path) still uses the conservative "keep it paused if either side says so" merge, which is correct when no explicit action has been taken locally

**Bug that was fixed:** The original `saveVaultData()` merge loop iterated `existing.pausedActivities` and restored any key not present in memory — silently undoing every unpause. The fix removes that merge entirely from the save path.

### Rendering

`renderTracker(el)` is the main render entry point. It:
1. Loads the config fresh
2. Rebuilds `activityConfigMap` (id → activity object, needed by `calculateStats`)
3. Renders heatmap(s), then activity rows

Each activity row is rendered by `renderDailyActivity` or `renderWeeklyActivity`. These close over `isPaused` and `currentState` at render time.

**Secondary mode** — holding the configured modifier key (default: Alt/Option) while hovering over the tracker adds `streak-secondary-mode` to the container. CSS uses this to hide primary buttons and reveal the pause/resume button. The pause button uses `mousedown` (not `click`) so its handler fires before the `keyup` event for the modifier key can remove `streak-secondary-mode` and hide the button.

### Stats calculation

`calculateStats(activityId)` and `calculateWeeklyStats(activityId, weeklyTarget)` are pure computations over `this.data.logs`. They write into `this.data.stats` and are called:
- After every `saveLog()` (user checks/unchecks an activity)
- In `recalculateAllStats()` — called on load, day change, and after pause/unpause
- During `saveVaultData()` after the merge (so stats always reflect merged logs)

**Paused activities** freeze stats at the pause date by substituting `pausedSince` for `today` in all date range calculations.

### Day boundary

`getCurrentDay()` returns the current logical date. If the wall clock time is before the configured `dayEndTime` (default `04:00`), it returns yesterday's date — so activity logged at 1am counts for the previous calendar day.
