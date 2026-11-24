"""Cleans visitor and manager text of invisible control characters before it is stored.

Removed: control characters (line breaks too, in single-line fields) and the bidi override/isolate
characters that can make text display differently from what it is ("Trojan Source" style spoofing).
Kept on purpose: zero-width joiners and left/right marks, which Arabic and Persian text and emoji need.
"""
import re

# U+202A-U+202E embeddings/overrides, U+2066-U+2069 isolates
_BIDI_CONTROLS = re.compile("[\u202a-\u202e\u2066-\u2069]")
# C0/C1 controls (incl. CR, LF, TAB, DEL) and the Unicode line/paragraph separators
_LINE_BREAKERS = re.compile("[\x00-\x1f\x7f-\x9f\u2028\u2029]")
_CONTROLS_EXCEPT_NEWLINE_TAB = re.compile("[\x00-\x08\x0b-\x1f\x7f-\x9f]")

def clean_line(text):
    """For one-line fields (names, titles): no line breaks or controls, outer spaces trimmed."""
    text = _BIDI_CONTROLS.sub("", text or "")
    return re.sub(r" {2,}", " ", _LINE_BREAKERS.sub(" ", text)).strip()

def clean_multiline(text):
    """For free text (messages, notes): keeps line breaks and tabs, drops other controls."""
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n").replace("\u2028", "\n").replace("\u2029", "\n")
    return _CONTROLS_EXCEPT_NEWLINE_TAB.sub("", _BIDI_CONTROLS.sub("", text)).strip()

def non_empty(cleaner):
    """A validator (pydantic AfterValidator / field_validator body) that cleans and then requires some text."""
    def validate(text):
        text = cleaner(text)
        if not text:
            raise ValueError("Enter some text")
        return text
    return validate

def optional(cleaner):
    """A validator that cleans text and allows it to be empty (None stays None)."""
    def validate(text):
        return None if text is None else cleaner(text)
    return validate
