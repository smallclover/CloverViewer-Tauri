use std::{fs, io, path::Path, time::SystemTime};

pub fn temporary_capture_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("CloverViewer")
}

#[derive(Debug, Default, serde::Serialize)]
pub struct CacheSummary {
    pub files: u64,
    pub bytes: u64,
}

#[derive(Debug, Default, serde::Serialize)]
pub struct CacheCleanupResult {
    pub files: u64,
    pub bytes: u64,
    pub failed_files: u64,
    pub first_error: Option<String>,
}

#[derive(Default)]
struct Failures {
    count: u64,
    first: Option<String>,
}

impl Failures {
    fn record(&mut self, error: String) {
        tracing::warn!("{error}");
        self.count += 1;
        if self.first.is_none() {
            self.first = Some(error);
        }
    }
}

/// 只维护目录顶层普通文件。文件在扫描期间被其它任务删除属于已清理，其他错误必须保留。
fn visit_files(
    dir: &Path,
    mut visit: impl FnMut(&Path, &fs::Metadata) -> io::Result<()>,
) -> Result<Failures, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Failures::default()),
        Err(error) => return Err(format!("{}: {error}", dir.display())),
    };
    let mut failures = Failures::default();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                failures.record(format!("{}: {error}", dir.display()));
                continue;
            }
        };
        let path = entry.path();
        let result = (|| {
            // 不跟随符号链接，不进入子目录（包括 MCP 截图目录）。
            if !entry.file_type()?.is_file() {
                return Ok(());
            }
            visit(&path, &entry.metadata()?)
        })();
        if let Err(error) = result {
            if error.kind() != io::ErrorKind::NotFound {
                failures.record(format!("{}: {error}", path.display()));
            }
        }
    }
    Ok(failures)
}

pub fn summary(dir: &Path) -> Result<CacheSummary, String> {
    let mut result = CacheSummary::default();
    let failures = visit_files(dir, |_, metadata| {
        result.files += 1;
        result.bytes += metadata.len();
        Ok(())
    })?;
    // 不能把扫描失败或不完整的统计伪装成零占用。
    if let Some(error) = failures.first {
        return Err(error);
    }
    Ok(result)
}

/// 按最后修改时间清理；0 表示全部。单文件失败继续处理其余文件并返回失败计数。
pub fn cleanup(dir: &Path, older_than_hours: u32) -> Result<CacheCleanupResult, String> {
    let cutoff = SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(
            u64::from(older_than_hours) * 3600,
        ))
        .ok_or_else(|| "Invalid cache retention period".to_string())?;
    let mut result = CacheCleanupResult::default();
    let failures = visit_files(dir, |path, metadata| {
        if older_than_hours == 0 || metadata.modified()? < cutoff {
            fs::remove_file(path)?;
            result.files += 1;
            result.bytes += metadata.len();
        }
        Ok(())
    })?;
    result.failed_files = failures.count;
    result.first_error = failures.first;
    Ok(result)
}

#[cfg(test)]
#[path = "temp_cache_tests.rs"]
mod tests;
