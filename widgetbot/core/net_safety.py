"""Keeps the crawler (a real browser running on our server) away from internal addresses (SSRF protection).

A web address is only crawlable when EVERY address its host name resolves to is a public internet address.
Resolving is what catches the tricks a text check misses: "127.1", "2130706433", "0x7f000001", "localhost.",
and DNS names that point at 127.0.0.1, the LAN or the cloud metadata service (169.254.169.254).

This check is one layer only. Redirects and DNS that changes between check and fetch are stopped by the
egress proxy the crawler runs behind (CRAWLER_PROXY_URL, see "Crawler proxy" in README.md).
"""
import asyncio
import ipaddress
import re
import socket
from urllib.parse import urlsplit

# A website origin as browsers send it: scheme + host (+ port), nothing else. Safe to put in a CSP header.
ORIGIN_PATTERN = re.compile(r"https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?")

def is_https_url(url):
    """An absolute https address with a host name (for links the widget shows)."""
    try:
        parts = urlsplit(url or "")
    except ValueError:
        return False
    return parts.scheme == "https" and bool(parts.hostname) and not any(ch.isspace() for ch in url)

class UnsafeURL(ValueError):
    """The message is safe to show to the dashboard user."""

_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home.arpa")

def is_public_ip(address):
    """True only for globally routable unicast addresses, including what IPv6 forms embed."""
    try:
        ip = ipaddress.ip_address(str(address).split("%", 1)[0])  # Drop an IPv6 zone id ("fe80::1%eth0")
    except ValueError:
        return False
    if ip.version == 6:
        embedded = ip.ipv4_mapped or ip.sixtofour or (ip.teredo[1] if ip.teredo else None)
        if embedded is None and ip in _NAT64:
            embedded = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
        if embedded is not None and not is_public_ip(embedded):
            return False
    return ip.is_global and not ip.is_multicast

def _split(raw):
    """Returns (url, host, port) for an http(s) address, or raises UnsafeURL."""
    url = (raw or "").strip()
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise UnsafeURL("Enter a full web address starting with https://")
    if parts.username is not None or parts.password is not None:
        raise UnsafeURL("Web addresses with a username or password can't be crawled")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        raise UnsafeURL("That web address has an invalid port")
    host = parts.hostname.rstrip(".")
    if not host or host == "localhost" or host.endswith(_BLOCKED_SUFFIXES):
        raise UnsafeURL("Local addresses can't be crawled")
    return url, host, port

def _check_addresses(infos):
    addresses = {info[4][0] for info in infos}
    if not addresses or not all(is_public_ip(a) for a in addresses):
        raise UnsafeURL("Private network addresses can't be crawled")

def check_public_url(raw):
    """Returns the cleaned URL, or raises UnsafeURL. Blocking (does a DNS lookup)."""
    url, host, port = _split(raw)
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError):
        raise UnsafeURL("That web address couldn't be found")
    _check_addresses(infos)
    return url

async def is_public_url(raw, cache=None):
    """Non-raising async version for the crawler's request filter. `cache` maps (host, port) -> bool."""
    try:
        _, host, port = _split(raw)
    except UnsafeURL:
        return False
    key = (host, port)
    if cache is not None and key in cache:
        return cache[key]
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
        _check_addresses(infos)
        ok = True
    except (OSError, UnicodeError, UnsafeURL):
        ok = False
    if cache is not None:
        cache[key] = ok
    return ok
