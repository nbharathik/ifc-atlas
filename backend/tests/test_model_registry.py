"""Model Registry - seed-merge, CRUD, reorder, enable/disable, persistence."""

import json

import pytest

from app.services import model_registry as mr
from app.services.model_registry import ModelEntry, ModelRegistry


@pytest.fixture
def tmp_models(tmp_path, monkeypatch):
    """Point the registry's JSON store at a throwaway file per test."""
    f = tmp_path / "models.json"
    monkeypatch.setattr(mr, "_DATA_DIR", tmp_path)
    monkeypatch.setattr(mr, "_MODELS_FILE", f)
    return f


@pytest.fixture
def reg(tmp_models):
    return ModelRegistry()


# ── seeding ────────────────────────────────────────────────────────────────

def test_seeds_on_first_launch(reg, tmp_models):
    models = reg.all()
    assert len(models) == len(mr._BUILTIN_SEEDS)
    assert all(m.enabled for m in models)
    ids = [m.id for m in models]
    assert len(ids) == len(set(ids)), "seeded ids must be unique"
    # File written with the ledger.
    saved = json.loads(tmp_models.read_text(encoding="utf-8"))
    assert saved["version"] == mr._SCHEMA_VERSION
    assert set(saved["seeded_ids"]) == set(ids)


def test_seed_covers_all_three_providers(reg):
    providers = {m.provider for m in reg.all()}
    assert providers == {"openai", "anthropic", "openrouter"}


def test_reasoning_seeds_have_reasoning_field(reg):
    # The flagship reasoning models seed with a reasoning setting.
    gpt = reg.get("openai-gpt-5-5")
    assert gpt is not None and gpt.reasoning == {"effort": "high"}
    opus = reg.get("anthropic-claude-opus-4-7")
    assert opus is not None and opus.reasoning == {"budget_tokens": 8000}


# ── persistence + seed-merge ledger ─────────────────────────────────────────

def test_custom_survives_reload(tmp_models):
    r1 = ModelRegistry()
    created = r1.create({
        "provider": "openai", "model_id": "gpt-x", "display_name": "X",
        "use_case": "coding", "temperature": 0.2,
    })
    r2 = ModelRegistry()
    got = r2.get(created.id)
    assert got is not None and got.is_custom and got.model_id == "gpt-x"


def test_deleted_builtin_stays_deleted(tmp_models):
    r1 = ModelRegistry()
    victim = r1.all()[0].id
    r1.delete(victim)
    # Reloading must NOT resurrect a seeded built-in the user deleted.
    r2 = ModelRegistry()
    assert r2.get(victim) is None
    assert victim in r2._seeded_ids


def test_new_release_seed_is_merged_once(tmp_models, monkeypatch):
    ModelRegistry()  # first launch seeds the current list
    extra = ModelEntry(
        id="openai-future-9", provider="openai", model_id="gpt-9",
        display_name="GPT-9", use_case="reasoning", temperature=0.2,
    )
    monkeypatch.setattr(mr, "_BUILTIN_SEEDS", [*mr._BUILTIN_SEEDS, extra])
    r2 = ModelRegistry()
    assert r2.get("openai-future-9") is not None
    # Deleting it then reloading must keep it gone (seeded once, not forever).
    r2.delete("openai-future-9")
    r3 = ModelRegistry()
    assert r3.get("openai-future-9") is None


# ── CRUD ────────────────────────────────────────────────────────────────────

def test_update_builtin_is_editable_in_place(reg):
    bid = reg.all()[0].id
    assert reg.get(bid).is_custom is False
    reg.update(bid, {"temperature": 0.9, "notes": "tuned"})
    got = reg.get(bid)
    assert got.temperature == 0.9 and got.notes == "tuned"
    assert got.is_custom is False  # editing a built-in does not reclassify it


def test_update_missing_raises(reg):
    with pytest.raises(KeyError):
        reg.update("does-not-exist", {"temperature": 0.1})


def test_delete_missing_raises(reg):
    with pytest.raises(KeyError):
        reg.delete("does-not-exist")


def test_set_enabled_and_enabled_filter(reg):
    bid = reg.all()[0].id
    reg.set_enabled(bid, False)
    assert reg.get(bid).enabled is False
    assert bid not in {m.id for m in reg.enabled()}


def test_create_coerces_bad_values(reg):
    m = reg.create({
        "provider": "not-a-provider", "model_id": "m", "display_name": "M",
        "use_case": "nonsense", "temperature": 0.3,
        "reasoning": "high", "cost_tier": "bogus", "speed_tier": "bogus",
    })
    assert m.provider == "openai"          # clamped
    assert m.use_case == "fast_chat"        # clamped
    assert m.reasoning == {"effort": "high"}  # string → effort dict
    assert m.cost_tier == "medium" and m.speed_tier == "medium"


def test_reorder(reg):
    original = [m.id for m in reg.all()]
    reversed_ids = original[::-1]
    reg.reorder(reversed_ids)
    assert [m.id for m in reg.all()] == reversed_ids
    # Survives reload.
    assert [m.id for m in ModelRegistry().all()] == reversed_ids
