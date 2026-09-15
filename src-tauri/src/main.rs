// release 构建用 "windows" 子系统（无 console 窗口，避免启动时弹出黑窗）；
// debug 构建保持 "console"（dev 日志输出需要看到）。
//
// MCP stdio 模式也走 "windows" 子系统是有意为之：MCP host 通过 pipe 启动本进程，
// 不需要 console 分配，stdio handle 仍然可用。tracing 输出经 fmt 默认 write to
// stderr（在 GUI subsystem 下会被忽略）——MCP 模式下日志不是关键信息，可接受丢失。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        // MCP stdio reserves stdout exclusively for JSON-RPC messages. Keep
        // diagnostics on stderr so a tool failure cannot corrupt the stream.
        .with_writer(std::io::stderr)
        .init();

    // MCP stdio must allow one independent server process per MCP client.
    if std::env::args().any(|a| a == "--mcp") {
        cloverviewer_tauri_lib::mcp::run_mcp_server();
        return;
    }

    // MCP HTTP server 模式
    if std::env::args().any(|a| a == "--mcp-http") {
        let args = std::env::args().collect::<Vec<_>>();
        let port = match args
            .windows(2)
            .find_map(|w| {
                if w[0] == "--port" {
                    Some(w[1].parse::<u16>())
                } else {
                    None
                }
            })
            .unwrap_or(Ok(3000))
        {
            Ok(port) if port != 0 => port,
            Ok(_) => {
                eprintln!("--port must be between 1 and 65535.");
                return;
            }
            Err(_) => {
                eprintln!("--port must be a number between 1 and 65535.");
                return;
            }
        };
        let token = match args
            .windows(2)
            .find_map(|w| (w[0] == "--token").then_some(w[1].clone()))
        {
            Some(token) if !token.trim().is_empty() => token,
            _ => {
                eprintln!("--mcp-http requires --token <secret> for local access protection.");
                return;
            }
        };
        cloverviewer_tauri_lib::mcp::run_mcp_http_server(port, token);
        return;
    }

    // GUI 模式：隐藏控制台窗口（仅 release 构建）
    #[cfg(all(not(debug_assertions), target_os = "windows"))]
    cloverviewer_tauri_lib::hide_console_window();

    cloverviewer_tauri_lib::run()
}
