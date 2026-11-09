"""wiek-browser-benchmark-framework: browser-agent evaluation pipeline (pi-coding-agent).

Layering: core holds pure value types and
contracts; engine (Stage A), judge (Stage B) and report (Stage C) depend only on
core. The single source of truth for derived metrics is the provider session JSONL.
"""

__all__ = ["__version__"]

__version__ = "0.1.0b1"
