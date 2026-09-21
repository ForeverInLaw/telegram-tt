use std::collections::HashMap;
use std::sync::LazyLock;

#[derive(Clone)]
pub struct WindowState {
  pub title: String,
  pub is_overlay: bool,
  // Only read by the macOS title bar overlay logic
  #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
  pub is_mobile: bool,
}

pub static WINDOW_STATES: LazyLock<std::sync::Mutex<HashMap<String, WindowState>>> =
  LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));
