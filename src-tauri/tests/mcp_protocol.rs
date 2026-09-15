#![cfg(windows)]

use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant},
};

const RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
const SERVER_BINARY: &str = env!("CARGO_BIN_EXE_cloverviewer-tauri");

struct StdioServer {
    child: Child,
    stdin: ChildStdin,
    responses: Receiver<std::io::Result<String>>,
    reader: Option<thread::JoinHandle<()>>,
}

impl StdioServer {
    fn start() -> Self {
        let mut child = Command::new(SERVER_BINARY)
            .arg("--mcp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start MCP stdio server");
        let stdin = child.stdin.take().expect("MCP stdio stdin");
        let stdout = child.stdout.take().expect("MCP stdio stdout");
        let (sender, responses) = mpsc::channel();
        let reader = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            stdin,
            responses,
            reader: Some(reader),
        }
    }

    fn send(&mut self, message: Value) {
        writeln!(self.stdin, "{}", serde_json::to_string(&message).unwrap())
            .expect("write MCP request");
        self.stdin.flush().expect("flush MCP request");
    }

    fn receive(&self) -> Value {
        let line = self
            .responses
            .recv_timeout(RESPONSE_TIMEOUT)
            .expect("timed out waiting for MCP response")
            .expect("read MCP response");
        serde_json::from_str(&line).expect("valid JSON-RPC response")
    }
}

impl Drop for StdioServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

struct HttpServer {
    child: Child,
    port: u16,
}

impl HttpServer {
    fn start(token: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("reserve local port");
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let child = Command::new(SERVER_BINARY)
            .args(["--mcp-http", "--port", &port.to_string(), "--token", token])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start MCP HTTP server");
        let deadline = Instant::now() + RESPONSE_TIMEOUT;
        while TcpStream::connect(("127.0.0.1", port)).is_err() {
            assert!(Instant::now() < deadline, "MCP HTTP server did not start");
            thread::sleep(Duration::from_millis(25));
        }
        Self { child, port }
    }
}

impl Drop for HttpServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn initialize_request(id: u64) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "cloverviewer-test", "version": "1.0" }
        }
    })
    .to_string()
}

fn http_post(port: u16, headers: &[(&str, &str)], body: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect MCP HTTP server");
    stream
        .set_read_timeout(Some(RESPONSE_TIMEOUT))
        .expect("set HTTP read timeout");
    let mut request = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (name, value) in headers {
        request.push_str(name);
        request.push_str(": ");
        request.push_str(value);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    request.push_str(body);
    stream
        .write_all(request.as_bytes())
        .expect("send HTTP request");
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .expect("read HTTP response");
    response
}

fn session_id(response: &str) -> String {
    response
        .lines()
        .find_map(|line| line.strip_prefix("mcp-session-id: "))
        .map(str::trim)
        .map(str::to_owned)
        .expect("MCP session ID response header")
}

#[test]
fn stdio_negotiates_tools_and_rejects_invalid_capture_target() {
    let mut server = StdioServer::start();
    server.send(serde_json::from_str(&initialize_request(1)).unwrap());
    let initialized = server.receive();
    assert_eq!(initialized["id"], 1);
    assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");

    server.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized", "params": {} }));
    server.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }));
    let tools = server.receive();
    let tool_names = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        tool_names,
        vec![
            "delete_screenshot",
            "get_screenshot",
            "list_monitors",
            "ocr_screenshot",
            "take_screenshot",
        ]
    );

    server.send(json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": { "name": "take_screenshot", "arguments": { "mode": "monitor" } }
    }));
    let invalid_target = server.receive();
    assert_eq!(invalid_target["error"]["code"], -32602);
    assert_eq!(
        invalid_target["error"]["message"],
        "monitor_id or monitor_index is required when mode='monitor'"
    );
}

#[test]
fn http_requires_local_origin_and_token_then_serves_tools() {
    let token = "mcp-protocol-test-token";
    let server = HttpServer::start(token);
    let request = initialize_request(1);

    let unauthorized = http_post(server.port, &[], &request);
    assert!(
        unauthorized.starts_with("HTTP/1.1 401"),
        "unexpected unauthorized response: {unauthorized:?}"
    );
    assert!(unauthorized
        .to_ascii_lowercase()
        .contains("www-authenticate: bearer"));

    let rejected_origin = http_post(
        server.port,
        &[
            ("Authorization", "Bearer mcp-protocol-test-token"),
            ("Origin", "https://example.invalid"),
        ],
        &request,
    );
    assert!(rejected_origin.starts_with("HTTP/1.1 403"));

    let headers = [
        ("Authorization", "Bearer mcp-protocol-test-token"),
        ("Origin", "http://localhost"),
        ("Accept", "application/json, text/event-stream"),
    ];
    let initialized = http_post(server.port, &headers, &request);
    assert!(initialized.starts_with("HTTP/1.1 200"));
    assert!(initialized.contains("\"protocolVersion\":\"2025-06-18\""));
    let session_id = session_id(&initialized);

    let session_headers = [
        ("Authorization", "Bearer mcp-protocol-test-token"),
        ("Origin", "http://localhost"),
        ("Accept", "application/json, text/event-stream"),
        ("Mcp-Session-Id", session_id.as_str()),
    ];
    let notification = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    })
    .to_string();
    let notification_response = http_post(server.port, &session_headers, &notification);
    assert!(notification_response.starts_with("HTTP/1.1 202"));

    let list_tools =
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }).to_string();
    let tools_response = http_post(server.port, &session_headers, &list_tools);
    assert!(tools_response.starts_with("HTTP/1.1 200"));
    assert!(tools_response.contains("\"list_monitors\""));
    assert!(tools_response.contains("\"take_screenshot\""));
}
