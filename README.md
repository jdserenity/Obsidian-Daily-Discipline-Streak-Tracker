# Streak Tracker

An Obsidian plugin for tracking daily activities with streaks, stats, and a contribution heatmap.

## Features

- Track multiple daily activities
- Streak counting (current and longest)
- Success/fail tracking for activities
- Link to notes directly from activity names using `[[wiki-links]]`
- Calendar year heatmap (with year navigation when you have multiple years of data)
- Automatic catch-up: missed days are counted when you reopen Obsidian
- Configurable day boundary (for night owls)
- Theme-aware styling

## Setup

### 1. Install the Plugin

Copy the plugin folder to your vault's `.obsidian/plugins/` directory:
```
your-vault/
└── .obsidian/
    └── plugins/
        └── streak-tracker/
            ├── main.js
            ├── manifest.json
            └── styles.css
```

### 2. Enable the Plugin

1. Open Obsidian Settings
2. Go to Community Plugins
3. Enable "Streak Tracker"

### 3. Create Activity Configuration

Create a file named `streak-tracker-config.md` in your vault root:

```json
{
  "activities": [
    {
      "id": "exercise",
      "name": "Exercise",
      "description": "At least 30 minutes of physical activity",
      "canFail": false
    },
    {
      "id": "no-social-media",
      "name": "No Social Media",
      "description": "Avoid social media except for work purposes",
      "canFail": true
    }
  ]
}
```

#### Activity Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier (use lowercase with hyphens) |
| `name` | Yes | Display name (supports `[[wiki-links]]`) |
| `description` | No | Longer description (shown when clicking the name) |
| `canFail` | No | If `true`, shows a ✗ button. Default: `false` |

#### Linking to Notes

You can include wiki-links in activity names to quickly open related notes:

```json
{
  "id": "gym",
  "name": "Go to [[Strength Training]]",
  "description": "Hit the gym"
}
```

Or with display text:
```json
{
  "name": "[[Strength Training|Gym]] session"
}
```

When hovering over the title, linked and non-linked parts show different colors. Clicking non-linked text opens the description; clicking linked text opens the note.

### 4. Add Tracker to a Note

Add a code block to any note:

````markdown
```streak-tracker
```
````

## Settings

Access via **Settings → Streak Tracker**:

| Setting | Default | Description |
|---------|---------|-------------|
| Day End Time | 06:59 | When the "day" ends (24-hour format) |
| Heatmap Color | green | Custom color (hex format, e.g., `#22c55e`) |
| Config File Path | streak-tracker-config.md | Path to activity config |
| Data File Path | streak-tracker-data.md | Path to streak data file (logs, stats). Syncs across devices. |
| Link Color | #8ECCDF | Color for wiki-links in activity names |
| Refresh UI | — | Manually reload data from the vault file and refresh all tracker views |

## Usage

### Tracking Activities

- Click ✓ to mark success
- Click ✗ to mark failed (only for activities with `canFail: true`)
- Click again to unmark
- Click the activity name to show/hide description

### Understanding Stats

- 🔥 **Current Streak**: Consecutive days of success ending today
- ⭐ **Longest Streak**: Your best streak ever
- ✅ **Success Rate**: Total successes / Total days tracked, followed by the percentage (e.g., `18/21 : 0.86%`)

**Important**: `totalDays` counts every day from when you first tracked an activity until today. If you miss a day (don't click anything), it still counts as a day - just not a success. This updates automatically when you open Obsidian, even if it's been closed for a week.

### Heatmap

- Shows the calendar year (Jan 1 - Dec 31)
- Darker colors = higher completion percentage
- Hover over a cell to see details
- Year navigation appears when you have more than one year of data

## Data Storage

Your data is stored in two places:

- **Activity definitions**: `streak-tracker-config.md` in your vault (editable)
- **Logs, stats, and start dates**: `streak-tracker-data.md` in your vault (syncs across devices)

Plugin settings (day end time, colors, file paths) are managed internally by Obsidian.

Both vault files are regular `.md` files so they appear in Obsidian's file browser and sync via any sync service (Obsidian Sync, iCloud, Proton Drive, etc.).

**Important**: The `streak-tracker` code block is just a UI element. You can add or remove it from any note without losing data. Multiple code blocks in different notes all share the same data.

## Live Reload

The plugin watches for changes to the config and data files. If you edit the config file or data arrives via sync, the tracker UI updates automatically — no need to reopen the note.

If the UI ever gets out of sync (e.g., after a sync conflict or delay), use the **Refresh UI** button in Settings to manually reload data from the vault file without writing anything back. This is a safe, read-only operation.

## Day Boundary

The "Day End Time" setting is for night owls:
- Setting: `06:59`
- At 2:00 AM on January 16th → logs for January 15th
- At 7:00 AM on January 16th → logs for January 16th
