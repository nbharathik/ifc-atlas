"""Provider parameter mapper - the reasoning/sampling compatibility rules.

These are the correctness core of the Model Registry: reasoning is mutually
exclusive with temperature/top_p on both providers, and getting the omission
wrong is a hard 400 mid-stream. No network - pure kwarg-shape assertions.
"""

from app.services.model_registry import ModelEntry
from app.services import provider_params as pp


def mk(**kw) -> ModelEntry:
    base = dict(id="x", provider="openai", model_id="m", display_name="M")
    base.update(kw)
    return ModelEntry(**base)


# ── resolve_sampling ─────────────────────────────────────────────────────────

def test_resolve_none_entry_returns_none():
    assert pp.resolve_sampling(None) is None


def test_resolve_uses_entry_temperature():
    sp = pp.resolve_sampling(mk(temperature=0.42))
    assert sp.temperature == 0.42


def test_resolve_temperature_override_wins():
    sp = pp.resolve_sampling(mk(temperature=0.42), temperature_override=0.1)
    assert sp.temperature == 0.1


# ── OpenAI: reasoning omits temperature + top_p ──────────────────────────────

def test_openai_reasoning_omits_temp_and_top_p():
    sp = pp.resolve_sampling(mk(provider="openai", temperature=0.0, top_p=0.5,
                                reasoning={"effort": "high"}))
    lc = pp.langchain_llm_kwargs("openai", sp)
    assert "temperature" not in lc and "top_p" not in lc
    assert lc["reasoning_effort"] == "high"

    create = pp.openai_create_kwargs(sp)
    assert "temperature" not in create and "top_p" not in create
    assert create["extra_body"]["reasoning_effort"] == "high"


def test_openai_reasoning_routes_langchain_to_responses_api():
    # gpt-5-family 400s on reasoning_effort + function tools over
    # /v1/chat/completions - reasoning entries must flip to /v1/responses.
    sp = pp.resolve_sampling(mk(provider="openai", reasoning={"effort": "high"}))
    assert pp.langchain_llm_kwargs("openai", sp)["use_responses_api"] is True
    # OpenRouter has no /v1/responses; non-reasoning OpenAI stays on chat.
    assert "use_responses_api" not in pp.langchain_llm_kwargs("openrouter", sp)
    plain = pp.resolve_sampling(mk(provider="openai"))
    assert "use_responses_api" not in pp.langchain_llm_kwargs("openai", plain)


def test_openai_non_reasoning_keeps_temp_and_top_p():
    sp = pp.resolve_sampling(mk(provider="openai", temperature=0.2, top_p=0.9,
                                max_output_tokens=1000))
    lc = pp.langchain_llm_kwargs("openai", sp)
    assert lc["temperature"] == 0.2 and lc["top_p"] == 0.9 and lc["max_tokens"] == 1000
    assert "reasoning_effort" not in lc

    create = pp.openai_create_kwargs(sp)
    assert create["temperature"] == 0.2 and create["top_p"] == 0.9
    assert "extra_body" not in create


# ── OpenAI wire format: max_completion_tokens + locked-sampling models ───────

def test_openai_raw_create_uses_max_completion_tokens():
    sp = pp.resolve_sampling(mk(provider="openai", max_output_tokens=1000))
    create = pp.openai_create_kwargs(sp, "gpt-5.4-nano")
    assert create["max_completion_tokens"] == 1000
    assert "max_tokens" not in create


def test_openrouter_raw_create_keeps_max_tokens():
    sp = pp.resolve_sampling(mk(provider="openrouter", max_output_tokens=1000))
    create = pp.openrouter_create_kwargs(sp, "deepseek/deepseek-v3.2")
    assert create["max_tokens"] == 1000
    assert "max_completion_tokens" not in create


def test_gpt5_family_locks_temperature_and_top_p():
    sp = pp.resolve_sampling(mk(provider="openai", temperature=0.3, top_p=0.9))
    for model in ("gpt-5.4-nano", "gpt-5.5", "o3-mini", "openai/gpt-5.4"):
        create = pp.openai_create_kwargs(sp, model)
        assert "temperature" not in create and "top_p" not in create, model
    lc = pp.langchain_llm_kwargs("openai", sp, "gpt-5.4-nano")
    assert "temperature" not in lc and "top_p" not in lc


