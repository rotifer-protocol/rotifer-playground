// Give the module's memory an upper bound (64 MiB): the IR verifier warns
// about memory without a maximum. Set here rather than in .cargo/config.toml,
// which cargo would only read when run from this directory.
fn main() {
    if std::env::var("TARGET").is_ok_and(|t| t.starts_with("wasm32")) {
        println!("cargo:rustc-link-arg-cdylib=--max-memory=67108864");
    }
}
