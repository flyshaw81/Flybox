use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
  tauri_build::build();

  // Copy BASS / FFmpeg / vcam vendor binaries next to the built exe for `tauri dev`.
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

  // Virtual-cam filter DLL → next to exe (dev) + resources/ for NSIS bundle.
  let vcam_src = manifest
    .join("..")
    .join("src-vcam")
    .join("dist")
    .join("flybox-virtualcam-module64.dll");
  let vcam_res_dir = manifest.join("resources").join("vcam");
  let vcam_res = vcam_res_dir.join("flybox-virtualcam-module64.dll");
  if vcam_src.is_file() {
    let _ = fs::copy(&vcam_src, dest.join("flybox-virtualcam-module64.dll"));
    let _ = fs::create_dir_all(&vcam_res_dir);
    let _ = fs::copy(&vcam_src, &vcam_res);
  }

  // OBS shared-memory queue (same .c as the DirectShow filter) — write path for flyphoto.
  let queue_c = manifest
    .join("..")
    .join("src-vcam")
    .join("vendor")
    .join("queue")
    .join("shared-memory-queue.c");
  let nv12_c = manifest
    .join("..")
    .join("src-vcam")
    .join("vendor")
    .join("nv12")
    .join("tiny-nv12-scale.c");
  let queue_inc = manifest
    .join("..")
    .join("src-vcam")
    .join("vendor")
    .join("queue");
  let nv12_inc = manifest
    .join("..")
    .join("src-vcam")
    .join("vendor")
    .join("nv12");

  if queue_c.is_file() && nv12_c.is_file() {
    cc::Build::new()
      .file(&queue_c)
      .file(&nv12_c)
      .include(&queue_inc)
      .include(&nv12_inc)
      .define("UNICODE", None)
      .define("_UNICODE", None)
      .warnings(false)
      .compile("flybox_video_queue");
    println!("cargo:rerun-if-changed={}", queue_c.display());
    println!("cargo:rerun-if-changed={}", nv12_c.display());
  } else {
    panic!(
      "missing OBS queue sources under src-vcam/vendor (looked for {} and {})",
      queue_c.display(),
      nv12_c.display()
    );
  }

  println!("cargo:rerun-if-changed=vendor/bass");
  println!("cargo:rerun-if-changed=vendor/ffmpeg");
  println!("cargo:rerun-if-changed=../src-vcam/dist/flybox-virtualcam-module64.dll");
}
