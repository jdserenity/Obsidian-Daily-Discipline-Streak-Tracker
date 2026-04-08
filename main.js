const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");

const DEFAULT_SETTINGS = {
  dayEndTime: "04:00",
  heatmapColor: null,
  configFilePath: "Archive/streak-tracker-config.md",
  dataFilePath: "Archive/streak-tracker-data.md",
  linkColor: "#8ECCDF", // Light blue default for links
  secondaryModifier: "Alt" // Modifier key to reveal secondary actions (Alt, Control, Shift, Meta)
};

const DEFAULT_DATA = {
  settings: DEFAULT_SETTINGS,
  logs: {},
  stats: {},
  activityStartDates: {}, // Track when each activity started being tracked
  pausedActivities: {}    // activityId → date string of when it was paused
};

class StreakTrackerPlugin extends Plugin {
  async onload() {
    this.vaultDataLoaded = false;
    this._trackerElements = new Set();
    this._lastDataWriteHash = null;
    this._lastConfigWriteHash = null;
    this._reloadTimeout = null;
    this.activityConfigMap = {}; // id → activity object, populated on config load

    await this.loadPluginData();

    // Register code block processor
    this.registerMarkdownCodeBlockProcessor("streak-tracker", (source, el, ctx) => {
      this.renderTracker(el);
    });

    // Register settings tab
    this.addSettingTab(new StreakTrackerSettingTab(this.app, this));

    // Recalculate all stats on load to catch up on missed days
    await this.recalculateAllStats();

    // Check for day change periodically
    this.lastCheckedDay = this.getCurrentDay();
    this.registerInterval(
      window.setInterval(() => this.checkDayChange(), 60000)
    );

    // Watch vault file modifications for sync/manual edits
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.onFileModified(file))
    );

    // Retry loading vault data after layout is ready, in case the file wasn't
    // accessible during onload (e.g. ProtonDrive still syncing at startup)
    this.app.workspace.onLayoutReady(async () => {
      if (!this.vaultDataLoaded) {
        await this.loadVaultData();
        await this.recalculateAllStats();
        await this.refreshAllTrackers();
      }
    });
  }

  async loadPluginData() {
    const savedData = await this.loadData();
    this.data = Object.assign({}, DEFAULT_DATA, savedData);
    if (!this.data.settings) {
      this.data.settings = DEFAULT_SETTINGS;
    }
    if (!this.data.logs) {
      this.data.logs = {};
    }
    if (!this.data.stats) {
      this.data.stats = {};
    }
    if (!this.data.activityStartDates) {
      this.data.activityStartDates = {};
    }
    if (!this.data.pausedActivities) {
      this.data.pausedActivities = {};
    }

    // Migrate .json vault files to .md so they appear in Obsidian's file browser
    await this.migrateJsonToMd();

    // Load vault data (logs, stats, activityStartDates) from the vault file
    const vaultDataLoaded = await this.loadVaultData();

    // Auto-migration: if the vault file had no data but plugin data.json has existing logs,
    // migrate them to the vault file and clear from plugin data
    if (!vaultDataLoaded && Object.keys(savedData?.logs || {}).length > 0) {
      this.data.logs = savedData.logs || {};
      this.data.stats = savedData.stats || {};
      this.data.activityStartDates = savedData.activityStartDates || {};
      this.vaultDataLoaded = true; // Migrating real data from data.json
      await this.saveVaultData();
      // Clear migrated data from plugin data.json (keep only settings)
      await this.saveData({ settings: this.data.settings });
    }
  }

  async migrateJsonToMd() {
    const migrations = [
      { setting: "configFilePath", oldDefault: "streak-tracker-config.json", newDefault: "Archive/streak-tracker-config.md" },
      { setting: "configFilePath", oldDefault: "streak-tracker-config.md", newDefault: "Archive/streak-tracker-config.md" },
      { setting: "dataFilePath", oldDefault: "streak-tracker-data.json", newDefault: "Archive/streak-tracker-data.md" },
      { setting: "dataFilePath", oldDefault: "streak-tracker-data.md", newDefault: "Archive/streak-tracker-data.md" }
    ];
    let changed = false;
    for (const { setting, oldDefault, newDefault } of migrations) {
      if (this.data.settings[setting] === oldDefault) {
        const exists = await this.app.vault.adapter.exists(oldDefault);
        if (exists) {
          await this.app.vault.adapter.rename(oldDefault, newDefault);
        }
        this.data.settings[setting] = newDefault;
        changed = true;
      }
    }
    if (changed) {
      await this.saveData({ settings: this.data.settings });
    }
  }

  async savePluginData() {
    // Save only settings to Obsidian's plugin data.json
    await this.saveData({ settings: this.data.settings });
    // Save logs, stats, activityStartDates to the vault file
    await this.saveVaultData();
  }

  async loadVaultData() {
    const dataPath = this.data.settings.dataFilePath || "Archive/streak-tracker-data.md";

    // Use adapter.exists + adapter.read instead of getAbstractFileByPath,
    // because the file index may not be ready yet on mobile
    const exists = await this.app.vault.adapter.exists(dataPath);
    if (!exists) {
      return false;
    }

    try {
      const content = await this.app.vault.adapter.read(dataPath);
      const vaultData = JSON.parse(content);
      const incoming = {
        logs: vaultData.logs || {},
        activityStartDates: vaultData.activityStartDates || {}
      };

      // Merge logs: for each date+activity, prefer in-memory value (recent user
      // action) over incoming, but never drop data that only exists in one side
      for (const date of Object.keys(incoming.logs)) {
        if (!this.data.logs[date]) {
          this.data.logs[date] = incoming.logs[date];
        } else {
          for (const act of Object.keys(incoming.logs[date])) {
            if (!this.data.logs[date][act]) {
              this.data.logs[date][act] = incoming.logs[date][act];
            }
            // If both have a value, keep the in-memory one (more recent action)
          }
        }
      }

      // Merge activityStartDates: keep the earliest
      for (const act of Object.keys(incoming.activityStartDates)) {
        if (!this.data.activityStartDates[act] ||
            incoming.activityStartDates[act] < this.data.activityStartDates[act]) {
          this.data.activityStartDates[act] = incoming.activityStartDates[act];
        }
      }

      // Merge pausedActivities: if paused on either side, keep it paused (use earlier date)
      const incomingPaused = vaultData.pausedActivities || {};
      if (!this.data.pausedActivities) this.data.pausedActivities = {};
      for (const [id, date] of Object.entries(incomingPaused)) {
        if (!this.data.pausedActivities[id] || date < this.data.pausedActivities[id]) {
          this.data.pausedActivities[id] = date;
        }
      }

      // Stats will be recalculated from merged logs
      this.data.stats = vaultData.stats || {};
      this.vaultDataLoaded = true;
      return true;
    } catch (e) {
      console.error("Failed to load streak tracker vault data:", e);
      // File exists but is temporarily unreadable (e.g. mid-sync from cloud storage).
      // Still mark as loaded so saves aren't blocked and in-memory data isn't lost.
      this.vaultDataLoaded = true;
      return false;
    }
  }

  _hashStr(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    }
    return h;
  }

  // Called when another device's write is detected. Takes the file as authoritative
  // for all past days, but merges today's in-memory state on top.
  async incomingSyncFromFile(content) {
    try {
      const vaultData = JSON.parse(content);
      const today = this.getCurrentDay();
      const todayMem = this.data.logs[today];
      const memStartDates = { ...this.data.activityStartDates };

      // Replace all data from the incoming file
      this.data.logs = vaultData.logs || {};
      this.data.activityStartDates = vaultData.activityStartDates || {};

      // Restore today's in-memory log on top (in-memory wins for today,
      // since the user may have just logged something on this device)
      if (todayMem) {
        if (!this.data.logs[today]) {
          this.data.logs[today] = todayMem;
        } else {
          for (const [act, val] of Object.entries(todayMem)) {
            this.data.logs[today][act] = val;
          }
        }
      }

      // activityStartDates: keep the earliest from either source
      for (const [act, date] of Object.entries(memStartDates)) {
        if (!this.data.activityStartDates[act] || date < this.data.activityStartDates[act]) {
          this.data.activityStartDates[act] = date;
        }
      }

      // pausedActivities: merge — if paused on either device, keep it paused
      const memPaused = { ...this.data.pausedActivities };
      this.data.pausedActivities = vaultData.pausedActivities || {};
      for (const [id, date] of Object.entries(memPaused)) {
        if (!this.data.pausedActivities[id] || date < this.data.pausedActivities[id]) {
          this.data.pausedActivities[id] = date;
        }
      }

      this.vaultDataLoaded = true;
      await this.recalculateAllStats();
      await this.refreshAllTrackers();
    } catch (e) {
      console.error("streak-tracker: incomingSyncFromFile failed:", e);
    }
  }

  async saveVaultData() {
    if (!this.vaultDataLoaded) return;
    const dataPath = this.data.settings.dataFilePath || "Archive/streak-tracker-data.md";
    // Merge with existing file data to prevent cross-device overwrites.
    // In-memory wins for conflicts (it has the most recent user action),
    // but data that only exists on disk is preserved.
    try {
      const exists = await this.app.vault.adapter.exists(dataPath);
      if (exists) {
        const raw = await this.app.vault.adapter.read(dataPath);
        const existing = JSON.parse(raw);

        // Merge logs: preserve data from both sides, prefer in-memory for conflicts.
        // Skip the current day — in-memory is authoritative for today since
        // the user just took an action. This prevents merge-on-save from
        // restoring entries the user intentionally deleted (deselected).
        // Cross-device data for today is already in memory via loadVaultData.
        if (existing.logs) {
          const today = this.getCurrentDay();
          for (const date of Object.keys(existing.logs)) {
            if (date === today) continue;
            if (!this.data.logs[date]) {
              this.data.logs[date] = existing.logs[date];
            } else {
              for (const act of Object.keys(existing.logs[date])) {
                if (!this.data.logs[date][act]) {
                  this.data.logs[date][act] = existing.logs[date][act];
                }
              }
            }
          }
        }

        // Merge activityStartDates: keep the earliest date
        if (existing.activityStartDates) {
          for (const act of Object.keys(existing.activityStartDates)) {
            if (!this.data.activityStartDates[act] ||
                existing.activityStartDates[act] < this.data.activityStartDates[act]) {
              this.data.activityStartDates[act] = existing.activityStartDates[act];
            }
          }
        }

        // Merge pausedActivities: preserve paused state from either side
        if (existing.pausedActivities) {
          if (!this.data.pausedActivities) this.data.pausedActivities = {};
          for (const [id, date] of Object.entries(existing.pausedActivities)) {
            if (!this.data.pausedActivities[id] || date < this.data.pausedActivities[id]) {
              this.data.pausedActivities[id] = date;
            }
          }
        }
      }
    } catch (e) {
      // If reading/parsing fails, just save what we have
      console.warn("streak-tracker: merge-on-save failed, writing current data:", e);
    }

    // Recalculate stats from the merged logs
    const activityIds = new Set();
    for (const date of Object.keys(this.data.logs)) {
      for (const act of Object.keys(this.data.logs[date])) {
        activityIds.add(act);
      }
    }
    for (const act of Object.keys(this.data.activityStartDates)) {
      activityIds.add(act);
    }
    for (const act of activityIds) {
      this.calculateStats(act);
    }

    const vaultData = {
      logs: this.data.logs,
      stats: this.data.stats,
      activityStartDates: this.data.activityStartDates,
      pausedActivities: this.data.pausedActivities || {}
    };
    const jsonStr = JSON.stringify(vaultData, null, 2);
    this._lastDataWriteHash = this._hashStr(jsonStr);
    await this.app.vault.adapter.write(dataPath, jsonStr);
  }

  async loadActivityConfig() {
    const configPath = this.data.settings.configFilePath || "Archive/streak-tracker-config.md";
    const file = this.app.vault.getAbstractFileByPath(configPath);

    if (!file) {
      return { activities: [] };
    }

    try {
      const content = await this.app.vault.read(file);
      return JSON.parse(content);
    } catch (e) {
      console.error("Failed to load streak tracker config:", e);
      return { activities: [] };
    }
  }

  async saveActivityConfig(config) {
    const configPath = this.data.settings.configFilePath || "Archive/streak-tracker-config.md";
    const content = JSON.stringify(config, null, 2);
    this._lastConfigWriteHash = this._hashStr(content);
    const file = this.app.vault.getAbstractFileByPath(configPath);
    if (file) {
      await this.app.vault.modify(file, content);
    } else {
      await this.app.vault.adapter.write(configPath, content);
    }
  }

  getCurrentDay() {
    const now = new Date();
    const [endHour, endMinute] = (this.data.settings.dayEndTime || "04:00").split(":").map(Number);

    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const endMinutes = endHour * 60 + endMinute;

    // If current time is before day end time, use yesterday's date
    if (currentMinutes < endMinutes) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      return this.formatDate(yesterday);
    }

    return this.formatDate(now);
  }

  formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  parseDate(dateStr) {
    const [year, month, day] = dateStr.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  daysBetween(date1, date2) {
    const d1 = this.parseDate(date1);
    const d2 = this.parseDate(date2);
    return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24)) + 1;
  }

  // Returns the YYYY-MM-DD string for the Monday of the ISO week containing dateStr
  getISOWeekStart(dateStr) {
    const d = this.parseDate(dateStr);
    const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return this.formatDate(d);
  }

  // Returns array of 7 YYYY-MM-DD strings (Mon–Sun) for the week starting at weekStartStr
  getWeekDays(weekStartStr) {
    const days = [];
    const d = this.parseDate(weekStartStr);
    for (let i = 0; i < 7; i++) {
      days.push(this.formatDate(d));
      d.setDate(d.getDate() + 1);
    }
    return days;
  }

  // dayStr is optional — defaults to today. Pass a specific YYYY-MM-DD to remove
  // a past session (used when deselecting a weekly activity checkmark).
  async saveLog(activityId, state, dayStr = null) {
    // If vault data wasn't loaded at startup (common on mobile where file index
    // isn't ready), try loading it now before we write anything
    if (!this.vaultDataLoaded) {
      await this.loadVaultData();
    }
    this.vaultDataLoaded = true; // Explicit user action = real data worth saving
    const targetDay = dayStr || this.getCurrentDay();

    if (!this.data.logs[targetDay]) {
      this.data.logs[targetDay] = {};
    }

    // Track start date for this activity if not already set
    if (!this.data.activityStartDates[activityId]) {
      this.data.activityStartDates[activityId] = targetDay;
    }

    if (state === "none") {
      delete this.data.logs[targetDay][activityId];
    } else {
      this.data.logs[targetDay][activityId] = state;
    }

    this.calculateStats(activityId);
    await this.savePluginData();
  }

  async recalculateAllStats() {
    // Get all activity IDs that have ever been tracked
    const activityIds = new Set();

    for (const dateStr of Object.keys(this.data.logs)) {
      for (const activityId of Object.keys(this.data.logs[dateStr])) {
        activityIds.add(activityId);
      }
    }

    // Also include activities from start dates
    for (const activityId of Object.keys(this.data.activityStartDates)) {
      activityIds.add(activityId);
    }

    // Recalculate stats for each activity
    for (const activityId of activityIds) {
      this.calculateStats(activityId);
    }

    if (activityIds.size > 0) {
      await this.savePluginData();
    }
  }

  calculateStats(activityId) {
    const activity = this.activityConfigMap?.[activityId];
    if (activity?.frequency === "weekly") {
      this.calculateWeeklyStats(activityId, activity.weeklyTarget || 1);
      return;
    }

    const logs = this.data.logs;

    // If paused, freeze stats at the pause date (treat it as "today" for calculations)
    const pausedSince = this.data.pausedActivities?.[activityId];
    const realToday = this.getCurrentDay();
    const today = pausedSince && pausedSince <= realToday ? pausedSince : realToday;

    let currentStreak = 0;
    let longestStreak = 0;
    let totalSuccesses = 0;
    let totalDays = 0;
    let tempStreak = 0;

    // Find the start date for this activity
    let startDate = this.data.activityStartDates[activityId];

    // If no explicit start date, find the earliest log entry
    if (!startDate) {
      const datesWithActivity = Object.keys(logs)
        .filter(date => logs[date][activityId] !== undefined)
        .sort();

      if (datesWithActivity.length > 0) {
        startDate = datesWithActivity[0];
        this.data.activityStartDates[activityId] = startDate;
      }
    }

    // If still no start date, this activity hasn't been tracked yet
    if (!startDate) {
      this.data.stats[activityId] = {
        currentStreak: 0,
        longestStreak: 0,
        totalSuccesses: 0,
        totalDays: 0
      };
      return;
    }

    // Calculate total days from start date to today
    totalDays = this.daysBetween(startDate, today);
    if (totalDays < 0) totalDays = 0;

    // Calculate total successes
    for (const date of Object.keys(logs)) {
      if (logs[date][activityId] === "success") {
        totalSuccesses++;
      }
    }

    // Calculate current streak (consecutive successes going backwards)
    // If today hasn't been achieved yet, start from yesterday — today is still open
    // and should not break the streak until the day actually ends.
    let checkDate = this.parseDate(today);
    const startDateObj = this.parseDate(startDate);

    const todayLog = logs[today];
    if (!todayLog || todayLog[activityId] !== "success") {
      checkDate.setDate(checkDate.getDate() - 1);
    }

    while (checkDate >= startDateObj) {
      const dateStr = this.formatDate(checkDate);
      const log = logs[dateStr];

      if (log && log[activityId] === "success") {
        currentStreak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        // Either failed, missed, or no entry - streak broken
        break;
      }
    }

    // Calculate longest streak
    tempStreak = 0;
    let iterDate = new Date(startDateObj);

    while (iterDate <= this.parseDate(today)) {
      const dateStr = this.formatDate(iterDate);
      const log = logs[dateStr];

      if (log && log[dateStr] === "success") {
        tempStreak++;
        if (tempStreak > longestStreak) {
          longestStreak = tempStreak;
        }
      } else if (log && log[activityId] === "success") {
        tempStreak++;
        if (tempStreak > longestStreak) {
          longestStreak = tempStreak;
        }
      } else {
        // Failed or missed - streak resets
        tempStreak = 0;
      }

      iterDate.setDate(iterDate.getDate() + 1);
    }

    // Ensure current streak doesn't exceed longest
    if (currentStreak > longestStreak) {
      longestStreak = currentStreak;
    }

    this.data.stats[activityId] = {
      currentStreak,
      longestStreak,
      totalSuccesses,
      totalDays
    };
  }

  calculateWeeklyStats(activityId, weeklyTarget) {
    const logs = this.data.logs;

    // If paused, freeze stats at the pause date
    const pausedSince = this.data.pausedActivities?.[activityId];
    const realToday = this.getCurrentDay();
    const today = pausedSince && pausedSince <= realToday ? pausedSince : realToday;

    // Ensure start date is set
    let startDate = this.data.activityStartDates[activityId];
    if (!startDate) {
      const datesWithActivity = Object.keys(logs)
        .filter(date => logs[date][activityId] !== undefined)
        .sort();
      if (datesWithActivity.length > 0) {
        startDate = datesWithActivity[0];
        this.data.activityStartDates[activityId] = startDate;
      }
    }

    if (!startDate) {
      this.data.stats[activityId] = {
        currentStreak: 0, longestStreak: 0,
        totalSuccesses: 0, totalDays: 0,
        weeklySuccesses: 0, weeklyTarget, isWeekly: true
      };
      return;
    }

    // Count all individual sessions ever
    let totalSuccesses = 0;
    for (const date of Object.keys(logs)) {
      if (logs[date][activityId] === "success") totalSuccesses++;
    }

    // Enumerate all complete ISO weeks from start through last week
    // (current week is in-progress and never counts toward/against streak)
    const currentWeekStart = this.getISOWeekStart(today);
    const startWeekStart = this.getISOWeekStart(startDate);

    let currentStreak = 0;
    let longestStreak = 0;
    let weeklySuccesses = 0;
    let totalWeeks = 0;
    let tempStreak = 0;

    let wStart = startWeekStart;
    while (wStart < currentWeekStart) {
      const weekDays = this.getWeekDays(wStart);
      let sessions = 0;
      for (const day of weekDays) {
        if (logs[day] && logs[day][activityId] === "success") sessions++;
      }

      totalWeeks++;
      if (sessions >= weeklyTarget) {
        weeklySuccesses++;
        tempStreak++;
        if (tempStreak > longestStreak) longestStreak = tempStreak;
      } else {
        tempStreak = 0;
      }

      // Advance to next week
      const next = this.parseDate(wStart);
      next.setDate(next.getDate() + 7);
      wStart = this.formatDate(next);
    }
    currentStreak = tempStreak; // the run ending at the most recent complete week

    if (currentStreak > longestStreak) longestStreak = currentStreak;

    this.data.stats[activityId] = {
      currentStreak,
      longestStreak,
      totalSuccesses,
      totalDays: totalWeeks,     // reuse field: total complete weeks tracked
      weeklySuccesses,           // weeks where target was met
      weeklyTarget,
      isWeekly: true
    };
  }

  checkDayChange() {
    const currentDay = this.getCurrentDay();
    if (currentDay !== this.lastCheckedDay) {
      this.lastCheckedDay = currentDay;

      // Recalculate all stats and refresh UI
      this.recalculateAllStats().then(() => this.refreshAllTrackers());
    }
  }

  async refreshAllTrackers() {
    for (const el of this._trackerElements) {
      if (!el.isConnected) {
        this._trackerElements.delete(el);
        continue;
      }
      await this.renderTracker(el);
    }
  }

  onFileModified(file) {
    const configPath = this.data.settings.configFilePath || "Archive/streak-tracker-config.md";
    const dataPath = this.data.settings.dataFilePath || "Archive/streak-tracker-data.md";

    if (file.path !== configPath && file.path !== dataPath) return;

    // Debounce rapid sync writes
    if (this._reloadTimeout) clearTimeout(this._reloadTimeout);
    this._reloadTimeout = setTimeout(async () => {
      try {
        if (file.path === dataPath) {
          const content = await this.app.vault.adapter.read(dataPath);
          const readHash = this._hashStr(content);
          // If the hash matches what we last wrote, this is our own write
          // bouncing back from cloud sync — nothing to do.
          if (readHash === this._lastDataWriteHash) return;
          // Different content means another device wrote this — treat the
          // file as authoritative for past days.
          await this.incomingSyncFromFile(content);
        } else {
          const content = await this.app.vault.adapter.read(configPath);
          if (this._hashStr(content) === this._lastConfigWriteHash) return;
          await this.refreshAllTrackers();
        }
      } catch (e) {
        console.error("streak-tracker: onFileModified handler failed:", e);
      }
    }, 500);
  }

  getYearsWithData() {
    const years = new Set();
    const currentYear = new Date().getFullYear();
    years.add(currentYear); // Always include current year

    for (const dateStr of Object.keys(this.data.logs)) {
      const year = parseInt(dateStr.split("-")[0]);
      years.add(year);
    }

    return Array.from(years).sort((a, b) => b - a); // Descending order
  }

  async renderTracker(el) {
    this._trackerElements.add(el);

    // Prevent concurrent renders for the same element. If a render is already
    // in progress, mark a pending re-render and return — the in-progress render
    // will do one final pass once it finishes, using the latest data.
    if (!this._renderingEls) this._renderingEls = new WeakSet();
    if (!this._pendingRerender) this._pendingRerender = new WeakSet();
    if (this._renderingEls.has(el)) {
      this._pendingRerender.add(el);
      return;
    }
    this._renderingEls.add(el);

    const config = await this.loadActivityConfig();

    // Keep activityConfigMap in sync so calculateStats can find frequency info
    this.activityConfigMap = {};
    for (const a of config.activities) {
      this.activityConfigMap[a.id] = a;
    }

    // Render into a detached container first to avoid scroll jumps
    const container = document.createElement("div");
    container.className = "streak-tracker-container";

    // Secondary mode: hold modifier key while mouse is inside to reveal secondary actions
    const modifier = this.data.settings.secondaryModifier || "Alt";
    const onKeyDown = (e) => {
      if (!container.isConnected) {
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("keyup", onKeyUp);
        return;
      }
      if (e.key === modifier) container.classList.add("streak-secondary-mode");
    };
    const onKeyUp = (e) => {
      if (e.key === modifier) {
        container.classList.remove("streak-secondary-mode");
        if (!container.isConnected) {
          document.removeEventListener("keydown", onKeyDown);
          document.removeEventListener("keyup", onKeyUp);
        }
      }
    };
    container.addEventListener("mouseenter", () => {
      document.addEventListener("keydown", onKeyDown);
      document.addEventListener("keyup", onKeyUp);
    });
    container.addEventListener("mouseleave", () => {
      container.classList.remove("streak-secondary-mode");
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    });

    if (config.activities.length === 0) {
      container.createEl("p", {
        text: "No activities configured. Create an Archive/streak-tracker-config.md file in your vault.",
        cls: "streak-tracker-empty"
      });
    } else {
      const currentDay = this.getCurrentDay();
      const currentLog = this.data.logs[currentDay] || {};

      // Get current year for heatmap
      const currentYear = new Date().getFullYear();

      const dailyActivities = config.activities.filter(a => a.frequency !== "weekly");
      const weeklyActivities = config.activities.filter(a => a.frequency === "weekly");

      // Recalculate weekly stats now that activityConfigMap is populated
      for (const activity of weeklyActivities) {
        this.calculateWeeklyStats(activity.id, activity.weeklyTarget || 1);
      }

      // Daily heatmap — all activities including paused (historical logs are preserved)
      this.renderHeatmap(container, dailyActivities, currentYear);

      // Weekly heatmap (red, single row)
      if (weeklyActivities.length > 0) {
        this.renderWeeklyHeatmap(container, weeklyActivities, currentYear);
      }

      // Render activities
      const activitiesContainer = container.createDiv({ cls: "streak-activities" });

      if (dailyActivities.length > 0 && weeklyActivities.length > 0) {
        activitiesContainer.createEl("div", { text: "Daily", cls: "streak-section-label" });
      }
      for (const activity of dailyActivities) {
        this.renderActivity(activitiesContainer, activity, currentLog[activity.id]);
      }
      if (weeklyActivities.length > 0) {
        activitiesContainer.createEl("div", { text: "Weekly", cls: "streak-section-label" });
        for (const activity of weeklyActivities) {
          this.renderActivity(activitiesContainer, activity, currentLog[activity.id]);
        }
      }
    }

    // Atomic update
    el.replaceChildren(container);

    // Release lock; if a render was requested while we were in progress, do it now.
    this._renderingEls.delete(el);
    if (this._pendingRerender.has(el)) {
      this._pendingRerender.delete(el);
      await this.renderTracker(el);
    }
  }

  renderActivity(container, activity, currentState) {
    if (activity.frequency === "weekly") {
      this.renderWeeklyActivity(container, activity);
    } else {
      this.renderDailyActivity(container, activity, currentState);
    }
  }

  renderDailyActivity(container, activity, currentState) {
    const isPaused = !!(this.data.pausedActivities?.[activity.id]);
    const activityEl = container.createDiv({ cls: `streak-activity${isPaused ? " streak-activity-paused" : ""}` });

    // Header row with buttons, name, and stats all inline
    const headerRow = activityEl.createDiv({ cls: "streak-activity-header" });

    // Buttons (checkmark and X) on the left
    const buttonsEl = headerRow.createDiv({ cls: "streak-buttons" });

    const successBtn = buttonsEl.createEl("button", {
      text: "✓",
      cls: `streak-btn streak-btn-success streak-btn-primary ${currentState === "success" ? "streak-btn-active" : ""}`,
      attr: { title: "Mark as success" }
    });

    successBtn.addEventListener("click", async () => {
      const newState = currentState === "success" ? "none" : "success";
      await this.saveLog(activity.id, newState);

      const trackerEl = container.closest(".streak-tracker-container");
      if (trackerEl) await this.renderTracker(trackerEl.parentElement);
    });

    if (activity.canFail) {
      const failBtn = buttonsEl.createEl("button", {
        text: "✗",
        cls: `streak-btn streak-btn-fail streak-btn-primary ${currentState === "failed" ? "streak-btn-active" : ""}`,
        attr: { title: "Mark as failed" }
      });

      failBtn.addEventListener("click", async () => {
        const newState = currentState === "failed" ? "none" : "failed";
        await this.saveLog(activity.id, newState);

        const trackerEl = container.closest(".streak-tracker-container");
        if (trackerEl) await this.renderTracker(trackerEl.parentElement);
      });
    }

    // Secondary mode: pause/resume button (only visible when modifier is held)
    const pauseBtn = buttonsEl.createEl("button", {
      text: isPaused ? "▶" : "⏸",
      cls: "streak-btn streak-btn-pause streak-btn-secondary",
      attr: { title: isPaused ? "Resume activity" : "Pause activity" }
    });
    pauseBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!this.data.pausedActivities) this.data.pausedActivities = {};
      if (isPaused) {
        delete this.data.pausedActivities[activity.id];
      } else {
        this.data.pausedActivities[activity.id] = this.getCurrentDay();
      }
      await this.recalculateAllStats();
      await this.saveVaultData();
      await this.refreshAllTrackers();
    });

    this.renderActivityNameAndStats(activityEl, headerRow, activity, "daily");

    if (isPaused) {
      activityEl.createDiv({ cls: "streak-pause-overlay" });
    }
  }

  parseScheduledDays(scheduledDays) {
    const map = {
      sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2,
      wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5,
      sat: 6, saturday: 6
    };
    return scheduledDays.map(d => map[d.toLowerCase()]).filter(d => d !== undefined);
  }

  renderWeeklyActivity(container, activity) {
    const isPaused = !!(this.data.pausedActivities?.[activity.id]);
    const weeklyTarget = activity.weeklyTarget || 1;
    const today = this.getCurrentDay();
    const weekStart = this.getISOWeekStart(today);
    const weekDays = this.getWeekDays(weekStart);

    const activityEl = container.createDiv({ cls: `streak-activity${isPaused ? " streak-activity-paused" : ""}` });
    const headerRow = activityEl.createDiv({ cls: "streak-activity-header" });
    const buttonsEl = headerRow.createDiv({ cls: "streak-buttons streak-buttons-weekly" });

    let sessionCount = 0;

    if (activity.scheduledDays && activity.scheduledDays.length > 0) {
      const scheduledIndices = this.parseScheduledDays(activity.scheduledDays);
      const DAY_ABBR = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

      for (const dayDate of weekDays) {
        const d = this.parseDate(dayDate);
        const dayIndex = d.getDay();
        if (!scheduledIndices.includes(dayIndex)) continue;

        const dayLog = this.data.logs[dayDate]?.[activity.id];
        const isFuture = dayDate > today;
        const isPast = dayDate < today;

        const chip = buttonsEl.createEl("button", { cls: "streak-day-chip streak-btn-primary" });
        chip.createEl("span", { text: DAY_ABBR[dayIndex], cls: "streak-day-chip-label" });

        if (dayLog === "success") {
          chip.classList.add("streak-day-chip-success");
          chip.setAttribute("title", "Click to undo");
          chip.addEventListener("click", async () => {
            await this.saveLog(activity.id, "none", dayDate);
            await this.refreshAllTrackers();
          });
        } else if (isPast) {
          chip.classList.add("streak-day-chip-failed");
        } else if (isFuture) {
          chip.classList.add("streak-day-chip-future");
        } else {
          // Today, not yet logged
          chip.classList.add("streak-day-chip-today");
          chip.setAttribute("title", "Log today");
          chip.addEventListener("click", async () => {
            await this.saveLog(activity.id, "success", today);
            await this.refreshAllTrackers();
          });
        }
      }

      sessionCount = weekDays.filter(d => {
        const idx = this.parseDate(d).getDay();
        return scheduledIndices.includes(idx) && this.data.logs[d]?.[activity.id] === "success";
      }).length;
    } else {
      // Generic: N checkmark buttons
      const sessionsThisWeek = weekDays.filter(
        day => this.data.logs[day] && this.data.logs[day][activity.id] === "success"
      );
      sessionCount = sessionsThisWeek.length;
      const todayLogged = sessionsThisWeek.includes(today);

      for (let i = 0; i < weeklyTarget; i++) {
        const isActive = i < sessionCount;
        const isNext = i === sessionCount && !todayLogged;
        const cls = `streak-btn streak-btn-success streak-btn-primary${isActive ? " streak-btn-active" : ""}${!isActive && !isNext ? " streak-btn-locked" : ""}`;
        const btn = buttonsEl.createEl("button", {
          text: "✓",
          cls,
          attr: { title: isActive ? "Deselect this session" : isNext ? "Log a session" : "" }
        });

        if (isActive) {
          const idx = i;
          btn.addEventListener("click", async () => {
            await this.saveLog(activity.id, "none", sessionsThisWeek[idx]);
            const trackerEl = container.closest(".streak-tracker-container");
            if (trackerEl) await this.renderTracker(trackerEl.parentElement);
          });
        } else if (isNext) {
          btn.addEventListener("click", async () => {
            await this.saveLog(activity.id, "success", today);
            const trackerEl = container.closest(".streak-tracker-container");
            if (trackerEl) await this.renderTracker(trackerEl.parentElement);
          });
        }
        // locked buttons get no click handler
      }
    }

    // Secondary mode: pause/resume button (only visible when modifier is held)
    const pauseBtn = buttonsEl.createEl("button", {
      text: isPaused ? "▶" : "⏸",
      cls: "streak-btn streak-btn-pause streak-btn-secondary",
      attr: { title: isPaused ? "Resume activity" : "Pause activity" }
    });
    pauseBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!this.data.pausedActivities) this.data.pausedActivities = {};
      if (isPaused) {
        delete this.data.pausedActivities[activity.id];
      } else {
        this.data.pausedActivities[activity.id] = this.getCurrentDay();
      }
      await this.recalculateAllStats();
      await this.saveVaultData();
      await this.refreshAllTrackers();
    });

    this.renderActivityNameAndStats(activityEl, headerRow, activity, "weekly", sessionCount, weeklyTarget);

    if (isPaused) {
      activityEl.createDiv({ cls: "streak-pause-overlay" });
    }
  }

  // Shared helper: renders the activity name (with links/description) and stats area.
  // mode is "daily" or "weekly". weekSessionCount and weeklyTarget only used in weekly mode.
  renderActivityNameAndStats(activityEl, headerRow, activity, mode, weekSessionCount = 0, weeklyTarget = 1) {
    // Activity name with link support
    const nameEl = headerRow.createDiv({ cls: "streak-activity-name" });
    const nameParts = this.parseNameWithLinks(activity.name);
    const hasLinks = nameParts.some(p => p.isLink);

    // Apply link color as CSS variable if set
    if (hasLinks && this.data.settings.linkColor) {
      nameEl.style.setProperty("--streak-link-color", this.data.settings.linkColor);
    }

    // Description element (create early so we can reference it)
    let descriptionEl = null;
    if (activity.description) {
      descriptionEl = activityEl.createDiv({
        cls: "streak-activity-description collapsed"
      });
      const descTextEl = descriptionEl.createEl("p", {
        attr: { title: "Double-click to edit" }
      });
      this.renderDescriptionText(descTextEl, activity.description);
      descTextEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        this.enterDescriptionEditMode(descriptionEl, descTextEl, activity);
      });
    }

    // Render name parts
    for (const part of nameParts) {
      if (part.isLink) {
        const linkSpan = nameEl.createEl("span", {
          text: part.display,
          cls: "streak-name-link"
        });
        linkSpan.addEventListener("click", (e) => {
          e.stopPropagation();
          this.app.workspace.openLinkText(part.target, "");
        });
      } else {
        const textSpan = nameEl.createEl("span", {
          text: part.text,
          cls: "streak-name-text"
        });
        if (activity.description) {
          textSpan.addEventListener("click", (e) => {
            e.stopPropagation();
            descriptionEl.classList.toggle("collapsed");
          });
        }
      }
    }

    if (activity.description && !hasLinks) {
      nameEl.classList.add("clickable");
      nameEl.addEventListener("click", () => {
        descriptionEl.classList.toggle("collapsed");
      });
    } else if (activity.description && hasLinks) {
      nameEl.classList.add("clickable-parts");
    }

    // Stats display
    const stats = this.data.stats[activity.id] || {
      currentStreak: 0, longestStreak: 0,
      totalSuccesses: 0, totalDays: 0
    };

    const statsEl = headerRow.createDiv({ cls: "streak-stats" });

    if (mode === "weekly") {
      // Weekly stats: streaks are in weeks, rate is successful-weeks/total-weeks
      const weeklySuccesses = stats.weeklySuccesses ?? 0;
      const totalWeeks = stats.totalDays ?? 0;
      const weekRate = totalWeeks > 0 ? ((weeklySuccesses / totalWeeks) * 100).toFixed(0) : "0";

      statsEl.createEl("span", {
        text: `🔥 ${stats.currentStreak}`,
        cls: "streak-stat streak-current",
        attr: { title: "Current streak (weeks)" }
      });
      statsEl.createEl("span", {
        text: `🔗 ${stats.longestStreak}`,
        cls: "streak-stat streak-longest",
        attr: { title: "Longest streak (weeks)" }
      });
      statsEl.createEl("span", {
        text: `✅ ${weeklySuccesses}/${totalWeeks} : ${weekRate}%`,
        cls: "streak-stat streak-total",
        attr: { title: "Weeks target met / Total weeks tracked" }
      });
      statsEl.createEl("span", {
        text: `${weekSessionCount}/${weeklyTarget} this week`,
        cls: "streak-stat streak-week-progress",
        attr: { title: "Sessions logged this week" }
      });
    } else {
      // Daily stats
      const successRate = stats.totalDays > 0 ? stats.totalSuccesses / stats.totalDays : 0;

      let rateColorCls = "";
      if (successRate >= 0.90) {
        rateColorCls = "streak-rate-green";
      } else if (successRate >= 0.70) {
        rateColorCls = "streak-rate-orange";
      } else if (successRate < 0.30) {
        rateColorCls = "streak-rate-red";
      } else {
        rateColorCls = "streak-rate-blue";
      }

      statsEl.createEl("span", {
        text: `🔥 ${stats.currentStreak}`,
        cls: "streak-stat streak-current",
        attr: { title: "Current streak" }
      });
      statsEl.createEl("span", {
        text: `🔗 ${stats.longestStreak}`,
        cls: "streak-stat streak-longest",
        attr: { title: "Longest streak" }
      });
      const totalEl = statsEl.createEl("span", {
        cls: "streak-stat streak-total",
        attr: { title: "Total successes / Total days tracked" }
      });
      totalEl.appendText(`✅ ${stats.totalSuccesses}/${stats.totalDays} : `);
      totalEl.createEl("span", {
        text: `${successRate.toFixed(2)}%`,
        cls: rateColorCls
      });
    }
  }

  enterDescriptionEditMode(descriptionEl, descTextEl, activity) {
    const originalText = activity.description || "";
    const textarea = document.createElement("textarea");
    textarea.className = "streak-description-editor";
    textarea.value = originalText;
    descTextEl.replaceWith(textarea);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const restoreText = (text) => {
      const p = document.createElement("p");
      p.title = "Double-click to edit";
      this.renderDescriptionText(p, text);
      p.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        activity.description = text;
        this.enterDescriptionEditMode(descriptionEl, p, activity);
      });
      textarea.replaceWith(p);
    };

    const commit = async () => {
      const newText = textarea.value.trim();
      if (newText !== originalText) {
        const config = await this.loadActivityConfig();
        const act = config.activities.find(a => a.id === activity.id);
        if (act) {
          if (newText) {
            act.description = newText;
          } else {
            delete act.description;
          }
          await this.saveActivityConfig(config);
          activity.description = newText;
        }
      }
      restoreText(newText || originalText);
    };

    const revert = () => {
      restoreText(originalText);
    };

    textarea.addEventListener("blur", commit);
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        textarea.removeEventListener("blur", commit);
        revert();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        textarea.removeEventListener("blur", commit);
        commit();
      }
    });
  }

  renderHeatmap(container, activities, year, replaceEl = null) {
    const heatmapContainer = document.createElement("div");
    heatmapContainer.className = "streak-heatmap-container";

    // Year navigation - only show if more than one year of data
    const yearsWithData = this.getYearsWithData();
    const showYearNav = yearsWithData.length > 1;

    if (showYearNav) {
      const navEl = heatmapContainer.createDiv({ cls: "streak-heatmap-nav" });

      const prevBtn = navEl.createEl("button", {
        text: "‹",
        cls: "streak-nav-btn",
        attr: { title: "Previous year" }
      });

      const yearLabel = navEl.createEl("span", {
        text: year.toString(),
        cls: "streak-year-label"
      });

      const nextBtn = navEl.createEl("button", {
        text: "›",
        cls: "streak-nav-btn",
        attr: { title: "Next year" }
      });

      const currentYear = new Date().getFullYear();

      // Disable next if we're at current year
      if (year >= currentYear) {
        nextBtn.classList.add("streak-nav-btn-disabled");
      } else {
        nextBtn.addEventListener("click", () => {
          this.renderHeatmap(container, activities, year + 1, heatmapContainer);
        });
      }

      // Disable prev if no earlier data exists
      const earliestYear = Math.min(...yearsWithData);
      if (year <= earliestYear) {
        prevBtn.classList.add("streak-nav-btn-disabled");
      } else {
        prevBtn.addEventListener("click", () => {
          this.renderHeatmap(container, activities, year - 1, heatmapContainer);
        });
      }
    }

    // Month labels
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthLabels = heatmapContainer.createDiv({ cls: "streak-heatmap-months" });

    for (const month of months) {
      monthLabels.createEl("span", { text: month, cls: "streak-heatmap-month" });
    }

    // Create the grid wrapper
    const heatmapWrapper = heatmapContainer.createDiv({ cls: "streak-heatmap-wrapper" });

    // Day labels
    const dayLabels = heatmapWrapper.createDiv({ cls: "streak-heatmap-days" });
    const days = ["", "Mon", "", "Wed", "", "Fri", ""];
    for (const day of days) {
      dayLabels.createEl("span", { text: day, cls: "streak-heatmap-day" });
    }

    // Create the grid
    const grid = heatmapWrapper.createDiv({ cls: "streak-heatmap-grid" });

    // Start from Jan 1 of the year
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31);

    // Calculate total weeks in the year
    const startDay = startDate.getDay(); // Day of week for Jan 1
    const totalDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
    const totalWeeks = Math.ceil((totalDays + startDay) / 7);

    const dailyActivities = activities.filter(a => a.frequency !== "weekly");
    let currentDate = new Date(startDate);

    for (let week = 0; week < totalWeeks; week++) {
      const weekCol = grid.createDiv({ cls: "streak-heatmap-week" });

      for (let day = 0; day < 7; day++) {
        const cell = weekCol.createDiv({ cls: "streak-heatmap-cell" });

        // Skip days before Jan 1 in first week
        if (week === 0 && day < startDay) {
          cell.classList.add("streak-heatmap-empty");
          continue;
        }

        // Skip days after Dec 31
        if (currentDate > endDate) {
          cell.classList.add("streak-heatmap-empty");
          continue;
        }

        const dateStr = this.formatDate(currentDate);
        const log = this.data.logs[dateStr] || {};

        // Calculate completion percentage using only activities that existed on this date
        let successCount = 0;
        let historicalCount = 0;

        for (const activity of dailyActivities) {
          const startedOn = this.data.activityStartDates[activity.id];
          if (startedOn && startedOn > dateStr) continue; // activity didn't exist yet
          historicalCount++;
          if (log[activity.id] === "success") {
            successCount++;
          }
        }

        // Set intensity level
        let level = 0;
        if (historicalCount > 0) {
          const percentage = (successCount / historicalCount) * 100;
          if (percentage === 100) {
            level = 5;
          } else if (percentage >= 76) {
            level = 4;
          } else if (percentage >= 51) {
            level = 3;
          } else if (percentage >= 26) {
            level = 2;
          } else if (percentage >= 1) {
            level = 1;
          }
        }

        cell.classList.add(`streak-heatmap-level-${level}`);
        cell.setAttribute("data-date", dateStr);
        cell.setAttribute("title", `${dateStr}: ${successCount}/${historicalCount} activities`);

        // Apply custom color if set
        if (this.data.settings.heatmapColor && level > 0) {
          const opacity = level * 0.2;
          cell.style.backgroundColor = this.hexToRgba(this.data.settings.heatmapColor, opacity);
        }

        currentDate.setDate(currentDate.getDate() + 1);
      }
    }

    if (replaceEl) {
      replaceEl.replaceWith(heatmapContainer);
    } else {
      container.appendChild(heatmapContainer);
    }
  }

  getWeeklyYearsWithData(weeklyActivities) {
    const years = new Set();
    const currentYear = new Date().getFullYear();
    years.add(currentYear);
    for (const activity of weeklyActivities) {
      const startDate = this.data.activityStartDates[activity.id];
      if (startDate) years.add(parseInt(startDate.split("-")[0]));
    }
    for (const dateStr of Object.keys(this.data.logs)) {
      const log = this.data.logs[dateStr];
      const y = parseInt(dateStr.split("-")[0]);
      for (const activity of weeklyActivities) {
        if (log[activity.id] !== undefined) { years.add(y); break; }
      }
    }
    return Array.from(years).sort((a, b) => b - a);
  }

  renderWeeklyHeatmap(container, weeklyActivities, year, replaceEl = null) {
    const heatmapContainer = document.createElement("div");
    heatmapContainer.className = "streak-weekly-heatmap-container";

    const currentYear = new Date().getFullYear();
    const weeklyYears = this.getWeeklyYearsWithData(weeklyActivities);
    const showNav = weeklyYears.length > 1;

    if (showNav) {
      const navEl = heatmapContainer.createDiv({ cls: "streak-heatmap-nav" });
      const prevBtn = navEl.createEl("button", { text: "‹", cls: "streak-nav-btn", attr: { title: "Previous year" } });
      navEl.createEl("span", { text: `${year} weekly`, cls: "streak-year-label" });
      const nextBtn = navEl.createEl("button", { text: "›", cls: "streak-nav-btn", attr: { title: "Next year" } });

      if (year >= currentYear) nextBtn.classList.add("streak-nav-btn-disabled");
      else nextBtn.addEventListener("click", () => {
        this.renderWeeklyHeatmap(container, weeklyActivities, year + 1, heatmapContainer);
      });

      const earliestYear = Math.min(...weeklyYears);
      if (year <= earliestYear) prevBtn.classList.add("streak-nav-btn-disabled");
      else prevBtn.addEventListener("click", () => {
        this.renderWeeklyHeatmap(container, weeklyActivities, year - 1, heatmapContainer);
      });
    }

    // Month labels
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthLabels = heatmapContainer.createDiv({ cls: "streak-heatmap-months streak-weekly-months" });
    for (const month of months) {
      monthLabels.createEl("span", { text: month, cls: "streak-heatmap-month" });
    }

    // Single row of week cells
    const row = heatmapContainer.createDiv({ cls: "streak-weekly-heatmap-row" });

    const jan1 = this.formatDate(new Date(year, 0, 1));
    const dec31 = this.formatDate(new Date(year, 11, 31));
    let wStart = this.getISOWeekStart(jan1);

    while (wStart <= dec31) {
      const weekDays = this.getWeekDays(wStart);
      const wEnd = weekDays[6];
      const cell = row.createDiv({ cls: "streak-weekly-cell" });

      let completedCount = 0;
      let historicalCount = 0;

      for (const activity of weeklyActivities) {
        const startedOn = this.data.activityStartDates[activity.id];
        if (startedOn && startedOn > wEnd) continue; // activity didn't exist yet
        historicalCount++;
        const weeklyTarget = activity.weeklyTarget || 1;
        let sessions = 0;
        for (const day of weekDays) {
          if (this.data.logs[day] && this.data.logs[day][activity.id] === "success") sessions++;
        }
        if (sessions >= weeklyTarget) completedCount++;
      }

      let level = 0;
      if (historicalCount > 0) {
        const pct = (completedCount / historicalCount) * 100;
        if (pct === 100) level = 5;
        else if (pct >= 76) level = 4;
        else if (pct >= 51) level = 3;
        else if (pct >= 26) level = 2;
        else if (pct >= 1) level = 1;
      }

      cell.classList.add(`streak-weekly-level-${level}`);
      const wEndDate = this.parseDate(wStart);
      wEndDate.setDate(wEndDate.getDate() + 6);
      const fmtDate = (d) => {
        const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        return `${months[d.getMonth()]} ${d.getDate()}`;
      };
      const wStartDate = this.parseDate(wStart);
      const rangeLabel = `${fmtDate(wStartDate)} – ${fmtDate(wEndDate)}`;
      cell.setAttribute("title", `${rangeLabel}: ${completedCount}/${historicalCount} activities met target`);

      const next = this.parseDate(wStart);
      next.setDate(next.getDate() + 7);
      wStart = this.formatDate(next);
    }

    if (replaceEl) {
      replaceEl.replaceWith(heatmapContainer);
    } else {
      container.appendChild(heatmapContainer);
    }
  }

  hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  renderDescriptionText(el, text) {
    while (el.firstChild) el.removeChild(el.firstChild);
    const lines = (text || "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const parts = this.parseNameWithLinks(lines[i]);
      for (const part of parts) {
        if (part.isLink) {
          const span = document.createElement("span");
          span.textContent = part.display;
          span.className = "streak-name-link";
          if (this.data.settings.linkColor) {
            span.style.setProperty("--streak-link-color", this.data.settings.linkColor);
          }
          span.addEventListener("click", (e) => {
            e.stopPropagation();
            this.app.workspace.openLinkText(part.target, "");
          });
          el.appendChild(span);
        } else if (part.text) {
          el.appendChild(document.createTextNode(part.text));
        }
      }
      if (i < lines.length - 1) {
        el.appendChild(document.createElement("br"));
      }
    }
  }

  parseNameWithLinks(name) {
    const parts = [];
    const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(name)) !== null) {
      // Add text before the link
      if (match.index > lastIndex) {
        parts.push({ isLink: false, text: name.slice(lastIndex, match.index) });
      }

      // Add the link
      const target = match[1]; // The actual link target
      const display = match[2] || match[1]; // Display text (alias) or target
      parts.push({ isLink: true, target, display });

      lastIndex = regex.lastIndex;
    }

    // Add remaining text after last link
    if (lastIndex < name.length) {
      parts.push({ isLink: false, text: name.slice(lastIndex) });
    }

    // If no parts were found, the whole name is plain text
    if (parts.length === 0) {
      parts.push({ isLink: false, text: name });
    }

    return parts;
  }
}

class StreakTrackerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Streak Tracker Settings" });

    new Setting(containerEl)
      .setName("Day End Time")
      .setDesc("When does the 'day' end? (HH:MM format, 24-hour). Activities before this time count for the previous day.")
      .addText(text => text
        .setPlaceholder("04:00")
        .setValue(this.plugin.data.settings.dayEndTime)
        .onChange(async (value) => {
          // Validate time format
          if (/^\d{2}:\d{2}$/.test(value)) {
            this.plugin.data.settings.dayEndTime = value;
            await this.plugin.savePluginData();
          }
        }));

    new Setting(containerEl)
      .setName("Heatmap Color")
      .setDesc("Base color for the contribution heatmap (leave empty for theme default)")
      .addText(text => text
        .setPlaceholder("#22c55e")
        .setValue(this.plugin.data.settings.heatmapColor || "")
        .onChange(async (value) => {
          this.plugin.data.settings.heatmapColor = value || null;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Config File Path")
      .setDesc("Path to the activity configuration JSON file (relative to vault root)")
      .addText(text => text
        .setPlaceholder("Archive/streak-tracker-config.md")
        .setValue(this.plugin.data.settings.configFilePath)
        .onChange(async (value) => {
          this.plugin.data.settings.configFilePath = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Data File Path")
      .setDesc("Path to the streak data file (logs, stats) in the vault. Syncs across devices.")
      .addText(text => text
        .setPlaceholder("Archive/streak-tracker-data.md")
        .setValue(this.plugin.data.settings.dataFilePath)
        .onChange(async (value) => {
          this.plugin.data.settings.dataFilePath = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Refresh UI")
      .setDesc("Reload streak data from the vault file and refresh all tracker views. Use this if the UI seems out of sync after syncing from another device.")
      .addButton(button => button
        .setButtonText("Refresh")
        .onClick(async () => {
          await this.plugin.loadVaultData();
          await this.plugin.recalculateAllStats();
          await this.plugin.refreshAllTrackers();
          new Notice("Streak tracker UI refreshed from vault data.");
        }));

    new Setting(containerEl)
      .setName("Force Load from File")
      .setDesc("Discard all in-memory data and reload exactly what's in the data file. Use this if the plugin isn't picking up an existing data file.")
      .addButton(button => button
        .setButtonText("Force Load")
        .setWarning()
        .onClick(async () => {
          const dataPath = this.plugin.data.settings.dataFilePath || "Archive/streak-tracker-data.md";
          const exists = await this.plugin.app.vault.adapter.exists(dataPath);
          if (!exists) {
            new Notice(`Data file not found at: ${dataPath}`);
            return;
          }
          try {
            const content = await this.plugin.app.vault.adapter.read(dataPath);
            const vaultData = JSON.parse(content);
            this.plugin.data.logs = vaultData.logs || {};
            this.plugin.data.stats = vaultData.stats || {};
            this.plugin.data.activityStartDates = vaultData.activityStartDates || {};
            this.plugin.vaultDataLoaded = true;
            await this.plugin.recalculateAllStats();
            await this.plugin.refreshAllTrackers();
            new Notice("Streak data force-loaded from file.");
          } catch (e) {
            new Notice(`Failed to load data file: ${e.message}`);
          }
        }));

    new Setting(containerEl)
      .setName("Link Color")
      .setDesc("Color for linked notes in activity names (hex format)")
      .addText(text => text
        .setPlaceholder("#8b5cf6")
        .setValue(this.plugin.data.settings.linkColor || "")
        .onChange(async (value) => {
          this.plugin.data.settings.linkColor = value || "#8b5cf6";
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Secondary action modifier")
      .setDesc("Hold this key while hovering over the tracker to reveal secondary actions (e.g. pause/resume an activity).")
      .addDropdown(drop => drop
        .addOption("Alt", "Alt / Option (⌥)")
        .addOption("Control", "Ctrl (^)")
        .addOption("Shift", "Shift (⇧)")
        .addOption("Meta", "Cmd / Win (⌘)")
        .setValue(this.plugin.data.settings.secondaryModifier || "Alt")
        .onChange(async (value) => {
          this.plugin.data.settings.secondaryModifier = value;
          await this.plugin.savePluginData();
        }));
  }
}

module.exports = StreakTrackerPlugin;
