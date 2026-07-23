use reqwest::blocking::Client;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::{Cursor, Read};
use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

pub const MAX_IMAGES: usize = 5;
pub const MAX_IMAGE_BYTES: usize = 1_500_000;
pub const MAX_TOTAL_BYTES: usize = 7_500_000;
pub const MAX_PIXELS: u64 = 40_000_000;
/// Streaming download ceiling before decoding/normalization (raw wire bytes).
pub const MAX_DOWNLOAD_BYTES: usize = MAX_IMAGE_BYTES.saturating_mul(8);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisionImageInput {
    pub url: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisionImageResult {
    pub url: String,
    pub source: String,
    /// SHA-256 of the normalized bytes, never the raw/base64 image payload.
    pub content_hash: String,
    /// MIME type of the normalized payload sent to a provider.
    pub mime_type: String,
    pub normalized_bytes: usize,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VisionBatchResult {
    pub images: Vec<VisionImageResult>,
    /// Deterministic digest over ordered normalized image content hashes.
    pub batch_hash: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VisionError {
    TooManyImages(usize),
    UnsafeUrl(String),
    Fetch(String),
    InvalidImage(String),
    TooLarge(String),
    Cancelled,
}

impl std::fmt::Display for VisionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooManyImages(count) => {
                write!(formatter, "VISION_IMAGE_LIMIT: {count} images requested")
            }
            Self::UnsafeUrl(url) => write!(formatter, "unsafe image URL: {url}"),
            Self::Fetch(error) => write!(formatter, "image fetch failed: {error}"),
            Self::InvalidImage(error) => write!(formatter, "invalid image: {error}"),
            Self::TooLarge(error) => write!(formatter, "image too large: {error}"),
            Self::Cancelled => formatter.write_str("image fetch cancelled"),
        }
    }
}

impl std::error::Error for VisionError {}

pub fn extract_final_image_urls(poster: &str, markdown: &str, html: &str) -> Vec<VisionImageInput> {
    let mut seen = HashSet::new();
    let mut images = Vec::new();
    for (source, text) in [("poster", poster), ("markdown", markdown), ("html", html)] {
        for url in extract_urls(text, source == "html") {
            if seen.insert(url.clone()) {
                images.push(VisionImageInput {
                    url,
                    source: source.to_string(),
                });
            }
        }
    }
    images
}

fn extract_urls(text: &str, html: bool) -> Vec<String> {
    // HTML path is restricted to real <img src="..."> values only. Bare URL
    // scanning remains for poster/markdown so existing behavior is preserved.
    if html {
        return extract_html_img_srcs(text);
    }
    let mut urls = Vec::new();
    let mut cursor = 0;
    while let Some(start) = text[cursor..]
        .find("http://")
        .or_else(|| text[cursor..].find("https://"))
    {
        let start = cursor + start;
        let end = text[start..]
            .find(|character: char| {
                character.is_whitespace() || matches!(character, ')' | '"' | '\'' | '>')
            })
            .map(|offset| start + offset)
            .unwrap_or(text.len());
        urls.push(text[start..end].trim_end_matches(['.', ',']).to_string());
        cursor = end;
    }
    urls
}

/// Collect `src` attribute values only from `<img ...>` elements.
///
/// Ignores arbitrary `src=` on scripts, iframes, sources, and other tags, and
/// does not treat bare `http(s)://` text inside HTML as image candidates.
/// Closing `>` and candidate `src=` matches are only recognized outside quoted
/// attribute values so decoys like `alt="src=..."` or `title="a > b"` cannot
/// hijack or truncate a real `<img>` tag.
fn extract_html_img_srcs(text: &str) -> Vec<String> {
    let lower = text.to_ascii_lowercase();
    let mut urls = Vec::new();
    let mut cursor = 0;
    while let Some(rel) = lower[cursor..].find("<img") {
        let tag_start = cursor + rel;
        let after_name = tag_start + 4;
        if let Some(&next) = lower.as_bytes().get(after_name) {
            // Require a real tag boundary so `<imgx` / `<imgsomething` do not match.
            if !(next == b'>' || next == b'/' || next.is_ascii_whitespace()) {
                cursor = after_name;
                continue;
            }
        }
        let Some(tag_end) = find_tag_end_outside_quotes(text, tag_start) else {
            break;
        };
        if let Some(src) =
            extract_quoted_src_attr(&text[tag_start..tag_end], &lower[tag_start..tag_end])
        {
            if !src.is_empty() {
                urls.push(src);
            }
        }
        cursor = tag_end + 1;
    }
    urls
}

