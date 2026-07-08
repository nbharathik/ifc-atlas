"""
Model Registry - flexible, UI-configurable catalogue of LLM models.

Sister service to ``prompt_library.py`` / ``tool_sets.py`` / ``agent_registry.py``.
Where those curate prompts, tool bundles, and agent personas, this curates the
*models* the chat can run: OpenAI, Anthropic, and OpenRouter entries, each with
rich metadata (use case, sampling defaults, reasoning settings, capability flags,
cost/speed tiers, notes).

The Chat Manager → **Models** tab reads from this registry. The chat model
dropdown is populated from the *enabled* entries here instead of a hard-coded
list, so a new provider model can be added from the UI (or by extending the seed
list) without touching the chat code. ``llm_service.stream_chat`` resolves a
``ModelEntry`` by its registry id and maps its sampling settings into each
provider's API format via ``provider_params.py``.

Divergence from the built-in-protected pattern (intentional - do not "fix")
---------------------------------------------------------------------------
``prompt_library`` / ``tool_sets`` make built-ins immutable (edits fork a copy).
Model configs are *pure data*, and the product spec requires the user to add,
edit, enable, disable, **and reorder every model** - including the seeded
defaults. So here built-ins are fully editable in place. To keep the seed list
useful as a source of *new* defaults when providers ship new models, a
``seeded_ids`` ledger records which built-in ids have already been introduced:

  * A built-in is seeded into ``models.json`` exactly once (the first launch that
    sees its id absent from ``seeded_ids``). Future releases that append to
    ``_BUILTIN`` get merged in on the next launch - without clobbering user edits.
  * Deleting a seeded built-in removes it from ``models`` but leaves its id in
    ``seeded_ids``, so it does **not** silently reappear on the next launch.

Persisted to ``{DATA_DIR}/models.json`` in the per-user dotfolder
(`~/.ifc-atlas/data/`), resolved via ``app.core.config.DATA_DIR``.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Any, Optional

from app.core.config import DATA_DIR

logger = logging.getLogger(__name__)

_DATA_DIR = DATA_DIR
_MODELS_FILE = _DATA_DIR / "models.json"
_SCHEMA_VERSION = 1

# Allowed provider ids.
PROVIDERS = ("openai", "anthropic", "openrouter")

# Default use cases. The temperature band each one targets follows the BIM-tuned
# guidance: extraction/JSON 0.0-0.2, coding/tool-use 0.1-0.3, general chat
# 0.4-0.7. ``USE_CASE_DEFAULT_TEMP`` is the fallback temperature applied when a
# created entry omits one; seeds set their own explicit temperatures.
USE_CASES = (
    "reasoning",
    "fast_chat",
    "cheap_fallback",
    "coding",
    "vision",
    "structured_extraction",
)
USE_CASE_DEFAULT_TEMP: dict[str, float] = {
    "structured_extraction": 0.1,
    "reasoning": 0.2,
    "coding": 0.2,
    "vision": 0.2,
    "cheap_fallback": 0.4,
    "fast_chat": 0.5,
}

COST_TIERS = ("free", "low", "medium", "high")
SPEED_TIERS = ("slow", "medium", "fast")


@dataclass(frozen=True)
class ModelEntry:
    """One configurable model. ``id`` is a registry-unique slug (NOT the API
    model id) so two entries may share a ``model_id`` with different presets."""

    id: str
    provider: str               # openai | anthropic | openrouter
    model_id: str               # the provider's API model string
    display_name: str
    use_case: str = "fast_chat"
    # Sampling. ``temperature`` is always present; ``top_p`` / ``max_output_tokens``
    # are optional (None = use provider default / omit from the request).
    temperature: float = 0.3
    top_p: Optional[float] = None
    max_output_tokens: Optional[int] = None
    # Reasoning / extended thinking. Normalised, provider-agnostic shape:
    #   None                       → reasoning off
    #   {"effort": "minimal|low|medium|high"}   → effort-style (native to OpenAI)
    #   {"budget_tokens": <int>}                → budget-style (native to Anthropic)
    # provider_params.py translates between the two per the target provider.
    reasoning: Optional[dict] = None
    # Capability flags - drive UI badges and (future) validation.
    supports_tools: bool = True
    supports_vision: bool = False
    supports_structured_output: bool = True
    # Coarse, provider-independent UI signals (separate from $ cost telemetry).
    cost_tier: str = "medium"   # free | low | medium | high
    speed_tier: str = "medium"  # slow | medium | fast
    notes: str = ""
    enabled: bool = True
    sort_order: int = 0
    is_custom: bool = False
    created_at: Optional[str] = None


# ---------------------------------------------------------------------------
# Built-in seed catalogue
# ---------------------------------------------------------------------------
# Model ids are seeded VERBATIM as requested. Several are not yet released - that
# is exactly what a UI-editable registry is for: the ids resolve against each
# provider when they go live, and can be edited/disabled now. (The cost/speed
# tiers below are the UI signal; the separate `_COST_PER_1M` table in
# llm_service.py has no $ rates for unreleased ids, which is fine.)

def _slug(s: str) -> str:
    out = "".join(c if c.isalnum() else "-" for c in s.lower())
    while "--" in out:
        out = out.replace("--", "-")
    out = out.strip("-")
    return out or f"model-{uuid.uuid4().hex[:6]}"


def _seed(
    provider: str,
    model_id: str,
    display_name: str,
    use_case: str,
    temperature: float,
    cost_tier: str,
    speed_tier: str,
    *,
    top_p: Optional[float] = None,
    max_output_tokens: Optional[int] = None,
    reasoning: Optional[dict] = None,
    supports_tools: bool = True,
    supports_vision: bool = False,
    supports_structured_output: bool = True,
    notes: str = "",
) -> ModelEntry:
    return ModelEntry(
        id=_slug(f"{provider}-{model_id}"),
        provider=provider,
        model_id=model_id,
        display_name=display_name,
        use_case=use_case,
        temperature=temperature,
        top_p=top_p,
        max_output_tokens=max_output_tokens,
        reasoning=reasoning,
        supports_tools=supports_tools,
        supports_vision=supports_vision,
        supports_structured_output=supports_structured_output,
        cost_tier=cost_tier,
        speed_tier=speed_tier,
        notes=notes,
    )


_BUILTIN_SEEDS: list[ModelEntry] = [
    # ── OpenAI ──────────────────────────────────────────────────────────────
    _seed("openai", "gpt-5.5", "GPT-5.5", "reasoning", 0.2, "high", "medium",
          reasoning={"effort": "high"}, supports_vision=True,
          notes="Flagship reasoning + tool use. Best for complex BIM analysis."),
    _seed("openai", "gpt-5.5-pro", "GPT-5.5 Pro", "reasoning", 0.2, "high", "slow",
          reasoning={"effort": "high"}, supports_vision=True,
          notes="Deepest reasoning tier. Slow + costly - reserve for hard problems."),
    _seed("openai", "gpt-5.4", "GPT-5.4", "fast_chat", 0.5, "medium", "fast",
          supports_vision=True, notes="Balanced general-purpose chat."),
    _seed("openai", "gpt-5.4-mini", "GPT-5.4 mini", "cheap_fallback", 0.3, "low", "fast",
          supports_vision=True, notes="Fast, cheap fallback for routine queries."),
    _seed("openai", "gpt-5.4-nano", "GPT-5.4 nano", "cheap_fallback", 0.3, "free", "fast",
          notes="Smallest/cheapest tier. Good for classification + extraction."),
    _seed("openai", "gpt-4.1", "GPT-4.1", "coding", 0.2, "medium", "medium",
          supports_vision=True, notes="Strong coding + tool calling."),

    # ── Anthropic ───────────────────────────────────────────────────────────
    _seed("anthropic", "claude-opus-4-7", "Claude Opus 4.7", "reasoning", 0.2, "high", "slow",
          reasoning={"budget_tokens": 8000}, max_output_tokens=16000, supports_vision=True,
          notes="Flagship Claude. Extended thinking enabled for deep analysis."),
    _seed("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6", "coding", 0.2, "medium", "fast",
          supports_vision=True, notes="Best Claude for coding + agentic tool use."),
    _seed("anthropic", "claude-opus-4-6", "Claude Opus 4.6", "reasoning", 0.2, "high", "slow",
          reasoning={"budget_tokens": 8000}, max_output_tokens=16000, supports_vision=True,
          notes="Previous Opus flagship. Extended thinking enabled."),
    _seed("anthropic", "claude-opus-4-5", "Claude Opus 4.5", "reasoning", 0.3, "high", "medium",
          supports_vision=True, notes="Capable all-rounder."),
    _seed("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", "fast_chat", 0.4, "low", "fast",
          supports_vision=True, notes="Fast, inexpensive Claude for everyday chat."),

    # ── OpenRouter ──────────────────────────────────────────────────────────
    _seed("openrouter", "deepseek/deepseek-v3.2", "DeepSeek V3.2", "fast_chat", 0.4, "low", "medium",
          notes="Strong open value model."),
    _seed("openrouter", "deepseek/deepseek-v3.2-speciale", "DeepSeek V3.2 Speciale", "coding", 0.2, "low", "medium",
          notes="Coding-tuned DeepSeek variant."),
    _seed("openrouter", "deepseek/deepseek-r1", "DeepSeek R1", "reasoning", 0.2, "low", "slow",
          reasoning={"effort": "medium"},
          notes="Open reasoning model. Low cost for chain-of-thought tasks."),
    _seed("openrouter", "qwen/qwen3-coder-480b-a35b-instruct", "Qwen3 Coder 480B", "coding", 0.2, "medium", "medium",
          notes="Large MoE coder. Excellent for code + structured output."),
    _seed("openrouter", "qwen/qwen3.6-35b-a3b", "Qwen3.6 35B A3B", "fast_chat", 0.4, "low", "fast",
          notes="Efficient MoE general chat."),
    _seed("openrouter", "qwen/qwen3.6-flash", "Qwen3.6 Flash", "cheap_fallback", 0.4, "free", "fast",
          notes="Fastest/cheapest Qwen tier."),
    _seed("openrouter", "qwen/qwen3.5-plus-2026-04-20", "Qwen3.5 Plus", "fast_chat", 0.4, "low", "medium",
          notes="Dated Qwen3.5 Plus snapshot."),
    _seed("openrouter", "google/gemma-4-26b-a4b-it", "Gemma 4 26B", "cheap_fallback", 0.4, "free", "fast",
          notes="Open Google model. Good cheap fallback."),
    _seed("openrouter", "moonshotai/kimi-k2", "Kimi K2", "coding", 0.2, "low", "medium",
          notes="Agentic coding + long-context."),
    _seed("openrouter", "openrouter/free", "OpenRouter Free (auto)", "cheap_fallback", 0.5, "free", "medium",
          supports_structured_output=False,
          notes="Free auto-routed model. Capabilities vary by what OpenRouter selects."),
]


class ModelRegistry:
    """Mutable, JSON-backed model catalogue with a seed-merge ledger.

    All entries (seeded built-ins + user-created) are fully editable. See module
    docstring for why this diverges from the built-in-protected sibling services.
    """

    def __init__(self) -> None:
        self._models: dict[str, ModelEntry] = {}
        self._seeded_ids: set[str] = set()
        self._load()

    # -- persistence --------------------------------------------------------

    def _load(self) -> None:
        raw: dict[str, Any] = {}
        if _MODELS_FILE.exists():
            try:
                raw = json.loads(_MODELS_FILE.read_text(encoding="utf-8"))
                if not isinstance(raw, dict):  # legacy / corrupt → reseed
                    raw = {}
            except Exception as e:
                logger.warning("Failed to load model registry: %s", e)
                raw = {}

        self._seeded_ids = set(raw.get("seeded_ids") or [])
        for d in raw.get("models") or []:
            try:
                m = _from_dict(d)
                self._models[m.id] = m
            except Exception as e:
                logger.warning("Skipping malformed model entry: %s", e)

        # Merge any built-in seeds we have not introduced yet (first launch, or
        # a new release added more). Already-seeded ids are skipped so user edits
        # and deletions are never clobbered / resurrected.
        next_order = (max((m.sort_order for m in self._models.values()), default=-1)) + 1
        changed = False
        for seed in _BUILTIN_SEEDS:
            if seed.id in self._seeded_ids:
                continue
            self._models[seed.id] = replace(
                seed, sort_order=next_order, created_at=_now_iso()
            )
            self._seeded_ids.add(seed.id)
            next_order += 1
            changed = True

        if changed or not _MODELS_FILE.exists():
            self._save()

    def _save(self) -> None:
        try:
            _DATA_DIR.mkdir(parents=True, exist_ok=True)
            payload = {
                "version": _SCHEMA_VERSION,
                "seeded_ids": sorted(self._seeded_ids),
                "models": [_to_dict(m) for m in self._sorted()],
            }
            _MODELS_FILE.write_text(
                json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
            )
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("Failed to save model registry: %s", e)

    # -- read ---------------------------------------------------------------

    def _sorted(self) -> list[ModelEntry]:
        return sorted(
            self._models.values(),
            key=lambda m: (m.sort_order, m.created_at or "", m.id),
        )

    def all(self) -> list[ModelEntry]:
        return self._sorted()

    def enabled(self) -> list[ModelEntry]:
        return [m for m in self._sorted() if m.enabled]

    def get(self, model_id: Optional[str]) -> Optional[ModelEntry]:
        """Look up by registry entry id (NOT the provider model_id)."""
        if not model_id:
            return None
        return self._models.get(model_id)

    def list_dicts(self) -> list[dict]:
        return [_to_dict(m) for m in self._sorted()]

    # -- write --------------------------------------------------------------

    def create(self, data: dict) -> ModelEntry:
        entry_id = data.get("id") or _slug(
            f"{data.get('provider', 'model')}-{data.get('model_id') or data.get('display_name', 'model')}"
        )
        base = entry_id
        n = 1
        while entry_id in self._models:
            entry_id = f"{base}-{n}"
            n += 1
        next_order = (max((m.sort_order for m in self._models.values()), default=-1)) + 1
        merged = {
            **data,
            "id": entry_id,
            "is_custom": True,
            "created_at": _now_iso(),
        }
        merged.setdefault("sort_order", next_order)
        entry = _from_dict(merged)
        self._models[entry_id] = entry
        self._save()
        return entry

    def update(self, entry_id: str, data: dict) -> ModelEntry:
        existing = self._models.get(entry_id)
        if existing is None:
            raise KeyError(f"Model '{entry_id}' not found.")
        # id / created_at / is_custom are immutable across an update.
        merged = {
            **_to_dict(existing),
            **data,
            "id": entry_id,
            "is_custom": existing.is_custom,
            "created_at": existing.created_at,
        }
        entry = _from_dict(merged)
        self._models[entry_id] = entry
        self._save()
        return entry

    def delete(self, entry_id: str) -> None:
        if entry_id not in self._models:
            raise KeyError(f"Model '{entry_id}' not found.")
        del self._models[entry_id]
        # Keep the id in _seeded_ids so a deleted built-in stays deleted.
        self._save()

    def set_enabled(self, entry_id: str, enabled: bool) -> ModelEntry:
        return self.update(entry_id, {"enabled": bool(enabled)})

    def reorder(self, ordered_ids: list[str]) -> list[ModelEntry]:
        """Assign ``sort_order`` by the position of each id in ``ordered_ids``.

        Ids not present in the registry are ignored; entries omitted from the
        list keep a stable relative order *after* the explicitly-ordered ones.
        """
        order_index = {eid: i for i, eid in enumerate(ordered_ids)}
        tail = len(order_index)
        for m in self._sorted():
            if m.id in order_index:
                new_order = order_index[m.id]
            else:
                new_order = tail
                tail += 1
            if m.sort_order != new_order:
                self._models[m.id] = replace(m, sort_order=new_order)
        self._save()
        return self._sorted()

    def __contains__(self, key: str) -> bool:
        return key in self._models


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _coerce_reasoning(value: Any) -> Optional[dict]:
    """Normalise the reasoning field to None or a clean dict.

    Accepts None / "" / "off" / "none" → None; a dict with ``effort`` or
    ``budget_tokens`` → kept; anything else → None.
    """
    if not value:
        return None
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("", "off", "none", "false"):
            return None
        return {"effort": v}
    if isinstance(value, dict):
        effort = value.get("effort")
        budget = value.get("budget_tokens")
        out: dict[str, Any] = {}
        if isinstance(effort, str) and effort.strip().lower() not in ("", "off", "none"):
            out["effort"] = effort.strip().lower()
        if isinstance(budget, (int, float)) and budget > 0:
            out["budget_tokens"] = int(budget)
        return out or None
    return None


def _clamp_choice(value: Any, allowed: tuple[str, ...], default: str) -> str:
    return value if isinstance(value, str) and value in allowed else default


def _to_dict(m: ModelEntry) -> dict:
    return {
        "id": m.id,
        "provider": m.provider,
        "model_id": m.model_id,
        "display_name": m.display_name,
        "use_case": m.use_case,
        "temperature": m.temperature,
        "top_p": m.top_p,
        "max_output_tokens": m.max_output_tokens,
        "reasoning": m.reasoning,
        "supports_tools": m.supports_tools,
        "supports_vision": m.supports_vision,
        "supports_structured_output": m.supports_structured_output,
        "cost_tier": m.cost_tier,
        "speed_tier": m.speed_tier,
        "notes": m.notes,
        "enabled": m.enabled,
        "sort_order": m.sort_order,
        "is_custom": m.is_custom,
        "created_at": m.created_at,
    }


def _from_dict(d: dict) -> ModelEntry:
    provider = _clamp_choice(d.get("provider"), PROVIDERS, "openai")
    use_case = _clamp_choice(d.get("use_case"), USE_CASES, "fast_chat")
    raw_temp = d.get("temperature")
    temperature = (
        float(raw_temp) if isinstance(raw_temp, (int, float))
        else USE_CASE_DEFAULT_TEMP.get(use_case, 0.3)
    )
    raw_top_p = d.get("top_p")
    top_p = float(raw_top_p) if isinstance(raw_top_p, (int, float)) else None
    raw_max = d.get("max_output_tokens")
    max_out = int(raw_max) if isinstance(raw_max, (int, float)) and raw_max > 0 else None
    return ModelEntry(
        id=d["id"],
        provider=provider,
        model_id=d.get("model_id", ""),
        display_name=d.get("display_name") or d.get("model_id", "Untitled"),
        use_case=use_case,
        temperature=temperature,
        top_p=top_p,
        max_output_tokens=max_out,
        reasoning=_coerce_reasoning(d.get("reasoning")),
        supports_tools=bool(d.get("supports_tools", True)),
        supports_vision=bool(d.get("supports_vision", False)),
        supports_structured_output=bool(d.get("supports_structured_output", True)),
        cost_tier=_clamp_choice(d.get("cost_tier"), COST_TIERS, "medium"),
        speed_tier=_clamp_choice(d.get("speed_tier"), SPEED_TIERS, "medium"),
        notes=str(d.get("notes") or ""),
        enabled=bool(d.get("enabled", True)),
        sort_order=int(d.get("sort_order") or 0),
        is_custom=bool(d.get("is_custom", False)),
        created_at=d.get("created_at"),
    )


# Module-level singleton.
model_registry = ModelRegistry()
