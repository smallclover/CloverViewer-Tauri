use super::*;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        static ID: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "clover-cache-test-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Verify the absolute deletion target is the isolated fixture under Temp.
        let root = self.0.canonicalize().unwrap();
        let temp = std::env::temp_dir().canonicalize().unwrap();
        assert_eq!(root.parent(), Some(temp.as_path()));
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("clover-cache-test-"));
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn missing_directory_is_empty_but_invalid_directory_is_an_error() {
    let fixture = Fixture::new();
    let missing = fixture.0.join("missing");
    assert_eq!(summary(&missing).unwrap().files, 0);
    let empty = cleanup(&missing, 168).unwrap();
    assert_eq!((empty.files, empty.failed_files), (0, 0));
    let invalid = fixture.file("not-a-directory", b"file");
    assert!(summary(&invalid).unwrap_err().contains("not-a-directory"));
    assert!(cleanup(&invalid, 0)
        .unwrap_err()
        .contains("not-a-directory"));
}

#[test]
fn retention_preserves_recent_files_and_never_enters_subdirectories() {
    let fixture = Fixture::new();
    let old = fixture.file("old.png", b"old image");
    let recent = fixture.file("recent.png", b"recent image");
    fs::File::options()
        .write(true)
        .open(&old)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(8 * 24 * 3600))
        .unwrap();
    let nested = fixture.0.join("mcp-captures");
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join("keep.png"), b"nested image").unwrap();
    let before = summary(&fixture.0).unwrap();
    assert_eq!((before.files, before.bytes), (2, 21));
    let result = cleanup(&fixture.0, 168).unwrap();
    assert_eq!((result.files, result.bytes, result.failed_files), (1, 9, 0));
    assert!(result.first_error.is_none());
    assert!(!old.exists());
    assert!(recent.exists());
    let all = cleanup(&fixture.0, 0).unwrap();
    assert_eq!((all.files, all.bytes, all.failed_files), (1, 12, 0));
    assert!(nested.join("keep.png").exists());
}

#[test]
fn inspection_errors_are_counted_and_preserve_the_first_reason() {
    let fixture = Fixture::new();
    fixture.file("one.png", b"one");
    fixture.file("two.png", b"two");
    let failures = visit_files(&fixture.0, |_, _| {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "access denied",
        ))
    })
    .unwrap();
    assert_eq!(failures.count, 2);
    assert!(failures.first.unwrap().contains("access denied"));
}

#[test]
fn files_removed_during_scanning_are_not_reported_as_failures() {
    let fixture = Fixture::new();
    fixture.file("gone.png", b"gone");
    let failures = visit_files(&fixture.0, |path, _| {
        fs::remove_file(path)?;
        fs::metadata(path).map(|_| ())
    })
    .unwrap();
    assert_eq!(failures.count, 0);
    assert!(failures.first.is_none());
}

#[cfg(windows)]
#[test]
fn locked_files_report_partial_or_complete_failure_and_can_be_retried() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let locked_path = fixture.file("locked.png", b"locked image");
    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&locked_path)
        .unwrap();
    let removable = fixture.file("removable.png", b"removable image");
    let partial = cleanup(&fixture.0, 0).unwrap();
    assert_eq!(
        (partial.files, partial.bytes, partial.failed_files),
        (1, 15, 1)
    );
    assert!(partial.first_error.unwrap().contains("locked.png"));
    assert!(!removable.exists());
    assert!(locked_path.exists());
    let failed = cleanup(&fixture.0, 0).unwrap();
    assert_eq!((failed.files, failed.bytes, failed.failed_files), (0, 0, 1));
    assert!(failed.first_error.is_some());
    assert_eq!(summary(&fixture.0).unwrap().files, 1);
    drop(lock);
    let retry = cleanup(&fixture.0, 0).unwrap();
    assert_eq!((retry.files, retry.bytes, retry.failed_files), (1, 12, 0));
    assert_eq!(summary(&fixture.0).unwrap().files, 0);
}
