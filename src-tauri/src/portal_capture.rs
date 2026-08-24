//! Portal screenshot capture and output policy.
//!
//! Tauri 2.11.5 does not expose a portable `Webview::screenshot` method. Its
//! Windows escape hatch is `Webview::with_webview`, whose
//! `PlatformWebview::controller()` reaches WebView2's
//! `ICoreWebView2::CapturePreview(PNG, IStream, handler)` API. This file does
//! the Windows wiring while keeping PNG validation and filesystem policy
//! independent from COM.
//!
//! The platform callback is bounded by a receiver timeout. The stream is
//! retained by the completion callback, rewound, size-checked, and read in
//! bounded chunks before the result reaches [`CaptureService::capture`].
//!
//! The current WebView2/Tauri callback owns an apartment-bound `IStream`. The
//! installed Windows features do not expose a verified COM marshaling path for
//! this callback, so the stream is intentionally read in the callback for
//! compatibility. The read is bounded to `DEFAULT_MAX_PNG_BYTES` in 64 KiB
//! chunks; timeout cancellation is checked before every COM operation. A
//! future marshaled worker must retain these same checks and limits.

use std::collections::HashMap;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

#[cfg(windows)]
use std::sync::mpsc;

#[cfg(windows)]
use tauri::{Runtime, Webview};

#[cfg(windows)]
use webview2_com::{
    CapturePreviewCompletedHandler,
    Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
};

#[cfg(windows)]
use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};
#[cfg(windows)]
use windows::Win32::UI::Shell::SHCreateMemStream;

pub const DEFAULT_MAX_WIDTH: u32 = 8_192;
pub const DEFAULT_MAX_HEIGHT: u32 = 8_192;
pub const DEFAULT_MAX_PNG_BYTES: usize = 32 * 1024 * 1024;
pub const DEFAULT_CAPTURE_TIMEOUT_MS: u64 = 5_000;
pub const MAX_CONCURRENT_CAPTURES: usize = 4;
pub const MAX_CONCURRENT_CAPTURES_PER_PORTAL: usize = 1;
const TEMP_FILE_RETRIES: usize = 8;

#[cfg(test)]
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct ActiveCaptures {
    total: usize,
    per_portal: HashMap<String, usize>,
}

static ACTIVE_CAPTURES: OnceLock<Arc<Mutex<ActiveCaptures>>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureLimits {
    pub max_width: u32,
    pub max_height: u32,
    pub max_png_bytes: usize,
}

