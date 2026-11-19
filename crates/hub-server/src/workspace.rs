use crate::{security::*, App};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Sqlite, SqlitePool};
use std::collections::HashSet;

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged, deny_unknown_fields)]
enum Unit {
    Group {
        id: String,
        members: Vec<String>,
    },
    Tab {
        id: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        hidden: bool,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: i64,
    write_id: Option<String>,
    units: Option<Vec<Unit>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Save {
    revision: i64,
    write_id: String,
    units: Vec<Unit>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct SaveResult {
    revision: i64,
    replayed: bool,
}

const CONFLICT: Error = Error(StatusCode::CONFLICT, "workspace_conflict");

fn group_id(id: &str) -> bool {
    id.strip_prefix("split-").is_some_and(|part| {
        matches!(part.len(), 32 | 64) && part.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

type Member = (String, i64, i64, Option<String>, bool);

impl Save {
    fn rows(self) -> Result<(i64, String, Vec<Member>)> {
        if !(0..i64::MAX).contains(&self.revision)
            || self.write_id.len() != 32
            || !self.write_id.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(bad());
        }
        let mut rows = Vec::new();
        let mut groups = HashSet::new();
        for (position, unit) in self.units.into_iter().enumerate() {
            match unit {
                Unit::Tab { id, hidden } => rows.push((id, position as i64, 0, None, hidden)),
                Unit::Group { id, members } => {
                    if !group_id(&id) || members.len() < 2 || !groups.insert(id.clone()) {
                        return Err(bad());
                    }
                    rows.extend(members.into_iter().enumerate().map(|(index, member)| {
                        (
                            member,
                            position as i64,
                            index as i64,
                            Some(id.clone()),
                            false,
                        )
                    }));
                }
            }
        }
        let mut unique = HashSet::new();
        if rows
            .iter()
            .any(|(id, ..)| !secret(id) || !unique.insert(id))
        {
            return Err(bad());
        }
        Ok((self.revision, self.write_id, rows))
    }
}

type Stored = (i64, String, Option<String>, Option<String>, Option<bool>);

async fn read(db: &SqlitePool, user: &str) -> Result<Snapshot> {
    let rows: Vec<Stored> = sqlx::query_as(
        "SELECT r.revision,r.write_id,m.instance,m.group_id,m.hidden
         FROM workspace_revisions r
         LEFT JOIN workspace_members m ON m.user_id=r.user_id
           AND EXISTS (SELECT 1 FROM grants g WHERE g.user_id=m.user_id AND g.instance=m.instance)
         WHERE r.user_id=? ORDER BY m.unit_position,m.member_position",
    )
    .bind(user)
    .fetch_all(db)
    .await?;
    let Some((revision, write_id, ..)) = rows.first() else {
        return Ok(Snapshot {
            revision: 0,
            write_id: None,
            units: None,
        });
    };
    let (revision, write_id) = (*revision, write_id.clone());
    let mut units: Vec<Unit> = Vec::new();
    for (_, _, instance, group, hidden) in rows {
        let Some(instance) = instance else { continue };
        if let Some(id) = group {
            if let Some(Unit::Group { id: last, members }) = units.last_mut() {
                if *last == id {
                    members.push(instance);
                    continue;
                }
            }
            units.push(Unit::Group {
                id,
                members: vec![instance],
            });
        } else {
            units.push(Unit::Tab {
                id: instance,
                hidden: hidden.unwrap_or(false),
            });
        }
    }
    for unit in &mut units {
        if let Unit::Group { members, .. } = unit {
            if members.len() == 1 {
                *unit = Unit::Tab {
                    id: members.pop().unwrap(),
                    hidden: false,
                };
            }
        }
    }
    Ok(Snapshot {
        revision,
        write_id: Some(write_id),
        units: Some(units),
    })
}

async fn write(db: &SqlitePool, user: &str, value: Save) -> Result<SaveResult> {
    let (revision, write_id, rows) = value.rows()?;
    let mut tx = db.begin().await?;
    // Acquire SQLite's write lock before checking current grants or replacing rows.
    let next: Option<i64> = if revision == 0 {
        sqlx::query_scalar("INSERT INTO workspace_revisions VALUES(?,1,?) ON CONFLICT DO NOTHING RETURNING revision")
            .bind(user).bind(&write_id).fetch_optional(&mut *tx).await?
    } else {
        sqlx::query_scalar(
            "UPDATE workspace_revisions SET revision=revision+1,write_id=? WHERE user_id=? AND revision=?
             AND NOT EXISTS (SELECT 1 FROM workspace_writes WHERE user_id=? AND write_id=?)
             RETURNING revision",
        )
        .bind(&write_id).bind(user).bind(revision).bind(user).bind(&write_id).fetch_optional(&mut *tx).await?
    };
    let Some(next) = next else {
        let saved = sqlx::query_scalar::<_, i64>(
            "SELECT revision FROM workspace_writes WHERE user_id=? AND write_id=?",
        )
        .bind(user)
        .bind(&write_id)
        .fetch_optional(&mut *tx)
        .await?;
        return saved
            .map(|revision| SaveResult {
                revision,
                replayed: true,
            })
            .ok_or(CONFLICT);
    };
    let grants: HashSet<String> = sqlx::query_scalar("SELECT instance FROM grants WHERE user_id=?")
        .bind(user)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect();
    if rows.iter().any(|(id, ..)| !grants.contains(id)) {
        return Err(Error(StatusCode::CONFLICT, "workspace_members_changed"));
    }
    sqlx::query("DELETE FROM workspace_members WHERE user_id=?")
        .bind(user)
        .execute(&mut *tx)
        .await?;
    // Chunk SQL bind parameters independently of how many terminals the layout contains.
    for chunk in rows.chunks(150) {
        let mut insert: QueryBuilder<'_, Sqlite> = QueryBuilder::new(
            "INSERT INTO workspace_members(user_id,instance,unit_position,member_position,group_id,hidden) ",
        );
        insert.push_values(chunk, |mut row, (id, unit, member, group, hidden)| {
            row.push_bind(user)
                .push_bind(id)
                .push_bind(unit)
                .push_bind(member)
                .push_bind(group)
                .push_bind(hidden);
        });
        insert.build().execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO workspace_writes(user_id,write_id,revision) VALUES(?,?,?)")
        .bind(user)
        .bind(&write_id)
        .bind(next)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(SaveResult {
        revision: next,
        replayed: false,
    })
}

pub async fn get(State(app): State<App>, headers: HeaderMap) -> Result<Json<Snapshot>> {
    let user = session(&app, &headers).await?;
    Ok(Json(read(&app.db, &user.user_id).await?))
}

pub async fn save(
    State(app): State<App>,
    headers: HeaderMap,
    Json(value): Json<Save>,
) -> Result<Json<SaveResult>> {
    let user = session(&app, &headers).await?;
    Ok(Json(write(&app.db, &user.user_id, value).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stores_large_groups_atomically_and_scopes_them_to_current_grants() {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../../migrations").run(&db).await.unwrap();
        sqlx::query("INSERT INTO users VALUES ('user','owner','',0,0),('other','other','',0,0)")
            .execute(&db)
            .await
            .unwrap();
        let ids: Vec<String> = (0..300).map(|n| format!("{n:064x}")).collect();
        for id in &ids {
            sqlx::query("INSERT INTO instances VALUES (?,?,'user','',1,NULL)")
                .bind(id)
                .bind(id)
                .execute(&db)
                .await
                .unwrap();
            sqlx::query("INSERT INTO grants VALUES (?,'user','owner')")
                .bind(id)
                .execute(&db)
                .await
                .unwrap();
        }
        let save = |revision, write_id: &str, members| Save {
            revision,
            write_id: write_id.repeat(32),
            units: vec![Unit::Group {
                id: format!("split-{}", "f".repeat(32)),
                members,
            }],
        };
        assert_eq!(
            write(&db, "user", save(0, "a", ids.clone())).await.unwrap(),
            SaveResult {
                revision: 1,
                replayed: false
            }
        );
        assert_eq!(
            write(&db, "user", save(0, "a", ids.clone())).await.unwrap(),
            SaveResult {
                revision: 1,
                replayed: true
            }
        );
        assert_eq!(
            write(&db, "user", save(0, "b", ids.clone()))
                .await
                .unwrap_err()
                .1,
            "workspace_conflict"
        );
        assert!(read(&db, "other").await.unwrap().units.is_none());
        assert_eq!(
            write(&db, "other", save(0, "c", ids.clone()))
                .await
                .unwrap_err()
                .1,
            "workspace_members_changed"
        );
        assert!(read(&db, "other").await.unwrap().units.is_none());
        let snapshot = read(&db, "user").await.unwrap();
        assert!(serde_json::to_string(&snapshot).unwrap().len() > 16384);
        let units = snapshot.units.unwrap();
        assert!(matches!(&units[0], Unit::Group {members,..} if members == &ids));
        let reversed: Vec<_> = ids.iter().rev().cloned().collect();
        assert_eq!(
            write(&db, "user", save(1, "b", reversed.clone()))
                .await
                .unwrap(),
            SaveResult {
                revision: 2,
                replayed: false
            }
        );
        assert_eq!(
            write(&db, "user", save(2, "a", ids.clone())).await.unwrap(),
            SaveResult {
                revision: 1,
                replayed: true
            }
        );
        let snapshot = read(&db, "user").await.unwrap();
        assert_eq!(snapshot.revision, 2);
        assert!(
            matches!(&snapshot.units.unwrap()[0], Unit::Group {members,..} if members == &reversed)
        );
        sqlx::query("DELETE FROM grants WHERE user_id='user' AND instance<>?")
            .bind(&ids[63])
            .execute(&db)
            .await
            .unwrap();
        let snapshot = read(&db, "user").await.unwrap();
        assert!(snapshot.revision > 2);
        let units = snapshot.units.unwrap();
        assert!(matches!(&units[0], Unit::Tab {id, hidden:false} if id == &ids[63]));
    }
}
