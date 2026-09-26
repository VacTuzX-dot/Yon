//! Device identity: one Ed25519 key per install, a self-signed cert derived
//! from it, and rustls configs for mutual TLS pinned by key fingerprint.
//!
//! Device id = SHA-256 of the certificate's SubjectPublicKeyInfo. Hashing the
//! key (not the cert DER) keeps the id stable if the cert is ever re-issued.

use crate::protocol::hex;
use ring::digest::{digest, SHA256};
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::sync::Arc;
use tokio_rustls::rustls::{
    self,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{ring::default_provider, CryptoProvider},
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime},
    server::danger::{ClientCertVerified, ClientCertVerifier},
    ClientConfig, CommonState, DigitallySignedStruct, DistinguishedName, ServerConfig,
    SignatureScheme,
};

pub type Fingerprint = [u8; 32];

const KEY_FILE: &str = "identity.key.pem";
/// SNI we present; meaningless for trust (we pin the key), but rustls needs one.
pub const SERVER_NAME: &str = "yon";

pub struct Identity {
    key_pkcs8: Vec<u8>,
    cert: CertificateDer<'static>,
    pub fingerprint: Fingerprint,
}

impl Identity {
    /// Load the key from `dir`, creating it on first run.
    pub fn load_or_create(dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let path = dir.join(KEY_FILE);
        let key = match fs::read_to_string(&path) {
            Ok(pem) => rcgen::KeyPair::from_pem(&pem).map_err(io::Error::other)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let key =
                    rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).map_err(io::Error::other)?;
                write_private(&path, key.serialize_pem().as_bytes())?;
                key
            }
            Err(e) => return Err(e),
        };
        Self::from_key(key)
    }

    fn from_key(key: rcgen::KeyPair) -> io::Result<Self> {
        // Default rcgen validity is 1975..4096; expiry is irrelevant because
        // peers pin the key, not a CA chain.
        let params = rcgen::CertificateParams::new(vec![SERVER_NAME.to_string()])
            .map_err(io::Error::other)?;
        let cert = params.self_signed(&key).map_err(io::Error::other)?;
        let cert = CertificateDer::from(cert.der().to_vec());
        let fingerprint = fingerprint_of(&cert).map_err(io::Error::other)?;
        Ok(Self {
            key_pkcs8: key.serialize_der(),
            cert,
            fingerprint,
        })
    }

    pub fn id_hex(&self) -> String {
        hex(&self.fingerprint)
    }

    fn key(&self) -> PrivateKeyDer<'static> {
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key_pkcs8.clone()))
    }

    /// Receiver side: TLS 1.3, requires a client cert (any key — the user
    /// judges it by fingerprint in the accept dialog).
    pub fn server_config(&self) -> Result<Arc<ServerConfig>, rustls::Error> {
        let provider = Arc::new(default_provider());
        let cfg = ServerConfig::builder_with_provider(provider.clone())
            .with_protocol_versions(&[&rustls::version::TLS13])?
            .with_client_cert_verifier(Arc::new(AnyClientKey { provider }))
            .with_single_cert(vec![self.cert.clone()], self.key())?;
        Ok(Arc::new(cfg))
    }

    /// Sender side: TLS 1.3, presents our cert, accepts the server only if its
    /// key fingerprint equals `expected` (taken from the mDNS advert).
    pub fn client_config(&self, expected: Fingerprint) -> Result<Arc<ClientConfig>, rustls::Error> {
        let provider = Arc::new(default_provider());
        let cfg = ClientConfig::builder_with_provider(provider.clone())
            .with_protocol_versions(&[&rustls::version::TLS13])?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(PinnedServerKey { expected, provider }))
            .with_client_auth_cert(vec![self.cert.clone()], self.key())?;
        Ok(Arc::new(cfg))
    }
}

fn write_private(path: &Path, data: &[u8]) -> io::Result<()> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    // TECH DEBT: key sits in a user-readable file (0600 on unix, per-user
    // AppData ACL on Windows). Move to Keychain/Credential Manager if the
    // threat model grows beyond "other users on this machine".
    let mut f = opts.open(path)?;
    f.write_all(data)?;
    f.sync_all()
}

/// SHA-256 of the cert's SubjectPublicKeyInfo.
pub fn fingerprint_of(cert: &CertificateDer<'_>) -> Result<Fingerprint, rustls::Error> {
    let parsed = webpki::EndEntityCert::try_from(cert)
        .map_err(|_| rustls::Error::General("unparseable certificate".into()))?;
    let spki = parsed.subject_public_key_info();
    let mut out = [0u8; 32];
    out.copy_from_slice(digest(&SHA256, spki.as_ref()).as_ref());
    Ok(out)
}

