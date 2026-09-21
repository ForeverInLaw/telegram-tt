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
  set_autostart_state(window.app_handle(), enabled)
}

/// Enables or disables autostart and propagates the new state to the tray menu
/// and the settings UI (`autostart-changed` event).
pub fn set_autostart_state(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
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

/// Reads the live autostart state into the tray cache; called before the tray
/// is created so the menu is built with the actual checked state.
pub fn sync_autostart_state(app: &tauri::AppHandle) {
  match app.autolaunch().is_enabled() {
    Ok(is_enabled) => crate::tray::set_tray_autostart_state(app, is_enabled),
    Err(err) => log::error!("Failed to read autostart state: {:?}", err),
  }
}