def test_gpt5_chat_and_older_models_keep_temperature():
    sp = pp.resolve_sampling(mk(provider="openai", temperature=0.3))
    for model in ("gpt-5-chat-latest", "gpt-4.1", "gpt-4o", None):
        create = pp.openai_create_kwargs(sp, model)
        assert create["temperature"] == 0.3, model


def test_openai_budget_only_maps_to_effort():
    sp = pp.resolve_sampling(mk(provider="openai", reasoning={"budget_tokens": 2048}))
    lc = pp.langchain_llm_kwargs("openai", sp)
    assert lc["reasoning_effort"] == "low"  # 2048 → low bucket


# ── Anthropic: thinking forces temp=1, drops top_p, max>budget ───────────────

def test_anthropic_thinking_rules():
    sp = pp.resolve_sampling(mk(provider="anthropic", temperature=0.0, top_p=0.5,
                                reasoning={"budget_tokens": 8000}))
    lc = pp.langchain_llm_kwargs("anthropic", sp)
    assert lc["temperature"] == 1.0
    assert "top_p" not in lc
    assert lc["thinking"] == {"type": "enabled", "budget_tokens": 8000}
    assert lc["max_tokens"] > 8000

    stream = pp.anthropic_stream_kwargs(sp)
    assert stream["temperature"] == 1.0 and "top_p" not in stream
    assert stream["extra_body"]["thinking"]["budget_tokens"] == 8000
    assert stream["max_tokens"] > 8000


def test_anthropic_effort_only_maps_to_budget():
    sp = pp.resolve_sampling(mk(provider="anthropic", reasoning={"effort": "low"}))
    lc = pp.langchain_llm_kwargs("anthropic", sp)
    assert lc["thinking"]["budget_tokens"] == pp._EFFORT_TO_BUDGET["low"]


def test_anthropic_non_reasoning_keeps_temp_and_top_p():
    sp = pp.resolve_sampling(mk(provider="anthropic", temperature=0.3, top_p=0.8,
                                max_output_tokens=2048))
    lc = pp.langchain_llm_kwargs("anthropic", sp)
    assert lc["temperature"] == 0.3 and lc["top_p"] == 0.8 and lc["max_tokens"] == 2048
    assert "thinking" not in lc


def test_default_max_tokens_applied_when_unset():
    sp = pp.resolve_sampling(mk(provider="openai", temperature=0.2))
    assert pp.openai_create_kwargs(sp)["max_completion_tokens"] == pp.DEFAULT_MAX_TOKENS
    assert pp.openrouter_create_kwargs(sp)["max_tokens"] == pp.DEFAULT_MAX_TOKENS


# ── 400 self-heal: _pop_unsupported_param ────────────────────────────────────

def _bad_request(code, param) -> Exception:
    e = Exception("boom")
    e.body = {"error": {"code": code, "param": param,
                        "message": f"Unsupported parameter: '{param}'"}}
    return e


def test_pop_unsupported_param_removes_named_kwarg():
    from app.services.llm_service import _pop_unsupported_param
    kwargs = {"temperature": 0.3, "max_tokens": 4096}
    assert _pop_unsupported_param(_bad_request("unsupported_parameter", "max_tokens"), kwargs)
    assert kwargs == {"temperature": 0.3}
    assert _pop_unsupported_param(_bad_request("unsupported_value", "temperature"), kwargs)
    assert kwargs == {}


def test_pop_unsupported_param_handles_extra_body_and_unknowns():
    from app.services.llm_service import _pop_unsupported_param
    kwargs = {"extra_body": {"reasoning_effort": "high"}}
    assert _pop_unsupported_param(
        _bad_request("unsupported_parameter", "reasoning_effort"), kwargs)
    assert kwargs == {}
    # Unknown param / non-param errors must not claim a retry.
    assert not _pop_unsupported_param(_bad_request("unsupported_parameter", "nope"), {})
    assert not _pop_unsupported_param(Exception("plain"), {"temperature": 0.3})


def test_pop_unsupported_param_handles_code_none():
    # gpt-5.5 rejects reasoning_effort + function tools with code=None - the
    # param field alone must be enough to trigger the strip-and-retry.
    from app.services.llm_service import _pop_unsupported_param
    kwargs = {"max_completion_tokens": 4096,
              "extra_body": {"reasoning_effort": "high"}}
    assert _pop_unsupported_param(_bad_request(None, "reasoning_effort"), kwargs)
    assert kwargs == {"max_completion_tokens": 4096}
    assert not _pop_unsupported_param(_bad_request(None, None), kwargs)