/// Fingerprint of the peer's verified cert after the handshake.
pub fn peer_fingerprint(conn: &CommonState) -> Option<Fingerprint> {
    conn.peer_certificates()
        .and_then(|certs| certs.first())
        .and_then(|c| fingerprint_of(c).ok())
}

/// Human-comparable form: first 64 bits, e.g. `A1B2-C3D4-E5F6-0718`.
pub fn short_fingerprint(fp: &Fingerprint) -> String {
    let h = hex(&fp[..8]).to_uppercase();
    format!("{}-{}-{}-{}", &h[0..4], &h[4..8], &h[8..12], &h[12..16])
}

pub fn parse_fingerprint(s: &str) -> Option<Fingerprint> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

#[derive(Debug)]
struct AnyClientKey {
    provider: Arc<CryptoProvider>,
}

impl ClientCertVerifier for AnyClientKey {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn client_auth_mandatory(&self) -> bool {
        true
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, rustls::Error> {
        // Identity is established by the handshake signature (proof of key
        // possession) below; here we only require a parseable key.
        fingerprint_of(end_entity)?;
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("TLS 1.2 not supported".into()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[derive(Debug)]
struct PinnedServerKey {
    expected: Fingerprint,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedServerKey {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        // WHY: constant-time compare isn't needed — the fingerprint is public
        // (broadcast over mDNS), there's no secret to leak by timing.
        if fingerprint_of(end_entity)? == self.expected {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("device fingerprint mismatch".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("TLS 1.2 not supported".into()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

pub fn server_name() -> ServerName<'static> {
    ServerName::try_from(SERVER_NAME).expect("static server name is valid")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio_rustls::{TlsAcceptor, TlsConnector};

    pub(crate) fn temp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "yon-test-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn key_persists_and_fingerprint_is_stable() {
        let dir = temp_dir("persist");
        let a = Identity::load_or_create(&dir).unwrap();
        let b = Identity::load_or_create(&dir).unwrap();
        assert_eq!(a.fingerprint, b.fingerprint);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join(KEY_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn different_installs_differ() {
        let (d1, d2) = (temp_dir("a"), temp_dir("b"));
        let a = Identity::load_or_create(&d1).unwrap();
        let b = Identity::load_or_create(&d2).unwrap();
        assert_ne!(a.fingerprint, b.fingerprint);
        fs::remove_dir_all(d1).unwrap();
        fs::remove_dir_all(d2).unwrap();
    }

    #[test]
    fn fingerprint_formats() {
        let fp = [
            0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x07, 0x18, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff,
        ];
        assert_eq!(short_fingerprint(&fp), "A1B2-C3D4-E5F6-0718");
        assert_eq!(parse_fingerprint(&hex(&fp)), Some(fp));
        assert_eq!(parse_fingerprint("zz"), None);
        assert_eq!(parse_fingerprint(&"g".repeat(64)), None);
    }

    /// Returns (client-seen-by-server fingerprint, client result).
    async fn handshake(
        server: &Identity,
        client: &Identity,
        pin: Fingerprint,
    ) -> (Option<Fingerprint>, io::Result<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let acceptor = TlsAcceptor::from(server.server_config().unwrap());
        let srv = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut tls = acceptor.accept(tcp).await.ok()?;
            let fp = peer_fingerprint(tls.get_ref().1);
            let mut b = [0u8; 2];
            tls.read_exact(&mut b).await.ok()?;
            fp
        });
        let connector = TlsConnector::from(client.client_config(pin).unwrap());
        let res = async {
            let tcp = TcpStream::connect(addr).await?;
            let mut tls = connector.connect(server_name(), tcp).await?;
            tls.write_all(b"hi").await?;
            tls.flush().await
        }
        .await;
        (srv.await.unwrap(), res)
    }

    #[tokio::test]
    async fn mutual_tls_with_correct_pin() {
        let (d1, d2) = (temp_dir("srv"), temp_dir("cli"));
        let server = Identity::load_or_create(&d1).unwrap();
        let client = Identity::load_or_create(&d2).unwrap();
        let (seen, res) = handshake(&server, &client, server.fingerprint).await;
        res.unwrap();
        assert_eq!(
            seen,
            Some(client.fingerprint),
            "server must see the real client key"
        );
        fs::remove_dir_all(d1).unwrap();
        fs::remove_dir_all(d2).unwrap();
    }

    #[tokio::test]
    async fn wrong_pin_aborts_handshake() {
        let (d1, d2) = (temp_dir("srv2"), temp_dir("cli2"));
        let server = Identity::load_or_create(&d1).unwrap();
        let client = Identity::load_or_create(&d2).unwrap();
        let (seen, res) = handshake(&server, &client, [7u8; 32]).await;
        assert!(res.is_err());
        assert_eq!(seen, None);
        fs::remove_dir_all(d1).unwrap();
        fs::remove_dir_all(d2).unwrap();
    }
}
