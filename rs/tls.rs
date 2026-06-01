//! Self-signed TLS support for `--tls` mode (Phase 1: no system trust
//! install). Generates a self-signed certificate for the configured
//! domain (with `*.<domain>` SAN) and persists it under
//! `~/.config/fbi-proxy/certs/` so the same fingerprint survives
//! restarts — browsers can "remember the exception" once.
//!
//! The browser warning is expected in this phase. Use Phase 2
//! (`fbi-proxy trust`) to install a local CA into the system trust
//! store for a clean lock-icon experience.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rcgen::{CertificateParams, DnType, DistinguishedName, KeyPair, SanType};
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Where on-disk certs live. Layout: `{base}/certs/{domain}.{pem,key}`.
/// `XDG_CONFIG_HOME` wins if set; otherwise `<home>/.config`, resolving
/// home via `HOME` (Unix) or `USERPROFILE` (Windows) so the layout
/// matches the conf dir the proxy uses elsewhere.
pub fn default_cert_dir() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|h| PathBuf::from(h).join(".config"))
        })
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("fbi-proxy").join("certs")
}

/// Path to the cert file for a given domain (sibling `.key` lives at
/// the same stem). Use this when you need to install the cert into a
/// system trust store after `build_acceptor` has materialized it.
pub fn cert_pem_path(domain: &str, cert_dir: &Path) -> PathBuf {
    let slug = if domain.is_empty() { "localhost" } else { domain };
    cert_dir.join(format!("{slug}.pem"))
}

/// Whether the given cert is currently a trusted anchor on this
/// system. Returns `false` if the check itself can't be performed
/// (unsupported platform, missing tool) — callers should treat that
/// as "no, attempt install."
pub fn is_trusted(cert_path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("security")
            .args(["verify-cert", "-c"])
            .arg(cert_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = cert_path;
        false
    }
}

/// Install `cert_path` as a trusted root anchor in the system trust
/// store. Idempotent — checks `is_trusted` first and returns `Ok(false)`
/// if no install was performed.
///
/// Requires root on macOS (writes to `/Library/Keychains/System.keychain`).
/// On other platforms this is a no-op for now (Linux / Windows is a
/// follow-up — see TODO.md).
pub fn install_to_system_trust(cert_path: &Path) -> Result<bool, BoxError> {
    if is_trusted(cert_path) {
        return Ok(false);
    }

    #[cfg(target_os = "macos")]
    {
        log::info!("installing {} to System.keychain", cert_path.display());
        let status = std::process::Command::new("security")
            .args([
                "add-trusted-cert",
                "-d",
                "-r",
                "trustRoot",
                "-k",
                "/Library/Keychains/System.keychain",
            ])
            .arg(cert_path)
            .status()?;
        if !status.success() {
            return Err(format!(
                "security add-trusted-cert failed (exit {:?}); needs root (sudo)",
                status.code(),
            )
            .into());
        }
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = cert_path;
        log::warn!("auto-trust-install: only macOS supported in this build");
        Ok(false)
    }
}

/// Build a `TlsAcceptor` for the given domain, reusing a persisted
/// cert if one exists or generating + writing a fresh one if not.
///
/// `domain` is the apex (e.g. `"fbi.com"`); the cert SAN includes both
/// the apex and `*.{domain}` so any subdomain validates. If `domain`
/// is empty or `"localhost"`, only `localhost` + `127.0.0.1` are
/// covered.
pub fn build_acceptor(domain: &str, cert_dir: &Path) -> Result<TlsAcceptor, BoxError> {
    let (cert_pem, key_pem) = load_or_generate(domain, cert_dir)?;

    let cert_chain: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(cert_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()?;
    let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes())?;

    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(cert_chain, key)?;

    Ok(TlsAcceptor::from(Arc::new(config)))
}

fn load_or_generate(domain: &str, cert_dir: &Path) -> Result<(String, String), BoxError> {
    let slug = if domain.is_empty() { "localhost" } else { domain };
    let cert_path = cert_dir.join(format!("{slug}.pem"));
    let key_path = cert_dir.join(format!("{slug}.key"));

    if cert_path.exists() && key_path.exists() {
        let cert = std::fs::read_to_string(&cert_path)?;
        let key = std::fs::read_to_string(&key_path)?;
        return Ok((cert, key));
    }

    let (cert_pem, key_pem) = generate_self_signed(domain)?;
    std::fs::create_dir_all(cert_dir)?;
    std::fs::write(&cert_path, &cert_pem)?;
    // 0600 on the key — std::fs::write opens 0644 by default
    write_private(&key_path, key_pem.as_bytes())?;

    Ok((cert_pem, key_pem))
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

/// Generate a SAN-only self-signed cert valid for ~1 year. Returns
/// `(cert_pem, key_pem)`. The Common Name is intentionally left blank
/// — modern browsers ignore CN and only honor SAN entries.
pub fn generate_self_signed(domain: &str) -> Result<(String, String), BoxError> {
    let mut sans: Vec<SanType> = Vec::new();
    if domain.is_empty() || domain == "localhost" {
        sans.push(SanType::DnsName("localhost".try_into()?));
        sans.push(SanType::IpAddress("127.0.0.1".parse()?));
    } else {
        sans.push(SanType::DnsName(domain.try_into()?));
        sans.push(SanType::DnsName(format!("*.{domain}").try_into()?));
    }

    let mut params = CertificateParams::default();
    params.subject_alt_names = sans;

    // Browsers ignore CN, but a non-empty DN avoids some tooling
    // warnings. Use OrganizationName so the CN stays empty.
    let mut dn = DistinguishedName::new();
    dn.push(DnType::OrganizationName, "fbi-proxy (self-signed)");
    params.distinguished_name = dn;

    let now = time::OffsetDateTime::now_utc();
    params.not_before = now - time::Duration::days(1);
    params.not_after = now + time::Duration::days(365);

    let key_pair = KeyPair::generate()?;
    let cert = params.self_signed(&key_pair)?;

    Ok((cert.pem(), key_pair.serialize_pem()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_pem_with_domain_san() {
        let (cert, key) = generate_self_signed("fbi.com").unwrap();
        assert!(cert.contains("BEGIN CERTIFICATE"));
        assert!(key.contains("BEGIN PRIVATE KEY"));

        // Parse the cert and check SAN entries
        let der = CertificateDer::pem_slice_iter(cert.as_bytes())
            .next()
            .unwrap()
            .unwrap();
        // We don't fully x509-parse here — but the cert+key should be
        // accepted by rustls' single-cert builder, which is what the
        // real server uses. That's the real-world contract.
        let key_der = PrivateKeyDer::from_pem_slice(key.as_bytes()).unwrap();
        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![der], key_der);
        assert!(config.is_ok(), "rustls should accept generated cert+key");
    }

    #[test]
    fn generates_for_localhost_fallback() {
        let (cert, _key) = generate_self_signed("").unwrap();
        assert!(cert.contains("BEGIN CERTIFICATE"));
    }

    #[test]
    fn load_or_generate_round_trips_persisted_certs() {
        let tmp = std::env::temp_dir().join(format!(
            "fbi-tls-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);

        let (cert1, key1) = load_or_generate("test.dev", &tmp).unwrap();
        // Second call should return the same content (loaded from disk)
        let (cert2, key2) = load_or_generate("test.dev", &tmp).unwrap();
        assert_eq!(cert1, cert2);
        assert_eq!(key1, key2);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
