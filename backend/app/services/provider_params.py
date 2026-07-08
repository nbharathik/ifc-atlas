"""
Provider parameter mapper - one common sampling interface, three provider APIs.

The Model Registry (``model_registry.py``) stores each model's sampling settings
in a single provider-agnostic shape (temperature, top_p, max_output_tokens, and a
normalised ``reasoning`` dict). This module translates that common interface into
the keyword arguments each target expects:

  * ``langchain_llm_kwargs``    → ChatOpenAI / ChatAnthropic constructor kwargs
                                  (the PRIMARY path, via build_streaming_agent).
  * ``openai_create_kwargs``    → openai.AsyncOpenAI().chat.completions.create()
                                  kwargs (the direct OpenAI / OpenRouter
                                  fallback streamers).
  * ``anthropic_stream_kwargs`` → anthropic.AsyncAnthropic().messages.stream()
                                  kwargs (the direct Anthropic fallback streamer).

Compatibility rules (the reason this module exists)
---------------------------------------------------
Reasoning / extended thinking is mutually exclusive with ``temperature`` /
``top_p`` on both providers - sending them together is a hard 400, not a client
error we can swallow. So when ``reasoning`` is set we **omit** temperature/top_p
and emit the provider's reasoning control instead:

  * OpenAI / OpenRouter: drop temperature + top_p, set ``reasoning_effort``.
  * Anthropic: drop top_p, force ``temperature=1`` (required with thinking), set
    ``thinking={"type": "enabled", "budget_tokens": N}`` and ensure
    ``max_tokens > N``.

The reasoning decision is gated on the registry's ``reasoning`` field - never on
model-name sniffing (the seeded ids are future models we can't pattern-match).

Two OpenAI wire-format rules, however, ARE model/provider shaped (they mirror
what langchain-openai itself does on the primary path):

  * OpenAI's Chat Completions deprecated ``max_tokens`` - gpt-5-family models
    hard-400 on it. The raw OpenAI streamer must send ``max_completion_tokens``
    (accepted by every current OpenAI model). OpenRouter keeps ``max_tokens``
    (its normalised cross-vendor param).
  * gpt-5* (non-chat) and o-series models lock temperature/top_p to their
    defaults - any custom value is a 400, reasoning enabled or not.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:  # avoid an import cycle at runtime - only needed for hints
    from app.services.model_registry import ModelEntry

# Fallback max output tokens when an entry leaves it unset. Matches the literal
# the streamers used before this module existed.
DEFAULT_MAX_TOKENS = 4096
# Headroom added on top of an Anthropic thinking budget so the visible answer has
# room after the (billed-against-max_tokens) thinking tokens.
_THINKING_ANSWER_HEADROOM = 4096

_EFFORT_TO_BUDGET = {"minimal": 1024, "low": 2048, "medium": 4096, "high": 16000}
_EFFORT_ORDER = ("minimal", "low", "medium", "high")


@dataclass(frozen=True)
class SamplingParams:
    """Provider-agnostic resolved sampling for one turn."""

    temperature: float = 0.3
    top_p: Optional[float] = None
    max_output_tokens: Optional[int] = None
    # Normalised reasoning: None | {"effort": str} | {"budget_tokens": int}.
    reasoning: Optional[dict] = None

    @property
    def reasoning_on(self) -> bool:
        return bool(self.reasoning)


def resolve_sampling(
    entry: "Optional[ModelEntry]",
    temperature_override: Optional[float] = None,
) -> Optional[SamplingParams]:
    """Build :class:`SamplingParams` from a registry entry.

    Returns ``None`` when there is no entry, so callers can preserve the legacy
    temperature-only behaviour. ``temperature_override`` (an explicit per-turn
    temperature from the request) wins over the entry default when provided.
    """
    if entry is None:
        return None
    temperature = (
        temperature_override
        if temperature_override is not None
        else entry.temperature
    )
    return SamplingParams(
        temperature=temperature if temperature is not None else 0.3,
        top_p=entry.top_p,
        max_output_tokens=entry.max_output_tokens,
        reasoning=entry.reasoning,
    )


# ---------------------------------------------------------------------------
# Reasoning normalisation helpers
# ---------------------------------------------------------------------------

def _effort_from_reasoning(reasoning: dict) -> str:
    effort = reasoning.get("effort")
    if isinstance(effort, str) and effort in _EFFORT_TO_BUDGET:
        return effort
    budget = reasoning.get("budget_tokens")
    if isinstance(budget, (int, float)):
        # Map a budget back to the nearest effort bucket for OpenAI-style APIs.
        for name in _EFFORT_ORDER:
            if budget <= _EFFORT_TO_BUDGET[name]:
                return name
        return "high"
    return "medium"


def _budget_from_reasoning(reasoning: dict) -> int:
    budget = reasoning.get("budget_tokens")
    if isinstance(budget, (int, float)) and budget > 0:
        return int(budget)
    effort = reasoning.get("effort")
    if isinstance(effort, str) and effort in _EFFORT_TO_BUDGET:
        return _EFFORT_TO_BUDGET[effort]
    return _EFFORT_TO_BUDGET["medium"]


# ---------------------------------------------------------------------------
# Target kwarg builders
# ---------------------------------------------------------------------------

def sampling_locked(model_id: Optional[str]) -> bool:
    """True for OpenAI models that reject custom temperature / top_p.

    gpt-5-family (except the -chat variants) and o-series models only accept
    their default sampling - any other value is a hard 400. Mirrors
    langchain-openai's own ``validate_temperature`` model sniffing so the raw
    fallback streamers behave like the primary LangChain path.
    """
    if not model_id:
        return False
    m = model_id.lower().split("/")[-1]  # strip an OpenRouter vendor prefix
    if m.startswith(("o1", "o3", "o4")):
        return True
    return m.startswith("gpt-5") and "chat" not in m


def _openai_common(
    sp: SamplingParams,
    model_id: Optional[str] = None,
    *,
    max_tokens_key: str = "max_tokens",
) -> dict[str, Any]:
    """OpenAI-shaped sampling (shared by LangChain ChatOpenAI + raw create).

    Reasoning is reported separately by the callers (constructor kwarg vs
    ``extra_body``) so this only covers temperature / top_p / max tokens and the
    omission rules.
    """
    kwargs: dict[str, Any] = {}
    if sp.reasoning_on or sampling_locked(model_id):
        # These models reject custom temperature / top_p - omit both.
        pass
    else:
        kwargs["temperature"] = sp.temperature
        if sp.top_p is not None:
            kwargs["top_p"] = sp.top_p
    kwargs[max_tokens_key] = sp.max_output_tokens or DEFAULT_MAX_TOKENS
    return kwargs


def _anthropic_common(sp: SamplingParams) -> dict[str, Any]:
    """Anthropic-shaped sampling (shared by LangChain ChatAnthropic + raw stream).

    Thinking is reported separately by the callers (constructor kwarg vs
    ``extra_body``) so this only covers temperature / top_p / max_tokens and the
    thinking-mode overrides.
    """
    kwargs: dict[str, Any] = {}
    if sp.reasoning_on:
        budget = _budget_from_reasoning(sp.reasoning or {})
        # Thinking forces temperature=1, disallows top_p, and needs headroom
        # above the thinking budget for the visible answer.
        kwargs["temperature"] = 1.0
        kwargs["max_tokens"] = max(
            sp.max_output_tokens or 0, budget + _THINKING_ANSWER_HEADROOM
        )
    else:
        kwargs["temperature"] = sp.temperature
        if sp.top_p is not None:
            kwargs["top_p"] = sp.top_p
        kwargs["max_tokens"] = sp.max_output_tokens or DEFAULT_MAX_TOKENS
    return kwargs


def langchain_llm_kwargs(
    provider: str, sp: SamplingParams, model_id: Optional[str] = None
) -> dict[str, Any]:
    """Constructor kwargs for the LangChain chat model (PRIMARY path).

    ``reasoning_effort`` (ChatOpenAI) and ``thinking`` (ChatAnthropic) are both
    first-class fields in the pinned langchain-openai / langchain-anthropic, so
    they go straight on the constructor. ``max_tokens`` is kept here - ChatOpenAI
    aliases it to ``max_completion_tokens`` on the wire itself.
    """
    if provider == "anthropic":
        kwargs = _anthropic_common(sp)
        if sp.reasoning_on:
            budget = _budget_from_reasoning(sp.reasoning or {})
            kwargs["thinking"] = {"type": "enabled", "budget_tokens": budget}
        return kwargs
    # openai + openrouter both use the ChatOpenAI shape.
    kwargs = _openai_common(sp, model_id)
    if sp.reasoning_on:
        kwargs["reasoning_effort"] = _effort_from_reasoning(sp.reasoning or {})
        if provider == "openai":
            # gpt-5-family rejects reasoning_effort combined with function
            # tools on /v1/chat/completions ("Please use /v1/responses
            # instead"). ChatOpenAI translates reasoning_effort and max_tokens
            # to the Responses API shapes itself, so flipping the endpoint is
            # all that's needed. OpenRouter has no /v1/responses - never set
            # this for it.
            kwargs["use_responses_api"] = True
    return kwargs


def openai_create_kwargs(
    sp: SamplingParams, model_id: Optional[str] = None
) -> dict[str, Any]:
    """kwargs for raw ``chat.completions.create`` against OpenAI.

    Sends ``max_completion_tokens`` (``max_tokens`` is deprecated and rejected
    by gpt-5-family models). Reasoning rides in ``extra_body`` so it is
    forwarded verbatim regardless of SDK-version param coverage; it is only ever
    sent for entries the user marked as reasoning models, so an
    unsupported-param 400 cannot reach a normal model.
    """
    kwargs = _openai_common(sp, model_id, max_tokens_key="max_completion_tokens")
    if sp.reasoning_on:
        kwargs["extra_body"] = {
            "reasoning_effort": _effort_from_reasoning(sp.reasoning or {})
        }
    return kwargs


def openrouter_create_kwargs(
    sp: SamplingParams, model_id: Optional[str] = None
) -> dict[str, Any]:
    """kwargs for raw ``chat.completions.create`` against OpenRouter.

    Identical to :func:`openai_create_kwargs` except the token cap stays
    ``max_tokens`` - OpenRouter's normalised cross-vendor parameter.
    """
    kwargs = _openai_common(sp, model_id, max_tokens_key="max_tokens")
    if sp.reasoning_on:
        kwargs["extra_body"] = {
            "reasoning_effort": _effort_from_reasoning(sp.reasoning or {})
        }
    return kwargs


def anthropic_stream_kwargs(sp: SamplingParams) -> dict[str, Any]:
    """kwargs for raw ``messages.stream`` (direct Anthropic fallback).

    Thinking rides in ``extra_body`` so it is forwarded verbatim regardless of
    SDK-version param coverage (required on anthropic <0.75, still valid on the
    pinned 0.109).
    """
    kwargs = _anthropic_common(sp)
    if sp.reasoning_on:
        budget = _budget_from_reasoning(sp.reasoning or {})
        kwargs["extra_body"] = {
            "thinking": {"type": "enabled", "budget_tokens": budget}
        }
    return kwargs
