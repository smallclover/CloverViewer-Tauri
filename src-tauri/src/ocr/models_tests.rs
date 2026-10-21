use super::*;
use sha2::{Digest, Sha256};
use std::{
    net::TcpListener,
    sync::{mpsc, Arc},
    thread::JoinHandle,
    time::Instant,
};

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "clover-ocr-download-test-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        CANCEL.store(false, Ordering::Relaxed);
        for name in ["test.onnx", "test.onnx.part"] {
            let _ = fs::remove_file(self.0.join(name));
        }
        let _ = fs::remove_dir(&self.0);
    }
}

/// Every blocking operation has a deadline; Drop also releases a paused response on failure.
struct TestServer {
    url: &'static str,
    stop: Arc<AtomicBool>,
    release: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl TestServer {
    fn new(body: &'static [u8], length: usize, paused: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url =
            Box::leak(format!("http://{}/model", listener.local_addr().unwrap()).into_boxed_str());
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let (release, released) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut stream = loop {
                if stopping.load(Ordering::Relaxed) || Instant::now() >= deadline {
                    return;
                }
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => return,
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut request = [0u8; 4096];
            if stream.read(&mut request).is_err() {
                return;
            }
            if write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
            )
            .and_then(|_| stream.write_all(body))
            .is_err()
            {
                return;
            }
            if paused {
                let _ = released.recv_timeout(Duration::from_secs(3));
            }
        });
        Self {
            url,
            stop,
            release: Some(release),
            thread: Some(thread),
        }
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.release.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn client() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(1))
        .read_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap()
}

#[test]
fn downloads_commit_only_verified_bytes_and_preserve_existing_files() {
    let _access = ACCESS.write().unwrap();
    let dir = TestDirectory::new();
    CANCEL.store(false, Ordering::Relaxed);
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let client = client();
        for valid in [true, false] {
            let server = TestServer::new(b"model", 5, false);
            let hash = if valid {
                format!("{:x}", Sha256::digest(b"model"))
            } else {
                "0".repeat(64)
            };
            let asset = Asset {
                name: "test.onnx",
                url: server.url,
                bytes: 5,
                sha256: Box::leak(hash.into_boxed_str()),
            };
            let result = download(&client, &dir.0, &asset).await;
            if valid {
                result.unwrap();
            } else {
                assert_eq!(result.unwrap_err(), "OCR_MODEL_CORRUPT");
            }
            assert_eq!(fs::read(dir.0.join("test.onnx")).unwrap(), b"model");
            assert!(!dir.0.join("test.onnx.part").exists());
        }
        CANCEL.store(true, Ordering::Relaxed);
        assert_eq!(
            download(&client, &dir.0, &assets::DET).await.unwrap_err(),
            "OCR_DOWNLOAD_CANCELLED"
        );
        assert!(!dir.0.join("det.onnx.part").exists());
    });
}

#[test]
fn cancelling_inflight_download_removes_partial_and_preserves_complete_target() {
    let _access = ACCESS.write().unwrap();
    let dir = TestDirectory::new();
    CANCEL.store(false, Ordering::Relaxed);
    fs::write(dir.0.join("test.onnx"), b"original").unwrap();
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let client = client();
        let server = TestServer::new(b"model", 10, true);
        let asset = Asset {
            name: "test.onnx",
            url: server.url,
            bytes: 10,
            sha256: Box::leak(format!("{:x}", Sha256::digest(b"model-more")).into_boxed_str()),
        };
        let cancel_after_partial = async {
            tokio::time::timeout(Duration::from_secs(2), async {
                while !fs::metadata(dir.0.join("test.onnx.part")).is_ok_and(|m| m.len() == 5) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the partial response must be written before cancelling");
            CANCEL.store(true, Ordering::Relaxed);
        };
        let (result, ()) = tokio::join!(download(&client, &dir.0, &asset), cancel_after_partial);
        assert_eq!(result.unwrap_err(), "OCR_DOWNLOAD_CANCELLED");
        assert!(!dir.0.join("test.onnx.part").exists());
        assert_eq!(fs::read(dir.0.join("test.onnx")).unwrap(), b"original");
    });
}

#[test]
#[ignore = "requires downloaded CLOVER_OCR_TEST_ASSETS"]
fn install_verified_runtime_archive() {
    let dir = PathBuf::from(std::env::var_os("CLOVER_OCR_TEST_ASSETS").unwrap());
    CANCEL.store(false, Ordering::Relaxed);
    install_runtime(&dir).unwrap();
    assert!(installed_at(&dir));
    assets::verify(&dir).unwrap();
    assert!(dir.join("PaddleOCR-LICENSE").is_file());
    assert!(!dir.join("runtime.zip").exists());
}

#[test]
fn corrupt_and_partial_downloads_are_not_installations() {
    let dir = std::env::temp_dir().join(format!("clover-ocr-test-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("det.onnx"), b"corrupt").unwrap();
    fs::write(dir.join("runtime.zip.part"), b"partial").unwrap();
    fs::write(dir.join("unrelated.txt"), b"preserve").unwrap();
    assert!(!installed_at(&dir));
    assert!(assets::check_file(&dir.join("det.onnx"), 7, assets::DET.sha256).is_err());
    remove_at(&dir).unwrap();
    assert_eq!(fs::read(dir.join("unrelated.txt")).unwrap(), b"preserve");
    fs::remove_file(dir.join("unrelated.txt")).unwrap();
    fs::remove_dir(dir).unwrap();
}
