use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // Copy BASS / FFmpeg vendor binaries next to the built exe for `tauri dev`.
    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".into());
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let dest = manifest.join("target").join(&profile);
    let _ = fs::create_dir_all(&dest);

    let bass_src = manifest.join("vendor").join("bass");
    if bass_src.is_dir() {
        if let Ok(entries) = fs::read_dir(&bass_src) {
            for ent in entries.flatten() {
                let p = ent.path();
                if p.extension().and_then(|e| e.to_str()) == Some("dll") {
                    let _ = fs::copy(&p, dest.join(ent.file_name()));
                }
            }
        }
    }

    let ff_src = manifest.join("vendor").join("ffmpeg");
    for name in ["ffmpeg.exe", "ffprobe.exe"] {
        let src = ff_src.join(name);
        if src.is_file() {
            let _ = fs::copy(&src, dest.join(name));
        }
    }

    println!("cargo:rerun-if-changed=vendor/bass");
    println!("cargo:rerun-if-changed=vendor/ffmpeg");
}
