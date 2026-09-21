use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
pub fn get_autostart_enabled(app: tauri::AppHandle) -> bool {
  match app.autolaunch().is_enabled() {
    Ok(is_enabled) => is_enabled,
    Err(err) => {
      log::error!("Failed to read autostart state: {:?}", err);
      false
    }
  }
}

#[tauri::command]
pub fn set_autostart_enabled(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
  let app = window.app_handle();
  let manager = app.autolaunch();

  let result = if enabled {
    manager.enable()
  } else {
    manager.disable()
  };

  if let Err(err) = result {
    log::error!("Failed to toggle autostart: {:?}", err);
    return Err(err.to_string());
  }

  crate::tray::set_tray_autostart_state(app, enabled);

  if let Err(err) = app.emit("autostart-changed", enabled) {
    log::error!("Failed to emit autostart-changed: {:?}", err);
  }

  Ok(())
}