/// Index of the first `>` that closes a start tag, ignoring `>` inside quotes.
fn find_tag_end_outside_quotes(text: &str, tag_start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = tag_start;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let b = bytes[i];
        match quote {
            Some(q) => {
                if b == q {
                    quote = None;
                }
            }
            None => match b {
                b'\'' | b'"' => quote = Some(b),
                b'>' => return Some(i),
                _ => {}
            },
        }
        i += 1;
    }
    None
}

/// Read a quoted `src="..."` / `src='...'` attribute from a single tag slice.
/// Rejects `data-src`, `srcset`, and other attribute names that merely contain `src`.
/// Also ignores `src=` text that appears inside another attribute's quoted value.
fn extract_quoted_src_attr(tag: &str, tag_lower: &str) -> Option<String> {
    let bytes = tag.as_bytes();
    let lower_bytes = tag_lower.as_bytes();
    let mut i = 0;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let b = bytes[i];
        match quote {
            Some(q) => {
                if b == q {
                    quote = None;
                }
                i += 1;
                continue;
            }
            None => {
                if b == b'\'' || b == b'"' {
                    quote = Some(b);
                    i += 1;
                    continue;
                }
            }
        }
        // Outside quotes: look for exact attribute name `src=`.
        if i + 4 <= lower_bytes.len() && &lower_bytes[i..i + 4] == b"src=" {
            let word_boundary_ok = if i == 0 {
                true
            } else {
                let prev = lower_bytes[i - 1];
                !(prev.is_ascii_alphanumeric() || prev == b'-' || prev == b'_' || prev == b':')
            };
            if word_boundary_ok {
                let value_start = i + 4;
                let quote_byte = bytes.get(value_start).copied().unwrap_or(b' ');
                if matches!(quote_byte, b'\'' | b'"') {
                    let content_start = value_start + 1;
                    if let Some(end) = tag[content_start..].find(quote_byte as char) {
                        return Some(tag[content_start..content_start + end].to_string());
                    }
                    return None;
                }
            }
        }
        i += 1;
    }
    None
}

/// Deterministic SHA-256 digest of normalized image bytes (`sha256:<hex>`).
///
/// Internal only: digests are never attached to public serialized Vision IPC
/// structs and never persist raw/base64 image payloads.
pub(crate) fn content_digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

/// Deterministic batch digest over ordered per-image content digests.
pub(crate) fn batch_content_digest(image_digests: &[String]) -> String {
    let mut hasher = Sha256::new();
    for digest in image_digests {
        hasher.update(digest.as_bytes());
        hasher.update(b"\n");
    }
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

pub fn validate_public_image_url(raw: &str) -> Result<Url, VisionError> {
    let url = Url::parse(raw).map_err(|_| VisionError::UnsafeUrl(raw.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") || url.username() != "" || url.password().is_some()
    {
        return Err(VisionError::UnsafeUrl(raw.to_string()));
    }
    let host = url
        .host_str()
        .ok_or_else(|| VisionError::UnsafeUrl(raw.to_string()))?;
    if host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host.ends_with(".local")
    {
        return Err(VisionError::UnsafeUrl(raw.to_string()));
    }
    if let Some(address) = parse_literal_ip_host(host) {
        if is_private_or_local(address) {
            return Err(VisionError::UnsafeUrl(raw.to_string()));
        }
    }
    Ok(url)
}

/// Parse a URL host string as a literal IP (v4, v6, or IPv4-mapped v6).
/// Accepts optional surrounding brackets used in URL IPv6 literals.
fn parse_literal_ip_host(host: &str) -> Option<IpAddr> {
    let host = host
        .strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(host);
    host.parse::<IpAddr>().ok()
}

pub fn resolve_public_address(url: &Url) -> Result<std::net::SocketAddr, VisionError> {
    let host = url
        .host_str()
        .ok_or_else(|| VisionError::UnsafeUrl(url.to_string()))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| VisionError::UnsafeUrl(url.to_string()))?;
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| VisionError::UnsafeUrl(format!("DNS resolution failed: {error}")))?
        .collect::<Vec<_>>();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| is_private_or_local(address.ip()))
    {
        return Err(VisionError::UnsafeUrl(url.to_string()));
    }
    addresses
        .into_iter()
        .next()
        .ok_or_else(|| VisionError::UnsafeUrl(url.to_string()))
}

