//! Browser-only receiver page. Assets are embedded so LAN sharing needs no CDN.

use crate::lan_share::SharedImage;

pub fn render(token: &str, asset: Option<&SharedImage>) -> String {
    let mut page = include_str!("lan_share_page/page.html")
        .replace("{{styles}}", include_str!("lan_share_page/page.css"))
        .replace("{{script}}", include_str!("lan_share_page/page.js"))
        .replace("{{zh}}", include_str!("lan_share_page/zh-CN.json"))
        .replace("{{en}}", include_str!("lan_share_page/en.json"))
        .replace("{{ja}}", include_str!("lan_share_page/ja.json"));
    let (bytes, seconds, remaining, mime, filename) = match asset {
        Some(asset) => (
            asset.data.len(),
            asset.expires_in_seconds,
            asset.downloads_remaining.map_or(-1, i64::from),
            asset.mime,
            asset.filename.as_str(),
        ),
        None => (0, 0, 0, "", ""),
    };
    // Insert untrusted strings last, so template-like filenames stay literal.
    page = page
        .replace("{{bytes}}", &bytes.to_string())
        .replace("{{seconds}}", &seconds.to_string())
        .replace("{{remaining}}", &remaining.to_string())
        .replace("{{mime}}", &escape_html(mime))
        .replace("{{token}}", &escape_html(token));
    page.replace("{{filename}}", &escape_html(filename))
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn page_embeds_assets_and_escapes_filename_without_replacing_its_contents() {
        let asset = SharedImage {
            data: Arc::new(vec![1, 2, 3]),
            mime: "image/png",
            filename: "\"><script>alert(1)</script>{{script}}.png".into(),
            expires_in_seconds: 59,
            downloads_remaining: Some(1),
        };
        let html = render("safe_token", Some(&asset));
        assert!(html.contains("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;{{script}}.png"));
        assert!(!html.contains("\"><script>alert(1)"));
        assert!(html.contains("data-seconds=\"59\""));
        assert!(html.contains("data-remaining=\"1\""));
        assert!(html.contains("/s/safe_token/download"));
        assert!(!html.contains("{{styles}}"));
        assert!(!html.contains("{{zh}}"));
    }

    #[test]
    fn expired_page_contains_no_previous_image_metadata() {
        let html = render("old_token", None);
        assert!(html.contains("data-seconds=\"0\""));
        assert!(html.contains("data-filename=\"\""));
        assert!(html.contains("data-remaining=\"0\""));
    }
}
