"""WeaverAI Memory Fabric Python SDK.

Version layout (v2 default exports with optional v3 sub-module, similar to common cloud SDK patterns):

- The default exports `MemoryClient` / `AsyncMemoryClient` point to v2 -- existing code keeps working with zero changes after upgrading the SDK.
- Explicitly `from weaverai_memory_fabric.v3 import MemoryClient` to switch to the v3
  strict-isolation version (team/agent/user/session are all required at construction, paths under /v3).

>>> # Existing code
>>> from weaverai_memory_fabric import MemoryClient
>>> client = MemoryClient(endpoint, api_key, service_id="...")
>>> client.add_conversation(session_id="s1", messages=[...])

>>> # New code (strict isolation)
>>> from weaverai_memory_fabric.v3 import MemoryClient
>>> client = MemoryClient(endpoint, api_key, service_id="...",
...                       team_id="t1", agent_id="a1", user_id="u1")
>>> client.add_conversation(session_id="s1", messages=[...])
"""

from .errors import ParamError, WAMFError
from .v2 import AsyncMemoryClient, MemoryClient

__all__ = ["MemoryClient", "AsyncMemoryClient", "WAMFError", "ParamError"]