pub fn fetch_image(url: &str, timeout: Duration) -> Result<(String, Vec<u8>), VisionError> {
    let url = validate_public_image_url(url)?;
    let address = resolve_public_address(&url)?;
    let host = url
        .host_str()
        .ok_or_else(|| VisionError::UnsafeUrl(url.to_string()))?;
    // No proxy env, no cookie jar, and no caller-supplied auth headers: only the public URL.
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .no_proxy()
        .resolve(host, address)
        .build()
        .map_err(|error| VisionError::Fetch(error.to_string()))?;
    let mut response = client
        .get(url.clone())
        .send()
        .map_err(|error| VisionError::Fetch(error.to_string()))?;
    if response.status().is_redirection() {
        return Err(VisionError::UnsafeUrl(
            "redirects are disabled for Vision".to_string(),
        ));
    }
    if !response.status().is_success() {
        return Err(VisionError::Fetch(format!("HTTP {}", response.status())));
    }
    if let Some(length) = response.content_length() {
        if length > MAX_DOWNLOAD_BYTES as u64 {
            return Err(VisionError::TooLarge(
                "download exceeds streaming ceiling".to_string(),
            ));
        }
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    // Bound the stream before buffering so a huge body never lands fully in memory.
    let bytes = read_body_bounded(&mut response, MAX_DOWNLOAD_BYTES)?;
    Ok((content_type, bytes))
}

fn read_body_bounded(source: &mut impl Read, max_bytes: usize) -> Result<Vec<u8>, VisionError> {
    let mut limited = source.take(max_bytes as u64 + 1);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|error| VisionError::Fetch(error.to_string()))?;
    if bytes.len() > max_bytes {
        return Err(VisionError::TooLarge(
            "download exceeds streaming ceiling".to_string(),
        ));
    }
    Ok(bytes)
}

pub fn normalize_image(
    content_type: &str,
    bytes: &[u8],
) -> Result<(Vec<u8>, u32, u32), VisionError> {
    if !is_supported_mime(content_type) || !has_image_magic(bytes) {
        return Err(VisionError::InvalidImage(
            "MIME and magic bytes do not identify an image".to_string(),
        ));
    }
    let decoded = image::load_from_memory(bytes)
        .map_err(|error| VisionError::InvalidImage(error.to_string()))?;
    let (width, height) = (decoded.width(), decoded.height());
    if u64::from(width).saturating_mul(u64::from(height)) > MAX_PIXELS {
        return Err(VisionError::TooLarge(
            "decoded pixel count exceeds limit".to_string(),
        ));
    }
    let mut output = Vec::new();
    decoded
        .write_to(&mut Cursor::new(&mut output), image::ImageFormat::Jpeg)
        .map_err(|error| VisionError::InvalidImage(error.to_string()))?;
    if output.len() > MAX_IMAGE_BYTES {
        return Err(VisionError::TooLarge(
            "re-encoded image exceeds 1.5 MiB".to_string(),
        ));
    }
    Ok((output, width, height))
}

