use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Creates (or, if already open, just focuses) the "view2d" window — a
/// plain resizable preview panel for whatever's wired into a `view2d` node,
/// no monitor targeting or fullscreen (unlike the projector-facing output
/// window). Its whole point is running on its own webview so a heavy 2D
/// texture chain never steals frame budget from the main editor's 3D
/// viewport; see view2DNodeId in Viewport.tsx.
#[tauri::command]
pub fn open_view2d_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("view2d") {
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, "view2d", WebviewUrl::App("index.html#/view2d".into()))
        .title("Tsuji 2D View")
        .inner_size(960.0, 540.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn close_view2d_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("view2d") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
