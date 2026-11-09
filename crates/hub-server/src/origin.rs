//! Resolve the public address from configuration or a trusted, single-hop proxy.
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
    pub fixed: Option<String>,
    trusted: Vec<IpNet>,
}
impl Policy {
    pub fn new(config: &config::Config) -> anyhow::Result<Self> {
        let trusted = config
            .trusted_proxies
            .clone()
            .unwrap_or_else(|| vec!["127.0.0.0/8".into(), "::1/128".into()]);
        Ok(Self {
            fixed: config
                .origin
                .as_deref()
                .map(config::parse_origin)
                .transpose()?,
            trusted: trusted
                .iter()
                .map(|v| parse_network(v))
                .collect::<anyhow::Result<_>>()?,
        })
    }
    pub fn resolve(&self, headers: &HeaderMap, peer: Option<SocketAddr>) -> Result<PublicOrigin> {
        if let Some(fixed) = &self.fixed {
            return Ok(PublicOrigin(fixed.clone()));
        }
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
        let origin =
            config::parse_origin(&format!("{scheme}://{host}")).map_err(|_| invalid_host())?;
        Ok(PublicOrigin(origin))
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

#[derive(Clone, Debug)]
pub struct PublicOrigin(pub String);
impl PublicOrigin {
    pub fn secure(&self) -> bool {
        self.0.starts_with("https://")
    }
    pub fn check(&self, headers: &HeaderMap, required: bool) -> Result<()> {
        let supplied = single_header(headers, "origin")
            .map_err(|_| Error(StatusCode::FORBIDDEN, "origin_mismatch"))?;
        let received = supplied.and_then(|value| config::parse_origin(value).ok());
        if (supplied.is_some() && received.as_deref() != Some(self.0.as_str()))
            || (required && supplied.is_none())
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
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|v| v.0);
    let origin = match app.addresses.resolve(request.headers(), peer) {
        Ok(origin) => origin,
        Err(error) => return error.into_response(),
    };
    let secure = origin.secure();
    request.extensions_mut().insert(origin);
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert("content-security-policy", "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'".parse().unwrap());
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
            let origin = policy().resolve(&headers, peer).unwrap();
            assert_eq!(origin.0, "http://127.0.0.1:8088");
            assert!(origin.check(&headers, true).is_err());
        }
    }
    #[test]
    fn supports_explicit_proxy_networks_or_disabling_trust_and_keeps_fixed_origins_strict() {
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
        assert!(!Policy::new(&config)
            .unwrap()
            .resolve(&headers, Some("127.0.0.1:80".parse().unwrap()))
            .unwrap()
            .secure());
        config.origin = Some("https://fixed.example".into());
        let origin = Policy::new(&config)
            .unwrap()
            .resolve(&headers, None)
            .unwrap();
        assert!(origin.check(&headers, true).is_err());
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
