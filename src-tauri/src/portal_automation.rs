pub const MAX_SCRIPT_BYTES: usize = 64 * 1024;
pub const MAX_PORTAL_RESPONSE_BYTES: usize = 1024 * 1024;

/// Generates safe JavaScript payload for `inspect` command (URL, Title, DOM summary & text preview).
pub fn build_inspect_js() -> String {
    r#"(function() {
    try {
        var text = (document.body ? document.body.innerText || "" : "").trim();
        if (text.length > 2000) {
            text = text.substring(0, 2000) + "...";
        }
        var links = Array.from(document.querySelectorAll("a[href]")).slice(0, 20).map(function(el) {
            return { text: el.innerText.trim(), href: el.getAttribute("href") };
        });
        var sensitiveMetadata = /(pass(word)?|token|secret|credential|auth(orization)?|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|session|cookie|csrf|refresh[-_ ]?token)/i;
        var inputs = Array.from(document.querySelectorAll("input, button, textarea, select")).slice(0, 20).map(function(el) {
            var type = (el.getAttribute("type") || "").toLowerCase();
            var metadata = [
                el.getAttribute("name") || "",
                el.id || "",
                el.getAttribute("autocomplete") || ""
            ].join(" ");
            var isSensitive = type === "password" || sensitiveMetadata.test(metadata);
            var item = {
                tag: el.tagName.toLowerCase(),
                type: type,
                id: el.id || "",
                name: el.getAttribute("name") || "",
                placeholder: el.getAttribute("placeholder") || "",
                valueRedacted: isSensitive
            };
            if (!isSensitive) item.value = el.value || "";
            return item;
        });
        return JSON.stringify({
            url: window.location.href,
            title: document.title,
            textSummary: text,
            interactiveCount: inputs.length,
            sampleInputs: inputs,
            sampleLinks: links
        });
    } catch(err) {
        return JSON.stringify({ error: String(err) });
    }
})()"#.to_string()
}

/// Generates safe JavaScript payload for `click` command using element selector.
pub fn build_click_js(selector: &str) -> Result<String, String> {
    if selector.trim().is_empty() {
        return Err("Selector cannot be empty".to_string());
    }
    let json_selector = serde_json::to_string(selector).map_err(|e| e.to_string())?;
    limit_script(format!(
        r#"(function() {{
    try {{
        var sel = {json_selector};
        var el = document.querySelector(sel);
        if (!el) {{
            return JSON.stringify({{ success: false, error: "Element not found for selector: " + sel }});
        }}
        el.click();
        return JSON.stringify({{ success: true, clicked: sel }});
    }} catch(err) {{
        return JSON.stringify({{ success: false, error: String(err) }});
    }}
}})()"#
    ))
}

/// Generates safe JavaScript payload for `fill` command using element selector and value.
pub fn build_fill_js(selector: &str, text: &str) -> Result<String, String> {
    if selector.trim().is_empty() {
        return Err("Selector cannot be empty".to_string());
    }
    let json_selector = serde_json::to_string(selector).map_err(|e| e.to_string())?;
    let json_text = serde_json::to_string(text).map_err(|e| e.to_string())?;
    limit_script(format!(
        r#"(function() {{
    try {{
        var sel = {json_selector};
        var val = {json_text};
        var el = document.querySelector(sel);
        if (!el) {{
            return JSON.stringify({{ success: false, error: "Element not found for selector: " + sel }});
        }}
        el.value = val;
        el.dispatchEvent(new Event('input', {{ bubbles: true }}));
        el.dispatchEvent(new Event('change', {{ bubbles: true }}));
        return JSON.stringify({{ success: true, filled: sel, valueLength: val.length }});
    }} catch(err) {{
        return JSON.stringify({{ success: false, error: String(err) }});
    }}
}})()"#
    ))
}

