// MCP stdio 模式需要控制台子系统（stdin/stdout），故用 "console"；
// GUI 模式下 release 构建手动隐藏控制台窗口（见 hide_console_window）。
// 与 egui 原版 main.rs 的处理一致。
#![cfg_attr(not(debug_assertions), windows_subsystem = "console")]

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    // MCP server 模式：--mcp 在 single-instance 检查之前处理
    if std::env::args().any(|a| a == "--mcp") {
        let instance_guard = match single_instance::SingleInstance::new("CloverViewer_MCP") {
            Ok(instance) => {
                if !instance.is_single() {
                    eprintln!("Another MCP server instance is already running, exiting.");
                    return;
                }
                instance
            }
            Err(err) => {
                eprintln!("Failed to create single instance guard: {err}");
                return;
            }
        };
        cloverviewer_tauri_lib::mcp::run_mcp_server(instance_guard);
        return;
    }

    // MCP HTTP server 模式
    if std::env::args().any(|a| a == "--mcp-http") {
        let port = std::env::args()
            .collect::<Vec<_>>()
            .windows(2)
            .find_map(|w| {
                if w[0] == "--port" {
                    w[1].parse::<u16>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(3000);
        // 探测端口是否已被占用
        if std::net::TcpStream::connect(format!("127.0.0.1:{port}")).is_ok() {
            eprintln!(
                "Port {port} is already in use, another MCP HTTP server may be running. Exiting."
            );
            return;
        }
        cloverviewer_tauri_lib::mcp::run_mcp_http_server(port);
        return;
    }

    // GUI 模式：隐藏控制台窗口（仅 release 构建）
    #[cfg(all(not(debug_assertions), target_os = "windows"))]
    cloverviewer_tauri_lib::hide_console_window();

    cloverviewer_tauri_lib::run()
}
