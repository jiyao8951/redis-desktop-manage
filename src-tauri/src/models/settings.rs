use serde::{Deserialize, Serialize};

/// Global settings that affect this stage. Defaults match the Windows values
/// in src/qml/settings/GlobalSettings.qml. `scanPageSize` is the stage
/// requirement of 100 keys per lazy SCAN page (the original had a single
/// SCAN limit, not a page size).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub show_namespaces_on_top: bool,
    pub reopen_namespaces_on_reload: bool,
    pub namespaced_keys_short_name: bool,
    pub scan_limit: u32,
    pub tree_item_max_childs: u32,
    pub scan_page_size: u32,
    pub live_update_keys_limit: u32,
    pub live_update_interval: u32,
    pub dark_mode: String,
    pub value_size_limit: u32,
    pub value_editor_page_size: u32,
    pub app_font: String,
    pub app_font_size: u32,
    pub value_editor_font: String,
    pub value_editor_font_size: u32,
    /// Empty means "not chosen yet": the UI falls back to the OS locale.
    pub language: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            show_namespaces_on_top: true,
            reopen_namespaces_on_reload: true,
            namespaced_keys_short_name: true,
            scan_limit: 10_000,
            tree_item_max_childs: 1_000,
            scan_page_size: 100,
            // GlobalSettings.qml: live update limit default 1000.
            live_update_keys_limit: 1_000,
            live_update_interval: 10,
            dark_mode: "auto".into(),
            value_size_limit: 1_500_000,
            value_editor_page_size: 100,
            app_font: String::new(),
            app_font_size: 12,
            value_editor_font: String::new(),
            // GlobalSettings.qml: 11 on Windows/Linux, 12 on macOS.
            value_editor_font_size: 11,
            language: String::new(),
        }
    }
}

impl Settings {
    pub fn sanitized(mut self) -> Self {
        self.scan_limit = self.scan_limit.clamp(1_000, 500_000);
        self.tree_item_max_childs = self.tree_item_max_childs.clamp(1, 100_000);
        self.scan_page_size = self.scan_page_size.clamp(1, 1_000);
        self.live_update_keys_limit = self.live_update_keys_limit.clamp(100, 100_000);
        self.live_update_interval = self.live_update_interval.clamp(3, 100_000);
        self.value_size_limit = self.value_size_limit.clamp(1_000, 20_000_000);
        self.value_editor_page_size = self.value_editor_page_size.clamp(10, 10_000);
        self.app_font_size = self.app_font_size.clamp(6, 48);
        self.value_editor_font_size = self.value_editor_font_size.clamp(6, 48);
        if !matches!(self.dark_mode.as_str(), "auto" | "on" | "off") {
            self.dark_mode = "auto".into();
        }
        if !matches!(self.language.as_str(), "" | "en" | "zh-CN") {
            // Unknown/removed locales fall back to automatic detection.
            self.language = String::new();
        }
        self
    }
}
