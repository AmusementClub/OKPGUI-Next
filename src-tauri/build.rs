fn main() {
    println!("cargo:rerun-if-changed=binaries/mediainfo-x86_64-pc-windows-msvc.exe");
    println!("cargo:rerun-if-changed=resources/mediainfo/THIRD_PARTY_NOTICES.html");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("x86_64")
    {
        let binary = std::path::Path::new("binaries/mediainfo-x86_64-pc-windows-msvc.exe");
        assert!(
            binary.is_file(),
            "Windows x64 builds require the verified embedded MediaInfo binary; run scripts/stage-mediainfo.ps1 -Target x86_64-pc-windows-msvc first"
        );
    }
    tauri_build::build()
}
