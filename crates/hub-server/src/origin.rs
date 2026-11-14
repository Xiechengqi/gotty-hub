//! Resolve each request's public address without a configured domain allowlist.
use crate::{config, security::*, App};
use axum::{
    async_trait,
    extract::{ConnectInfo, FromRequestParts, Request, State},
    http::{request::Parts, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use ipnet::IpNet;
use std::net::{IpAddr, SocketAddr};

#[derive(Clone)]
pub struct Policy {
    trusted: Vec<IpNet>,
}
impl Policy {
    pub fn new(config: &config::Config) -> anyhow::Result<Self> {
        let trusted = config
            .trusted_proxies
            .clone()
            .unwrap_or_else(|| vec!["127.0.0.0/8".into(), "::1/128".into()]);
        Ok(Self {
            trusted: trusted
                .iter()
                .map(|v| parse_network(v))
                .collect::<anyhow::Result<_>>()?,
        })
    }
    pub fn resolve(&self, headers: &HeaderMap, peer: Option<SocketAddr>) -> Result<PublicOrigin> {
        let trusted = peer.is_some_and(|peer| {
            let ip = match peer.ip() {
                IpAddr::V6(ip) => ip
                    .to_ipv4_mapped()
                    .map(IpAddr::V4)
                    .unwrap_or(IpAddr::V6(ip)),
                ip => ip,
            };
            self.trusted.iter().any(|network| network.contains(&ip))
        });
        let mut scheme = "http";
        let mut host = single_header(headers, "host").map_err(|_| bad())?;
        let mut forwarded_host = false;
        if trusted {
            let invalid = || Error(StatusCode::BAD_REQUEST, "invalid_proxy_headers");
            if let Some(proto) =
                single_header(headers, "x-forwarded-proto").map_err(|_| invalid())?
            {
                scheme = match proto {
                    "http" => "http",
                    "https" => "https",
                    _ => return Err(invalid()),
                };
            }
            if let Some(forwarded) =
                single_header(headers, "x-forwarded-host").map_err(|_| invalid())?
            {
                host = Some(forwarded);
                forwarded_host = true;
            }
        }
        let host = host.ok_or_else(bad)?;
        let invalid_host = || {
            if forwarded_host {
                Error(StatusCode::BAD_REQUEST, "invalid_proxy_headers")
            } else {
                bad()
            }
        };
        // Authority validation rejects paths and port confusion before URL normalization.
        host.parse::<axum::http::uri::Authority>()
            .map_err(|_| invalid_host())?;
        // A browser knows the external scheme even when TLS terminates at an
        // unconfigured proxy. It may select HTTP/HTTPS only for this request's
        // authority; an unrelated Origin can never select the public host.
        let supplied = browser_origin(headers)?;
        if let Some(origin) = &supplied {
            scheme = if origin.starts_with("https://") {
                "https"
            } else {
                "http"
            };
        }
        let expected =
            config::parse_origin(&format!("{scheme}://{host}")).map_err(|_| invalid_host())?;
        let origin = PublicOrigin(expected);
        origin.check(headers, false)?;
        Ok(origin)
    }
}

pub fn parse_network(value: &str) -> anyhow::Result<IpNet> {
    value
        .parse::<IpNet>()
        .or_else(|_| value.parse::<IpAddr>().map(IpNet::from))
        .map_err(Into::into)
}
fn single_header<'a>(
    headers: &'a HeaderMap,
    name: &str,
) -> std::result::Result<Option<&'a str>, ()> {
    let mut values = headers.get_all(name).iter();
    let value = values
        .next()
        .map(|value| value.to_str().map(str::trim))
        .transpose()
        .map_err(|_| ())?;
    if values.next().is_some() || value.is_some_and(|v| v.is_empty() || v.contains(',')) {
        return Err(());
    }
    Ok(value)
}

// Same-origin fetches do not always include Origin (notably GET /me). The web
// client supplies its address explicitly so refreshes retain the HTTPS address.
// This hint is subject to the same authority check and cannot replace or
// contradict a browser-supplied Origin. WebSockets still require a real Origin.
fn browser_origin(headers: &HeaderMap) -> Result<Option<String>> {
    let mismatch = || Error(StatusCode::FORBIDDEN, "origin_mismatch");
    let parse = |name| -> Result<Option<String>> {
        single_header(headers, name)
            .map_err(|_| mismatch())?
            .map(|value| config::parse_origin(value).map_err(|_| mismatch()))
            .transpose()
    };
    let origin = parse("origin")?;
    let hint = parse("x-hub-origin")?;
    if origin.is_some() && hint.is_some() && origin != hint {
        return Err(mismatch());
    }
    Ok(origin.or(hint))
}

