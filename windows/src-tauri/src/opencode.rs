// OpenCode plugin installation.
//
// Coucou ships one TypeScript plugin — shared, byte for byte, with the macOS
// app — that lets OpenCode sessions show up in the island. OpenCode loads every
// *.ts file under %USERPROFILE%\.config\opencode\plugins\, so installing is a
// single file write and uninstalling removes only that file. opencode.json is
// never read or rewritten, so nothing of the user's config can be lost.

use std::path::{Path, PathBuf};

/// The plugin source, embedded at build time from the shared resource the macOS
/// app bundles too.
const PLUGIN_SOURCE: &str = include_str!("../../../NotchBuddy/Resources/opencode/coucou.ts");

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// %USERPROFILE%\.config\opencode\plugins
pub fn plugins_dir() -> PathBuf {
    home().join(".config").join("opencode").join("plugins")
}

pub fn plugin_path() -> PathBuf {
    plugins_dir().join("coucou.ts")
}

pub fn installed() -> bool {
    plugin_path().is_file()
}

/// Writes the plugin and returns the path it landed at.
pub fn install() -> Result<String, String> {
    let path = plugin_path();
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    // Write beside the target and rename over it, so a crash never leaves a
    // half-written plugin for OpenCode to load.
    let temp = path.with_extension("ts.coucou-tmp");
    std::fs::write(&temp, PLUGIN_SOURCE).map_err(|e| format!("write failed: {e}"))?;
    if let Err(err) = std::fs::rename(&temp, &path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {err}"));
    }
    Ok(path.to_string_lossy().to_string())
}

pub fn uninstall() -> Result<(), String> {
    let path = plugin_path();
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shared_plugin_is_embedded() {
        assert!(PLUGIN_SOURCE.contains("export default"), "plugin export missing");
        assert!(PLUGIN_SOURCE.contains("hook_event_name"), "plugin payload shape missing");
    }

    #[test]
    fn the_plugin_lands_in_opencodes_global_plugin_dir() {
        let dir = plugins_dir();
        assert!(dir.ends_with(Path::new(".config").join("opencode").join("plugins")));
        assert_eq!(plugin_path().file_name().unwrap(), "coucou.ts");
    }
}
