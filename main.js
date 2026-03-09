const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");

const DEFAULT_SETTINGS = {
  dayEndTime: "06:59",
  heatmapColor: null,
  configFilePath: "Archive/streak-tracker-config.md",
  dataFilePath: "Archive/streak-tracker-data.md",
  linkColor: "#8ECCDF" // Light blue default for links
};

const DEFAULT_DATA = {
  settings: DEFAULT_SETTINGS,
  logs: {},
  stats: {},
  activityStartDates: {} // Track when each activity started being tracked
};

class StreakTrackerPlugin extends Plugin {
  async onload() {
    this.vaultDataLoaded = false;
    this._trackerElements = new Set();
    this._lastSaveTime = 0;
    this._reloadTimeout = null;

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

      // Stats will be recalculated from merged logs
      this.data.stats = vaultData.stats || {};
      this.vaultDataLoaded = true;
      return true;
    } catch (e) {
      console.error("Failed to load streak tracker vault data:", e);
      return false;
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
      activityStartDates: this.data.activityStartDates
    };
    this._lastSaveTime = Date.now();
    await this.app.vault.adapter.write(dataPath, JSON.stringify(vaultData, null, 2));
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

  getCurrentDay() {
    const now = new Date();
    const [endHour, endMinute] = (this.data.settings.dayEndTime || "06:59").split(":").map(Number);

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

  async saveLog(activityId, state) {
    // If vault data wasn't loaded at startup (common on mobile where file index
    // isn't ready), try loading it now before we write anything
    if (!this.vaultDataLoaded) {
      await this.loadVaultData();
    }
    this.vaultDataLoaded = true; // Explicit user action = real data worth saving
    const currentDay = this.getCurrentDay();

    if (!this.data.logs[currentDay]) {
      this.data.logs[currentDay] = {};
    }

    // Track start date for this activity if not already set
    if (!this.data.activityStartDates[activityId]) {
      this.data.activityStartDates[activityId] = currentDay;
    }

    if (state === "none") {
      delete this.data.logs[currentDay][activityId];
    } else {
      this.data.logs[currentDay][activityId] = state;
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
    const logs = this.data.logs;

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

    const today = this.getCurrentDay();

    // Calculate total days from start date to today
    totalDays = this.daysBetween(startDate, today);
    if (totalDays < 0) totalDays = 0;

    // Calculate total successes
    for (const date of Object.keys(logs)) {
      if (logs[date][activityId] === "success") {
        totalSuccesses++;
      }
    }

    // Calculate current streak (consecutive successes from today going backwards)
    let checkDate = this.parseDate(today);
    const startDateObj = this.parseDate(startDate);

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

    // Ignore self-triggered modifications
    if (Date.now() - this._lastSaveTime < 2000) return;

    // Debounce rapid sync writes
    if (this._reloadTimeout) clearTimeout(this._reloadTimeout);
    this._reloadTimeout = setTimeout(async () => {
      if (file.path === dataPath) {
        await this.loadVaultData();
      }
      await this.refreshAllTrackers();
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

    const config = await this.loadActivityConfig();
    
    // Render into a detached container first to avoid scroll jumps
    const container = document.createElement("div");
    container.className = "streak-tracker-container";

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

      // Render heatmap first (above activities)
      this.renderHeatmap(container, config.activities, currentYear);

      // Render activities
      const activitiesContainer = container.createDiv({ cls: "streak-activities" });

      for (const activity of config.activities) {
        this.renderActivity(activitiesContainer, activity, currentLog[activity.id]);
      }
    }

    // Atomic update
    el.replaceChildren(container);
  }

  renderActivity(container, activity, currentState) {
    const activityEl = container.createDiv({ cls: "streak-activity" });

    // Header row with buttons, name, and stats all inline
    const headerRow = activityEl.createDiv({ cls: "streak-activity-header" });

    // Buttons (checkmark and X) on the left
    const buttonsEl = headerRow.createDiv({ cls: "streak-buttons" });

    const successBtn = buttonsEl.createEl("button", {
      text: "✓",
      cls: `streak-btn streak-btn-success ${currentState === "success" ? "streak-btn-active" : ""}`,
      attr: { title: "Mark as success" }
    });

    successBtn.addEventListener("click", async () => {
      const newState = currentState === "success" ? "none" : "success";
      await this.saveLog(activity.id, newState);

      // Refresh the view
      const trackerEl = container.closest(".streak-tracker-container");
      if (trackerEl) {
        const parentEl = trackerEl.parentElement;
        await this.renderTracker(parentEl);
      }
    });

    if (activity.canFail) {
      const failBtn = buttonsEl.createEl("button", {
        text: "✗",
        cls: `streak-btn streak-btn-fail ${currentState === "failed" ? "streak-btn-active" : ""}`,
        attr: { title: "Mark as failed" }
      });

      failBtn.addEventListener("click", async () => {
        const newState = currentState === "failed" ? "none" : "failed";
        await this.saveLog(activity.id, newState);

        // Refresh the view
        const trackerEl = container.closest(".streak-tracker-container");
        if (trackerEl) {
          const parentEl = trackerEl.parentElement;
          await this.renderTracker(parentEl);
        }
      });
    }

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
      descriptionEl.createEl("p", { text: activity.description });
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

    // If has description but no links, make whole name clickable
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
      currentStreak: 0,
      longestStreak: 0,
      totalSuccesses: 0,
      totalDays: 0
    };

    const statsEl = headerRow.createDiv({ cls: "streak-stats" });
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

    const successRate = stats.totalDays > 0 ? stats.totalSuccesses / stats.totalDays : 0;
    const successRateText = successRate.toFixed(2);

    let rateColorCls = "";
    if (successRate >= 0.95) {
      rateColorCls = " streak-rate-green";
    } else if (successRate >= 0.75) {
      rateColorCls = " streak-rate-orange";
    }

    statsEl.createEl("span", {
      text: `✅ ${stats.totalSuccesses}/${stats.totalDays} : ${successRateText}%`,
      cls: `streak-stat streak-total${rateColorCls}`,
      attr: { title: "Total successes / Total days tracked" }
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

    const activityCount = activities.length;
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

        // Calculate completion percentage
        let successCount = 0;
        let trackedCount = 0;

        for (const activity of activities) {
          if (log[activity.id] !== undefined) {
            trackedCount++;
            if (log[activity.id] === "success") {
              successCount++;
            }
          }
        }

        // Set intensity level
        let level = 0;
        if (trackedCount > 0) {
          const percentage = (successCount / activityCount) * 100;
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
        cell.setAttribute("title", `${dateStr}: ${successCount}/${activityCount} activities`);

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

  hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
        .setPlaceholder("06:59")
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
      .setName("Link Color")
      .setDesc("Color for linked notes in activity names (hex format)")
      .addText(text => text
        .setPlaceholder("#8b5cf6")
        .setValue(this.plugin.data.settings.linkColor || "")
        .onChange(async (value) => {
          this.plugin.data.settings.linkColor = value || "#8b5cf6";
          await this.plugin.savePluginData();
        }));
  }
}

module.exports = StreakTrackerPlugin;