/// Generates safe JavaScript payload for arbitrary `eval` script.
pub fn build_eval_js(script: &str) -> Result<String, String> {
    if script.len() > MAX_SCRIPT_BYTES {
        return Err(format!(
            "Script size ({} bytes) exceeds maximum limit of {} bytes",
            script.len(),
            MAX_SCRIPT_BYTES
        ));
    }
    let json_script = serde_json::to_string(script).map_err(|e| e.to_string())?;
    limit_script(format!(
        r#"(function() {{
    try {{
        var res = eval({json_script});
        if (res === undefined) return JSON.stringify({{ result: null }});
        if (typeof res === 'object') return JSON.stringify({{ result: res }});
        return JSON.stringify({{ result: String(res) }});
    }} catch(err) {{
        return JSON.stringify({{ error: String(err) }});
    }}
}})()"#
    ))
}

fn limit_script(script: String) -> Result<String, String> {
    if script.as_bytes().len() > MAX_SCRIPT_BYTES {
        return Err(format!(
            "Script size ({} bytes) exceeds maximum limit of {} bytes",
            script.len(),
            MAX_SCRIPT_BYTES
        ));
    }
    Ok(script)
}

/// Truncates/limits the output payload to prevent IPC memory issues.
pub fn limit_response_body(body: String) -> String {
    if body.len() > MAX_PORTAL_RESPONSE_BYTES {
        let mut end = MAX_PORTAL_RESPONSE_BYTES;
        while end > 0 && !body.is_char_boundary(end) {
            end -= 1;
        }
        format!(
            "{}\n[Truncated: Response exceeded 1 MiB limit]",
            &body[..end]
        )
    } else {
        body
    }
}

#[cfg(test)]
mod automation_tests {
    use super::*;

    #[test]
    fn test_click_js_sanitizes_selector() {
        let js = build_click_js("button#submit").unwrap();
        assert!(js.contains("\"button#submit\""));
        assert!(build_click_js("").is_err());
    }

    #[test]
    fn test_fill_js_sanitizes_input_value() {
        let js = build_fill_js("input[name=\"user\"]", "hello \"world\"").unwrap();
        assert!(js.contains("hello \\\"world\\\""));
        assert!(js.contains("valueLength: val.length"));
        assert!(!js.contains("value: val"));
        assert!(build_fill_js("  ", "val").is_err());
    }

    #[test]
    fn inspect_redacts_password_and_sensitive_metadata_values() {
        let js = build_inspect_js();
        assert!(js.contains("type === \"password\""));
        assert!(js.contains("autocomplete"));
        assert!(js.contains("sensitiveMetadata"));
        assert!(js.contains("valueRedacted: isSensitive"));
        assert!(!js.contains("value: el.value || \"\""));
    }

    #[test]
    fn click_and_fill_arguments_are_json_literals_not_script_fragments() {
        let selector = r#"input[data-x='\');alert(1);//']"#;
        let value = "line 1\n\"quoted\"";
        let click = build_click_js(selector).unwrap();
        let fill = build_fill_js(selector, value).unwrap();
        assert!(click.contains(&serde_json::to_string(selector).unwrap()));
        assert!(fill.contains(&serde_json::to_string(value).unwrap()));
        assert!(!fill.contains("alert(1);//'\";"));
    }

    #[test]
    fn test_eval_js_limits_script_size() {
        let oversized = "a".repeat(MAX_SCRIPT_BYTES + 1);
        assert!(build_eval_js(&oversized).is_err());

        let valid = build_eval_js("document.title").unwrap();
        assert!(valid.contains("document.title"));
    }

    #[test]
    fn response_limit_does_not_panic_on_multibyte_boundary() {
        let body = "á".repeat(MAX_PORTAL_RESPONSE_BYTES);
        let limited = limit_response_body(body);
        assert!(limited.ends_with("[Truncated: Response exceeded 1 MiB limit]"));
        assert!(limited.len() <= MAX_PORTAL_RESPONSE_BYTES + 64);
    }
}
