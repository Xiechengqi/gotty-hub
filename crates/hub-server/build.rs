fn main() {
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    println!("cargo:rerun-if-changed=../../frontend/dist");
    let revision = std::env::var("GITHUB_SHA").unwrap_or_else(|_| {
        std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .output()
            .ok()
            .filter(|v| v.status.success())
            .map(|v| String::from_utf8_lossy(&v.stdout).trim().to_string())
            .unwrap_or_else(|| "development".into())
    });
    println!("cargo:rustc-env=HUB_REVISION={revision}");
}
