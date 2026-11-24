"""In-memory sliding-window counters for rate limits, with memory that stays bounded.

Fine for the single server process run.sh starts; move to Postgres/Redis if the app is ever scaled out.
"""
import ipaddress
import threading
import time
from collections import deque

SWEEP_EVERY = 1000  # Calls between clean-ups of keys that have gone quiet

def visitor_key(ip):
    """What a limit counts per visitor: the IPv4 address, or the /64 network for IPv6.

    One IPv6 connection usually owns a whole /64 (2^64 addresses), so counting single addresses would let
    anyone rotate through them and never hit a limit.
    """
    try:
        address = ipaddress.ip_address(ip or "")
    except ValueError:
        return ip or "unknown"
    if address.version == 6:
        if address.ipv4_mapped:
            return str(address.ipv4_mapped)
        return str(ipaddress.ip_network(f"{address}/64", strict=False))
    return str(address)

class SlidingWindow:
    """Timestamps of recent events per key, forgotten after `window_seconds`."""

    def __init__(self, window_seconds):
        self.window = window_seconds
        self._events = {}  # key -> deque of monotonic times, oldest first
        self._lock = threading.Lock()
        self._calls = 0

    def _sweep(self, now):
        stale = [key for key, times in self._events.items() if not times or now - times[-1] > self.window]
        for key in stale:
            del self._events[key]

    def _recent(self, key, now):
        times = self._events.get(key)
        if times is None:
            return None
        while times and now - times[0] > self.window:
            times.popleft()
        if not times:
            del self._events[key]
            return None
        return times

    def count(self, key, within=None):
        """Events for `key` in the last `within` seconds (default: the whole window)."""
        now = time.monotonic()
        with self._lock:
            self._calls += 1
            if self._calls % SWEEP_EVERY == 0:
                self._sweep(now)
            times = self._recent(key, now)
            if not times:
                return 0
            if within is None or within >= self.window:
                return len(times)
            return sum(1 for t in times if now - t < within)

    def add(self, key):
        with self._lock:
            self._events.setdefault(key, deque()).append(time.monotonic())

    def clear(self, key):
        with self._lock:
            self._events.pop(key, None)
