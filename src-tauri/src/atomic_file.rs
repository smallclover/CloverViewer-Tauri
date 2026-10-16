//! 先写完同目录临时文件再替换；编码、写入或替换失败都保留原文件。
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_FILE: AtomicU64 = AtomicU64::new(1);
struct TemporaryFile(PathBuf);
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_with(path, |file| file.write_all(bytes))
}

fn write_with(path: &Path, write: impl FnOnce(&mut File) -> io::Result<()>) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing filename"))?;
    let (temporary, mut file) = loop {
        let mut filename = std::ffi::OsString::from(".");
        filename.push(name);
        filename.push(format!(
            ".{}-{}.tmp",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        let temporary = TemporaryFile(parent.join(filename));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary.0)
        {
            Ok(file) => break (temporary, file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                std::mem::forget(temporary);
            }
            Err(error) => return Err(error),
        }
    };
    write(&mut file)?;
    file.sync_all()?;
    drop(file);
    // std::fs::rename uses MOVEFILE_REPLACE_EXISTING on Windows; the temporary
    // file is on the same filesystem and the target is never opened/truncated.
    fs::rename(&temporary.0, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_writes_keep_original_and_remove_partial_temporary_files() {
        let directory = std::env::temp_dir().join(format!(
            "clover-atomic-{}-{}",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        let target = directory.join("原图.png");
        fs::write(&target, b"original").unwrap();
        let result = write_with(&target, |file| {
            file.write_all(b"partial")?;
            Err(io::Error::other("disk full"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        write(&target, b"complete").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"complete");
        let occupied = directory.join("directory");
        fs::create_dir(&occupied).unwrap();
        assert!(write(&occupied, b"cannot replace directory").is_err());
        assert!(occupied.is_dir());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);
        fs::remove_file(target).unwrap();
        fs::remove_dir(occupied).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
