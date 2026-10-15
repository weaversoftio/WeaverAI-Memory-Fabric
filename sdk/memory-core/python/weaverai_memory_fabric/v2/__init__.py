"""WeaverAI Memory Fabric v2 Python SDK (existing data-plane + management-plane APIs, paths under /v2).

Explicit v2 entry point; the top-level `from weaverai_memory_fabric import MemoryClient` still points here,
so existing code keeps working with zero changes after upgrading the SDK.
"""

from .client import AsyncMemoryClient, MemoryClient

__all__ = ["MemoryClient", "AsyncMemoryClient"]
