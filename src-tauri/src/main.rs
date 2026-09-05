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
