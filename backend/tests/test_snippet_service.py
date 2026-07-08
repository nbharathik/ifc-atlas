"""Tests for SnippetService (prompt snippet library).

All tests are pure-unit: no IfcOpenShell, no disk I/O (we monkeypatch _save).
The HTTP routes are tested via a lightweight FastAPI TestClient.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def svc():
    """Fresh SnippetService with an empty custom dict (no disk interaction)."""
    from app.services.snippet_service import SnippetService
    service = SnippetService.__new__(SnippetService)
    from app.services.snippet_service import _BUILTIN_SNIPPETS
    service._builtins = {s.id: s for s in _BUILTIN_SNIPPETS}
    service._custom = {}
    return service


@pytest.fixture()
def client():
    """TestClient for the chat router (includes /api/chat/snippets endpoints)."""
    from fastapi import FastAPI
    from app.api.chat_routes import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


# ---------------------------------------------------------------------------
# SnippetService unit tests
# ---------------------------------------------------------------------------

class TestSnippetServiceList:
    def test_list_returns_builtins(self, svc):
        items = svc.list_all()
        builtin_ids = {s.id for s in items if s.is_builtin}
        assert len(builtin_ids) >= 5, "Expected at least 5 built-in snippets"

    def test_list_dicts_have_required_keys(self, svc):
        dicts = svc.list_dicts()
        for d in dicts:
            for key in ("id", "title", "body", "tags", "is_builtin"):
                assert key in d, f"Missing key {key!r} in snippet dict"


class TestSnippetServiceCreate:
    def test_create_returns_snippet(self, svc):
        svc._save = MagicMock()
        s = svc.create({"title": "My Prompt", "body": "How many walls?", "tags": ["walls"]})
        assert s.title == "My Prompt"
        assert s.body == "How many walls?"
        assert s.tags == ["walls"]
        assert not s.is_builtin

    def test_create_generates_unique_id(self, svc):
        svc._save = MagicMock()
        s1 = svc.create({"title": "A", "body": "x"})
        s2 = svc.create({"title": "B", "body": "y"})
        assert s1.id != s2.id

    def test_create_persists(self, svc):
        save_mock = MagicMock()
        svc._save = save_mock
        svc.create({"title": "Saved", "body": "test"})
        save_mock.assert_called_once()


class TestSnippetServiceUpdate:
    def test_update_changes_fields(self, svc):
        svc._save = MagicMock()
        created = svc.create({"title": "Old Title", "body": "Old body"})
        updated = svc.update(created.id, {"title": "New Title", "body": "New body"})
        assert updated.title == "New Title"
        assert updated.body == "New body"

    def test_update_builtin_raises(self, svc):
        builtin_id = next(iter(svc._builtins))
        with pytest.raises(ValueError, match="cannot be modified"):
            svc.update(builtin_id, {"title": "nope", "body": "nope"})

    def test_update_missing_raises(self, svc):
        with pytest.raises(KeyError):
            svc.update("nonexistent-id", {"title": "x", "body": "y"})


class TestSnippetServiceDelete:
    def test_delete_removes_custom(self, svc):
        svc._save = MagicMock()
        created = svc.create({"title": "Temp", "body": "delete me"})
        svc._save.reset_mock()
        svc.delete(created.id)
        assert created.id not in svc._custom

    def test_delete_builtin_raises(self, svc):
        builtin_id = next(iter(svc._builtins))
        with pytest.raises(ValueError, match="cannot be deleted"):
            svc.delete(builtin_id)

    def test_delete_missing_raises(self, svc):
        with pytest.raises(KeyError):
            svc.delete("ghost-id-xyz")


# ---------------------------------------------------------------------------
# HTTP route tests
# ---------------------------------------------------------------------------

class TestSnippetRoutes:
    def test_get_snippets_returns_list(self, client):
        with patch("app.api.chat_routes.snippet_service") as mock_svc:
            mock_svc.list_dicts.return_value = [
                {"id": "snip-1", "title": "T", "body": "B", "tags": [], "is_builtin": True, "created_at": None}
            ]
            resp = client.get("/api/chat/snippets")
        assert resp.status_code == 200
        assert "snippets" in resp.json()
        assert len(resp.json()["snippets"]) == 1

    def test_post_snippet_creates(self, client):
        with patch("app.api.chat_routes.snippet_service") as mock_svc:
            from app.services.snippet_service import SnippetEntry
            mock_entry = SnippetEntry(
                id="snip-new",
                title="New",
                body="body",
                tags=[],
                is_builtin=False,
                created_at="2026-05-10T00:00:00+00:00",
            )
            mock_svc.create.return_value = mock_entry
            resp = client.post("/api/chat/snippets", json={"title": "New", "body": "body", "tags": []})
        assert resp.status_code == 201
        assert resp.json()["snippet"]["title"] == "New"

    def test_delete_snippet_builtin_returns_403(self, client):
        with patch("app.api.chat_routes.snippet_service") as mock_svc:
            mock_svc.delete.side_effect = ValueError("Built-in snippet 'x' cannot be deleted.")
            resp = client.delete("/api/chat/snippets/snip-model-summary")
        assert resp.status_code == 403

    def test_delete_snippet_missing_returns_404(self, client):
        with patch("app.api.chat_routes.snippet_service") as mock_svc:
            mock_svc.delete.side_effect = KeyError("ghost")
            resp = client.delete("/api/chat/snippets/ghost")
        assert resp.status_code == 404