#[derive(Clone, Debug)]
pub struct PublicOrigin(pub String);
impl PublicOrigin {
    pub fn secure(&self) -> bool {
        self.0.starts_with("https://")
    }
    pub fn websocket_sources(&self) -> String {
        // Older WebKit does not include WebSockets in connect-src 'self'.
        // Only use the authority already validated by Policy, never raw headers.
        if let Some(authority) = self.0.strip_prefix("https://") {
            format!("wss://{authority}")
        } else {
            let authority = self
                .0
                .strip_prefix("http://")
                .expect("validated HTTP origin");
            // A navigation has no Origin hint. Preserve HTTPS access through
            // a TLS proxy that keeps Host but does not forward its scheme.
            format!("ws://{authority} wss://{authority}")
        }
    }
    pub fn check(&self, headers: &HeaderMap, required: bool) -> Result<()> {
        let received = browser_origin(headers)?;
        if (received.is_some() && received.as_deref() != Some(self.0.as_str()))
            || (required && !headers.contains_key("origin"))
        {
            tracing::warn!(expected=%self.0, received=?received, "Request origin does not match public Hub address");
            return Err(Error(StatusCode::FORBIDDEN, "origin_mismatch"));
        }
        Ok(())
    }
}
#[async_trait]
impl FromRequestParts<App> for PublicOrigin {
    type Rejection = Error;
    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self> {
        if let Some(origin) = parts.extensions.get::<Self>() {
            return Ok(origin.clone());
        }
        app.addresses.resolve(
            &parts.headers,
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|v| v.0),
        )
    }
}

