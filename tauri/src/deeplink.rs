use log::info;
use tauri::{Emitter, Manager, UserAttentionType};
use tauri_plugin_deep_link::DeepLinkExt;

pub struct Deeplink;

impl Deeplink {
  pub fn init() -> Self {
    Self {}
  }

  pub fn setup(&self, app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Clone the app handle for use in the closure
    let app_handle = app.clone();

    // Set up the deep link event handler
    app.deep_link().on_open_url(move |event| {
      // Store URLs to avoid calling event.urls() multiple times (it consumes the event)
      let urls = event.urls();
      info!("Deep link received: {:?}", urls);

      // Broadcast to every webview window; window labels are random UUIDs,
      // so there is no fixed window label to target
      if let Err(err) = app_handle.emit("deeplink", &urls) {
        info!("Error emitting deeplink event: {:?}", err);
      }

      // Show and focus the first available window
      let windows = app_handle.windows();
      let Some(window) = windows.values().next() else {
        return;
      };

      if let Err(err) = window.request_user_attention(Some(UserAttentionType::Informational)) {
        info!("Error requesting user attention: {:?}", err);
      }

      if let Err(err) = window.show() {
        info!("Error showing window: {:?}", err);
      }

      if let Err(err) = window.unminimize() {
        info!("Error unminimizing window: {:?}", err);
      }

      if let Err(err) = window.set_focus() {
        info!("Error setting focus: {:?}", err);
      }
    });

    Ok(())
  }
}
