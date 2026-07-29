"""Tests for the unified knowledge tool (get_docs, incl. its bSDD search /
class-detail routing), the async->sync bridge, and the reference-docs service.

Fast lane: no network (bSDD is mocked), no IFC model load. The one test that
indexes the real ifcopenshell.api package is marked requires_ifc_load (slow +
IfcOpenShell-heavy), so it runs only in the full lane.
"""

import pytest

from app.services.tools import _execute_tool_raw, _run_coro_sync, tool_tier


# ──────────────────────────────────────────────────────────────────────
# Async bridge + tiering
# ──────────────────────────────────────────────────────────────────────


def test_async_bridge_runs_coroutine():
    async def _demo():
        return {"v": 7}

    assert _run_coro_sync(_demo()) == {"v": 7}


def test_knowledge_tool_is_read_knowledge_tier():
    assert tool_tier("get_docs")[0] == "read_knowledge"


# ──────────────────────────────────────────────────────────────────────
# bSDD tool dispatch - works with NO model loaded (gate exemption), async bridged
# ──────────────────────────────────────────────────────────────────────


class TestBsddToolDispatch:
    def test_bsdd_search_dispatches_and_bridges(self, monkeypatch):
        import app.services.bsdd_service as bsdd

        async def fake_search(text, *, dictionary_uri=None, type_filter="All", limit=20):
            return {"query": text, "count": 1,
                    "results": [{"uri": "u", "name": "Wall", "type": "class", "dictionary": "IFC"}]}

        monkeypatch.setattr(bsdd, "search", fake_search)
        res = _execute_tool_raw("get_docs", {"source": "bsdd", "query": "wall"})
        assert res["count"] == 1
        assert res["results"][0]["name"] == "Wall"

    def test_bsdd_search_empty_query_error(self):
        res = _execute_tool_raw("get_docs", {"source": "bsdd", "query": "   "})
        assert "error" in res

    def test_bsdd_uri_fetches_class_detail(self, monkeypatch):
        import app.services.bsdd_service as bsdd

        async def fake_get_class(uri):
            return {"uri": uri, "name": "IfcWall"}

        monkeypatch.setattr(bsdd, "get_class", fake_get_class)
        res = _execute_tool_raw(
            "get_docs",
            {"source": "bsdd", "uri": "https://identifier.buildingsmart.org/uri/x"},
        )
        assert res["detail"] == "class"
        assert res["result"]["name"] == "IfcWall"

    def test_bsdd_without_query_or_uri_errors(self):
        assert "error" in _execute_tool_raw("get_docs", {"source": "bsdd"})

    def test_bsdd_uri_detail_properties_dispatches(self, monkeypatch):
        import app.services.bsdd_service as bsdd

        async def fake(uri):
            return {"class_uri": uri, "count": 2, "properties": [{}, {}]}

        monkeypatch.setattr(bsdd, "get_class_properties", fake)
        res = _execute_tool_raw(
            "get_docs", {"source": "bsdd", "uri": "u", "detail": "properties"}
        )
        assert res["detail"] == "properties"
        assert res["result"]["count"] == 2


# ──────────────────────────────────────────────────────────────────────
# get_docs router
# ──────────────────────────────────────────────────────────────────────


class TestGetDocsRouting:
    def test_bsdd_source(self, monkeypatch):
        import app.services.bsdd_service as bsdd

        async def fake_search(text, *, dictionary_uri=None, type_filter="All", limit=20):
            return {"query": text, "count": 1, "results": [{"uri": "u", "name": "X"}]}

        monkeypatch.setattr(bsdd, "search", fake_search)
        res = _execute_tool_raw("get_docs", {"source": "bsdd", "query": "wall"})
        assert res["source"] == "bsdd" and res["count"] == 1

    def test_bsdd_source_symbol_uri_fetches_class(self, monkeypatch):
        import app.services.bsdd_service as bsdd

        async def fake_get_class(uri):
            return {"uri": uri, "name": "IfcWall"}

        monkeypatch.setattr(bsdd, "get_class", fake_get_class)
        res = _execute_tool_raw(
            "get_docs",
            {"source": "bsdd", "query": "", "symbol": "https://identifier.buildingsmart.org/uri/x"},
        )
        assert res["result"]["name"] == "IfcWall"

    def test_user_source(self, monkeypatch):
        import app.services.document_index_service as dis

        monkeypatch.setattr(
            dis.document_index_service, "search",
            lambda q, top_k=5: [{"text": "hi", "source": "spec.pdf"}],
        )
        res = _execute_tool_raw("get_docs", {"source": "user", "query": "fire rating"})
        assert res["source"] == "user" and res["result_count"] == 1

    def test_ifcopenshell_not_indexed(self, monkeypatch):
        import app.services.document_index_service as rds

        monkeypatch.setattr(rds.reference_docs_service, "status", lambda: {"indexed": False})
        res = _execute_tool_raw("get_docs", {"source": "ifcopenshell", "query": "wall"})
        assert res.get("error") == "not_indexed"
        assert "fetch_reference_docs" in res.get("hint", "")

    def test_ifcopenshell_indexed(self, monkeypatch):
        import app.services.document_index_service as rds

        monkeypatch.setattr(rds.reference_docs_service, "status", lambda: {"indexed": True})
        monkeypatch.setattr(
            rds.reference_docs_service, "search",
            lambda q, top_k=5: [{"text": "add_wall", "source": "ifcopenshell.api.wall"}],
        )
        res = _execute_tool_raw(
            "get_docs",
            {"source": "ifcopenshell", "query": "wall", "symbol": "ifcopenshell.api.wall.add_wall"},
        )
        assert res["result_count"] == 1

    def test_unknown_source(self):
        assert "error" in _execute_tool_raw("get_docs", {"source": "wikipedia", "query": "x"})

    def test_requires_query_or_symbol(self):
        assert "error" in _execute_tool_raw("get_docs", {"source": "user"})


# ──────────────────────────────────────────────────────────────────────
# Reference docs service
# ──────────────────────────────────────────────────────────────────────


class TestReferenceDocsService:
    def test_index_search_status_clear(self, tmp_path):
        from app.services.document_index_service import ReferenceDocsService

        svc = ReferenceDocsService(index_dir=tmp_path / "ref")
        assert svc.status()["indexed"] is False
        svc._index.index_document(
            "ifcopenshell.api.wall", b"add_wall creates an IfcWall element in the model"
        )
        assert svc.status()["indexed"] is True
        assert isinstance(svc.search("wall"), list)
        assert svc.clear() >= 1
        assert svc.status()["indexed"] is False

    def test_search_empty_query_returns_empty(self, tmp_path):
        from app.services.document_index_service import ReferenceDocsService

        svc = ReferenceDocsService(index_dir=tmp_path / "ref2")
        assert svc.search("   ") == []

    @pytest.mark.requires_ifc_load
    def test_index_ifcopenshell_api_populates(self, tmp_path):
        """Slow: imports + walks the real ifcopenshell.api package."""
        from app.services.document_index_service import ReferenceDocsService

        svc = ReferenceDocsService(index_dir=tmp_path / "ref_api")
        res = svc.index_ifcopenshell_api()
        assert res["ok"] is True
        assert res["indexed"] > 0
        assert svc.status()["indexed"] is True
