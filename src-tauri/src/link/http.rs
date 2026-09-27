//! Deliberately tiny HTTP/1.1 for the Yon Link listener: one request per
//! connection, `Content-Length` bodies only, hard size and time limits.
//! `httparse` (the parser hyper uses) handles the request line and headers.

use std::io;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::time::timeout;

pub const MAX_HEAD: usize = 8 * 1024;
pub const MAX_HEADERS: usize = 32;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub head_timeout: Duration,
    pub body_timeout: Duration,
    pub max_body: usize,
}

#[derive(Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    query: Vec<(String, String)>,
    headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn query(&self, key: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// Header lookup, case-insensitive.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug)]
pub enum HttpError {
    /// Head or body over the limit → 413 / 431.
    TooLarge,
    /// Not HTTP we accept (bad syntax, chunked, conflicting lengths) → 400.
    Malformed(&'static str),
    Timeout,
    Io(io::Error),
}

impl From<io::Error> for HttpError {
    fn from(e: io::Error) -> Self {
        HttpError::Io(e)
    }
}

pub async fn read_request<R: AsyncRead + Unpin>(
    r: &mut R,
    limits: Limits,
) -> Result<Request, HttpError> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];

    // Head: read until the blank line, bounded in size and total time.
    let head_len = timeout(limits.head_timeout, async {
        loop {
            if let Some(end) = find_head_end(&buf) {
                return Ok(end);
            }
            if buf.len() > MAX_HEAD {
                return Err(HttpError::TooLarge);
            }
            let n = r.read(&mut chunk).await?;
            if n == 0 {
                return Err(HttpError::Malformed(
                    "connection closed before request head",
                ));
            }
            buf.extend_from_slice(&chunk[..n]);
        }
    })
    .await
    .map_err(|_| HttpError::Timeout)??;
    if head_len > MAX_HEAD {
        return Err(HttpError::TooLarge);
    }

    let mut raw_headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut parsed = httparse::Request::new(&mut raw_headers);
    match parsed.parse(&buf[..head_len]) {
        Ok(httparse::Status::Complete(_)) => {}
        Ok(httparse::Status::Partial) => return Err(HttpError::Malformed("incomplete head")),
        Err(httparse::Error::TooManyHeaders) => return Err(HttpError::TooLarge),
        Err(_) => return Err(HttpError::Malformed("bad request head")),
    }
    let method = parsed
        .method
        .ok_or(HttpError::Malformed("no method"))?
        .to_string();
    let target = parsed.path.ok_or(HttpError::Malformed("no path"))?;
    let mut headers = Vec::with_capacity(parsed.headers.len());
    for h in parsed.headers.iter() {
        let value =
            std::str::from_utf8(h.value).map_err(|_| HttpError::Malformed("non-UTF-8 header"))?;
        headers.push((h.name.to_ascii_lowercase(), value.trim().to_string()));
    }

    // WHY: no chunked bodies at all — one framing rule leaves no room for
    // request smuggling or unbounded streams.
    if headers.iter().any(|(k, _)| k == "transfer-encoding") {
        return Err(HttpError::Malformed("transfer-encoding not supported"));
    }
    let mut length: Option<usize> = None;
    for (_, v) in headers.iter().filter(|(k, _)| k == "content-length") {
        let n: usize = v
            .parse()
            .map_err(|_| HttpError::Malformed("bad content-length"))?;
        if length.is_some_and(|l| l != n) {
            return Err(HttpError::Malformed("conflicting content-length"));
        }
        length = Some(n);
    }
    let length = length.unwrap_or(0);
    if length > limits.max_body {
        return Err(HttpError::TooLarge);
    }

    // Body: whatever came with the head, then exactly the rest.
    let mut body = buf[head_len..].to_vec();
    if body.len() > length {
        return Err(HttpError::Malformed("more data than content-length"));
    }
    let already = body.len();
    body.resize(length, 0);
    timeout(limits.body_timeout, r.read_exact(&mut body[already..]))
        .await
        .map_err(|_| HttpError::Timeout)??;

    let (path, query) = split_target(target);
    Ok(Request {
        method,
        path,
        query,
        headers,
        body,
    })
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// `/chunk?f=0&i=12` → ("/chunk", [("f","0"), ("i","12")]). Values in Yon Link
/// are hex or digits, so no percent-decoding is needed (or accepted).
fn split_target(target: &str) -> (String, Vec<(String, String)>) {
    let (path, q) = target.split_once('?').unwrap_or((target, ""));
    let query = q
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (k.to_string(), v.to_string())
        })
        .collect();
    (path.to_string(), query)
}

/// Headers sent on every response. The page loads nothing from elsewhere and
/// has no inline script; nothing may frame it, cache it or leak its URL
/// (which carries the pairing key in its fragment).
const SECURITY_HEADERS: &str = "Content-Security-Policy: default-src 'self'; script-src 'self'; \
style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; \
frame-ancestors 'none'\r\n\
X-Content-Type-Options: nosniff\r\n\
X-Frame-Options: DENY\r\n\
Referrer-Policy: no-referrer\r\n\
Cache-Control: no-store\r\n\
Cross-Origin-Resource-Policy: same-origin\r\n\
Permissions-Policy: camera=(), microphone=(), geolocation=()\r\n";

