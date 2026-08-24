# Third-party notices

This file records the third-party components declared by the Windows native
scaffold. The corresponding upstream license texts and exact resolved versions
must be retained in release source archives and installer notices.

| Component | Use | Declared license/source |
|---|---|---|
| Tauri | Desktop runtime, window lifecycle, commands, events, bundling | Apache-2.0 OR MIT; https://github.com/tauri-apps/tauri |
| tauri-build | Rust build integration | Apache-2.0 OR MIT; https://github.com/tauri-apps/tauri |
| portable-pty | Cross-platform PTY process and resize support | Apache-2.0 OR MIT; https://github.com/wez/portable-pty |
| serde | Serialization of IPC payloads | Apache-2.0 OR MIT; https://github.com/serde-rs/serde |
| serde_json | JSON payload support | Apache-2.0 OR MIT; https://github.com/serde-rs/json |

## Distribution obligations

The application remains GPL-3.0-only. These permissive dependencies are linked
into the Rust/Tauri executable under their respective terms; their copyright
and license notices must remain available to recipients. Before a public
release, generate a version-accurate inventory from `Cargo.lock` and include
the upstream license texts or a machine-readable notice bundle in the release
artifacts.

Recommended audit commands after dependencies are resolved:

```powershell
cargo tree --manifest-path src-tauri/Cargo.toml
cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 > cargo-metadata.json
cargo install cargo-about --locked
cargo about generate about.hbs > THIRD_PARTY_NOTICES.generated.md
```

`cargo-metadata.json` is a temporary audit output and should not be committed
unless the release process explicitly requires it. Verify each package's
license from its published manifest and repository before shipping an
installer. The existing macOS project has its own dependency set and notices;
this Windows inventory does not replace those macOS obligations.
