use crate::{security::*, App};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::HeaderMap,
    response::IntoResponse,
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use hub_protocol::{Frame, MAX_MESSAGE, MAX_STREAMS, QUEUE};
use serde_json::{json, Value};
use sqlx::Row;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{mpsc, Mutex};
#[derive(Clone)]
pub struct Device {
    pub tx: mpsc::Sender<Frame>,
    pub streams: Arc<Mutex<HashMap<String, mpsc::Sender<Message>>>>,
    pub generation: String,
    pub color: String,
    pub revision: u64,
    pub capabilities: Value,
}
pub async fn new_ticket(app: &App, s: &Session, id: &str) -> Result<Json<Value>> {
    let version:Option<i64>=sqlx::query_scalar("SELECT i.version FROM instances i JOIN grants g ON i.id=g.instance WHERE i.id=? AND g.email=?").bind(id).bind(&s.email).fetch_optional(&app.db).await?;
    let version = version.ok_or(denied())?;
    if !app.devices.lock().await.contains_key(id) {
        return Err(Error(axum::http::StatusCode::CONFLICT, "instance_offline"));
    }
    limit(app, format!("tickets:{}", s.key), 120).await?;
    let raw = token();
    sqlx::query("INSERT INTO tickets VALUES(?,?,?,?,?)")
        .bind(hash(&raw))
        .bind(&s.key)
        .bind(id)
        .bind(version)
        .bind(now() + 30)
        .execute(&app.db)
        .await?;
    Ok(Json(
        json!({"ticket":raw,"connection_id":id,"expires_in":30}),
    ))
}
pub async fn device_upgrade(
    State(app): State<App>,
    h: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse> {
    let id = h
        .get("x-instance-id")
        .and_then(|v| v.to_str().ok())
        .ok_or(denied())?
        .to_owned();
    let raw = h
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(denied())?;
    let stored = sqlx::query("SELECT device,device_next FROM instances WHERE id=?")
        .bind(&id)
        .fetch_optional(&app.db)
        .await?
        .ok_or(denied())?;
    let fingerprint = hash(raw);
    let current: String = stored.get("device");
    let next: Option<String> = stored.get("device_next");
    if current != fingerprint && next.as_deref() != Some(&fingerprint) {
        return Err(denied());
    }
    if next.as_deref() == Some(&fingerprint) {
        sqlx::query(
            "UPDATE instances SET device=device_next,device_next=NULL WHERE id=? AND device_next=?",
        )
        .bind(&id)
        .bind(&fingerprint)
        .execute(&app.db)
        .await?;
    }
    Ok(ws
        .max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE)
        .on_upgrade(move |socket| device(app, id, socket)))
}
async fn device(app: App, id: String, mut socket: WebSocket) {
    let hello = tokio::time::timeout(Duration::from_secs(5), socket.recv()).await;
    let Ok(Some(Ok(Message::Text(text)))) = hello else {
        return;
    };
    let Ok(frame) = serde_json::from_str::<Frame>(&text) else {
        return;
    };
    if frame.kind != "hello" || frame.data["protocol"] != 1 {
        return;
    }
    let generation = token();
    let (tx, mut rx) = mpsc::channel::<Frame>(QUEUE);
    let streams = Arc::new(Mutex::new(HashMap::<String, mpsc::Sender<Message>>::new()));
    let device = Device {
        tx: tx.clone(),
        streams: streams.clone(),
        generation: generation.clone(),
        color: "gray".into(),
        revision: 0,
        capabilities: frame.data["capabilities"].clone(),
    };
    if let Some(old) = app.devices.lock().await.insert(id.clone(), device) {
        let _ = old.tx.try_send(Frame::new("superseded", "", json!({})));
    }
    let _ = tx.try_send(Frame::new(
        "hello_ack",
        "",
        json!({"protocol":1,"generation":generation}),
    ));
    let (mut sink, mut source) = socket.split();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    let mut last = tokio::time::Instant::now();
    loop {
        tokio::select! {
         message=rx.recv()=>{let Some(f)=message else{break};let stop=f.kind=="revoked"||f.kind=="superseded";if tokio::time::timeout(Duration::from_secs(10),sink.send(Message::Text(serde_json::to_string(&f).unwrap()))).await.map(|v|v.is_err()).unwrap_or(true)||stop{break}},
         _=heartbeat.tick()=>{
          if last.elapsed()>Duration::from_secs(45){break}
          if sink.send(Message::Ping(vec![])).await.is_err(){break}
         },
         incoming=source.next()=>{
          match incoming{
           Some(Ok(Message::Pong(_)))=>last=tokio::time::Instant::now(),
           Some(Ok(Message::Text(t)))=>{
            last=tokio::time::Instant::now();let Ok(f)=serde_json::from_str::<Frame>(&t)else{break};
            match f.kind.as_str(){
             "status"=>{let mut devices=app.devices.lock().await;if let Some(d)=devices.get_mut(&id){
              if d.generation!=generation{break}
              let revision=f.data["revision"].as_u64().unwrap_or(0);let color=f.data["color"].as_str().unwrap_or("");
              if revision>d.revision&&["red","gray","yellow","green"].contains(&color){d.revision=revision;d.color=color.into()}
             }},
             "asr_data"=>{let sender=streams.lock().await.get(&f.stream).cloned();if let Some(sender)=sender{let message=if f.data["binary"]==true{STANDARD.decode(f.data["payload"].as_str().unwrap_or("")).ok().map(Message::Binary)}else{f.data["payload"].as_str().map(|s|Message::Text(s.into()))};if let Some(message)=message{if sender.try_send(message).is_err(){streams.lock().await.remove(&f.stream);let _=tx.try_send(Frame::new("close",&f.stream,json!({})));}}}},
             "data"=>{if let Some(data)=f.data.as_str(){let sender=streams.lock().await.get(&f.stream).cloned();if let Some(sender)=sender{if sender.try_send(Message::Text(data.into())).is_err(){streams.lock().await.remove(&f.stream);let _=tx.try_send(Frame::new("close",&f.stream,json!({"reason":"slow_consumer"})));}}}},
             "close"=>{streams.lock().await.remove(&f.stream);},
             "rotated"=>{let _=sqlx::query("UPDATE instances SET device=device_next,device_next=NULL WHERE id=? AND device_next=?").bind(&id).bind(f.data["fingerprint"].as_str().unwrap_or("")).execute(&app.db).await;},
             "open_ack"|"pong"=>{},
             _=>break,
            }
           },
          Some(Ok(Message::Ping(p)))=>{if sink.send(Message::Pong(p)).await.is_err(){break}},
           _=>break,
          }
         }
        }
    }
    let mut devices = app.devices.lock().await;
    if devices.get(&id).map(|d| d.generation.as_str()) == Some(&generation) {
        devices.remove(&id);
    }
    drop(devices);
    streams.lock().await.clear();
}
pub async fn browser_upgrade(
    State(app): State<App>,
    Path(id): Path<String>,
    h: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse> {
    if h.get("origin").and_then(|v| v.to_str().ok()) != Some(&app.origin) {
        return Err(denied());
    }
    let s = session(&app, &h).await?;
    limit(&app, format!("upgrade:{}", s.key), 120).await?;
    Ok(ws
        .max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE)
        .on_upgrade(move |socket| browser(app, id, s, socket)))
}
async fn browser(app: App, id: String, s: Session, mut socket: WebSocket) {
    let Ok(Some(Ok(Message::Text(t)))) =
        tokio::time::timeout(Duration::from_secs(5), socket.recv()).await
    else {
        return;
    };
    let Ok(auth) = serde_json::from_str::<Value>(&t) else {
        return;
    };
    let Some(raw) = auth["ticket"].as_str() else {
        return;
    };
    let row=sqlx::query("DELETE FROM tickets WHERE token=? AND session=? AND instance=? AND expires>? RETURNING version").bind(hash(raw)).bind(&s.key).bind(&id).bind(now()).fetch_optional(&app.db).await.ok().flatten();
    let Some(row) = row else { return };
    let version: i64 = row.get("version");
    let Some((role, _)) = access(&app, &s, &id, version).await else {
        return;
    };
    let device = app.devices.lock().await.get(&id).cloned();
    let Some(device) = device else { return };
    let channel = auth["channel"].as_str().unwrap_or("terminal");
    if !["terminal", "asr"].contains(&channel) {
        return;
    }
    let asr = channel == "asr";
    if asr
        && (role == "observer"
            || device.capabilities["asr"] != true
            || device.capabilities["write"] != true)
    {
        return;
    }
    let stream = token();
    let (tx, mut rx) = mpsc::channel::<Message>(QUEUE);
    {
        let mut streams = device.streams.lock().await;
        if streams.len() >= MAX_STREAMS {
            return;
        }
        streams.insert(stream.clone(), tx);
    }
    if device.tx.try_send(Frame::new("open",&stream,json!({"channel":channel,"role":role,"epoch":auth["epoch"],"offset":auth["offset"],"writable":role!="observer"&&device.capabilities["write"]==true}))).is_err(){device.streams.lock().await.remove(&stream);return}
    let (mut sink, mut source) = socket.split();
    let mut check = tokio::time::interval(Duration::from_millis(500));
    let started = tokio::time::Instant::now();
    let mut audio_bytes = 0usize;
    loop {
        tokio::select! {
             _=check.tick()=>{
              if asr&&started.elapsed()>Duration::from_secs(120){break}
              if access(&app,&s,&id,version).await.is_none(){break}
              if app.devices.lock().await.get(&id).map(|d|d.generation.clone())!=Some(device.generation.clone()){break}
              if device.tx.is_closed(){break}
             },
             message=rx.recv()=>{let Some(message)=message else{break};if tokio::time::timeout(Duration::from_secs(10),sink.send(message)).await.map(|v|v.is_err()).unwrap_or(true){break}},
             incoming=source.next()=>match incoming{
              Some(Ok(Message::Text(t)))=>{
               if access(&app,&s,&id,version).await.is_none(){break}
               if let Ok(v)=serde_json::from_str::<Value>(&t){if v["viewing"].is_boolean(){let _=device.tx.try_send(Frame::new("view",&stream,json!({"viewing":v["viewing"]})));continue}}
               if asr{if t!="Done"{break}
        if device.tx.try_send(Frame::new("asr_data",&stream,json!({"binary":false,"payload":t}))).is_err(){break}continue}
               let kind=t.as_bytes().first().copied().unwrap_or(0);
               let writable=role!="observer"&&device.capabilities["write"]==true;
               if !b"12347".contains(&kind){break}
               if !writable && !b"24".contains(&kind){break}
               if device.tx.try_send(Frame::new("data",&stream,Value::String(t))).is_err(){break}
              },
              Some(Ok(Message::Binary(data)))=>{
               if !asr||access(&app,&s,&id,version).await.is_none(){break}
               audio_bytes+=data.len();if audio_bytes>16*1024*1024{break}
               if device.tx.try_send(Frame::new("asr_data",&stream,json!({"binary":true,"payload":STANDARD.encode(data)}))).is_err(){break}
              },
              Some(Ok(Message::Ping(p)))=>{if sink.send(Message::Pong(p)).await.is_err(){break}},
              Some(Ok(Message::Pong(_)))=>{},
              _=>break,
             }
            }
    }
    device.streams.lock().await.remove(&stream);
    let _ = device.tx.try_send(Frame::new("close", &stream, json!({})));
    let _ = sink.send(Message::Close(None)).await;
}
async fn access(app: &App, s: &Session, id: &str, version: i64) -> Option<(String, i64)> {
    sqlx::query("SELECT g.role,i.version FROM grants g JOIN instances i ON i.id=g.instance JOIN sessions s ON s.email=g.email WHERE s.token=? AND s.expires>? AND i.id=? AND i.version=?").bind(&s.key).bind(now()).bind(id).bind(version).fetch_optional(&app.db).await.ok().flatten().map(|r|(r.get("role"),r.get("version")))
}
