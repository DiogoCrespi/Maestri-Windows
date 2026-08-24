//! Scheduled routines persistence & timezone-aware calculation engine for Windows.

use chrono::{Datelike, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::str::FromStr;

const MAX_ID_LEN: usize = 128;
const MAX_NAME_LEN: usize = 256;
const MAX_COMMAND_LEN: usize = 4096;
const MAX_TARGET_LEN: usize = 128;
pub const MAX_ROUTINES_COUNT: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RoutineAction {
    #[serde(rename = "command")]
    Command { command: String },
    #[serde(rename = "reminder")]
    Reminder { reminder: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SchedulePattern {
    #[serde(rename = "once")]
    Once {
        #[serde(rename = "timestampMs")]
        timestamp_ms: u64,
    },
    #[serde(rename = "every")]
    Every {
        #[serde(rename = "intervalSeconds")]
        interval_seconds: u64,
    },
    #[serde(rename = "daily")]
    Daily {
        hour: u8,
        minute: u8,
        #[serde(rename = "timeZone")]
        time_zone: Option<String>,
    },
    #[serde(rename = "weekly")]
    Weekly {
        #[serde(rename = "daysOfWeek")]
        days_of_week: Vec<u8>, // 0 = Sun, 6 = Sat
        hour: u8,
        minute: u8,
        #[serde(rename = "timeZone")]
        time_zone: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExecutionLimit {
    #[serde(rename = "indefinite")]
    Indefinite,
    #[serde(rename = "maxCount")]
    MaxCount {
        #[serde(rename = "maxCount")]
        count: u64,
    },
    #[serde(rename = "untilTimestamp")]
    UntilTimestamp {
        #[serde(rename = "untilTimestampMs")]
        until_timestamp_ms: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub name: String,
    pub target_terminal_id: String,
    pub action: RoutineAction,
    pub schedule: SchedulePattern,
    pub limit: ExecutionLimit,
    pub enabled: bool,
    pub pre_run_script: Option<String>,
    pub no_notify: bool,
    pub execution_count: u64,

    #[serde(
        rename = "firstRunAtMs",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub first_run_at: Option<u64>,

    #[serde(
        rename = "lastRunAtMs",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub last_run_at: Option<u64>,

    #[serde(rename = "createdAtMs")]
    pub created_at: u64,

    #[serde(default)]
    pub last_idempotency_key: Option<String>,
}

impl Routine {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() || self.id.len() > MAX_ID_LEN {
            return Err("Routine ID is invalid or too long".to_string());
        }
        if self.name.trim().is_empty() || self.name.len() > MAX_NAME_LEN {
            return Err("Routine name is invalid or too long".to_string());
        }
        if self.target_terminal_id.trim().is_empty()
            || self.target_terminal_id.len() > MAX_TARGET_LEN
        {
            return Err("Target terminal ID is invalid or too long".to_string());
        }

        match &self.action {
            RoutineAction::Command { command } => {
                if command.trim().is_empty() || command.len() > MAX_COMMAND_LEN {
                    return Err("Command action cannot be empty or exceed length limit".to_string());
                }
            }
            RoutineAction::Reminder { reminder } => {
                if reminder.trim().is_empty() || reminder.len() > MAX_COMMAND_LEN {
                    return Err("Reminder text cannot be empty or exceed length limit".to_string());
                }
            }
        }

        match &self.schedule {
            SchedulePattern::Once { timestamp_ms } => {
                if *timestamp_ms == 0 {
                    return Err("Once schedule timestampMs must be positive".to_string());
                }
                if let ExecutionLimit::UntilTimestamp { until_timestamp_ms } = self.limit {
                    if *timestamp_ms >= until_timestamp_ms {
                        return Err(
                            "Once schedule timestampMs cannot be at or past UntilTimestamp limit"
                                .to_string(),
                        );
                    }
                }
            }
            SchedulePattern::Every { interval_seconds } => {
                if *interval_seconds == 0 {
                    return Err("Every schedule interval must be greater than zero".to_string());
                }
            }
            SchedulePattern::Daily {
                hour,
                minute,
                time_zone,
            } => {
                if *hour > 23 || *minute > 59 {
                    return Err(
                        "Daily schedule hour (0-23) or minute (0-59) out of bounds".to_string()
                    );
                }
                if let Some(tz_str) = time_zone {
                    Tz::from_str(tz_str)
                        .map_err(|_| format!("Invalid IANA timezone '{tz_str}'"))?;
                }
            }
            SchedulePattern::Weekly {
                days_of_week,
                hour,
                minute,
                time_zone,
            } => {
                if *hour > 23 || *minute > 59 {
                    return Err(
                        "Weekly schedule hour (0-23) or minute (0-59) out of bounds".to_string()
                    );
                }
                if days_of_week.is_empty() || days_of_week.iter().any(|d| *d > 6) {
                    return Err("Weekly daysOfWeek must contain days 0-6".to_string());
                }
                if let Some(tz_str) = time_zone {
                    Tz::from_str(tz_str)
                        .map_err(|_| format!("Invalid IANA timezone '{tz_str}'"))?;
                }
            }
        }

        if let Some(script) = &self.pre_run_script {
            if script.len() > MAX_COMMAND_LEN {
                return Err("Pre-run script exceeds length limit".to_string());
            }
        }

        Ok(())
    }

    pub fn is_due(&self, now_ms: u64) -> bool {
        if !self.enabled {
            return false;
        }

        match self.limit {
            ExecutionLimit::MaxCount { count } if self.execution_count >= count => return false,
            ExecutionLimit::UntilTimestamp { until_timestamp_ms }
                if now_ms >= until_timestamp_ms =>
            {
                return false
            }
            _ => {}
        }

        match &self.schedule {
            SchedulePattern::Once { timestamp_ms } => {
                self.execution_count == 0 && self.last_run_at.is_none() && now_ms >= *timestamp_ms
            }
            SchedulePattern::Every { interval_seconds } => {
                let interval_ms = interval_seconds.saturating_mul(1000);
                let last = self.last_run_at.unwrap_or(self.created_at);
                if self.last_run_at.is_none() {
                    now_ms >= last
                } else {
                    now_ms >= last.saturating_add(interval_ms)
                }
            }
            SchedulePattern::Daily {
                hour,
                minute,
                time_zone,
            } => {
                let target_ms =
                    compute_target_daily_ms(now_ms, *hour, *minute, time_zone.as_deref());
                if let Some(last) = self.last_run_at {
                    now_ms >= target_ms && last < target_ms
                } else {
                    now_ms >= target_ms
                }
            }
            SchedulePattern::Weekly {
                days_of_week,
                hour,
                minute,
                time_zone,
            } => {
                let target_ms = compute_target_weekly_ms(
                    now_ms,
                    days_of_week,
                    *hour,
                    *minute,
                    time_zone.as_deref(),
                );
                if let Some(last) = self.last_run_at {
                    now_ms >= target_ms && last < target_ms
                } else {
                    now_ms >= target_ms
                }
            }
        }
    }

    /// Constructs the exact command payload string to send to ConPTY.
    /// If pre_run_script is present and not whitespace-only, prepends it with \r\n before command.
    pub fn build_command_payload(&self) -> Option<String> {
        match &self.action {
            RoutineAction::Command { command } => match &self.pre_run_script {
                Some(pre_script) if !pre_script.trim().is_empty() => {
                    Some(format!("{pre_script}\r\n{command}\r\n"))
                }
                _ => Some(format!("{command}\r\n")),
            },
            RoutineAction::Reminder { .. } => None,
        }
    }

    pub fn record_execution(&mut self, run_timestamp_ms: u64, idempotency_key: String) {
        self.execution_count = self.execution_count.saturating_add(1);
        if self.first_run_at.is_none() {
            self.first_run_at = Some(run_timestamp_ms);
        }
        self.last_run_at = Some(run_timestamp_ms);
        self.last_idempotency_key = Some(idempotency_key);
    }
}

// MARK: - Timezone & IANA Helpers

pub fn compute_target_daily_ms(now_ms: u64, hour: u8, minute: u8, time_zone: Option<&str>) -> u64 {
    let now_datetime = Utc.timestamp_millis_opt(now_ms as i64).unwrap();
    if let Some(tz_str) = time_zone {
        if let Ok(tz) = Tz::from_str(tz_str) {
            let local_now = now_datetime.with_timezone(&tz);
            let target_local = local_now
                .date_naive()
                .and_hms_opt(hour as u32, minute as u32, 0)
                .unwrap();
            let target_dt = tz
                .from_local_datetime(&target_local)
                .single()
                .unwrap_or_else(|| {
                    local_now
                        .with_hour(hour as u32)
                        .unwrap()
                        .with_minute(minute as u32)
                        .unwrap()
                        .with_timezone(&tz)
                });
            let target_utc = target_dt.with_timezone(&Utc);
            if target_utc <= now_datetime {
                return target_utc.timestamp_millis() as u64;
            } else {
                let prev_day = target_local - chrono::Duration::days(1);
                let prev_utc = tz
                    .from_local_datetime(&prev_day)
                    .single()
                    .unwrap()
                    .with_timezone(&Utc);
                return prev_utc.timestamp_millis() as u64;
            }
        }
    }

    let day_ms = 86_400_000;
    let target_time_ms = (hour as u64) * 3_600_000 + (minute as u64) * 60_000;
    let current_day_start = (now_ms / day_ms) * day_ms;
    let candidate = current_day_start.saturating_add(target_time_ms);
    if candidate <= now_ms {
        candidate
    } else {
        candidate.saturating_sub(day_ms)
    }
}

pub fn compute_target_weekly_ms(
    now_ms: u64,
    days_of_week: &[u8],
    hour: u8,
    minute: u8,
    time_zone: Option<&str>,
) -> u64 {
    let now_datetime = Utc.timestamp_millis_opt(now_ms as i64).unwrap();
    let tz = time_zone.and_then(|s| Tz::from_str(s).ok());

    let (current_dow, local_now_naive) = if let Some(tz) = tz {
        let local = now_datetime.with_timezone(&tz);
        (
            local.weekday().num_days_from_sunday() as u8,
            local.naive_local(),
        )
    } else {
        let days_since_epoch = now_ms / 86_400_000;
        (
            ((days_since_epoch + 4) % 7) as u8,
            now_datetime.naive_local(),
        )
    };

    let mut best_target_ms = 0;
    for &target_dow in days_of_week {
        let days_back = if current_dow >= target_dow {
            (current_dow - target_dow) as i64
        } else {
            (7 - (target_dow - current_dow)) as i64
        };

        let candidate_ms = if let Some(tz) = tz {
            let target_date = local_now_naive.date() - chrono::Duration::days(days_back);
            let target_dt = target_date
                .and_hms_opt(hour as u32, minute as u32, 0)
                .unwrap();
            let utc_dt = tz
                .from_local_datetime(&target_dt)
                .single()
                .unwrap()
                .with_timezone(&Utc);
            let mut ms = utc_dt.timestamp_millis() as u64;
            if ms > now_ms {
                let prev_week_dt = target_date - chrono::Duration::days(7);
                let prev_utc = tz
                    .from_local_datetime(
                        &prev_week_dt
                            .and_hms_opt(hour as u32, minute as u32, 0)
                            .unwrap(),
                    )
                    .single()
                    .unwrap()
                    .with_timezone(&Utc);
                ms = prev_utc.timestamp_millis() as u64;
            }
            ms
        } else {
            let day_ms = 86_400_000;
            let current_day_start = (now_ms / day_ms) * day_ms;
            let target_time_ms = (hour as u64) * 3_600_000 + (minute as u64) * 60_000;
            let mut cand = current_day_start
                .saturating_sub((days_back as u64) * day_ms)
                .saturating_add(target_time_ms);
            if cand > now_ms {
                cand = cand.saturating_sub(7 * day_ms);
            }
            cand
        };

        if candidate_ms > best_target_ms && candidate_ms <= now_ms {
            best_target_ms = candidate_ms;
        }
    }

    if best_target_ms == 0 {
        now_ms.saturating_sub(86_400_000)
    } else {
        best_target_ms
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RoutineItemOrLegacy {
    Canonical(Routine),
    Legacy(LegacyMacOsRoutine),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyMacOsRoutine {
    id: String,
    name: Option<String>,
    #[serde(alias = "targetTerminalId", alias = "terminalId")]
    target_terminal_id: String,
    prompts: Option<Vec<String>>,
    command: Option<String>,
    reminder: Option<String>,
    #[serde(alias = "intervalSeconds", alias = "interval_seconds")]
    interval_seconds: Option<u64>,
    #[serde(alias = "isActive")]
    is_active: Option<bool>,
    enabled: Option<bool>,
    pre_run_script: Option<String>,
    no_notify: Option<bool>,
    execution_count: Option<u64>,
    #[serde(alias = "createdAt")]
    created_at_iso_or_ms: Option<serde_json::Value>,
    #[serde(alias = "lastRunAt")]
    last_run_at_iso_or_ms: Option<serde_json::Value>,
}

fn parse_iso_or_ms(val: &serde_json::Value) -> Option<u64> {
    match val {
        serde_json::Value::Number(n) => n.as_u64(),
        serde_json::Value::String(s) => {
            if let Ok(ms) = s.parse::<u64>() {
                Some(ms)
            } else if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                Some(dt.timestamp_millis() as u64)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn migrate_legacy_routine(leg: LegacyMacOsRoutine) -> Result<Routine, String> {
    let name = leg.name.unwrap_or_else(|| leg.id.clone());

    let action = if let Some(prompts) = leg.prompts {
        let joined = prompts.join("\r\n");
        RoutineAction::Command { command: joined }
    } else if let Some(cmd) = leg.command {
        RoutineAction::Command { command: cmd }
    } else if let Some(rem) = leg.reminder {
        RoutineAction::Reminder { reminder: rem }
    } else {
        return Err(format!(
            "Legacy routine '{}' has no prompts/command/reminder",
            leg.id
        ));
    };

    let interval_seconds = leg.interval_seconds.unwrap_or(60);
    let schedule = SchedulePattern::Every { interval_seconds };

    let enabled = leg.enabled.or(leg.is_active).unwrap_or(true);
    let created_at = leg
        .created_at_iso_or_ms
        .as_ref()
        .and_then(parse_iso_or_ms)
        .unwrap_or(1000000);
    let last_run_at = leg.last_run_at_iso_or_ms.as_ref().and_then(parse_iso_or_ms);

    let routine = Routine {
        id: leg.id,
        name,
        target_terminal_id: leg.target_terminal_id,
        action,
        schedule,
        limit: ExecutionLimit::Indefinite,
        enabled,
        pre_run_script: leg.pre_run_script,
        no_notify: leg.no_notify.unwrap_or(false),
        execution_count: leg.execution_count.unwrap_or(0),
        first_run_at: None,
        last_run_at,
        created_at,
        last_idempotency_key: None,
    };

    routine.validate()?;
    Ok(routine)
}

fn parse_items_list(items: Vec<RoutineItemOrLegacy>) -> Result<Vec<Routine>, String> {
    let mut result = Vec::with_capacity(items.len());
    for item in items {
        match item {
            RoutineItemOrLegacy::Canonical(r) => result.push(r),
            RoutineItemOrLegacy::Legacy(leg) => {
                let r = migrate_legacy_routine(leg)?;
                result.push(r);
            }
        }
    }
    Ok(result)
}

fn parse_routines_json_flexible(content: &str) -> Result<Vec<Routine>, String> {
    let value: serde_json::Value =
        serde_json::from_str(content).map_err(|e| format!("Failed to parse routines JSON: {e}"))?;

    match value {
        serde_json::Value::Array(_) => {
            let items: Vec<RoutineItemOrLegacy> = serde_json::from_value(value)
                .map_err(|e| format!("Failed to parse routine array: {e}"))?;
            parse_items_list(items)
        }
        serde_json::Value::Object(map) => {
            let routines_val = if let Some(r) = map.get("routines") {
                r
            } else if let Some(p) = map.get("payload") {
                p
            } else {
                return Err(
                    "Failed to parse routines JSON: missing routines or payload array key"
                        .to_string(),
                );
            };

            let items: Vec<RoutineItemOrLegacy> = serde_json::from_value(routines_val.clone())
                .map_err(|e| format!("Failed to parse routines field: {e}"))?;
            parse_items_list(items)
        }
        _ => Err("Failed to parse routines JSON: expected array or object wrapper".to_string()),
    }
}

// MARK: - Transactional RoutineManager Persistence

#[derive(Default)]
pub struct RoutineManager {
    routines: HashMap<String, Routine>,
}

impl RoutineManager {
    pub fn new() -> Self {
        Self {
            routines: HashMap::new(),
        }
    }

    pub fn upsert(&mut self, routine: Routine) -> Result<(), String> {
        routine.validate()?;
        if self.routines.len() >= MAX_ROUTINES_COUNT && !self.routines.contains_key(&routine.id) {
            return Err("Maximum routine capacity reached".to_string());
        }
        self.routines.insert(routine.id.clone(), routine);
        Ok(())
    }

    pub fn remove(&mut self, id: &str) -> bool {
        self.routines.remove(id).is_some()
    }

    pub fn get(&self, id: &str) -> Option<&Routine> {
        self.routines.get(id)
    }

    pub fn list(&self) -> Vec<&Routine> {
        self.routines.values().collect()
    }

    pub fn find_due(&self, now_ms: u64) -> Vec<String> {
        self.routines
            .values()
            .filter(|r| r.is_due(now_ms))
            .map(|r| r.id.clone())
            .collect()
    }

    pub fn save_to_file<P: AsRef<Path>>(&self, path: P) -> Result<(), String> {
        let routines_list: Vec<&Routine> = self.routines.values().collect();
        let json_data = serde_json::to_string_pretty(&routines_list)
            .map_err(|e| format!("Failed to serialize routines: {e}"))?;

        let path_ref = path.as_ref();
        let parent = path_ref
            .parent()
            .ok_or_else(|| "Invalid file path".to_string())?;
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {e}"))?;

        let unique_id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let temp_filename = format!(
            "{}.tmp.{}",
            path_ref
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("routines"),
            unique_id
        );
        let temp_path = parent.join(temp_filename);

        {
            let mut file =
                File::create(&temp_path).map_err(|e| format!("Failed to create temp file: {e}"))?;
            file.write_all(json_data.as_bytes())
                .map_err(|e| format!("Failed to write to temp file: {e}"))?;
            file.flush()
                .map_err(|e| format!("Failed to flush temp file: {e}"))?;
            file.sync_all()
                .map_err(|e| format!("Failed to sync temp file: {e}"))?;
        }

        if let Err(err) = atomic_replace_file(&temp_path, path_ref) {
            let _ = fs::remove_file(&temp_path);
            return Err(format!("Atomic file replace failed: {err}"));
        }

        Ok(())
    }

    pub fn load_from_file<P: AsRef<Path>>(&mut self, path: P) -> Result<usize, String> {
        let path_ref = path.as_ref();
        if !path_ref.exists() {
            self.routines.clear();
            return Ok(0);
        }

        let content = fs::read_to_string(path_ref)
            .map_err(|e| format!("Failed to read routines file: {e}"))?;

        let loaded = parse_routines_json_flexible(&content)?;

        if loaded.len() > MAX_ROUTINES_COUNT {
            return Err(format!(
                "File contains {} routines, exceeding maximum allowed {}",
                loaded.len(),
                MAX_ROUTINES_COUNT
            ));
        }

        let mut validated_map: HashMap<String, Routine> = HashMap::new();
        let mut seen_ids: HashSet<String> = HashSet::new();

        for routine in loaded {
            routine.validate()?;
            if !seen_ids.insert(routine.id.clone()) {
                return Err(format!(
                    "Transactional load rejected: duplicate routine ID '{}' found in file",
                    routine.id
                ));
            }
            validated_map.insert(routine.id.clone(), routine);
        }

        self.routines = validated_map;
        Ok(self.routines.len())
    }
}

fn atomic_replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let from_wide: Vec<u16> = from
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let to_wide: Vec<u16> = to
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        unsafe {
            let res = winapi_replace_or_move(from_wide.as_ptr(), to_wide.as_ptr());
            if res != 0 {
                Ok(())
            } else {
                fs::rename(from, to)
            }
        }
    }
    #[cfg(not(windows))]
    {
        fs::rename(from, to)
    }
}

#[cfg(windows)]
unsafe fn winapi_replace_or_move(from: *const u16, to: *const u16) -> i32 {
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            lpExistingFileName: *const u16,
            lpNewFileName: *const u16,
            dwFlags: u32,
        ) -> i32;
    }
    MoveFileExW(from, to, 0x00000001 | 0x00000008)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_routine() -> Routine {
        Routine {
            id: "rt-001".to_string(),
            name: "Health Check".to_string(),
            target_terminal_id: "term-1".to_string(),
            action: RoutineAction::Command {
                command: "echo 'ping'".to_string(),
            },
            schedule: SchedulePattern::Every {
                interval_seconds: 300,
            },
            limit: ExecutionLimit::Indefinite,
            enabled: true,
            pre_run_script: None,
            no_notify: false,
            execution_count: 0,
            first_run_at: None,
            last_run_at: None,
            created_at: 1000000,
            last_idempotency_key: None,
        }
    }

    #[test]
    fn routine_validation_rules() {
        let mut r = sample_routine();
        assert!(r.validate().is_ok());

        r.id = "".to_string();
        assert!(r.validate().is_err());

        r = sample_routine();
        r.name = " ".to_string();
        assert!(r.validate().is_err());

        r = sample_routine();
        r.action = RoutineAction::Command {
            command: "".to_string(),
        };
        assert!(r.validate().is_err());

        r = sample_routine();
        r.schedule = SchedulePattern::Daily {
            hour: 25,
            minute: 0,
            time_zone: None,
        };
        assert!(r.validate().is_err());

        r = sample_routine();
        r.schedule = SchedulePattern::Weekly {
            days_of_week: vec![7],
            hour: 12,
            minute: 0,
            time_zone: None,
        };
        assert!(r.validate().is_err());
    }

    #[test]
    fn serde_golden_roundtrip_identical_to_ts() {
        let r = sample_routine();
        let json_str = serde_json::to_string(&r).unwrap();
        assert!(json_str.contains(r#""kind":"command""#));
        assert!(json_str.contains(r#""kind":"every""#));
        assert!(json_str.contains(r#""intervalSeconds":300"#));
        assert!(json_str.contains(r#""createdAtMs":1000000"#));
        assert!(!json_str.contains(r#""firstRunAtMs""#));

        let deserialized: Routine = serde_json::from_str(&json_str).unwrap();
        assert_eq!(r, deserialized);
    }

    #[test]
    fn dst_sao_paulo_timezone_calculation() {
        let now_ms = 1700000000000;
        let target_ms = compute_target_daily_ms(now_ms, 14, 30, Some("America/Sao_Paulo"));
        assert!(target_ms <= now_ms);

        let weekly_ms = compute_target_weekly_ms(now_ms, &[1, 5], 10, 0, Some("America/Sao_Paulo"));
        assert!(weekly_ms <= now_ms);
    }

    #[test]
    fn find_due_all_schedules_exact_late_restart() {
        let mut manager = RoutineManager::new();

        let mut r_once = sample_routine();
        r_once.id = "r-once".to_string();
        r_once.schedule = SchedulePattern::Once {
            timestamp_ms: 1000000,
        };
        manager.upsert(r_once).unwrap();

        let mut r_every = sample_routine();
        r_every.id = "r-every".to_string();
        r_every.schedule = SchedulePattern::Every {
            interval_seconds: 60,
        };
        r_every.created_at = 1000000;
        manager.upsert(r_every).unwrap();

        let due_at_1005000 = manager.find_due(1005000);
        assert!(due_at_1005000.contains(&"r-once".to_string()));
        assert!(due_at_1005000.contains(&"r-every".to_string()));

        let mut r_ev_ref = manager.get("r-every").cloned().unwrap();
        r_ev_ref.record_execution(1005000, "k1".to_string());
        manager.upsert(r_ev_ref).unwrap();

        assert!(!manager.find_due(1030000).contains(&"r-every".to_string()));
        assert!(manager.find_due(1070000).contains(&"r-every".to_string()));
    }

    #[test]
    fn max_count_limit_test() {
        let mut r = sample_routine();
        r.created_at = 1000000;
        r.limit = ExecutionLimit::MaxCount { count: 2 };

        assert!(r.is_due(1000000));
        r.record_execution(1000000, "k1".to_string());
        assert!(r.is_due(1300000));
        r.record_execution(1300000, "k2".to_string());

        assert!(!r.is_due(1600000));
    }

    #[test]
    fn until_boundary_exclusive_tests() {
        let mut r = sample_routine();
        r.limit = ExecutionLimit::UntilTimestamp {
            until_timestamp_ms: 1000000,
        };

        assert!(!r.is_due(1000000));
        assert!(!r.is_due(1005000));

        let mut r_once = sample_routine();
        r_once.schedule = SchedulePattern::Once {
            timestamp_ms: 1000000,
        };
        r_once.limit = ExecutionLimit::UntilTimestamp {
            until_timestamp_ms: 1000000,
        };
        assert!(r_once.validate().is_err());
    }

    #[test]
    fn atomic_overwrite_preserves_on_success() {
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("maestri_atomic_test_new.json");

        let mut manager = RoutineManager::new();
        manager.upsert(sample_routine()).unwrap();

        assert!(manager.save_to_file(&test_file).is_ok());
        assert!(test_file.exists());

        assert!(manager.save_to_file(&test_file).is_ok());

        let mut reader_mgr = RoutineManager::new();
        assert_eq!(reader_mgr.load_from_file(&test_file).unwrap(), 1);

        let _ = fs::remove_file(test_file);
    }

    #[test]
    fn build_command_payload_formatting_crlf_and_whitespace_preservation() {
        let mut r = sample_routine();

        // 1. Single command without pre_run_script -> command + \r\n
        r.action = RoutineAction::Command {
            command: "echo hello".to_string(),
        };
        r.pre_run_script = None;
        assert_eq!(
            r.build_command_payload(),
            Some("echo hello\r\n".to_string())
        );

        // 2. Whitespace-only pre_run_script -> ignored
        r.pre_run_script = Some("   \t\n ".to_string());
        assert_eq!(
            r.build_command_payload(),
            Some("echo hello\r\n".to_string())
        );

        // 3. Valid pre_run_script + Unicode + literal preservation -> script + \r\n + command + \r\n
        r.pre_run_script = Some("cd C:\\projeto-maestri".to_string());
        r.action = RoutineAction::Command {
            command: "npm test -- --filter=\"teste_ação\"".to_string(),
        };
        assert_eq!(
            r.build_command_payload(),
            Some("cd C:\\projeto-maestri\r\nnpm test -- --filter=\"teste_ação\"\r\n".to_string())
        );

        // 4. Reminder routine -> returns None
        r.action = RoutineAction::Reminder {
            reminder: "Lembrete".to_string(),
        };
        assert_eq!(r.build_command_payload(), None);
    }

    #[test]
    fn transactional_load_preserves_state_on_corrupt_file() {
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("maestri_corrupt_load_test_new.json");

        let mut manager = RoutineManager::new();
        manager.upsert(sample_routine()).unwrap();

        let corrupt_json = r#"[
            {"id": "rt-1", "name": "Valid", "targetTerminalId": "t1", "action": {"kind": "command", "command": "cmd"}, "schedule": {"kind": "every", "intervalSeconds": 60}, "limit": {"kind": "indefinite"}, "enabled": true, "noNotify": false, "executionCount": 0, "createdAtMs": 1000},
            {"id": "rt-1", "name": "Duplicate", "targetTerminalId": "t1", "action": {"kind": "command", "command": "cmd"}, "schedule": {"kind": "every", "intervalSeconds": 60}, "limit": {"kind": "indefinite"}, "enabled": true, "noNotify": false, "executionCount": 0, "createdAtMs": 1000}
        ]"#;
        fs::write(&test_file, corrupt_json).unwrap();

        assert!(manager.load_from_file(&test_file).is_err());
        assert!(manager.get("rt-001").is_some());

        let _ = fs::remove_file(test_file);
    }

    #[test]
    fn flexible_json_loader_supports_all_wrappers_and_legacy_macos_format() {
        let temp_dir = std::env::temp_dir();

        // 1. Array wrapper []
        let f1 = temp_dir.join("maestri_fmt_array.json");
        let json1 = r#"[
            {"id": "rt-array", "name": "Array Routine", "targetTerminalId": "t1", "action": {"kind": "command", "command": "dir"}, "schedule": {"kind": "every", "intervalSeconds": 30}, "limit": {"kind": "indefinite"}, "enabled": true, "noNotify": false, "executionCount": 0, "createdAtMs": 1000}
        ]"#;
        fs::write(&f1, json1).unwrap();
        let mut mgr1 = RoutineManager::new();
        assert_eq!(mgr1.load_from_file(&f1).unwrap(), 1);
        assert!(mgr1.get("rt-array").is_some());
        let _ = fs::remove_file(f1);

        // 2. Map with { "routines": [...] }
        let f2 = temp_dir.join("maestri_fmt_routines.json");
        let json2 = r#"{
            "schemaVersion": 1,
            "routines": [
                {"id": "rt-routines", "name": "Wrapped Routine", "targetTerminalId": "t1", "action": {"kind": "command", "command": "echo hi"}, "schedule": {"kind": "every", "intervalSeconds": 60}, "limit": {"kind": "indefinite"}, "enabled": true, "noNotify": false, "executionCount": 0, "createdAtMs": 1000}
            ]
        }"#;
        fs::write(&f2, json2).unwrap();
        let mut mgr2 = RoutineManager::new();
        assert_eq!(mgr2.load_from_file(&f2).unwrap(), 1);
        assert!(mgr2.get("rt-routines").is_some());
        let _ = fs::remove_file(f2);

        // 3. Map with { "payload": [...] }
        let f3 = temp_dir.join("maestri_fmt_payload.json");
        let json3 = r#"{
            "payload": [
                {"id": "rt-payload", "name": "Payload Routine", "targetTerminalId": "t1", "action": {"kind": "command", "command": "ls"}, "schedule": {"kind": "every", "intervalSeconds": 15}, "limit": {"kind": "indefinite"}, "enabled": true, "noNotify": false, "executionCount": 0, "createdAtMs": 1000}
            ]
        }"#;
        fs::write(&f3, json3).unwrap();
        let mut mgr3 = RoutineManager::new();
        assert_eq!(mgr3.load_from_file(&f3).unwrap(), 1);
        assert!(mgr3.get("rt-payload").is_some());
        let _ = fs::remove_file(f3);

        // 4. Legacy macOS DTO format migration
        let f4 = temp_dir.join("maestri_fmt_legacy.json");
        let json4 = r#"{
            "routines": [
                {
                    "id": "rt-mac-legacy",
                    "terminalId": "t-mac",
                    "prompts": ["git pull", "npm install"],
                    "interval_seconds": 120,
                    "isActive": true,
                    "createdAt": "2026-08-23T20:00:00Z"
                }
            ]
        }"#;
        fs::write(&f4, json4).unwrap();
        let mut mgr4 = RoutineManager::new();
        assert_eq!(mgr4.load_from_file(&f4).unwrap(), 1);
        let migrated = mgr4.get("rt-mac-legacy").unwrap();
        assert_eq!(migrated.name, "rt-mac-legacy");
        assert_eq!(migrated.target_terminal_id, "t-mac");
        assert_eq!(
            migrated.action,
            RoutineAction::Command {
                command: "git pull\r\nnpm install".to_string()
            }
        );
        assert_eq!(
            migrated.schedule,
            SchedulePattern::Every {
                interval_seconds: 120
            }
        );
        assert!(migrated.enabled);
        let _ = fs::remove_file(f4);

        // 5. Unknown map format without routines or payload -> fail-closed without clearing current state
        let f5 = temp_dir.join("maestri_fmt_unknown.json");
        let json5 = r#"{"otherKey": [1, 2, 3]}"#;
        fs::write(&f5, json5).unwrap();
        let mut mgr5 = RoutineManager::new();
        mgr5.upsert(sample_routine()).unwrap();
        assert!(mgr5.load_from_file(&f5).is_err());
        assert!(mgr5.get("rt-001").is_some());
        let _ = fs::remove_file(f5);
    }
}
