use std::ffi::OsString;
use std::path::PathBuf;

/// Lists where the official Windows installers put `claude`, in the order they
/// are tried: the native installer under `user_profile` (`USERPROFILE`), then a
/// global npm install under `app_data` (`APPDATA`).
///
/// A value that is missing or not an absolute path adds no location.
pub fn install_locations(
    user_profile: Option<OsString>,
    app_data: Option<OsString>,
) -> Vec<PathBuf> {
    let native =
        absolute(user_profile).map(|home| home.join(".local").join("bin").join("claude.exe"));
    let npm = absolute(app_data).map(|data| data.join("npm").join("claude.cmd"));
    native.into_iter().chain(npm).collect()
}

/// Turns `value` into a path, or `None` when it is missing or not absolute.
fn absolute(value: Option<OsString>) -> Option<PathBuf> {
    value.map(PathBuf::from).filter(|path| path.is_absolute())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_install_comes_before_npm() {
        let locations = install_locations(
            Some(r"C:\Users\example".into()),
            Some(r"C:\Users\example\AppData\Roaming".into()),
        );
        assert_eq!(
            locations,
            [
                PathBuf::from(r"C:\Users\example\.local\bin\claude.exe"),
                PathBuf::from(r"C:\Users\example\AppData\Roaming\npm\claude.cmd"),
            ]
        );
    }

    #[test]
    fn missing_or_relative_variables_add_nothing() {
        assert!(install_locations(None, None).is_empty());
        assert_eq!(
            install_locations(Some("relative".into()), Some(r"C:\Data".into())),
            [PathBuf::from(r"C:\Data\npm\claude.cmd")]
        );
    }
}
