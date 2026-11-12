use crate::{security::*, App};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    schema_version: u8,
    theme: String,
    font_size: u8,
    font_id: String,
    #[serde(default = "default_tab_transparency")]
    tab_bar_transparency: u8,
}

fn default_tab_transparency() -> u8 {
    20
}

impl Settings {
    fn validate(&self) -> Result<()> {
        if self.tab_bar_transparency > 100
            || self.schema_version != 1
            || !(8..=48).contains(&self.font_size)
            || ![
                "default",
                "nord",
                "dracula",
                "solarized-dark",
                "monokai",
                "paper",
                "light",
            ]
            .contains(&self.theme.as_str())
            || ![
                "source-code-pro",
                "jetbrains-mono",
                "fira-code",
                "dejavu-sans-mono",
                "cascadia-code",
                "monaco",
                "menlo",
                "monospace",
            ]
            .contains(&self.font_id.as_str())
        {
            return Err(bad());
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Save {
    revision: i64,
    settings: Settings,
}

pub async fn get(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    let user = session(&app, &headers).await?;
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT value,revision FROM terminal_settings WHERE user_id=?")
            .bind(user.user_id)
            .fetch_optional(&app.db)
            .await?;
    Ok(Json(match row {
        Some((value, revision)) => {
            json!({"revision":revision,"settings":serde_json::from_str::<Value>(&value).map_err(|_| bad())?})
        }
        None => json!({"revision":0,"settings":null}),
    }))
}

pub async fn save(
    State(app): State<App>,
    headers: HeaderMap,
    Json(value): Json<Save>,
) -> Result<Json<Value>> {
    let user = session(&app, &headers).await?;
    value.settings.validate()?;
    if value.revision < 0 || value.revision == i64::MAX {
        return Err(bad());
    }
    let encoded = serde_json::to_string(&value.settings).map_err(|_| bad())?;
    let revision: Option<i64> = if value.revision == 0 {
        sqlx::query_scalar("INSERT INTO terminal_settings(user_id,value,revision) VALUES(?,?,1) ON CONFLICT(user_id) DO NOTHING RETURNING revision")
            .bind(user.user_id).bind(encoded).fetch_optional(&app.db).await?
    } else {
        sqlx::query_scalar("UPDATE terminal_settings SET value=?,revision=revision+1 WHERE user_id=? AND revision=? RETURNING revision")
            .bind(encoded).bind(user.user_id).bind(value.revision).fetch_optional(&app.db).await?
    }.ok_or(Error(StatusCode::CONFLICT, "terminal_settings_conflict"))?;
    Ok(Json(json!({"revision":revision,"settings":value.settings})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transparency_defaults_for_legacy_settings_and_validates_bounds() {
        let legacy = json!({"schemaVersion":1,"theme":"paper","fontSize":18,"fontId":"monospace"});
        let settings: Settings = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(settings.tab_bar_transparency, 20);
        for n in [0, 20, 50, 100] {
            let mut value = legacy.clone();
            value["tabBarTransparency"] = json!(n);
            let settings: Settings = serde_json::from_value(value).unwrap();
            assert!(settings.validate().is_ok());
            assert_eq!(
                serde_json::to_value(settings).unwrap()["tabBarTransparency"],
                n
            );
        }
        for n in [json!(-1), json!(101), json!(1.5), json!("50"), json!(null)] {
            let mut value = legacy.clone();
            value["tabBarTransparency"] = n;
            assert!(serde_json::from_value::<Settings>(value)
                .map(|v| v.validate().is_err())
                .unwrap_or(true));
        }
    }
}
