"""Reference documentation index (IfcOpenShell API, IFC schema).

A *separate* ``DocumentIndexService`` collection (its own index dir) holding
reference material the LLM consults before writing IfcOpenShell code or picking
IFC entities - kept apart from the user's uploaded documents. Populated by
``scripts/fetch_reference_docs.py`` (plan E2) and queried through the ``get_docs``
tool (plan E3). See ``dev/docs/AI_BIM_EDITOR_MASTER_PLAN.md`` Workstream E.

The IfcOpenShell API docs are indexed from the *installed* package's docstrings
(version-matched by construction, no network/git needed), aggregated one document
per API domain to stay under ``DocumentIndexService.MAX_DOCS`` and to keep the
per-add index rebuild count low.
"""

from __future__ import annotations

import importlib
import inspect
import logging
import pkgutil
from pathlib import Path
from typing import Any, Optional

from app.core.config import DATA_DIR
from app.services.document_index_service import DocumentIndexService

logger = logging.getLogger(__name__)

_REFERENCE_INDEX_DIR = DATA_DIR / "reference_index"


class ReferenceDocsService:
    """Wraps a dedicated DocumentIndexService for reference docs."""

    def __init__(self, index_dir: Optional[Path] = None) -> None:
        self._index = DocumentIndexService(index_dir=index_dir or _REFERENCE_INDEX_DIR)

    def status(self) -> dict[str, Any]:
        docs = self._index.list_docs()
        return {
            "indexed": len(docs) > 0,
            "doc_count": len(docs),
            "documents": [d.get("name") for d in docs],
            "semantic": self._index.semantic_status(),
        }

    def search(self, query: str, *, top_k: int = 5) -> list[dict]:
        if not query.strip():
            return []
        return self._index.search(query, top_k=top_k)

    def clear(self) -> int:
        """Remove all reference docs (used to make re-fetch idempotent)."""
        docs = self._index.list_docs()
        removed = 0
        for d in docs:
            doc_id = d.get("doc_id")
            if doc_id and self._index.delete_doc(doc_id):
                removed += 1
        return removed

    # ------------------------------------------------------------------
    # Indexing sources
    # ------------------------------------------------------------------

    def index_ifcopenshell_api(self) -> dict[str, Any]:
        """Index the installed ``ifcopenshell.api`` package docstrings, grouped
        one document per top-level API domain (wall, geometry, pset, ...)."""
        try:
            import ifcopenshell
            import ifcopenshell.api
        except Exception as exc:  # pragma: no cover - env without ifcopenshell
            return {"ok": False, "error": f"ifcopenshell not importable: {exc}", "indexed": 0}

        api_path = getattr(ifcopenshell.api, "__path__", None)
        if not api_path:
            return {"ok": False, "error": "ifcopenshell.api is not a package", "indexed": 0}

        self.clear()  # idempotent re-fetch

        version = str(getattr(ifcopenshell, "version", "unknown"))
        domains: dict[str, list[str]] = {}
        for modinfo in pkgutil.walk_packages(
            api_path, prefix="ifcopenshell.api.", onerror=lambda _n: None
        ):
            full = modinfo.name
            parts = full.split(".")
            domain = parts[2] if len(parts) > 2 else full  # component after "api"
            try:
                mod = importlib.import_module(full)
            except Exception:
                continue
            blob = self._module_doc_text(mod, full)
            if blob.strip():
                domains.setdefault(domain, []).append(blob)

        indexed, errors = 0, 0
        for domain, blobs in sorted(domains.items()):
            text = f"# IfcOpenShell API - {domain} (v{version})\n\n" + "\n\n".join(blobs)
            try:
                self._index.index_document(f"ifcopenshell.api.{domain}", text.encode("utf-8"))
                indexed += 1
            except Exception as exc:
                logger.warning("reference index failed for %s: %s", domain, exc)
                errors += 1

        return {
            "ok": True,
            "indexed": indexed,
            "errors": errors,
            "domains": sorted(domains.keys()),
            "ifcopenshell_version": version,
            "source": "ifcopenshell.api",
        }

    @staticmethod
    def _module_doc_text(mod: Any, name: str) -> str:
        """Collect a module's docstring + its public functions' signatures and
        docstrings into one searchable text blob."""
        parts: list[str] = [f"# {name}"]
        if getattr(mod, "__doc__", None):
            parts.append(mod.__doc__.strip())
        for attr_name in dir(mod):
            if attr_name.startswith("_"):
                continue
            try:
                obj = getattr(mod, attr_name)
            except Exception:
                continue
            # Only functions defined in this module (skip re-exported imports).
            if not inspect.isfunction(obj):
                continue
            if getattr(obj, "__module__", None) != name:
                continue
            doc = inspect.getdoc(obj)
            if not doc:
                continue
            try:
                sig = str(inspect.signature(obj))
            except (ValueError, TypeError):
                sig = "(...)"
            parts.append(f"## {name}.{attr_name}{sig}\n{doc}")
        return "\n\n".join(parts)


# Global singleton, mirrors document_index_service.
reference_docs_service = ReferenceDocsService()
