"""Server-side cleaning of the HTML the widget shows: AI replies and FAQ answers.

The widget and dashboard sanitise again in the browser (DOMPurify); this is the server's own guarantee, so what
is stored and sent never carries script, and an AI reply can only link to the setting's approved links,
however the model was talked into writing something else (prompt injection).
"""
import re
import nh3

TAGS = {"a", "br", "strong", "b", "em", "i", "del", "s", "ul", "ol", "li", "p"}
ATTRIBUTES = {"a": {"href", "class", "target"}}
URL_SCHEMES = {"https", "mailto", "tel"}
BUTTON_CLASS = "action-btn"

# A link left without an href (it pointed somewhere not allowed) becomes its plain text.
# nh3's output is normalised, and such a link can only still carry these three attributes.
_HREFLESS_LINK = re.compile(r'<a(?:\s+(?:class|target|rel)="[^"]*")*\s*>(.*?)</a>', re.DOTALL)

def _normalise_url(url):
    return url.strip().rstrip("/")

def _attribute_filter(allowed_hrefs):
    def keep(tag, attr, value):
        if tag == "a" and attr == "href":
            return value if allowed_hrefs is None or _normalise_url(value) in allowed_hrefs else None
        if attr == "class":
            return BUTTON_CLASS if tag == "a" and BUTTON_CLASS in value.split() else None
        if attr == "target":
            return "_blank"
        return value
    return keep

def _clean(html_text, allowed_hrefs):
    # url_relative="deny" also removes scheme-less "//evil.example" links, which would otherwise pass
    cleaned = nh3.clean(html_text or "", tags=TAGS, attributes=ATTRIBUTES, url_schemes=URL_SCHEMES,
                        url_relative="deny", attribute_filter=_attribute_filter(allowed_hrefs),
                        link_rel="noopener noreferrer")
    return _HREFLESS_LINK.sub(r"\1", cleaned)

def clean_reply(text, approved_links):
    """An AI reply: allowed formatting only, and links only to the approved links' exact addresses."""
    allowed = {_normalise_url(link["url"]) for link in approved_links or [] if link.get("url")}
    return _clean(text, allowed)

def clean_faq_answer(text):
    """An FAQ answer written on the dashboard: allowed formatting, any https/mailto/tel link."""
    return _clean(text, None)
