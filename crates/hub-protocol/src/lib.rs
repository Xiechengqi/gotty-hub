//! GoTTY Hub v1: authenticated device connection, bounded multiplexed terminal streams.
use serde::{Deserialize, Serialize};
pub const VERSION: u32 = 1;
pub const MAX_MESSAGE: usize = 1024 * 1024;
pub const QUEUE: usize = 128;
pub const MAX_STREAMS: usize = 64;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frame {
    pub kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub stream: String,
    #[serde(default)]
    pub data: serde_json::Value,
}
impl Frame {
    pub fn new(kind: &str, stream: &str, data: serde_json::Value) -> Self {
        Self {
            kind: kind.into(),
            stream: stream.into(),
            data,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn go_fixture() {
        let f: Frame =
            serde_json::from_str(r#"{"kind":"data","stream":"c1","data":"1aGVsbG8="}"#).unwrap();
        assert_eq!(f.data.as_str(), Some("1aGVsbG8="));
        assert_eq!(serde_json::to_value(&f).unwrap()["stream"], "c1");
    }
}