impl Default for CaptureLimits {
    fn default() -> Self {
        Self {
            max_width: DEFAULT_MAX_WIDTH,
            max_height: DEFAULT_MAX_HEIGHT,
            max_png_bytes: DEFAULT_MAX_PNG_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureOutput {
    /// Creates a collision-resistant `.png` file in the process temp folder.
    Temporary,
    /// Creates this path without overwriting an existing file.
    Png(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureRequest {
    pub portal_id: String,
    pub width: u32,
    pub height: u32,
    pub output: CaptureOutput,
}

impl CaptureRequest {
    pub fn new(
        portal_id: impl Into<String>,
        width: u32,
        height: u32,
        output: CaptureOutput,
    ) -> Self {
        Self {
            portal_id: portal_id.into(),
            width,
            height,
            output,
        }
    }

    /// Builds a request for a WebView2 viewport. `CapturePreview` chooses the
    /// actual viewport dimensions; these values are the maximum dimensions
    /// accepted when the returned PNG is validated.
    pub fn for_portal(portal_id: impl Into<String>, output: CaptureOutput) -> Self {
        Self::new(portal_id, DEFAULT_MAX_WIDTH, DEFAULT_MAX_HEIGHT, output)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureResult {
    pub path: PathBuf,
    pub bytes_written: usize,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureError {
    InvalidPortalId,
    InvalidDimensions,
    DimensionsTooLarge {
        width: u32,
        height: u32,
        max_width: u32,
        max_height: u32,
    },
    InvalidOutputPath,
    OutputAlreadyExists(PathBuf),
    ConcurrentLimit {
        scope: &'static str,
        limit: usize,
    },
    InvalidOutputPathReason(&'static str),
    InvalidPng(&'static str),
    PngTooLarge {
        bytes: usize,
        max_bytes: usize,
    },
    PngDimensionsTooLarge {
        width: u32,
        height: u32,
        max_width: u32,
        max_height: u32,
    },
    Unsupported(&'static str),
    Cancelled,
    Timeout {
        millis: u64,
    },
    WebView(String),
    Stream(String),
    Io(String),
}

impl fmt::Display for CaptureError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPortalId => formatter.write_str("portal capture requires a valid portal id"),
            Self::InvalidDimensions => formatter.write_str("portal capture dimensions must be non-zero"),
            Self::DimensionsTooLarge {
                width,
                height,
                max_width,
                max_height,
            } => write!(
                formatter,
                "portal capture dimensions {width}x{height} exceed limit {max_width}x{max_height}"
            ),
            Self::InvalidOutputPath => formatter.write_str("portal capture output must be a .png path"),
            Self::OutputAlreadyExists(path) => {
                write!(formatter, "portal capture output already exists: {}", path.display())
            }
            Self::ConcurrentLimit { scope, limit } => write!(
                formatter,
                "portal screenshot concurrency limit reached for {scope} (limit {limit})"
            ),
            Self::InvalidOutputPathReason(reason) => {
                write!(formatter, "invalid portal screenshot output path: {reason}")
            }
            Self::InvalidPng(reason) => write!(formatter, "portal capture returned invalid PNG: {reason}"),
            Self::PngTooLarge { bytes, max_bytes } => write!(
                formatter,
                "portal capture PNG is {bytes} bytes, exceeding limit {max_bytes}"
            ),
            Self::PngDimensionsTooLarge {
                width,
                height,
                max_width,
                max_height,
            } => write!(
                formatter,
                "portal capture PNG dimensions {width}x{height} exceed limit {max_width}x{max_height}"
            ),
            Self::Unsupported(reason) => formatter.write_str(reason),
            Self::Cancelled => formatter.write_str("portal screenshot capture was cancelled"),
            Self::Timeout { millis } => {
                write!(formatter, "portal screenshot timed out after {millis} ms")
            }
            Self::WebView(reason) => write!(formatter, "portal WebView2 capture failed: {reason}"),
            Self::Stream(reason) => write!(formatter, "portal screenshot stream failed: {reason}"),
            Self::Io(reason) => write!(formatter, "portal capture I/O failed: {reason}"),
        }
    }
}

impl std::error::Error for CaptureError {}

struct CaptureGuard {
    portal_id: String,
    active: Arc<Mutex<ActiveCaptures>>,
}

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        let Ok(mut active) = self.active.lock() else {
            return;
        };

        active.total = active.total.saturating_sub(1);
        if let Some(count) = active.per_portal.get_mut(&self.portal_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                active.per_portal.remove(&self.portal_id);
            }
        }
    }
}

fn acquire_capture_guard(portal_id: &str) -> Result<CaptureGuard, CaptureError> {
    let lock = ACTIVE_CAPTURES
        .get_or_init(|| Arc::new(Mutex::new(ActiveCaptures::default())))
        .clone();
    acquire_capture_guard_from(lock, portal_id)
}

fn acquire_capture_guard_from(
    lock: Arc<Mutex<ActiveCaptures>>,
    portal_id: &str,
) -> Result<CaptureGuard, CaptureError> {
    let mut active = lock
        .lock()
        .map_err(|_| CaptureError::Io("portal capture concurrency lock poisoned".to_string()))?;
    if active.total >= MAX_CONCURRENT_CAPTURES {
        return Err(CaptureError::ConcurrentLimit {
            scope: "global",
            limit: MAX_CONCURRENT_CAPTURES,
        });
    }
    let portal_count = active.per_portal.get(portal_id).copied().unwrap_or(0);
    if portal_count >= MAX_CONCURRENT_CAPTURES_PER_PORTAL {
        return Err(CaptureError::ConcurrentLimit {
            scope: "portal",
            limit: MAX_CONCURRENT_CAPTURES_PER_PORTAL,
        });
    }

    active.total += 1;
    active
        .per_portal
        .entry(portal_id.to_owned())
        .and_modify(|count| *count += 1)
        .or_insert(1);
    Ok(CaptureGuard {
        portal_id: portal_id.to_owned(),
        active: lock.clone(),
    })
}

fn cancellation_requested(cancelled: &AtomicBool) -> Result<(), CaptureError> {
    if cancelled.load(Ordering::Acquire) {
        Err(CaptureError::Cancelled)
    } else {
        Ok(())
    }
}

/// Backend boundary for the one platform-specific operation.
///
/// The backend must return the complete PNG generated by WebView2. It must
/// not write files; [`CaptureService`] owns validation and filesystem policy.
pub trait PortalCaptureBackend {
    fn capture_png(
        &mut self,
        portal_id: &str,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, CaptureError>;
}

/// Deterministic fallback backend for platforms without the native adapter.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnsupportedTauriCapture;

impl PortalCaptureBackend for UnsupportedTauriCapture {
    fn capture_png(
        &mut self,
        _portal_id: &str,
        _width: u32,
        _height: u32,
    ) -> Result<Vec<u8>, CaptureError> {
        Err(CaptureError::Unsupported(
            "portal screenshot backend is unavailable",
        ))
    }
}

#[cfg(windows)]
struct TauriWebView2Backend<'a, R: Runtime> {
    webview: &'a Webview<R>,
    timeout: Duration,
    max_png_bytes: usize,
}

#[cfg(windows)]
impl<R: Runtime> PortalCaptureBackend for TauriWebView2Backend<'_, R> {
    fn capture_png(
        &mut self,
        _portal_id: &str,
        _width: u32,
        _height: u32,
    ) -> Result<Vec<u8>, CaptureError> {
        capture_png_from_webview(self.webview, self.timeout, self.max_png_bytes)
    }
}

/// Captures the native Windows WebView2 and applies the common output policy.
///
/// The caller must already have authorized the portal and resolved its native
/// `Webview` by the `portal:{canvas_node_id}` label.
#[cfg(windows)]
pub fn capture_webview<R: Runtime>(
    webview: &Webview<R>,
    request: CaptureRequest,
    timeout: Duration,
    limits: CaptureLimits,
) -> Result<CaptureResult, CaptureError> {
    let backend = TauriWebView2Backend {
        webview,
        timeout,
        max_png_bytes: limits.max_png_bytes,
    };
    CaptureService::new(backend, limits).capture(request)
}

#[cfg(windows)]
fn capture_png_from_webview<R: Runtime>(
    webview: &Webview<R>,
    timeout: Duration,
    max_png_bytes: usize,
) -> Result<Vec<u8>, CaptureError> {
    let (sender, receiver) = mpsc::channel::<Result<Vec<u8>, CaptureError>>();
    let cancelled = std::sync::Arc::new(AtomicBool::new(false));
    let callback_cancelled = std::sync::Arc::clone(&cancelled);
    webview
        .with_webview(move |platform| {
            let stream = match unsafe { SHCreateMemStream(None) } {
                Some(stream) => stream,
                None => {
                    let _ = sender.send(Err(CaptureError::Stream(
                        "SHCreateMemStream returned no stream".to_string(),
                    )));
                    return;
                }
            };

            let callback_stream = stream.clone();
            let callback_sender = sender.clone();
            let callback_cancelled = std::sync::Arc::clone(&callback_cancelled);
            let callback = CapturePreviewCompletedHandler::create(Box::new(move |status| {
                if cancellation_requested(&callback_cancelled).is_err() {
                    return Ok(());
                }
                let result = status
                    .map_err(|error| CaptureError::WebView(error.to_string()))
                    .and_then(|_| {
                        read_png_stream(&callback_stream, max_png_bytes, &callback_cancelled)
                    });
                let _ = callback_sender.send(result);
                Ok(())
            }));

            let core = match unsafe { platform.controller().CoreWebView2() } {
                Ok(core) => core,
                Err(error) => {
                    let _ = sender.send(Err(CaptureError::WebView(error.to_string())));
                    return;
                }
            };

            if let Err(error) = unsafe {
                core.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream,
                    &callback,
                )
            } {
                let _ = sender.send(Err(CaptureError::WebView(error.to_string())));
            }
        })
        .map_err(|error| CaptureError::WebView(error.to_string()))?;

    match receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            cancelled.store(true, Ordering::Release);
            Err(CaptureError::Timeout {
                millis: timeout.as_millis().min(u64::MAX as u128) as u64,
            })
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(CaptureError::WebView(
            "CapturePreview callback disconnected".to_string(),
        )),
    }
}

#[cfg(windows)]
fn read_png_stream(
    stream: &IStream,
    max_png_bytes: usize,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, CaptureError> {
    cancellation_requested(cancelled)?;
    let mut stat = STATSTG::default();
    unsafe { stream.Stat(&mut stat, STATFLAG_NONAME) }
        .map_err(|error| CaptureError::Stream(format!("cannot stat output stream: {error}")))?;
    let declared_size = usize::try_from(stat.cbSize).map_err(|_| CaptureError::PngTooLarge {
        bytes: usize::MAX,
        max_bytes: max_png_bytes,
    })?;
    if declared_size > max_png_bytes {
        return Err(CaptureError::PngTooLarge {
            bytes: declared_size,
            max_bytes: max_png_bytes,
        });
    }

    cancellation_requested(cancelled)?;
    unsafe { stream.Seek(0, STREAM_SEEK_SET, None) }
        .map_err(|error| CaptureError::Stream(format!("cannot rewind output stream: {error}")))?;

    let mut output = Vec::with_capacity(declared_size);
    let mut buffer = [0u8; 64 * 1024];
    loop {
        cancellation_requested(cancelled)?;
        let mut bytes_read = 0u32;
        unsafe {
            stream.Read(
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                Some(&mut bytes_read),
            )
        }
        .ok()
        .map_err(|error| CaptureError::Stream(format!("cannot read output stream: {error}")))?;
        cancellation_requested(cancelled)?;
        if bytes_read == 0 {
            break;
        }
        let bytes_read = bytes_read as usize;
        let next_size = output
            .len()
            .checked_add(bytes_read)
            .ok_or(CaptureError::PngTooLarge {
                bytes: usize::MAX,
                max_bytes: max_png_bytes,
            })?;
        if next_size > max_png_bytes {
            return Err(CaptureError::PngTooLarge {
                bytes: next_size,
                max_bytes: max_png_bytes,
            });
        }
        output.extend_from_slice(&buffer[..bytes_read]);
    }
    Ok(output)
}

pub struct CaptureService<B> {
    backend: B,
    limits: CaptureLimits,
}

impl<B> CaptureService<B>
where
    B: PortalCaptureBackend,
{
    pub fn new(backend: B, limits: CaptureLimits) -> Self {
        Self { backend, limits }
    }

    pub fn capture(&mut self, request: CaptureRequest) -> Result<CaptureResult, CaptureError> {
        validate_request(&request, self.limits)?;
        let _capture_guard = acquire_capture_guard(&request.portal_id)?;
        let png = self
            .backend
            .capture_png(&request.portal_id, request.width, request.height)?;
        let (png_width, png_height) = validate_png(&png, self.limits)?;
        let path = write_output(&request.output, &png)?;

        Ok(CaptureResult {
            path,
            bytes_written: png.len(),
            width: png_width,
            height: png_height,
        })
    }
}

fn validate_request(request: &CaptureRequest, limits: CaptureLimits) -> Result<(), CaptureError> {
    if request.portal_id.trim().is_empty()
        || request.portal_id.chars().any(char::is_control)
        || request.portal_id.contains(':')
    {
        return Err(CaptureError::InvalidPortalId);
    }
    if request.width == 0 || request.height == 0 {
        return Err(CaptureError::InvalidDimensions);
    }
    if request.width > limits.max_width || request.height > limits.max_height {
        return Err(CaptureError::DimensionsTooLarge {
            width: request.width,
            height: request.height,
            max_width: limits.max_width,
            max_height: limits.max_height,
        });
    }
    if let CaptureOutput::Png(path) = &request.output {
        validate_output_path(path)?;
    }
    Ok(())
}

fn validate_output_path(path: &Path) -> Result<(), CaptureError> {
    let value = path.to_str().ok_or(CaptureError::InvalidOutputPath)?;
    if value.is_empty() {
        return Err(CaptureError::InvalidOutputPath);
    }
    if value
        .chars()
        .any(|character| character == '\0' || character.is_control())
    {
        return Err(CaptureError::InvalidOutputPathReason(
            "NUL/control characters are not allowed",
        ));
    }

    let windows_value = value.replace('/', "\\");
    let lowercase = windows_value.to_ascii_lowercase();
    if windows_value.starts_with("\\\\")
        || lowercase.starts_with("\\\\?\\")
        || lowercase.starts_with("\\\\.\\")
        || lowercase.starts_with("\\device\\")
        || lowercase.starts_with("\\??\\")
    {
        return Err(CaptureError::InvalidOutputPathReason(
            "UNC/device paths are not allowed",
        ));
    }

    let mut colon_count = 0usize;
    for (index, character) in windows_value.char_indices() {
        if character != ':' {
            continue;
        }
        colon_count += 1;
        if index != 1
            || !windows_value
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
            || windows_value.as_bytes().get(2).copied() != Some(b'\\')
        {
            return Err(CaptureError::InvalidOutputPathReason(
                "alternate data streams and drive-relative paths are not allowed",
            ));
        }
    }
    if colon_count > 1 {
        return Err(CaptureError::InvalidOutputPathReason(
            "alternate data streams are not allowed",
        ));
    }

    for component in windows_value.split('\\') {
        if component == "." || component == ".." {
            return Err(CaptureError::InvalidOutputPathReason(
                "traversal components are not allowed",
            ));
        }
    }
    if path.components().any(|component| {
        matches!(
            component,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )
    }) {
        return Err(CaptureError::InvalidOutputPathReason(
            "traversal components are not allowed",
        ));
    }
    if !path.is_absolute() {
        return Err(CaptureError::InvalidOutputPathReason(
            "output path must be absolute",
        ));
    }
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("png"))
        != Some(true)
    {
        return Err(CaptureError::InvalidOutputPath);
    }

    let parent = path.parent().ok_or(CaptureError::InvalidOutputPath)?;
    let metadata = fs::metadata(parent)
        .map_err(|_| CaptureError::InvalidOutputPathReason("output parent must already exist"))?;
    if !metadata.is_dir() {
        return Err(CaptureError::InvalidOutputPathReason(
            "output parent must be a directory",
        ));
    }
    Ok(())
}

fn validate_png(bytes: &[u8], limits: CaptureLimits) -> Result<(u32, u32), CaptureError> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    const IHDR_LENGTH: usize = 8 + 4 + 4 + 13 + 4;

    if bytes.len() > limits.max_png_bytes {
        return Err(CaptureError::PngTooLarge {
            bytes: bytes.len(),
            max_bytes: limits.max_png_bytes,
        });
    }
    if bytes.len() < IHDR_LENGTH || &bytes[..8] != PNG_SIGNATURE {
        return Err(CaptureError::InvalidPng("missing PNG signature or IHDR"));
    }
    if &bytes[12..16] != b"IHDR" {
        return Err(CaptureError::InvalidPng("first chunk is not IHDR"));
    }
    if u32::from_be_bytes(bytes[8..12].try_into().unwrap()) != 13 {
        return Err(CaptureError::InvalidPng("IHDR chunk has invalid length"));
    }

    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0 || height == 0 {
        return Err(CaptureError::InvalidPng("IHDR dimensions are zero"));
    }
    if width > limits.max_width || height > limits.max_height {
        return Err(CaptureError::PngDimensionsTooLarge {
            width,
            height,
            max_width: limits.max_width,
            max_height: limits.max_height,
        });
    }
    Ok((width, height))
}

fn write_output(output: &CaptureOutput, bytes: &[u8]) -> Result<PathBuf, CaptureError> {
    match output {
        CaptureOutput::Png(path) => {
            write_new_file(path, bytes)?;
            Ok(path.clone())
        }
        CaptureOutput::Temporary => write_temporary_file(bytes),
    }
}

fn write_temporary_file(bytes: &[u8]) -> Result<PathBuf, CaptureError> {
    let directory = std::env::temp_dir();
    for _ in 0..TEMP_FILE_RETRIES {
        let mut file = match tempfile::Builder::new()
            .prefix("maestri-portal-capture-")
            .suffix(".png")
            .tempfile_in(&directory)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(CaptureError::Io(error.to_string())),
        };
        if let Err(error) = file.write_all(bytes).and_then(|_| file.flush()) {
            return Err(CaptureError::Io(error.to_string()));
        }
        return file
            .keep()
            .map(|(_, path)| path)
            .map_err(|error| CaptureError::Io(error.error.to_string()));
    }
    Err(CaptureError::Io(
        "could not allocate a unique temporary screenshot path".to_string(),
    ))
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), CaptureError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                CaptureError::OutputAlreadyExists(path.to_path_buf())
            } else {
                CaptureError::Io(error.to_string())
            }
        })?;

    if let Err(error) = file.write_all(bytes).and_then(|_| file.flush()) {
        let _ = fs::remove_file(path);
        return Err(CaptureError::Io(error.to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockBackend {
        png: Vec<u8>,
    }

    impl PortalCaptureBackend for MockBackend {
        fn capture_png(
            &mut self,
            _portal_id: &str,
            _width: u32,
            _height: u32,
        ) -> Result<Vec<u8>, CaptureError> {
            Ok(self.png.clone())
        }
    }

    fn fake_png(width: u32, height: u32) -> Vec<u8> {
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&13_u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&width.to_be_bytes());
        png.extend_from_slice(&height.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        png.extend_from_slice(&[0, 0, 0, 0]);
        png
    }

    fn test_limits() -> CaptureLimits {
        CaptureLimits {
            max_width: 1_024,
            max_height: 768,
            max_png_bytes: 4 * 1024,
        }
    }

    #[test]
    fn validates_request_limits_and_portal_identity() {
        let limits = test_limits();
        let valid = CaptureRequest::new("portal-1", 800, 600, CaptureOutput::Temporary);
        assert!(validate_request(&valid, limits).is_ok());

        let invalid_id = CaptureRequest::new("portal:1", 800, 600, CaptureOutput::Temporary);
        assert_eq!(
            validate_request(&invalid_id, limits),
            Err(CaptureError::InvalidPortalId)
        );

        let oversized = CaptureRequest::new("portal-1", 2_000, 600, CaptureOutput::Temporary);
        assert!(matches!(
            validate_request(&oversized, limits),
            Err(CaptureError::DimensionsTooLarge { .. })
        ));
    }

    #[test]
    fn validates_png_signature_dimensions_and_byte_limit() {
        let limits = test_limits();
        assert_eq!(validate_png(&fake_png(800, 600), limits), Ok((800, 600)));
        assert!(matches!(
            validate_png(b"not png", limits),
            Err(CaptureError::InvalidPng(_))
        ));
        assert!(matches!(
            validate_png(&fake_png(2_000, 600), limits),
            Err(CaptureError::PngDimensionsTooLarge { .. })
        ));
        assert!(matches!(
            validate_png(&vec![0; 4_097], limits),
            Err(CaptureError::PngTooLarge { .. })
        ));
    }

    #[test]
    fn captures_to_explicit_png_path_without_overwriting() {
        let path = std::env::temp_dir().join(format!(
            "maestri-portal-capture-test-{}-{}.png",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let mut service = CaptureService::new(
            MockBackend {
                png: fake_png(320, 200),
            },
            test_limits(),
        );
        let request = CaptureRequest::new("portal-1", 320, 200, CaptureOutput::Png(path.clone()));
        let result = service.capture(request).unwrap();
        assert_eq!(result.width, 320);
        assert_eq!(result.height, 200);
        assert_eq!(fs::read(&path).unwrap(), fake_png(320, 200));

        let second = service.capture(CaptureRequest::new(
            "portal-1",
            320,
            200,
            CaptureOutput::Png(path.clone()),
        ));
        assert_eq!(second, Err(CaptureError::OutputAlreadyExists(path.clone())));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn captures_to_process_temp_png_path() {
        let mut service = CaptureService::new(
            MockBackend {
                png: fake_png(160, 90),
            },
            test_limits(),
        );
        let result = service
            .capture(CaptureRequest::new(
                "portal-process-temp-9d",
                160,
                90,
                CaptureOutput::Temporary,
            ))
            .unwrap();

        let temp_dir = std::env::temp_dir();
        assert_eq!(result.path.parent(), Some(temp_dir.as_path()));
        assert_eq!(
            result
                .path
                .extension()
                .and_then(|extension| extension.to_str()),
            Some("png")
        );
        assert_eq!(fs::read(&result.path).unwrap(), fake_png(160, 90));
        let _ = fs::remove_file(result.path);
    }

    #[test]
    fn temporary_paths_are_unpredictable_and_unique() {
        let mut service = CaptureService::new(
            MockBackend {
                png: fake_png(160, 90),
            },
            test_limits(),
        );
        let first = service
            .capture(CaptureRequest::new(
                "portal-temp-unique",
                160,
                90,
                CaptureOutput::Temporary,
            ))
            .unwrap();
        let second = service
            .capture(CaptureRequest::new(
                "portal-temp-unique",
                160,
                90,
                CaptureOutput::Temporary,
            ))
            .unwrap();
        assert_ne!(first.path, second.path);
        assert!(first.path.exists());
        assert!(second.path.exists());
        let _ = fs::remove_file(first.path);
        let _ = fs::remove_file(second.path);
    }

    #[test]
    fn unsupported_tauri_backend_is_deterministic() {
        let mut backend = UnsupportedTauriCapture;
        assert_eq!(
            backend.capture_png("portal-1", 100, 100),
            Err(CaptureError::Unsupported(
                "portal screenshot backend is unavailable"
            ))
        );
    }

    #[test]
    fn output_requires_png_extension() {
        let request = CaptureRequest::new(
            "portal-1",
            100,
            100,
            CaptureOutput::Png(std::env::temp_dir().join("capture.jpg")),
        );
        assert_eq!(
            validate_request(&request, test_limits()),
            Err(CaptureError::InvalidOutputPath)
        );
    }

    #[test]
    fn rejects_ambiguous_or_unsafe_explicit_paths() {
        let root = std::env::temp_dir();
        let cases = [
            root.join("capture.png").join("..").join("other.png"),
            PathBuf::from("relative.png"),
            PathBuf::from("\\\\server\\share\\capture.png"),
            PathBuf::from("\\\\?\\C:\\capture.png"),
            root.join("capture.png:stream"),
            root.join("capture\0.png"),
            root.join("missing-parent-9d").join("capture.png"),
        ];
        for path in cases {
            assert!(
                validate_output_path(&path).is_err(),
                "unsafe path unexpectedly accepted: {}",
                path.display()
            );
        }
    }

    #[test]
    fn capture_guard_enforces_per_portal_limit_and_raii_release() {
        let portal_id = "portal-guard-9d";
        let state = Arc::new(Mutex::new(ActiveCaptures::default()));
        let guard = acquire_capture_guard_from(state.clone(), portal_id).unwrap();
        assert!(matches!(
            acquire_capture_guard_from(state.clone(), portal_id),
            Err(CaptureError::ConcurrentLimit {
                scope: "portal",
                ..
            })
        ));
        drop(guard);
        assert!(acquire_capture_guard_from(state, portal_id).is_ok());
    }

    #[test]
    fn capture_guard_enforces_global_limit() {
        let state = Arc::new(Mutex::new(ActiveCaptures::default()));
        let guards = (0..MAX_CONCURRENT_CAPTURES)
            .map(|index| {
                acquire_capture_guard_from(state.clone(), &format!("portal-global-9d-{index}"))
            })
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(matches!(
            acquire_capture_guard_from(state.clone(), "portal-global-overflow-9d"),
            Err(CaptureError::ConcurrentLimit {
                scope: "global",
                ..
            })
        ));
        drop(guards);
        assert!(acquire_capture_guard_from(state, "portal-global-released-9d").is_ok());
    }

    #[test]
    fn capture_guard_limits_real_concurrent_threads() {
        use std::sync::{mpsc, Barrier};
        use std::thread;

        let state = Arc::new(Mutex::new(ActiveCaptures::default()));
        let barrier = Arc::new(Barrier::new(MAX_CONCURRENT_CAPTURES + 1));
        let (sender, receiver) = mpsc::channel();
        let mut workers = Vec::new();
        for index in 0..MAX_CONCURRENT_CAPTURES {
            let state = state.clone();
            let barrier = barrier.clone();
            let sender = sender.clone();
            workers.push(thread::spawn(move || {
                let guard = acquire_capture_guard_from(state, &format!("portal-thread-9d-{index}"))
                    .unwrap();
                sender.send(true).unwrap();
                barrier.wait();
                drop(guard);
            }));
        }
        drop(sender);
        for _ in 0..MAX_CONCURRENT_CAPTURES {
            assert_eq!(receiver.recv().unwrap(), true);
        }
        assert!(matches!(
            acquire_capture_guard_from(state, "portal-thread-overflow-9d"),
            Err(CaptureError::ConcurrentLimit {
                scope: "global",
                ..
            })
        ));
        barrier.wait();
        for worker in workers {
            worker.join().unwrap();
        }
    }

    #[test]
    fn cancellation_is_checked_before_stream_operations() {
        let cancelled = AtomicBool::new(false);
        assert!(cancellation_requested(&cancelled).is_ok());
        cancelled.store(true, Ordering::Release);
        assert_eq!(
            cancellation_requested(&cancelled),
            Err(CaptureError::Cancelled)
        );
    }
}