pub async fn headers(State(app): State<App>, mut request: Request, next: Next) -> Response {
    if app.shutdown.is_stopping() {
        return Error(StatusCode::SERVICE_UNAVAILABLE, "server_shutting_down").into_response();
    }
    let terminal_upgrade = request
        .uri()
        .path()
        .starts_with("/api/v1/terminal-connections/")
        && request.uri().path().ends_with("/ws");
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|v| v.0);
    let origin = match app.addresses.resolve(request.headers(), peer) {
        Ok(origin) => origin,
        Err(error) => {
            if terminal_upgrade {
                tracing::warn!(
                    phase = "request",
                    status = error.0.as_u16(),
                    reason = error.1,
                    "Terminal WebSocket rejected"
                );
            }
            return error.into_response();
        }
    };
    let secure = origin.secure();
    let csp = app.assets.csp(&origin);
    request.extensions_mut().insert(origin);
    let mut response = next.run(request).await;
    if terminal_upgrade && response.status() != StatusCode::SWITCHING_PROTOCOLS {
        tracing::warn!(
            phase = "upgrade",
            status = response.status().as_u16(),
            "Terminal WebSocket upgrade did not complete"
        );
    }
    let headers = response.headers_mut();
    headers.insert("content-security-policy", csp.parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    headers.insert("permissions-policy", "microphone=(self)".parse().unwrap());
    if secure {
        headers.insert(
            "strict-transport-security",
            "max-age=31536000".parse().unwrap(),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy() -> Policy {
        Policy::new(&config::Config::default()).unwrap()
    }
    #[test]
    fn websocket_csp_sources_are_explicit_and_limited_to_the_validated_authority() {
        for (raw, expected) in [
            (
                "http://192.0.2.10:8088",
                "ws://192.0.2.10:8088 wss://192.0.2.10:8088",
            ),
            ("http://hub.example", "ws://hub.example wss://hub.example"),
            ("https://Hub.Example:443", "wss://hub.example"),
            ("https://hub.example:8443", "wss://hub.example:8443"),
            (
                "http://[2001:db8::1]:8088",
                "ws://[2001:db8::1]:8088 wss://[2001:db8::1]:8088",
            ),
            ("https://[2001:db8::1]", "wss://[2001:db8::1]"),
        ] {
            let origin = PublicOrigin(config::parse_origin(raw).unwrap());
            assert_eq!(origin.websocket_sources(), expected);
            let store = crate::assets::Store::embedded_for_tests();
            let csp = store.csp(&origin);
            assert_eq!(csp.matches("connect-src ").count(), 1);
            assert!(csp.ends_with(&format!("connect-src 'self' {expected}")));
            assert!(!csp
                .split_ascii_whitespace()
                .any(|token| token == "'unsafe-eval'"));
            assert!(!csp.contains("connect-src *"));
        }
    }
    fn request() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("host", "127.0.0.1:8088".parse().unwrap());
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        headers.insert("x-forwarded-host", "Hub.Example:443".parse().unwrap());
        headers.insert("origin", "https://hub.example".parse().unwrap());
        headers
    }
    #[test]
    fn trusts_only_the_socket_peer_and_normalizes_the_public_address() {
        let headers = request();
        for peer in ["127.0.0.1:12000", "[::1]:12000", "[::ffff:127.0.0.1]:12000"] {
            let origin = policy()
                .resolve(&headers, Some(peer.parse().unwrap()))
                .unwrap();
            assert_eq!(origin.0, "https://hub.example");
            assert!(origin.secure());
            assert!(origin.check(&headers, true).is_ok());
        }
        for peer in [None, Some("192.0.2.1:12000".parse().unwrap())] {
            assert!(policy().resolve(&headers, peer).is_err());
            let mut no_browser = headers.clone();
            no_browser.remove("origin");
            let origin = policy().resolve(&no_browser, peer).unwrap();
            assert_eq!(origin.0, "http://127.0.0.1:8088");
            assert!(origin.check(&headers, true).is_err());
        }
    }
    #[test]
    fn supports_explicit_proxy_networks_or_disabling_trust() {
        let mut config = config::Config {
            trusted_proxies: Some(vec!["192.0.2.0/24".into()]),
            ..Default::default()
        };
        let headers = request();
        assert_eq!(
            Policy::new(&config)
                .unwrap()
                .resolve(&headers, Some("192.0.2.4:80".parse().unwrap()))
                .unwrap()
                .0,
            "https://hub.example"
        );
        config.trusted_proxies = Some(vec![]);
        let mut headers = headers;
        assert!(Policy::new(&config)
            .unwrap()
            .resolve(&headers, Some("127.0.0.1:80".parse().unwrap()))
            .is_err());
        headers.remove("origin");
        assert!(!Policy::new(&config)
            .unwrap()
            .resolve(&headers, Some("127.0.0.1:80".parse().unwrap()))
            .unwrap()
            .secure());
    }
    #[test]
    fn domain_changes_and_https_work_without_proxy_headers_despite_a_saved_origin() {
        let policy = Policy::new(&config::Config {
            origin: Some("http://old.example".into()),
            ..Default::default()
        })
        .unwrap();
        for (host, browser) in [
            ("first.example", "https://first.example"),
            ("NEW.Example:443", "https://new.example"),
            ("new.example:8443", "https://new.example:8443"),
            ("new.example:80", "http://new.example"),
            ("192.0.2.10:8088", "http://192.0.2.10:8088"),
            ("[2001:db8::1]:8088", "https://[2001:db8::1]:8088"),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("host", host.parse().unwrap());
            headers.insert("origin", browser.parse().unwrap());
            // Even a nested proxy's HTTP last hop must not downgrade the
            // browser's HTTPS scheme when the public authority matches.
            headers.insert("x-forwarded-proto", "http".parse().unwrap());
            for peer in [None, Some("127.0.0.1:12000".parse().unwrap())] {
                let origin = policy.resolve(&headers, peer).unwrap();
                assert_eq!(origin.0, browser);
                assert!(origin.check(&headers, true).is_ok());
            }
        }
    }
    #[test]
    fn rejects_foreign_hosts_ports_and_invalid_browser_metadata() {
        for (name, value) in [
            ("origin", "https://foreign.example"),
            ("origin", "https://hub.example:8443"),
            ("origin", "http://hub.example:443"),
            ("origin", "null"),
            ("origin", "https://hub.example/path"),
            ("origin", "https://hub.example,https://foreign.example"),
            ("x-hub-origin", "https://foreign.example"),
            ("x-hub-origin", "null"),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("host", "hub.example".parse().unwrap());
            headers.insert(name, value.parse().unwrap());
            assert!(policy().resolve(&headers, None).is_err(), "{name}={value}");
        }
        for name in ["origin", "x-hub-origin"] {
            let mut headers = HeaderMap::new();
            headers.insert("host", "hub.example".parse().unwrap());
            headers.append(name, "https://hub.example".parse().unwrap());
            headers.append(name, "https://hub.example".parse().unwrap());
            assert!(policy().resolve(&headers, None).is_err());
        }
    }
    #[test]
    fn refresh_hint_preserves_https_but_cannot_replace_a_websocket_origin() {
        let mut headers = HeaderMap::new();
        headers.insert("host", "hub.example".parse().unwrap());
        headers.insert("x-hub-origin", "https://hub.example".parse().unwrap());
        let origin = policy().resolve(&headers, None).unwrap();
        assert_eq!(origin.0, "https://hub.example");
        assert!(origin.check(&headers, false).is_ok());
        assert!(origin.check(&headers, true).is_err());
        headers.insert("origin", "https://hub.example".parse().unwrap());
        assert!(origin.check(&headers, true).is_ok());
        for value in ["http://hub.example", "https://foreign.example"] {
            headers.insert("origin", value.parse().unwrap());
            assert!(policy().resolve(&headers, None).is_err());
        }
    }
    #[test]
    fn rejects_ambiguous_forwarding_and_invalid_origins() {
        let peer = Some("127.0.0.1:80".parse().unwrap());
        for (name, value) in [
            ("x-forwarded-proto", "https,http"),
            ("x-forwarded-proto", "ftp"),
            ("x-forwarded-host", "hub.example,evil.example"),
            ("x-forwarded-host", "user@hub.example"),
            ("x-forwarded-host", "hub.example/path"),
        ] {
            let mut headers = request();
            headers.insert(name, value.parse().unwrap());
            assert!(policy().resolve(&headers, peer).is_err(), "{name}={value}");
        }
        let mut headers = request();
        headers.append("x-forwarded-proto", "https".parse().unwrap());
        assert!(policy().resolve(&headers, peer).is_err());
        for value in ["null", "https://evil.example", "https://hub.example:8443"] {
            let mut headers = request();
            headers.insert("origin", value.parse().unwrap());
            assert!(PublicOrigin("https://hub.example".into())
                .check(&headers, true)
                .is_err());
        }
    }
}