pub async fn write_response<W: AsyncWrite + Unpin>(
    w: &mut W,
    status: u16,
    content_type: &str,
    extra_headers: &[(&str, String)],
    body: &[u8],
) -> io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n{SECURITY_HEADERS}",
        reason(status),
        body.len()
    );
    for (k, v) in extra_headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    w.write_all(head.as_bytes()).await?;
    w.write_all(body).await?;
    w.flush().await
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    fn limits(max_body: usize) -> Limits {
        Limits {
            head_timeout: Duration::from_millis(300),
            body_timeout: Duration::from_millis(300),
            max_body,
        }
    }

    async fn parse(raw: &[u8], max_body: usize) -> Result<Request, HttpError> {
        let (mut a, mut b) = duplex(64 * 1024);
        a.write_all(raw).await.unwrap();
        drop(a);
        read_request(&mut b, limits(max_body)).await
    }

    #[tokio::test]
    async fn parses_get_with_query() {
        let r = parse(b"GET /hello?p=ab&nc=cd HTTP/1.1\r\nHost: x\r\n\r\n", 0)
            .await
            .unwrap();
        assert_eq!((r.method.as_str(), r.path.as_str()), ("GET", "/hello"));
        assert_eq!(
            (r.query("p"), r.query("nc"), r.query("zz")),
            (Some("ab"), Some("cd"), None)
        );
        assert_eq!(r.header("HOST"), Some("x"));
        assert!(r.body.is_empty());
    }

    #[tokio::test]
    async fn reads_body_split_across_reads() {
        let (mut a, mut b) = duplex(64);
        let writer = tokio::spawn(async move {
            a.write_all(b"POST /chunk HTTP/1.1\r\nContent-Length: 10\r\n\r\n01234")
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
            a.write_all(b"56789").await.unwrap();
        });
        let r = read_request(&mut b, limits(100)).await.unwrap();
        writer.await.unwrap();
        assert_eq!(r.body, b"0123456789");
    }

    #[tokio::test]
    async fn rejects_oversized_head_and_too_many_headers() {
        let big = format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(MAX_HEAD));
        assert!(matches!(
            parse(big.as_bytes(), 0).await,
            Err(HttpError::TooLarge)
        ));
        let many: String = (0..MAX_HEADERS + 1)
            .map(|i| format!("H{i}: v\r\n"))
            .collect();
        let req = format!("GET / HTTP/1.1\r\n{many}\r\n");
        assert!(matches!(
            parse(req.as_bytes(), 0).await,
            Err(HttpError::TooLarge)
        ));
    }

    #[tokio::test]
    async fn rejects_chunked_and_bad_lengths() {
        let chunked = b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n";
        assert!(matches!(
            parse(chunked, 100).await,
            Err(HttpError::Malformed(_))
        ));
        let conflict = b"POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nab";
        assert!(matches!(
            parse(conflict, 100).await,
            Err(HttpError::Malformed(_))
        ));
        let neg = b"POST / HTTP/1.1\r\nContent-Length: -1\r\n\r\n";
        assert!(matches!(
            parse(neg, 100).await,
            Err(HttpError::Malformed(_))
        ));
        let extra = b"POST / HTTP/1.1\r\nContent-Length: 1\r\n\r\nabc";
        assert!(matches!(
            parse(extra, 100).await,
            Err(HttpError::Malformed(_))
        ));
        let garbage = b"\x00\x01\x02 nonsense\r\n\r\n";
        assert!(matches!(
            parse(garbage, 100).await,
            Err(HttpError::Malformed(_))
        ));
    }

    #[tokio::test]
    async fn enforces_body_limit_before_reading() {
        let r = b"POST / HTTP/1.1\r\nContent-Length: 1000000000\r\n\r\n";
        assert!(matches!(parse(r, 1024).await, Err(HttpError::TooLarge)));
    }

    #[tokio::test]
    async fn slow_head_and_short_body_time_out() {
        let (mut a, mut b) = duplex(64);
        a.write_all(b"GET / HTTP/1.1\r\n").await.unwrap(); // never finishes
        assert!(matches!(
            read_request(&mut b, limits(0)).await,
            Err(HttpError::Timeout)
        ));

        let (mut a, mut b) = duplex(64);
        a.write_all(b"POST / HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc")
            .await
            .unwrap();
        assert!(matches!(
            read_request(&mut b, limits(10)).await,
            Err(HttpError::Timeout)
        ));
        drop(a);
    }

    #[tokio::test]
    async fn response_carries_security_headers() {
        let mut out = Vec::new();
        write_response(
            &mut out,
            404,
            "text/plain",
            &[("X-Yon-Ctr", "7".into())],
            b"no",
        )
        .await
        .unwrap();
        let s = String::from_utf8(out).unwrap();
        assert!(s.starts_with("HTTP/1.1 404 Not Found\r\n"));
        for h in [
            "Content-Length: 2",
            "Connection: close",
            "Content-Security-Policy: default-src 'self'",
            "X-Content-Type-Options: nosniff",
            "Referrer-Policy: no-referrer",
            "Cache-Control: no-store",
            "X-Yon-Ctr: 7",
        ] {
            assert!(s.contains(h), "missing {h}");
        }
        assert!(s.ends_with("\r\n\r\nno"));
    }
}
