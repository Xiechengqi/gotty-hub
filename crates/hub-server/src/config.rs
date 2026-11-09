use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, IsTerminal, Read},
    path::{Path, PathBuf},
};

#[derive(Parser)]
#[command(version=concat!(env!("CARGO_PKG_VERSION")," (",env!("HUB_REVISION"),")"), about="Self-hosted GoTTY terminal hub")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
    #[arg(long, global = true, conflicts_with = "password_stdin")]
    pub password: Option<String>,
    #[arg(long, global = true)]
    pub password_stdin: bool,
    /// Deprecated compatibility option; addresses now follow each request.
    #[arg(long, global = true)]
    pub origin: Option<String>,
    /// Comma-separated proxy IPs/CIDRs; 'none' disables forwarding headers.
    #[arg(long, global = true)]
    pub trusted_proxies: Option<String>,
}
#[derive(Subcommand)]
pub enum Command {
    Serve,
    #[command(alias = "configure")]
    Config,
    Check,
    Users {
        #[command(subcommand)]
        command: UserCommand,
    },
}
#[derive(Subcommand)]
pub enum UserCommand {
    ResetPassword {
        #[arg(long)]
        username: String,
        #[arg(long, conflicts_with = "new_password_stdin")]
        new_password: Option<String>,
        #[arg(long)]
        new_password_stdin: bool,
    },
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub password: String,
    // Read old configs without retaining a domain restriction on the next save.
    #[serde(default, skip_serializing)]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trusted_proxies: Option<Vec<String>>,
}
#[derive(Clone)]
pub struct Runtime {
    pub home: PathBuf,
    pub config: Config,
    pub reset_password: Option<(String, String)>,
}
pub fn parse_origin(raw: &str) -> Result<String> {
    let origin = raw.trim_end_matches('/').to_string();
    let url = reqwest::Url::parse(&origin)?;
    anyhow::ensure!(
        ["http", "https"].contains(&url.scheme())
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none(),
        "origin must be an HTTP(S) origin without credentials, path, query or fragment"
    );
    Ok(url.origin().ascii_serialization())
}
pub fn private_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
pub fn save(path: &Path, value: &[u8]) -> Result<()> {
    use std::io::Write;
    let temp = path.with_extension(format!("tmp-{}", crate::security::token()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<()> {
        let mut file = options.open(&temp)?;
        file.write_all(value)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
pub fn stdin_password() -> Result<String> {
    let mut value = String::new();
    io::stdin().take(1026).read_to_string(&mut value)?;
    // Strip only the line ending supplied by printf/echo; spaces belong to the password.
    if value.ends_with('\n') {
        value.pop();
        if value.ends_with('\r') {
            value.pop();
        }
    }
    Ok(value)
}
pub fn valid_admin_password(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256
}
fn network_options(
    stored: &Config,
    cli_proxies: Option<String>,
    env_proxies: Option<String>,
) -> Result<Option<Vec<String>>> {
    let proxies = cli_proxies
        .or(env_proxies)
        .map(|value| -> Result<Vec<String>> {
            if value.trim().is_empty() || value.trim() == "none" {
                return Ok(vec![]);
            }
            value
                .split(',')
                .map(|value| Ok(crate::origin::parse_network(value.trim())?.to_string()))
                .collect()
        })
        .transpose()?
        .or_else(|| stored.trusted_proxies.clone());
    for proxy in proxies.iter().flatten() {
        crate::origin::parse_network(proxy)?;
    }
    Ok(proxies)
}
pub fn load() -> Result<Option<Runtime>> {
    let cli = Cli::parse();
    let home = std::env::var_os("HUB_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".gotty-hub")
        });
    anyhow::ensure!(home.is_absolute(), "HUB_HOME must be absolute");
    private_dir(&home)?;
    let path = home.join("config");
    let existed = path.exists();
    let stored: Config = if existed {
        serde_json::from_slice(&std::fs::read(&path)?).context("Invalid ~/.gotty-hub/config; a fresh data directory is required for the username account schema")?
    } else {
        Config::default()
    };
    if cli.origin.is_some() || std::env::var_os("HUB_ORIGIN").is_some() || stored.origin.is_some() {
        eprintln!(
            "Fixed origin settings are deprecated and ignored; Hub addresses follow each request."
        );
    }
    let trusted_proxies = network_options(
        &stored,
        cli.trusted_proxies,
        std::env::var("HUB_TRUSTED_PROXIES").ok(),
    )?;
    let mut password = if cli.password_stdin {
        stdin_password()?
    } else {
        cli.password
            .or_else(|| std::env::var("HUB_PASSWORD").ok())
            .unwrap_or(stored.password)
    };
    if !existed && std::env::args_os().len() == 1 {
        password.clear();
    }
    if matches!(cli.command, Some(Command::Check)) {
        anyhow::ensure!(
            valid_admin_password(&password),
            "admin password is required (1–256 bytes, not whitespace only)"
        );
        println!("Configuration valid: {}", path.display());
        return Ok(None);
    }
    while !valid_admin_password(&password) {
        anyhow::ensure!(
            io::stdin().is_terminal(),
            "admin password is required (1–256 bytes); use --password VALUE or --password-stdin"
        );
        password = rpassword::prompt_password("admin password: ")?;
    }
    let config = Config {
        password,
        origin: None,
        trusted_proxies,
    };
    if !existed || matches!(cli.command, Some(Command::Config)) {
        save(&path, &serde_json::to_vec_pretty(&config)?)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    if matches!(cli.command, Some(Command::Config)) {
        println!("Configuration saved: {} (username: admin)", path.display());
        return Ok(None);
    }
    let reset_password = if let Some(Command::Users {
        command:
            UserCommand::ResetPassword {
                username,
                new_password,
                new_password_stdin,
            },
    }) = cli.command
    {
        let username = crate::security::username(&username)
            .map_err(|_| anyhow::anyhow!("Invalid username"))?;
        let password = if new_password_stdin {
            stdin_password()?
        } else if let Some(value) = new_password {
            value
        } else {
            anyhow::ensure!(
                io::stdin().is_terminal(),
                "use --new-password or --new-password-stdin"
            );
            rpassword::prompt_password("New password: ")?
        };
        Some((username, password))
    } else {
        None
    };
    Ok(Some(Runtime {
        home,
        config,
        reset_password,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_and_https_origins_need_no_development_flag() {
        for origin in [
            "http://hub.example:8088",
            "http://192.0.2.1:8088",
            "http://[2001:db8::1]:8088",
            "http://127.0.0.1:8088",
            "https://hub.example",
        ] {
            assert_eq!(parse_origin(origin).unwrap(), origin);
        }
        assert_eq!(
            parse_origin("http://hub.example:8088/").unwrap(),
            "http://hub.example:8088"
        );
    }

    #[test]
    fn origins_still_reject_credentials_paths_and_other_schemes() {
        for origin in [
            "hub.example:8088",
            "ftp://hub.example",
            "http://owner:secret@hub.example",
            "http://hub.example/path",
            "http://hub.example?query=1",
            "http://hub.example#fragment",
        ] {
            assert!(parse_origin(origin).is_err(), "accepted {origin}");
        }
    }

    #[test]
    fn proxy_settings_follow_cli_environment_and_file_precedence_without_new_prompts() {
        let stored = Config {
            password: "password".into(),
            origin: Some("https://file.example".into()),
            trusted_proxies: Some(vec!["10.0.0.0/24".into()]),
        };
        let effective = |cli: Option<&str>, env: Option<&str>| {
            network_options(&stored, cli.map(str::to_owned), env.map(str::to_owned)).unwrap()
        };
        assert_eq!(
            effective(Some("127.0.0.1,::1"), Some("invalid")),
            Some(vec!["127.0.0.1/32".into(), "::1/128".into()])
        );
        assert_eq!(
            effective(None, Some("192.0.2.1")),
            Some(vec!["192.0.2.1/32".into()])
        );
        assert_eq!(effective(None, None), stored.trusted_proxies);
        assert_eq!(effective(Some("none"), Some("invalid")), Some(vec![]));
        assert_eq!(effective(Some(""), None), Some(vec![]));
        assert!(network_options(&stored, Some("invalid".into()), None).is_err());
    }

    #[test]
    fn legacy_origin_is_read_but_never_saved_as_a_domain_restriction() {
        let stored: Config =
            serde_json::from_str(r#"{"password":"existing","origin":"https://old.example"}"#)
                .unwrap();
        assert_eq!(stored.origin.as_deref(), Some("https://old.example"));
        assert_eq!(
            serde_json::to_value(&stored).unwrap(),
            serde_json::json!({"password":"existing"})
        );
        assert!(Cli::try_parse_from(["gotty-hub", "--origin", "https://old.example"]).is_ok());
        let legacy: Config = serde_json::from_str(r#"{"password":"existing"}"#).unwrap();
        assert!(legacy.origin.is_none() && legacy.trusted_proxies.is_none());
        assert_eq!(
            serde_json::to_value(&legacy).unwrap(),
            serde_json::json!({"password":"existing"})
        );
    }
}
