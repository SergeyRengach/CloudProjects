//! Markdown extras: `[[wikilinks]]`, `#tags`, front matter. Code spans/blocks are ignored.

use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ParsedLink {
    pub target: String,
    pub heading: Option<String>,
    pub alias: Option<String>,
    /// Byte span of the whole `[[...]]` in the body.
    pub start: usize,
    pub end: usize,
}

impl ParsedLink {
    pub fn render(&self, target: &str) -> String {
        let mut s = format!("[[{target}");
        if let Some(h) = &self.heading {
            s.push('#');
            s.push_str(h);
        }
        if let Some(a) = &self.alias {
            s.push('|');
            s.push_str(a);
        }
        s.push_str("]]");
        s
    }
}

/// Per-byte mask: true where the byte lies inside a fenced block or inline code.
fn code_mask(s: &str) -> Vec<bool> {
    let mut m = vec![false; s.len()];
    let mut in_fence = false;
    let mut off = 0;
    for line in s.split_inclusive('\n') {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
            m[off..off + line.len()].fill(true);
        } else if in_fence {
            m[off..off + line.len()].fill(true);
        } else {
            let mut open = false;
            for (i, b) in line.bytes().enumerate() {
                if b == b'`' {
                    open = !open;
                    m[off + i] = true;
                } else if open {
                    m[off + i] = true;
                }
            }
        }
        off += line.len();
    }
    m
}

pub fn parse_links(body: &str) -> Vec<ParsedLink> {
    let mask = code_mask(body);
    let bytes = body.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' && !mask[i] {
            if let Some(rel) = body[i + 2..].find("]]") {
                let inner = &body[i + 2..i + 2 + rel];
                if !inner.contains('\n') && !inner.contains("[[") {
                    let (left, alias) = match inner.split_once('|') {
                        Some((l, a)) => (l, Some(a.trim().to_string()).filter(|a| !a.is_empty())),
                        None => (inner, None),
                    };
                    let (target, heading) = match left.split_once('#') {
                        Some((t, h)) => (t, Some(h.trim().to_string()).filter(|h| !h.is_empty())),
                        None => (left, None),
                    };
                    let target = target.trim();
                    let end = i + 2 + rel + 2;
                    if !target.is_empty() {
                        out.push(ParsedLink {
                            target: target.to_string(),
                            heading,
                            alias,
                            start: i,
                            end,
                        });
                    }
                    i = end;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

pub fn parse_tags(body: &str) -> Vec<String> {
    let mask = code_mask(body);
    let mut out: Vec<String> = Vec::new();
    let mut prev: Option<char> = None;
    let mut iter = body.char_indices().peekable();
    while let Some((i, c)) = iter.next() {
        if c == '#' && !mask[i] && prev.is_none_or(|p| p.is_whitespace()) {
            let mut tag = String::new();
            while let Some(&(_, n)) = iter.peek() {
                if n.is_alphanumeric() || n == '_' || n == '-' || n == '/' {
                    tag.push(n);
                    iter.next();
                } else {
                    break;
                }
            }
            let tag = tag.trim_end_matches('/').to_lowercase();
            if tag.chars().any(|c| c.is_alphabetic()) && !out.contains(&tag) {
                out.push(tag);
            }
            prev = Some('a');
            continue;
        }
        prev = Some(c);
    }
    out
}

/// Returns the body without a leading `---` front matter block.
pub fn strip_front_matter(body: &str) -> &str {
    if let Some(rest) = body.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            let after = &rest[end + 4..];
            return after.strip_prefix('\n').unwrap_or(after);
        }
    }
    body
}

pub fn normalize_path(p: &str) -> String {
    let p = p.trim().trim_matches('/');
    let p = p.strip_suffix(".md").unwrap_or(p);
    p.split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

pub fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Heading {
    pub level: u8,
    pub text: String,
    /// 1-based line number in the full body (front matter included).
    pub line: u32,
}

/// ATX headings (`# ..`) outside code fences and front matter.
pub fn parse_outline(body: &str) -> Vec<Heading> {
    let skip = body.len() - strip_front_matter(body).len();
    let mut out = Vec::new();
    let (mut in_fence, mut off) = (false, 0usize);
    for (i, line) in body.split('\n').enumerate() {
        let start = off;
        off += line.len() + 1;
        if start < skip {
            continue;
        }
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || !line.starts_with('#') {
            continue;
        }
        let level = line.bytes().take_while(|&b| b == b'#').count();
        let rest = &line[level..];
        if level <= 6 && (rest.is_empty() || rest.starts_with(' ')) {
            let text = rest.trim().trim_end_matches('#').trim().to_string();
            if !text.is_empty() {
                out.push(Heading {
                    level: level as u8,
                    text,
                    line: i as u32 + 1,
                });
            }
        }
    }
    out
}

pub fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_basic() {
        let l = parse_links("see [[Note A]] and [[folder/B#Head|alias]].");
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].target, "Note A");
        assert_eq!(l[1].target, "folder/B");
        assert_eq!(l[1].heading.as_deref(), Some("Head"));
        assert_eq!(l[1].alias.as_deref(), Some("alias"));
    }

    #[test]
    fn links_ignore_code_and_garbage() {
        let l = parse_links("`[[x]]`\n```\n[[y]]\n```\n[[ ]] [[a\nb]] [[ok]]");
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].target, "ok");
    }

    #[test]
    fn links_cyrillic_spans() {
        let body = "Привіт [[Ідея]] світ";
        let l = parse_links(body);
        assert_eq!(&body[l[0].start..l[0].end], "[[Ідея]]");
    }

    #[test]
    fn tags() {
        let t =
            parse_tags("# Title\n#idea and #Проєкт/Дім, not#this #123 `#code`\n```\n#fence\n```");
        assert_eq!(t, vec!["idea", "проєкт/дім"]);
    }

    #[test]
    fn front_matter() {
        assert_eq!(strip_front_matter("---\na: 1\n---\nbody"), "body");
        assert_eq!(strip_front_matter("no fm"), "no fm");
    }

    #[test]
    fn outline() {
        let o =
            parse_outline("---\n# fm\n---\n# A\ntext\n```\n# no\n```\n### B ##\n#tag\n####### x");
        assert_eq!(
            o,
            vec![
                Heading {
                    level: 1,
                    text: "A".into(),
                    line: 4
                },
                Heading {
                    level: 3,
                    text: "B".into(),
                    line: 9
                }
            ]
        );
    }

    #[test]
    fn paths() {
        assert_eq!(normalize_path(" /A/ b.md "), "A/b");
        assert_eq!(basename("A/b"), "b");
    }
}
