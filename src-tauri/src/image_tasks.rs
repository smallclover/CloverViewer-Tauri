//! 所有昂贵图像任务共用并发上限，等待许可不占用 UI 或 Tokio 工作线程。
use std::sync::{Arc, OnceLock};
use tokio::sync::Semaphore;
static GATE: OnceLock<Arc<Semaphore>> = OnceLock::new();

pub async fn run<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    run_with(
        GATE.get_or_init(|| Arc::new(Semaphore::new(2))).clone(),
        task,
    )
    .await
}

async fn run_with<T: Send + 'static>(
    gate: Arc<Semaphore>,
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let permit = gate
        .acquire_owned()
        .await
        .map_err(|error| error.to_string())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        task()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn image_jobs_run_off_the_runtime_thread_and_release_permits_after_failure() {
        let gate = Arc::new(Semaphore::new(1));
        let caller = std::thread::current().id();
        assert_ne!(
            run_with(gate.clone(), || Ok(std::thread::current().id()))
                .await
                .unwrap(),
            caller
        );
        assert!(run_with(gate.clone(), || -> Result<(), String> {
            Err("decode failed".into())
        })
        .await
        .is_err());
        assert_eq!(gate.available_permits(), 1);
        let held = gate.clone().acquire_owned().await.unwrap();
        let future = run_with(gate.clone(), || Ok(7));
        tokio::pin!(future);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut future)
                .await
                .is_err()
        );
        drop(held);
        assert_eq!(future.await.unwrap(), 7);
    }
}