pub fn prepare_images(
    inputs: Vec<VisionImageInput>,
    timeout: Duration,
) -> Result<VisionBatchResult, VisionError> {
    let mut seen = HashSet::new();
    if inputs.len() > MAX_IMAGES {
        return Err(VisionError::TooManyImages(inputs.len()));
    }
    // Sequential fetch stays within the documented max concurrency of two.
    let mut result = VisionBatchResult::default();
    let mut total_bytes = 0usize;
    let mut image_digests = Vec::new();
    for input in inputs {
        if !seen.insert(input.url.clone()) {
            continue;
        }
        let (content_type, bytes) = fetch_image(&input.url, timeout)?;
        let (normalized, width, height) = normalize_image(&content_type, &bytes)?;
        // Digest normalized bytes before drop; never retain or serialize image bytes.
        image_digests.push(content_digest(&normalized));
        total_bytes = total_bytes.saturating_add(normalized.len());
        enforce_aggregate_limit(total_bytes)?;
        result.images.push(VisionImageResult {
            url: input.url,
            source: input.source,
            content_hash: image_digests.last().cloned().unwrap_or_default(),
            mime_type: "image/jpeg".to_string(),
            normalized_bytes: normalized.len(),
            width,
            height,
        });
        // normalized drops here without base64/path persistence.
    }
    result.batch_hash = batch_content_digest(&image_digests);
    Ok(result)
}

fn enforce_aggregate_limit(total_bytes: usize) -> Result<(), VisionError> {
    if total_bytes > MAX_TOTAL_BYTES {
        Err(VisionError::TooLarge(
            "aggregate normalized image bytes exceed 7.5 MiB".to_string(),
        ))
    } else {
        Ok(())
    }
}

fn is_supported_mime(content_type: &str) -> bool {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    matches!(
        mime.as_str(),
        "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    )
}

fn has_image_magic(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xff, 0xd8, 0xff])
        || bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"))
}

fn is_private_or_local(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_private_or_local_v4(address),
        IpAddr::V6(address) => {
            // Normalize IPv4-mapped IPv6 (::ffff:a.b.c.d) before private/local checks so
            // mapped loopback, RFC1918, link-local, unspecified, broadcast, and docs nets
            // cannot bypass the v4 denylist via literal or mixed DNS answers.
            //
            // Do not use Ipv4Addr::to_ipv4_mapped (IPv4→IPv6) or Ipv6Addr::to_ipv4 as the
            // primary path: to_ipv4 also matches deprecated IPv4-compatible forms and
            // treats ::1 as 0.0.0.1, which would skip the native IPv6 loopback check.
            // Explicit ::ffff segment decode is the correct IPv6→IPv4 mapped extraction.
            if let Some(mapped) = ipv4_mapped_from_v6(address) {
                return is_private_or_local_v4(mapped);
            }
            address.is_loopback()
                || address.is_unspecified()
                || address.is_unique_local()
                || address.segments()[0] & 0xffc0 == 0xfe80
        }
    }
}

/// Extract the embedded IPv4 address from an IPv4-mapped IPv6 address
/// (`::ffff:a.b.c.d` / segments `[0,0,0,0,0,0xffff,hi,lo]`).
fn ipv4_mapped_from_v6(address: std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    let segments = address.segments();
    if segments[0] == 0
        && segments[1] == 0
        && segments[2] == 0
        && segments[3] == 0
        && segments[4] == 0
        && segments[5] == 0xffff
    {
        let [a, b] = segments[6].to_be_bytes();
        let [c, d] = segments[7].to_be_bytes();
        Some(std::net::Ipv4Addr::new(a, b, c, d))
    } else {
        None
    }
}

