import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  type Routine,
  type SchedulePattern,
  type ExecutionLimit,
  type RoutineAction,
} from "../routines/routinesModel";
import { routinesAdapter } from "../bridge/routines";
import "./RoutinesPanel.css";

export interface RoutineTerminalOption {
  id: string;
  name: string;
  isManager?: boolean;
}

export interface RoutinesPanelProps {
  onClose?: () => void;
  workspacePath?: string;
  availableTerminalIds?: string[];
  availableTerminals?: RoutineTerminalOption[];
}

function getDefaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function formatIsoForDateTimeInput(timestampMs: number): string {
  const date = new Date(timestampMs);
  const tzOffset = date.getTimezoneOffset() * 60000;
  const localISOTime = new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
  return localISOTime;
}

export const RoutinesPanel: React.FC<RoutinesPanelProps> = ({
  onClose,
  workspacePath = "workspace.json",
  availableTerminalIds = [],
  availableTerminals = [],
}) => {
  // Normalize terminal options (prefer availableTerminals, fallback to availableTerminalIds)
  const normalizedTerminals: RoutineTerminalOption[] =
    availableTerminals.length > 0
      ? availableTerminals
      : availableTerminalIds.map((id) => ({ id, name: id }));

  const defaultTerminalId = normalizedTerminals[0]?.id || "";

  const [routines, setRoutines] = useState<Routine[]>([]);
  const [selectedRoutine, setSelectedRoutine] = useState<Routine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const previousFocusedElementRef = useRef<HTMLElement | null>(null);

  // Form State
  const [name, setName] = useState("");
  const [targetTerminalId, setTargetTerminalId] = useState(defaultTerminalId);
  const [actionKind, setActionKind] = useState<"command" | "reminder">("command");
  const [actionValue, setActionValue] = useState("");
  const [scheduleKind, setScheduleKind] = useState<"once" | "every" | "daily" | "weekly">("every");

  const [onceDateTime, setOnceDateTime] = useState<string>(
    formatIsoForDateTimeInput(Date.now() + 3600000),
  );
  const [intervalSeconds, setIntervalSeconds] = useState(300);
  const [dailyHour, setDailyHour] = useState(9);
  const [dailyMinute, setDailyMinute] = useState(0);
  const [timeZone, setTimeZone] = useState(getDefaultTimeZone());
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 2, 3, 4, 5]); // Mon-Fri default

  const [limitKind, setLimitKind] = useState<"indefinite" | "maxCount" | "untilTimestamp">("indefinite");
  const [maxCount, setMaxCount] = useState(10);
  const [untilDateTime, setUntilDateTime] = useState<string>(
    formatIsoForDateTimeInput(Date.now() + 86400000 * 7),
  );

  const [preRunScript, setPreRunScript] = useState("");
  const [noNotify, setNoNotify] = useState(false);

  const fetchRoutines = useCallback(async () => {
    try {
      await routinesAdapter.setWorkspace(workspacePath);
      const list = await routinesAdapter.listRoutines();
      setRoutines(list);
    } catch (err) {
      setError(String(err));
    }
  }, [workspacePath]);

  useEffect(() => {
    void fetchRoutines();
  }, [fetchRoutines]);

  // Setup Event Listeners for status and reminders
  useEffect(() => {
    let unlistenStatus: (() => void) | undefined;
    let unlistenReminder: (() => void) | undefined;

    const setupListeners = async () => {
      if (routinesAdapter.onStatusEvent) {
        unlistenStatus = await routinesAdapter.onStatusEvent((payload) => {
          setStatusMessage(`Routine '${payload.routineId}' status: ${payload.status}`);
          void fetchRoutines();
        });
      }
      if (routinesAdapter.onReminderEvent) {
        unlistenReminder = await routinesAdapter.onReminderEvent((payload) => {
          setStatusMessage(`🔔 Reminder for ${payload.targetTerminalId}: ${payload.message}`);
          void fetchRoutines();
        });
      }
    };

    void setupListeners();

    return () => {
      unlistenStatus?.();
      unlistenReminder?.();
    };
  }, [fetchRoutines]);

  // Accessibility: Focus Trap & Restore Focus
  useEffect(() => {
    previousFocusedElementRef.current = document.activeElement as HTMLElement | null;
    titleInputRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose) {
        onClose();
      }

      if (e.key === "Tab" && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocusedElementRef.current?.focus();
    };
  }, [onClose]);

  const resetForm = useCallback(() => {
    setSelectedRoutine(null);
    setName("");
    setTargetTerminalId(defaultTerminalId);
    setActionKind("command");
    setActionValue("");
    setScheduleKind("every");
    setOnceDateTime(formatIsoForDateTimeInput(Date.now() + 3600000));
    setIntervalSeconds(300);
    setDailyHour(9);
    setDailyMinute(0);
    setTimeZone(getDefaultTimeZone());
    setSelectedDays([1, 2, 3, 4, 5]);
    setLimitKind("indefinite");
    setMaxCount(10);
    setUntilDateTime(formatIsoForDateTimeInput(Date.now() + 86400000 * 7));
    setPreRunScript("");
    setNoNotify(false);
    setError(null);
  }, [defaultTerminalId]);

  const handleEditSelect = (routine: Routine) => {
    setSelectedRoutine(routine);
    setName(routine.name);
    setTargetTerminalId(routine.targetTerminalId);
    if (routine.action.kind === "command") {
      setActionKind("command");
      setActionValue(routine.action.command);
    } else {
      setActionKind("reminder");
      setActionValue(routine.action.reminder);
    }

    setScheduleKind(routine.schedule.kind);
    if (routine.schedule.kind === "once") {
      setOnceDateTime(formatIsoForDateTimeInput(routine.schedule.timestampMs));
    } else if (routine.schedule.kind === "every") {
      setIntervalSeconds(routine.schedule.intervalSeconds);
    } else if (routine.schedule.kind === "daily") {
      setDailyHour(routine.schedule.hour);
      setDailyMinute(routine.schedule.minute);
      setTimeZone(routine.schedule.timeZone || getDefaultTimeZone());
    } else if (routine.schedule.kind === "weekly") {
      setSelectedDays(routine.schedule.daysOfWeek);
      setDailyHour(routine.schedule.hour);
      setDailyMinute(routine.schedule.minute);
      setTimeZone(routine.schedule.timeZone || getDefaultTimeZone());
    }

    setLimitKind(routine.limit.kind);
    if (routine.limit.kind === "maxCount") {
      setMaxCount(routine.limit.maxCount);
    } else if (routine.limit.kind === "untilTimestamp") {
      setUntilDateTime(formatIsoForDateTimeInput(routine.limit.untilTimestampMs));
    }

    setPreRunScript(routine.preRunScript || "");
    setNoNotify(routine.noNotify);
    setError(null);
  };

  const handleSaveForm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const action: RoutineAction =
      actionKind === "command"
        ? { kind: "command", command: actionValue }
        : { kind: "reminder", reminder: actionValue };

    let schedule: SchedulePattern;
    if (scheduleKind === "once") {
      const ts = new Date(onceDateTime).getTime();
      if (isNaN(ts) || ts <= 0) {
        setError("Invalid Once date/time value");
        return;
      }
      schedule = { kind: "once", timestampMs: ts };
    } else if (scheduleKind === "every") {
      schedule = { kind: "every", intervalSeconds };
    } else if (scheduleKind === "daily") {
      schedule = { kind: "daily", hour: dailyHour, minute: dailyMinute, timeZone };
    } else {
      schedule = {
        kind: "weekly",
        daysOfWeek: selectedDays,
        hour: dailyHour,
        minute: dailyMinute,
        timeZone,
      };
    }

    let limit: ExecutionLimit;
    if (limitKind === "maxCount") {
      limit = { kind: "maxCount", maxCount };
    } else if (limitKind === "untilTimestamp") {
      const untilTs = new Date(untilDateTime).getTime();
      if (isNaN(untilTs) || untilTs <= 0) {
        setError("Invalid Until date/time value");
        return;
      }
      limit = { kind: "untilTimestamp", untilTimestampMs: untilTs };
    } else {
      limit = { kind: "indefinite" };
    }

    // Preserve metadata if editing existing routine
    const newOrUpdated: Routine = selectedRoutine
      ? {
          ...selectedRoutine,
          name,
          targetTerminalId,
          action,
          schedule,
          limit,
          preRunScript: preRunScript.trim() || undefined,
          noNotify,
        }
      : {
          id: crypto.randomUUID(),
          name,
          targetTerminalId,
          action,
          schedule,
          limit,
          enabled: true,
          preRunScript: preRunScript.trim() || undefined,
          noNotify,
          executionCount: 0,
          createdAtMs: Date.now(),
        };

    const res = await routinesAdapter.upsertRoutine(newOrUpdated);
    if (!res.success) {
      setError(res.message || "Failed to save routine");
      return;
    }

    await fetchRoutines();
    resetForm();
  };

  const handleToggle = async (id: string, currentStatus: boolean) => {
    await routinesAdapter.setRoutineEnabled(id, !currentStatus);
    await fetchRoutines();
  };

  const handleRunNow = async (id: string) => {
    const success = await routinesAdapter.runRoutineNow(id);
    if (!success) {
      setError("Execution blocked by routine limit or inactive state");
    } else {
      setError(null);
    }
    await fetchRoutines();
  };

  const handleRemove = async (id: string) => {
    await routinesAdapter.removeRoutine(id);
    if (selectedRoutine?.id === id) resetForm();
    await fetchRoutines();
  };

  const toggleDayOfWeek = (day: number) => {
    if (selectedDays.includes(day)) {
      if (selectedDays.length > 1) {
        setSelectedDays(selectedDays.filter((d) => d !== day));
      }
    } else {
      setSelectedDays([...selectedDays, day].sort());
    }
  };

  const isOrphan = (terminalId: string) => {
    if (!terminalId) return true;
    return !normalizedTerminals.some((t) => t.id === terminalId);
  };

  return (
    <div
      className="routines-panel-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="routines-panel-title"
    >
      <div className="routines-panel" ref={panelRef}>
        <div className="routines-header">
          <h3 id="routines-panel-title">
            Scheduled Routines {!routinesAdapter.isNative && "(Web Preview Mode)"}
          </h3>
          {onClose && (
            <button className="close-btn" onClick={onClose} aria-label="Close panel">
              ✕
            </button>
          )}
        </div>

        {statusMessage && (
          <div className="routines-status-banner" role="status">
            {statusMessage}
          </div>
        )}

        {error && <div className="routines-error" role="alert">⚠️ {error}</div>}

        <div className="routines-content">
          {/* Left Column: Routines List */}
          <div className="routines-list-col">
            <div className="list-actions">
              <button className="new-btn" onClick={resetForm}>
                + New Routine
              </button>
            </div>
            <div className="routines-list" role="region" aria-label="Routines list">
              {routines.length === 0 && <div className="empty-item">No routines configured</div>}
              {routines.map((r) => {
                const orphan = isOrphan(r.targetTerminalId);
                return (
                  <div
                    key={r.id}
                    className={`routine-item ${selectedRoutine?.id === r.id ? "active" : ""}`}
                    onClick={() => handleEditSelect(r)}
                  >
                    <div className="item-title">
                      <span className="routine-name">{r.name}</span>
                      <span className={`status-badge ${r.enabled ? "enabled" : "disabled"}`}>
                        {r.enabled ? "ON" : "OFF"}
                      </span>
                    </div>
                    <div className="item-meta">
                      <span className={orphan ? "orphan-warning" : ""}>
                        Target: {r.targetTerminalId} {orphan ? "⚠️ (Orphan)" : ""}
                      </span>
                      {" | "}
                      <span>Runs: {r.executionCount}</span>
                    </div>
                    {/* Controls as valid sibling DOM element */}
                    <div className="item-controls">
                      <button
                        type="button"
                        className="toggle-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleToggle(r.id, r.enabled);
                        }}
                      >
                        {r.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        className="run-btn"
                        disabled={orphan}
                        title={orphan ? "Cannot run orphan routine without active terminal" : "Run Now"}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRunNow(r.id);
                        }}
                      >
                        ▶ Run
                      </button>
                      <button
                        type="button"
                        className="delete-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRemove(r.id);
                        }}
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Column: Routine Form */}
          <form className="routine-form-col" onSubmit={(e) => void handleSaveForm(e)}>
            <h4>{selectedRoutine ? "Edit Routine" : "Create Routine"}</h4>

            <label>
              Name:
              <input
                ref={titleInputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Daily Test Run"
                required
              />
            </label>

            <label>
              Target Terminal:
              {normalizedTerminals.length > 0 ? (
                <select
                  value={targetTerminalId}
                  onChange={(e) => setTargetTerminalId(e.target.value)}
                  required
                >
                  {normalizedTerminals.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.id.slice(0, 8)}...) {t.isManager ? "★ Manager" : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={targetTerminalId}
                  onChange={(e) => setTargetTerminalId(e.target.value)}
                  placeholder="e.g. terminal-1"
                  required
                />
              )}
            </label>

            <div className="form-group">
              <label>Action Type:</label>
              <select
                value={actionKind}
                onChange={(e) => setActionKind(e.target.value as "command" | "reminder")}
              >
                <option value="command">Command</option>
                <option value="reminder">Reminder</option>
              </select>
              <textarea
                value={actionValue}
                onChange={(e) => setActionValue(e.target.value)}
                placeholder={
                  actionKind === "command" ? "e.g. npm run test" : "e.g. Review pending PRs"
                }
                required
              />
            </div>

            <div className="form-group">
              <label>Schedule Pattern:</label>
              <select
                value={scheduleKind}
                onChange={(e) =>
                  setScheduleKind(e.target.value as "once" | "every" | "daily" | "weekly")
                }
              >
                <option value="every">Every Interval</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="once">Once</option>
              </select>

              {scheduleKind === "once" && (
                <label className="sub-label">
                  Execute At (Date & Time):
                  <input
                    type="datetime-local"
                    value={onceDateTime}
                    onChange={(e) => setOnceDateTime(e.target.value)}
                    required
                  />
                </label>
              )}

              {scheduleKind === "every" && (
                <label className="sub-label">
                  Interval (Seconds):
                  <input
                    type="number"
                    min={1}
                    value={intervalSeconds}
                    onChange={(e) => setIntervalSeconds(parseInt(e.target.value, 10) || 60)}
                  />
                </label>
              )}

              {(scheduleKind === "daily" || scheduleKind === "weekly") && (
                <div className="time-picker">
                  {scheduleKind === "weekly" && (
                    <div className="days-picker">
                      <span className="sub-label">Days of Week:</span>
                      <div className="days-buttons">
                        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((dayName, idx) => (
                          <button
                            type="button"
                            key={dayName}
                            className={`day-chip ${selectedDays.includes(idx) ? "selected" : ""}`}
                            onClick={() => toggleDayOfWeek(idx)}
                          >
                            {dayName}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <label className="sub-label">
                    Hour (0-23):
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={dailyHour}
                      onChange={(e) => setDailyHour(parseInt(e.target.value, 10) || 0)}
                    />
                  </label>
                  <label className="sub-label">
                    Minute (0-59):
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={dailyMinute}
                      onChange={(e) => setDailyMinute(parseInt(e.target.value, 10) || 0)}
                    />
                  </label>
                  <label className="sub-label">
                    Time Zone (IANA):
                    <input
                      type="text"
                      value={timeZone}
                      onChange={(e) => setTimeZone(e.target.value)}
                      placeholder="e.g. UTC, America/New_York"
                    />
                  </label>
                </div>
              )}
            </div>

            <div className="form-group">
              <label>Execution Limit:</label>
              <select
                value={limitKind}
                onChange={(e) =>
                  setLimitKind(e.target.value as "indefinite" | "maxCount" | "untilTimestamp")
                }
              >
                <option value="indefinite">Indefinite</option>
                <option value="maxCount">Max Execution Count</option>
                <option value="untilTimestamp">Until Date & Time</option>
              </select>

              {limitKind === "maxCount" && (
                <label className="sub-label">
                  Max Count:
                  <input
                    type="number"
                    min={1}
                    value={maxCount}
                    onChange={(e) => setMaxCount(parseInt(e.target.value, 10) || 1)}
                  />
                </label>
              )}

              {limitKind === "untilTimestamp" && (
                <label className="sub-label">
                  Until Date & Time:
                  <input
                    type="datetime-local"
                    value={untilDateTime}
                    onChange={(e) => setUntilDateTime(e.target.value)}
                    required
                  />
                </label>
              )}
            </div>

            <label>
              Pre-Run Script (Optional):
              <input
                type="text"
                value={preRunScript}
                onChange={(e) => setPreRunScript(e.target.value)}
                placeholder="e.g. echo 'starting routine...'"
              />
            </label>

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={noNotify}
                onChange={(e) => setNoNotify(e.target.checked)}
              />
              No notification on completion
            </label>

            <div className="form-actions">
              <button type="submit" className="save-btn">
                {selectedRoutine ? "Update Routine" : "Create Routine"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default RoutinesPanel;
