//! 页面自绘菜单的无边框窗口，不应因裸 Alt / F10 进入不可见的原生菜单循环。
//!
//! RegisterHotKey 会吃掉 Alt+S 中的 S；窗口可能只收到 Alt 的按下和松开。
//! DefWindowProc 随后处理 SC_KEYMENU(0)，捕获鼠标并等待点击或另一个键，
//! 阻塞正常的截图输入与 Tauri 事件循环。只拦截这个空菜单入口。
use tauri::WebviewWindow;

pub(crate) fn prevent_empty_menu_loop(window: &WebviewWindow) {
    #[cfg(windows)]
    {
        let target = window.clone();
        // SetWindowSubclass 必须在拥有 HWND 的线程调用；截图窗在 worker 中创建。
        if let Err(error) = window.run_on_main_thread(move || {
            let Ok(handle) = target.hwnd() else { return };
            if !unsafe { platform::install(windows::Win32::Foundation::HWND(handle.0)) } {
                tracing::warn!("安装窗口 Alt 菜单保护失败");
            }
        }) {
            tracing::warn!("调度窗口 Alt 菜单保护失败: {error}");
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
mod platform {
    use windows::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{SC_KEYMENU, WM_NCDESTROY, WM_SYSCOMMAND},
        },
    };

    const SUBCLASS_ID: usize = 0x434c4b42;

    pub(super) unsafe fn install(hwnd: HWND) -> bool {
        SetWindowSubclass(hwnd, Some(menu_guard), SUBCLASS_ID, 0).as_bool()
    }

    unsafe extern "system" fn menu_guard(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        _data: usize,
    ) -> LRESULT {
        if message == WM_SYSCOMMAND && wparam.0 & 0xfff0 == SC_KEYMENU as usize && lparam.0 == 0 {
            // 仅裸 Alt / F10。Alt+Space 的非零字符、Alt+F4 及其他系统命令照常传递。
            return LRESULT(0);
        }
        if message == WM_NCDESTROY {
            let _ = RemoveWindowSubclass(hwnd, Some(menu_guard), id);
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::cell::RefCell;
        use windows::{
            core::w,
            Win32::UI::WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, SendMessageW, SC_CLOSE, SC_MINIMIZE,
                WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW,
            },
        };

        thread_local! {
            static FORWARDED: RefCell<Vec<(usize, isize)>> = const { RefCell::new(Vec::new()) };
        }

        struct TestWindow(HWND);
        impl Drop for TestWindow {
            fn drop(&mut self) {
                unsafe { DestroyWindow(self.0).unwrap() };
            }
        }

        unsafe extern "system" fn record_system_command(
            hwnd: HWND,
            message: u32,
            wparam: WPARAM,
            lparam: LPARAM,
            _id: usize,
            _data: usize,
        ) -> LRESULT {
            if message == WM_SYSCOMMAND {
                FORWARDED.with(|calls| calls.borrow_mut().push((wparam.0, lparam.0)));
                // 截住下游命令，避免测试真的关闭窗口或进入系统菜单等待。
                return LRESULT(42);
            }
            DefSubclassProc(hwnd, message, wparam, lparam)
        }

        #[test]
        fn native_alt_menu_is_blocked_while_system_shortcuts_are_forwarded() {
            unsafe {
                let window = TestWindow(
                    CreateWindowExW(
                        WINDOW_EX_STYLE::default(),
                        w!("STATIC"),
                        w!("menu-guard-test"),
                        WS_OVERLAPPEDWINDOW,
                        0,
                        0,
                        100,
                        100,
                        None,
                        None,
                        None,
                        None,
                    )
                    .unwrap(),
                );
                assert!(SetWindowSubclass(
                    window.0,
                    Some(record_system_command),
                    SUBCLASS_ID + 1,
                    0
                )
                .as_bool());
                assert!(install(window.0));
                for command in [SC_KEYMENU as usize, SC_KEYMENU as usize | 0xf] {
                    assert_eq!(
                        SendMessageW(
                            window.0,
                            WM_SYSCOMMAND,
                            Some(WPARAM(command)),
                            Some(LPARAM(0))
                        ),
                        LRESULT(0)
                    );
                }
                let commands = [
                    (SC_KEYMENU, 32),
                    (SC_KEYMENU, 70),
                    (SC_CLOSE, 0),
                    (SC_MINIMIZE, 0),
                ];
                for (command, character) in commands {
                    assert_eq!(
                        SendMessageW(
                            window.0,
                            WM_SYSCOMMAND,
                            Some(WPARAM(command as usize)),
                            Some(LPARAM(character))
                        ),
                        LRESULT(42)
                    );
                }
                FORWARDED.with(|calls| {
                    assert_eq!(
                        *calls.borrow(),
                        commands.map(|(command, character)| (command as usize, character))
                    )
                });
            }
        }
    }
}
