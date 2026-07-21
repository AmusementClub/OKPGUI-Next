/// Replace `dest` with `temp` without a delete-then-rename gap.
///
/// - Unix: `rename` replaces an existing destination atomically.
/// - Windows: `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` replaces without deleting first,
///   so a crash cannot leave the user with neither the old nor the new file.
pub(crate) fn replace_file_atomically(
    temp: &std::path::Path,
    dest: &std::path::Path,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;

        fn to_wide(path: &std::path::Path) -> Vec<u16> {
            path.as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect()
        }

        // https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw
        const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(
                lp_existing_file_name: *const u16,
                lp_new_file_name: *const u16,
                dw_flags: u32,
            ) -> i32;
        }

        let from_wide = to_wide(temp);
        let to_wide_path = to_wide(dest);
        let ok = unsafe {
            MoveFileExW(
                from_wide.as_ptr(),
                to_wide_path.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if ok == 0 {
            return Err(format!(
                "无法原子替换配置文件: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        std::fs::rename(temp, dest).map_err(|error| format!("无法提交配置文件: {}", error))
    }
}

/// Atomically replace the file at `path` via temp write + platform-safe replace.
pub(crate) fn write_text_file_atomically(path: &std::path::Path, data: &str) -> Result<(), String> {
    let temp_path = path.with_extension("json.tmp");
    if let Err(error) = std::fs::write(&temp_path, data) {
        return Err(format!("无法写入临时配置文件: {}", error));
    }

    if let Err(error) = replace_file_atomically(&temp_path, path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_replace_file_atomically_over_existing_destination() {
        let dir = std::env::temp_dir().join(format!(
            "okpgui-replace-unit-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let dest = dir.join("target.json");
        let temp = dir.join("target.json.tmp");

        std::fs::write(&dest, b"{\"old\":true}").expect("seed dest");
        std::fs::write(&temp, b"{\"new\":true}").expect("seed temp");

        replace_file_atomically(&temp, &dest).expect("atomic replace over existing");

        assert!(dest.exists());
        assert!(!temp.exists());
        let body = std::fs::read_to_string(&dest).expect("read dest");
        assert_eq!(body, "{\"new\":true}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
