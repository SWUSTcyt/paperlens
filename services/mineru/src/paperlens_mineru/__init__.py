"""PaperLens 本地 MinerU 服务。"""

from importlib.metadata import version as package_version

from .contracts import CONTRACT_SCHEMA_VERSION

__all__ = ["CONTRACT_SCHEMA_VERSION", "__version__"]
__version__ = package_version("paperlens-mineru")
