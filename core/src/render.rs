//! Markdown -> HTML with wikilinks. Raw HTML in notes is escaped (never injected).

use crate::parse::{parse_links, strip_front_matter};
use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag};

fn pct(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

pub fn render_html(body: &str) -> String {
    let body = strip_front_matter(body);
    let off = 0;
    let mut src = body.to_string();
    for l in parse_links(body).iter().rev() {
        let label = l.alias.clone().unwrap_or_else(|| match &l.heading {
            Some(h) => format!("{} › {}", l.target, h),
            None => l.target.clone(),
        });
        let label = label.replace('[', "\\[").replace(']', "\\]");
        src.replace_range(
            l.start + off..l.end + off,
            &format!("[{label}](wikilink:{})", pct(&l.target)),
        );
    }
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let events = Parser::new_ext(&src, opts).map(|e| match e {
        Event::Html(h) | Event::InlineHtml(h) => Event::Text(h),
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) => {
            let ok = ["http://", "https://", "mailto:", "wikilink:", "#"]
                .iter()
                .any(|p| dest_url.starts_with(p));
            let dest_url = if ok { dest_url } else { CowStr::Borrowed("#") };
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                title,
                id,
            })
        }
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => {
            let ok = dest_url.starts_with("https://") || dest_url.starts_with("data:image/");
            let dest_url = if ok { dest_url } else { CowStr::Borrowed("") };
            Event::Start(Tag::Image {
                link_type,
                dest_url,
                title,
                id,
            })
        }
        e => e,
    });
    let mut out = String::new();
    html::push_html(&mut out, events);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wikilinks_become_links() {
        let h = render_html("Hi [[Моя нотатка|alias]]!");
        assert!(h.contains("href=\"wikilink:%D0%9C"), "{h}");
        assert!(h.contains(">alias</a>"));
    }

    #[test]
    fn html_is_escaped_and_js_links_blocked() {
        let h = render_html("<script>alert(1)</script> [x](javascript:alert(1))");
        assert!(!h.contains("<script>"), "{h}");
        assert!(!h.to_lowercase().contains("href=\"javascript"));
        let h = render_html("[a](data:text/html,x) [b](vbscript:x)");
        assert!(
            !h.contains("href=\"data:") && !h.contains("href=\"vbscript"),
            "{h}"
        );
    }

    #[test]
    fn tasks_and_front_matter() {
        let h = render_html("---\na: b\n---\n- [x] done\n- [ ] todo");
        assert!(h.contains("checked"));
        assert!(!h.contains("a: b"));
    }
}
