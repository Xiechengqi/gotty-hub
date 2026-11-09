use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
};

#[derive(Parser)]
#[command(version=concat!(env!("CARGO_PKG_VERSION")," (",env!("HUB_REVISION"),")"), about = "Self-hosted GoTTY terminal hub")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
    #[arg(long, global = true)]
    pub resend_api_key: Option<String>,
    #[arg(long, global = true)]
    pub admin_email: Option<String>,
}
#[derive(Subcommand)]
pub enum Command {
    Serve,
    #[command(alias = "configure")]
    Config,
    Check,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Config {
    pub resend_api_key: String,
    pub admin_email: String,
}
#[derive(Clone)]
pub struct Runtime {
    pub home: PathBuf,
    pub config: Config,
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
fn resolve(cli: Option<String>, env: Option<String>, stored: String) -> String {
    cli.or(env).unwrap_or(stored).trim().to_string()
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
        serde_json::from_slice(&std::fs::read(&path)?).context("Invalid ~/.gotty-hub/config")?
    } else {
        Config::default()
    };
    let mut config = Config {
        resend_api_key: resolve(
            cli.resend_api_key,
            std::env::var("RESEND_API_KEY").ok(),
            stored.resend_api_key,
        ),
        admin_email: resolve(
            cli.admin_email,
            std::env::var("HUB_ADMIN_EMAIL").ok(),
            stored.admin_email,
        ),
    };
    for (name, value, secret) in [
        ("Resend API key", &mut config.resend_api_key, true),
        ("Admin email", &mut config.admin_email, false),
    ] {
        while value.trim().is_empty() {
            anyhow::ensure!(io::stdin().is_terminal(),"{name} is required; run gotty-hub config --resend-api-key VALUE --admin-email EMAIL or use an interactive terminal");
            *value = if secret {
                rpassword::prompt_password(format!("{name}: "))?
            } else {
                print!("{name}: ");
                io::stdout().flush()?;
                let mut line = String::new();
                io::stdin().read_line(&mut line)?;
                line.trim().to_string()
            };
        }
    }
    config.admin_email = crate::security::email(&config.admin_email)
        .map_err(|_| anyhow::anyhow!("Invalid admin email"))?;
    anyhow::ensure!(
        !config.resend_api_key.trim().is_empty(),
        "Resend API key cannot be empty"
    );
    if !existed || matches!(cli.command, Some(Command::Config)) {
        save(&path, &serde_json::to_vec_pretty(&config)?)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    if matches!(cli.command, Some(Command::Config | Command::Check)) {
        println!("Configuration valid: {}", path.display());
        return Ok(None);
    }
    Ok(Some(Runtime { home, config }))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn precedence_and_explicit_empty() {
        assert_eq!(
            resolve(Some(" cli ".into()), Some("env".into()), "file".into()),
            "cli"
        );
        assert_eq!(resolve(None, Some("env".into()), "file".into()), "env");
        assert_eq!(resolve(None, None, "file".into()), "file");
        assert_eq!(resolve(Some(" ".into()), None, "file".into()), "");
    }
}
