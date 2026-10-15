"""WeaverAI Memory Fabric v3 Python SDK -- strict-isolation data-plane client.

Construction requires the team_id / agent_id / user_id / session_id four-tuple;
paths go under ``/v3/...``. See the ``v3.client.MemoryClient`` docstring for details.

The management-plane clients :class:`MetadataClient` / :class:`AsyncMetadataClient` do not need the isolation
four-tuple; they wrap the public ``/v3/meta/*`` interface (54 entries, aligned with Panel ``META_ACTIONS``) and
the ``/v3/knowledge/*`` Knowledge CRUD; see ``v3.metadata_client``.

The Skill clients :class:`SkillClient` / :class:`AsyncSkillClient` wrap the 14
``/v3/skill/*`` interfaces -- the skill isolation fields are all optional at the server schema level,
so pass defaults at construction as needed; when missing, the server returns a business error code (40001/40301/40302).
"""

from .client import AsyncMemoryClient, MemoryClient
from .metadata_client import AsyncMetadataClient, MetadataClient
from .memory_prompt import AsyncMemoryPromptClient, MemoryPromptClient
from .memory_generation_log import AsyncMemoryGenerationLogClient, MemoryGenerationLogClient
from .skill_client import (
    SKILL_ERROR_CODE,
    AsyncSkillClient,
    SkillClient,
    encode_base64,
    encode_utf8,
)

__all__ = [
    "MemoryClient",
    "AsyncMemoryClient",
    "MetadataClient",
    "AsyncMetadataClient",
    "MemoryPromptClient",
    "AsyncMemoryPromptClient",
    "MemoryGenerationLogClient",
    "AsyncMemoryGenerationLogClient",
    "SkillClient",
    "AsyncSkillClient",
    "SKILL_ERROR_CODE",
    "encode_utf8",
    "encode_base64",
]