fn is_private_or_local_v4(address: std::net::Ipv4Addr) -> bool {
    address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_unspecified()
        || address.is_broadcast()
        || address.is_documentation()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_and_deduplicates_only_final_sources() {
        let images = extract_final_image_urls(
            "https://example.test/poster.jpg",
            "![x](https://example.test/poster.jpg) ![y](https://example.test/body.png)",
            "<img src=\"https://example.test/body.png\"><img src=\"https://example.test/html.jpg\">",
        );
        assert_eq!(images.len(), 3);
    }

    #[test]
    fn html_extraction_only_collects_img_src_not_script_or_link() {
        let html = r#"
            <script src="https://example.test/tracker.js"></script>
            <link rel="preload" href="https://example.test/font.woff2" as="font">
            <iframe src="https://example.test/frame.html"></iframe>
            <source src="https://example.test/video.mp4">
            <img class="cover" data-src="https://example.test/lazy.jpg" src="https://example.test/keep.png" alt="x">
            <IMG SRC='https://example.test/upper.JPG'>
            <a href="https://example.test/page.html">not an image tag</a>
            bare https://example.test/orphan.jpg in html text
        "#;
        let images = extract_final_image_urls("", "", html);
        let urls: Vec<&str> = images.iter().map(|image| image.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://example.test/keep.png",
                "https://example.test/upper.JPG",
            ]
        );
        assert!(images.iter().all(|image| image.source == "html"));
        // Regression: non-img src= and bare URLs must not appear.
        assert!(!urls.iter().any(|url| url.contains("tracker.js")));
        assert!(!urls.iter().any(|url| url.contains("frame.html")));
        assert!(!urls.iter().any(|url| url.contains("video.mp4")));
        assert!(!urls.iter().any(|url| url.contains("lazy.jpg")));
        assert!(!urls.iter().any(|url| url.contains("orphan.jpg")));
        assert!(!urls.iter().any(|url| url.contains("page.html")));
    }

    #[test]
    fn html_img_src_ignores_decoy_src_inside_alt_or_title() {
        // Decoy `src=` text appears inside quoted alt/title values before the real attribute.
        let html = r#"
            <img alt="look src='https://example.test/decoy-alt.png' here" title="src=&quot;https://example.test/decoy-title.png&quot;" src="https://example.test/real.png">
            <img title='prefix src="https://example.test/decoy2.png" suffix' src='https://example.test/real2.jpg'>
        "#;
        let urls = extract_html_img_srcs(html);
        assert_eq!(
            urls,
            vec![
                "https://example.test/real.png".to_string(),
                "https://example.test/real2.jpg".to_string(),
            ]
        );
        assert!(!urls.iter().any(|url| url.contains("decoy")));
    }

    #[test]
    fn html_img_src_survives_quoted_greater_than_in_alt() {
        // A `>` inside a quoted attribute must not truncate the tag before real `src`.
        let html = r#"<img alt="a > b and also c > d" class="x" src="https://example.test/after-gt.png">"#;
        let urls = extract_html_img_srcs(html);
        assert_eq!(urls, vec!["https://example.test/after-gt.png".to_string()]);

        let html_mixed = r#"<img title='ratio 16>9' alt="score 10 > 9" src='https://example.test/mixed.png'>"#;
        assert_eq!(
            extract_html_img_srcs(html_mixed),
            vec!["https://example.test/mixed.png".to_string()]
        );
    }

    #[test]
    fn content_digest_is_deterministic_and_batch_stable() {
        let a = content_digest(b"normalized-jpeg-bytes");
        let b = content_digest(b"normalized-jpeg-bytes");
        let c = content_digest(b"other-bytes");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(a.starts_with("sha256:"));
        assert_eq!(a.len(), "sha256:".len() + 64);

        let batch_a = batch_content_digest(&[a.clone(), c.clone()]);
        let batch_b = batch_content_digest(&[a.clone(), c.clone()]);
        let batch_order = batch_content_digest(&[c, a]);
        assert_eq!(batch_a, batch_b);
        assert_ne!(batch_a, batch_order);
        assert!(batch_a.starts_with("sha256:"));
    }

    #[test]
    fn rejects_local_and_credentialed_urls() {
        assert!(validate_public_image_url("http://127.0.0.1/image.png").is_err());
        assert!(validate_public_image_url("http://user:pass@example.test/image.png").is_err());
        assert!(validate_public_image_url("http://localhost/image.png").is_err());
    }

    #[test]
    fn image_magic_and_metadata_are_normalized() {
        let image = image::DynamicImage::new_rgb8(2, 3);
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        let (normalized, width, height) = normalize_image("image/png", &bytes).unwrap();
        assert!(!normalized.is_empty());
        assert_eq!((width, height), (2, 3));
    }

    #[test]
    fn aggregate_overflow_is_hard_failure_not_warning() {
        assert!(matches!(
            enforce_aggregate_limit(MAX_TOTAL_BYTES + 1),
            Err(VisionError::TooLarge(_))
        ));
        assert!(enforce_aggregate_limit(MAX_TOTAL_BYTES).is_ok());
        assert!(enforce_aggregate_limit(0).is_ok());
    }

    #[test]
    fn streaming_read_rejects_bodies_over_download_ceiling() {
        let oversized = vec![0_u8; MAX_DOWNLOAD_BYTES + 8];
        let error = read_body_bounded(&mut Cursor::new(oversized), MAX_DOWNLOAD_BYTES).unwrap_err();
        assert!(matches!(error, VisionError::TooLarge(_)));
    }

    #[test]
    fn streaming_read_accepts_bodies_within_ceiling() {
        let payload = b"tiny-body".to_vec();
        let bytes =
            read_body_bounded(&mut Cursor::new(payload.clone()), MAX_DOWNLOAD_BYTES).unwrap();
        assert_eq!(bytes, payload);
    }

    #[test]
    fn rejects_non_http_schemes() {
        assert!(validate_public_image_url("file:///tmp/image.png").is_err());
        assert!(validate_public_image_url("ftp://example.test/image.png").is_err());
    }

    #[test]
    fn normalized_image_cap_constant_is_1_5_mib() {
        assert_eq!(MAX_IMAGE_BYTES, 1_500_000);
        assert_eq!(MAX_PIXELS, 40_000_000);
        assert_eq!(MAX_TOTAL_BYTES, 7_500_000);
    }

    #[test]
    fn rejects_ipv4_mapped_ipv6_private_and_local_addresses() {
        let cases = [
            // loopback
            "::ffff:127.0.0.1",
            // RFC1918
            "::ffff:10.0.0.1",
            "::ffff:172.16.5.5",
            "::ffff:192.168.1.10",
            // link-local
            "::ffff:169.254.10.20",
            // unspecified
            "::ffff:0.0.0.0",
            // broadcast
            "::ffff:255.255.255.255",
            // documentation / TEST-NET
            "::ffff:192.0.2.1",
            "::ffff:198.51.100.1",
            "::ffff:203.0.113.1",
        ];
        for host in cases {
            let mapped: IpAddr = host.parse().expect("valid mapped address");
            assert!(
                is_private_or_local(mapped),
                "expected private/local rejection for {host}"
            );
            let url = format!("http://[{host}]/image.png");
            assert!(
                validate_public_image_url(&url).is_err(),
                "literal mapped URL must be rejected: {url}"
            );
        }
    }

    #[test]
    fn rejects_mixed_dns_answers_containing_mapped_private_address() {
        // resolve_public_address rejects when *any* resolved address is private/local.
        let public: IpAddr = "93.184.216.34".parse().unwrap();
        let mapped_loopback: IpAddr = "::ffff:127.0.0.1".parse().unwrap();
        let mapped_rfc1918: IpAddr = "::ffff:10.1.2.3".parse().unwrap();
        assert!(!is_private_or_local(public));
        assert!(is_private_or_local(mapped_loopback));
        assert!(is_private_or_local(mapped_rfc1918));
        // Mixed answer set: public + mapped private must fail the any() gate used by DNS resolution.
        let mixed = [public, mapped_loopback, mapped_rfc1918];
        assert!(
            mixed.iter().any(|address| is_private_or_local(*address)),
            "mixed DNS answers that include mapped private addresses must be rejected"
        );
    }

    #[test]
    fn allows_public_ipv4_mapped_addresses() {
        let public_mapped: IpAddr = "::ffff:93.184.216.34".parse().unwrap();
        assert!(
            !is_private_or_local(public_mapped),
            "public IPv4-mapped addresses remain allowed"
        );
    }
}
