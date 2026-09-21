use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use tauri::{
  AppHandle, Emitter, Manager, WebviewWindow,
  image::Image,
  menu::{CheckMenuItem, Menu, MenuItem},
  tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
};

#[cfg(not(target_os = "macos"))]
mod badge;

pub use crate::{AppState, BASE_URL, DEFAULT_WINDOW_TITLE, LAST_URL, WITH_UPDATER};

// Platform-specific tray icon assets
#[cfg(target_os = "macos")]
pub(crate) static TRAY_ICON_BYTES: &[u8] = include_bytes!("../../icons/tray-macos.png");

#[cfg(not(target_os = "macos"))]
pub(crate) static TRAY_ICON_BYTES: &[u8] = include_bytes!("../../icons/32x32.png");

pub(crate) static TRAY_BASE_ICON: LazyLock<Image<'static>> =
  LazyLock::new(|| Image::from_bytes(TRAY_ICON_BYTES).expect("Failed to load base tray icon"));

// Menu constants; ids are matched by the web-sent translations in
// `src/util/tauri/updateTrayMenu.ts`.
pub const MENU_ITEM_OPEN_ID: &str = "open";
pub const MENU_ITEM_OPEN_LABEL: &str = "Open Telegram";
pub const MENU_ITEM_AUTOSTART_ID: &str = "autostart";
pub const MENU_ITEM_AUTOSTART_LABEL: &str = "Launch on system startup";
pub const MENU_ITEM_CHECK_UPDATES_ID: &str = "check_updates";
pub const MENU_ITEM_CHECK_UPDATES_LABEL: &str = "Check for updates";
pub const MENU_ITEM_QUIT_ID: &str = "quit";
pub const MENU_ITEM_QUIT_LABEL: &str = "Quit Telegram";

static MENU_TRANSLATIONS: LazyLock<std::sync::Mutex<HashMap<String, String>>> =
  LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

pub(super) static TRAY_HANDLE: LazyLock<Mutex<Option<TrayIcon>>> =
  LazyLock::new(|| Mutex::new(None));

// Mirrors the current autostart state so the menu can be built with the
// correct checked state of the autostart item.
pub static AUTOSTART_STATE: LazyLock<Mutex<bool>> = LazyLock::new(|| Mutex::new(false));

/// Updates the cached autostart state and rebuilds the menu, so the check item
/// reflects reality from either trigger surface (settings or tray).
pub fn set_tray_autostart_state(app: &AppHandle, is_enabled: bool) {
  if let Ok(mut state) = AUTOSTART_STATE.lock() {
    *state = is_enabled;
  }

  if let Err(err) = rebuild_menu(app) {
    log::error!("Failed to rebuild tray menu: {:?}", err);
  }
}

pub fn set_menu_translations(new_labels: HashMap<String, String>) {
  if let Ok(mut labels) = MENU_TRANSLATIONS.lock() {
    *labels = new_labels;
  }
}

fn translated_label(id: &str, default: &str) -> String {
  if let Ok(labels) = MENU_TRANSLATIONS.lock() {
    labels
      .get(id)
      .cloned()
      .unwrap_or_else(|| default.to_string())
  } else {
    default.to_string()
  }
}

/// Builds the tray menu with the current translations and the current
/// autostart state, and applies it to the tray icon. A no-op when the tray is
/// not created yet (the menu is built at init instead).
pub fn rebuild_menu(app: &AppHandle) -> tauri::Result<()> {
  let tray = TRAY_HANDLE.lock().ok().and_then(|tray| tray.as_ref().cloned());
  let Some(tray) = tray else {
    return Ok(());
  };

  let open_label = translated_label(MENU_ITEM_OPEN_ID, MENU_ITEM_OPEN_LABEL);
  let open_i = MenuItem::with_id(app, MENU_ITEM_OPEN_ID, &open_label, true, None::<&str>)?;

  let is_autostart_enabled = AUTOSTART_STATE.lock().map(|is_enabled| *is_enabled).unwrap_or(false);
  let autostart_label = translated_label(MENU_ITEM_AUTOSTART_ID, MENU_ITEM_AUTOSTART_LABEL);
  let autostart_i = CheckMenuItem::with_id(
    app,
    MENU_ITEM_AUTOSTART_ID,
    &autostart_label,
    true,
    is_autostart_enabled,
    None::<&str>,
  )?;

  let quit_label = translated_label(MENU_ITEM_QUIT_ID, MENU_ITEM_QUIT_LABEL);
  let quit_i = MenuItem::with_id(app, MENU_ITEM_QUIT_ID, &quit_label, true, None::<&str>)?;

  // `WITH_UPDATER` is a compile-time constant, so one branch is eliminated here.
  let menu = if WITH_UPDATER == "true" {
    let check_updates_label = translated_label(
      MENU_ITEM_CHECK_UPDATES_ID,
      MENU_ITEM_CHECK_UPDATES_LABEL,
    );
    let check_updates_i = MenuItem::with_id(
      app,
      MENU_ITEM_CHECK_UPDATES_ID,
      &check_updates_label,
      true,
      None::<&str>,
    )?;
    Menu::with_items(app, &[&open_i, &autostart_i, &check_updates_i, &quit_i])?
  } else {
    Menu::with_items(app, &[&open_i, &autostart_i, &quit_i])?
  };

  tray.set_menu(Some(menu))
}

