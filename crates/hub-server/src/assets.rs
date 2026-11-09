use axum::{
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
};
#[derive(rust_embed::RustEmbed)]
#[folder = "../../frontend/dist/"]
struct Assets;
pub async fn embedded(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let asset = Assets::get(path).or_else(|| {
        if !path.contains('.') && !path.starts_with("api/") && !path.starts_with("connector/") {
            Assets::get("index.html")
        } else {
            None
        }
    });
    match asset {
        Some(file) => (
            [(
                header::CONTENT_TYPE,
                mime_guess::from_path(if Assets::get(path).is_some() {
                    path
                } else {
                    "index.html"
                })
                .first_or_octet_stream()
                .to_string(),
            )],
            file.data.into_owned(),
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