#[derive(Default)]
pub struct TrayManager;

impl TrayManager {
  pub fn init(app: AppHandle) -> Result<Self, tauri::Error> {
    let icon = TRAY_BASE_ICON.clone();

    let tray_builder = TrayIconBuilder::new()
      .icon(icon)
      .show_menu_on_left_click(false)
      .tooltip(DEFAULT_WINDOW_TITLE)
      .on_menu_event(|app, event| match event.id.as_ref() {
        MENU_ITEM_OPEN_ID => handle_icon_click(app, true),
        MENU_ITEM_AUTOSTART_ID => toggle_autostart_from_tray(app),
        MENU_ITEM_CHECK_UPDATES_ID => emit_check_updates(app),
        MENU_ITEM_QUIT_ID => app.exit(0),
        _ => {}
      })
      .on_tray_icon_event(|tray, event| tray_click_handler(tray, event));

    // Set icon as template on macOS for proper system theme integration
    #[cfg(target_os = "macos")]
    let tray_builder = tray_builder.icon_as_template(true);

    let tray_icon = tray_builder.build(&app)?;

    // Save tray handle for future updates
    if let Ok(mut tray_lock) = TRAY_HANDLE.lock() {
      *tray_lock = Some(tray_icon.clone());
    }

    rebuild_menu(&app)?;

    Ok(Self)
  }
}

fn toggle_autostart_from_tray(app: &AppHandle) {
  let is_enabled = AUTOSTART_STATE.lock().map(|is_enabled| *is_enabled).unwrap_or(false);
  if let Err(err) = crate::autostart::set_autostart_state(app, !is_enabled) {
    log::error!("Failed to toggle autostart from tray: {:?}", err);
  }
}

/// Asks the web side (see `src/util/tauri/appUpdates.ts`) to run a manual
/// update check with visible feedback.
fn emit_check_updates(app: &AppHandle) {
  if let Err(err) = app.emit("update-check-requested", ()) {
    log::error!("Failed to emit update-check-requested: {:?}", err);
  }
}

fn tray_click_handler(tray: &TrayIcon, event: TrayIconEvent) {
  let TrayIconEvent::Click {
    button: MouseButton::Left,
    button_state: MouseButtonState::Up,
    ..
  } = event
  else {
    return;
  };

  handle_icon_click(tray.app_handle(), false);
}

fn handle_icon_click(app: &AppHandle, only_open: bool) {
  let active_windows = app.windows();

  if active_windows.is_empty() {
    // No open windows, restore with last URL.
    let url = if let Ok(last_url) = LAST_URL.lock() {
      last_url.clone()
    } else {
      BASE_URL.to_string()
    };

    if let Err(err) = crate::open_new_window(app.clone(), url) {
      log::error!("Failed to open window from tray: {:?}", err);
    }
    return;
  }

  // Check if any window is visible (since clicking tray unfocuses windows).
  let visible_window = active_windows.iter().find(|(_, window)| {
    window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
  });

  let Some((_, visible_window)) = visible_window else {
    // No visible window, show and focus the first available window.
    if let Some((_, window)) = active_windows.iter().next() {
      if let Err(err) = window.unminimize() {
        log::warn!("Failed to unminimize window: {:?}", err);
      }
      if let Err(err) = window.show() {
        log::error!("Failed to show window: {:?}", err);
      }
      if let Err(err) = window.set_focus() {
        log::error!("Failed to focus window: {:?}", err);
      }

      // Update icon with notification count
      if let Some(webview_window) = window.get_webview_window(window.label()) {
        if let Some(state) = app.try_state::<AppState>() {
          if let Ok(app_state) = state.lock() {
            if app_state.notification_count > 0 {
              crate::tray::set_notifications_count(
                &webview_window,
                app_state.notification_count,
                app_state.is_muted,
              );
            }
          }
        }
      }
    }
    return;
  };

  if only_open {
    return;
  }

  // If there's a visible window, close it and remember its URL.
  crate::save_window_url(&app, visible_window.label());
  if let Err(err) = visible_window.close() {
    log::error!("Failed to close visible window: {:?}", err);
  }
}

// -------------------------------------------------------------------------------------------------
// Platform-specific badge / notification counter implementation
// -------------------------------------------------------------------------------------------------
#[cfg(target_os = "macos")]
mod platform {
  use super::*;
  pub fn set_notifications_count(window: &WebviewWindow, amount: i32, is_muted: bool) {
    window
      .set_badge_count(if amount > 0 {
        Some(amount.into())
      } else {
        None
      })
      .unwrap_or_default();
  }
}

#[cfg(not(target_os = "macos"))]
mod platform {
  use super::*;
  pub fn set_notifications_count(window: &WebviewWindow, amount: i32, is_muted: bool) {
    badge::set_badge_count_icon(window, amount, is_muted);
  }
}

pub use platform::set_notifications_count;
