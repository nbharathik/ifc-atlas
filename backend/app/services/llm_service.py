"""
LLM provider abstraction with structured tool calling.

Supports OpenAI and Anthropic, with streaming responses and a tool-calling
loop that lets the model query the IFC backend to answer user questions.

Agent presets (see agent_registry.py) override the system prompt, provider,
model, temperature, and the allowed tool catalogue per turn.
"""

import asyncio
import json
import logging
from typing import Any, AsyncGenerator, Awaitable, Callable, Iterable, Optional

from app.core.config import (
    OPENROUTER_BASE_URL,
    EDIT_MODE_ENABLED,
)
from app.services.secrets_service import get_api_key
from app.services.agent_registry import AgentPreset, get_agent
from app.services.budget_tracker import budget_tracker
from app.services.tool_memo import tool_memo_cache
from app.services.tools import (
    get_openai_tools,
    get_anthropic_tools,
    execute_tool_off_loop,
    format_tool_result,
)
from app.models.ifc_models import ChatAttachment, ChatMessage

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Per-turn cost telemetry
# ---------------------------------------------------------------------------

# Approximate cost per 1 M tokens (USD) - (input_rate, output_rate).
# Best-effort; OpenRouter adds its own margin on top of provider pricing.
_COST_PER_1M: dict[str, tuple[float, float]] = {
    # OpenAI
    "gpt-4o":               (5.0,  15.0),
    "gpt-4o-mini":          (0.15,  0.6),
    "gpt-4-turbo":          (10.0, 30.0),
    "gpt-4-turbo-preview":  (10.0, 30.0),
    # Anthropic
    "claude-sonnet-4-20250514":   (3.0,  15.0),
    "claude-haiku-4-5-20251001":  (0.8,   4.0),
    "claude-opus-4-5":            (15.0, 75.0),
    # OpenRouter slugs (provider margin baked in, ±20 %)
    "anthropic/claude-sonnet-4-20250514":   (3.6,  18.0),
    "anthropic/claude-haiku-4-5-20251001":  (1.0,   4.8),
    "openai/gpt-4o":                        (6.0,  18.0),
    "deepseek/deepseek-chat":               (0.14,  0.28),
    "qwen/qwen-2.5-72b-instruct":           (0.2,   0.2),
    "meta-llama/llama-3.3-70b-instruct":    (0.1,   0.3),
}


def _registry_rates(model: str) -> Optional[tuple[float, float]]:
    """Look up $/1M rates for a provider model id in the model registry.

    The registry is UI-editable and covers the models people actually run;
    the static ``_COST_PER_1M`` table only knows a handful of legacy ids.
    Registry entries are keyed by slug but priced per ``model_id`` — when
    several entries share a model_id the first priced one wins.
    """
    try:
        from app.services.model_registry import model_registry
        for entry in model_registry.all():
            if (
                entry.model_id == model
                and entry.input_cost_per_1m is not None
                and entry.output_cost_per_1m is not None
            ):
                return (entry.input_cost_per_1m, entry.output_cost_per_1m)
    except Exception:  # pragma: no cover - registry must never break costing
        return None
    return None


def _estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """Return approximate USD cost for a turn. Returns -1.0 when rates unknown."""
    rates = _registry_rates(model) or _COST_PER_1M.get(model)
    if rates is None:
        return -1.0
    in_rate, out_rate = rates
    return (input_tokens * in_rate + output_tokens * out_rate) / 1_000_000


def _usage_event(
    model: str,
    provider: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
) -> dict:
    cost = _estimate_cost(model, input_tokens, output_tokens)
    ev: dict = {
        "type": "usage",
        "model": model,
        "provider": provider,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
    }
    if cache_read_tokens:
        ev["cache_read_tokens"] = cache_read_tokens
    if cache_creation_tokens:
        ev["cache_creation_tokens"] = cache_creation_tokens
    if cache_read_tokens or cache_creation_tokens:
        billable = input_tokens - cache_read_tokens
        total = input_tokens
        ev["cache_hit_ratio"] = round(cache_read_tokens / total, 3) if total else 0.0
        ev["cached_cost_usd"] = round(
            _estimate_cost(model, billable, output_tokens), 6
        ) if billable >= 0 else None
    if cost >= 0:
        ev["cost_usd"] = round(cost, 6)
    return ev


# ---------------------------------------------------------------------------
# Anthropic prompt caching helpers
# ---------------------------------------------------------------------------

def _anthropic_system_with_cache(system: str) -> list[dict]:
    """Wrap system text in an Anthropic content block with ephemeral cache_control."""
    return [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]


def _anthropic_tools_with_cache(tools: list[dict]) -> list[dict]:
    """Add ephemeral cache_control to the last tool definition.

    Anthropic caches up to and including the last block that carries
    cache_control, so marking only the last tool caches the entire tool list.
    """
    if not tools:
        return tools
    result = list(tools)
    last = dict(result[-1])
    last["cache_control"] = {"type": "ephemeral"}
    result[-1] = last
    return result


# Read-only model tools whose results are safe to memoize within a single turn.
_MEMOIZABLE_TOOLS = frozenset({
    "get_project_info",
    "get_model_stats",
    "get_storeys",
    "get_all_property_names",
    "get_quantities_summary",
    "get_element_details",
    "get_elements_by_type",
    "get_elements_by_storey",
    "search_elements",
    "search_by_property",
    "execute_ifc_query_code",
    "get_connected_elements",
    "get_element_material",
    "get_openings_for_element",
    "find_elements_by_type_name",
})


# Legacy default system prompt - used only when no agent preset is chosen.
SYSTEM_PROMPT = """You are an AI assistant embedded in an IFC/BIM viewer application. You help users understand and query Building Information Models (BIM) loaded in the viewer.

You have tools to query and drive the currently loaded IFC model. Use them to answer questions accurately - do not guess when you can look up the data.

Guidelines:
- Use tools to retrieve real data before answering questions about the model.
- Reference specific element Express IDs, types, storeys, and properties when relevant.
- When asked to find or filter elements, call the appropriate tool and summarize the results.
- Use highlight_elements when the user wants to see or locate elements.
- Use select_element to focus a single element and open its properties panel.
- Use isolate_elements when the user wants to focus on a subset (others get hidden).
  Pass an empty array to clear isolation.
- Use show_all_elements to restore full visibility.
- Use get_quantities_summary for aggregate measurements (total area, total volume,
  totals per storey, etc.) instead of summing element-by-element.
- Be concise but thorough. Use structured formatting when listing data.
- If no model is loaded, tell the user to upload one first.
"""


# -- Attachment helpers ---------------------------------------------------

# Cap on inlined text-attachment length so we never blow through context.
MAX_TEXT_ATTACHMENT_CHARS = 40_000


def _format_text_attachment(att: ChatAttachment) -> str:
    import base64 as _b64

    try:
        raw = _b64.b64decode(att.data_base64).decode("utf-8", errors="replace")
    except Exception:
        raw = "(binary content could not be decoded as text)"
    if len(raw) > MAX_TEXT_ATTACHMENT_CHARS:
        raw = raw[:MAX_TEXT_ATTACHMENT_CHARS] + "\n\n... (attachment truncated)"
    header = f"\n\n--- attached file: {att.name} ({att.mime or 'text/plain'}) ---\n"
    return header + raw + "\n--- end of attachment ---\n"


def _openai_user_content(message: str, attachments: Iterable[ChatAttachment]):
    """Build an OpenAI Chat Completions user message content.

    Mixed-content form (list of parts) is used when any image is attached;
    otherwise we stay with a plain string for minimum tokens.
    """
    atts = list(attachments)
    images = [a for a in atts if a.kind == "image"]
    texts = [a for a in atts if a.kind in ("text", "ids")]

    body = message
    for att in texts:
        body += _format_text_attachment(att)

    if not images:
        return body

    parts: list[dict] = [{"type": "text", "text": body or "(see attached image)"}]
    for img in images:
        mime = img.mime or "image/png"
        parts.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:{mime};base64,{img.data_base64}",
                "detail": "auto",
            },
        })
    return parts


def _anthropic_user_content(message: str, attachments: Iterable[ChatAttachment]):
    """Build an Anthropic messages user content list."""
    atts = list(attachments)
    images = [a for a in atts if a.kind == "image"]
    texts = [a for a in atts if a.kind in ("text", "ids")]

    body = message
    for att in texts:
        body += _format_text_attachment(att)

    parts: list[dict] = []
    for img in images:
        mime = img.mime or "image/png"
        parts.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": mime,
                "data": img.data_base64,
            },
        })
    parts.append({"type": "text", "text": body or "(see attached image)"})
    return parts


def _filter_tools(tools: list[dict], allowed: Optional[frozenset[str]], key: str) -> list[dict]:
    if not allowed:
        return tools
    filtered = []
    for t in tools:
        name = t.get(key) if isinstance(t, dict) else None
        if key == "function":
            # OpenAI form: {type, function: {name, ...}}
            name = t.get("function", {}).get("name")
        if name in allowed:
            filtered.append(t)
    return filtered


def _ui_action_events(result: dict) -> list[dict]:
    """Translate a tool result's "action" key into WebSocket events for the
    frontend. Tools that drive the 3D viewer (highlight/select/isolate/
    show_all) return an action marker; this function maps those markers to
    the wire-level event dicts that chat_routes forwards as JSON.
    """
    action = result.get("action")
    if action in ("highlight", "ids_highlight"):
        return [{"type": "highlight", "element_ids": result.get("element_ids", [])}]
    if action == "select":
        return [{"type": "select", "element_id": result["element_id"]}]
    if action == "isolate":
        return [{"type": "isolate", "element_ids": result.get("element_ids", [])}]
    if action == "show_all":
        return [{"type": "show_all"}]
    if action == "clip_section_box":
        return [{"type": "clip_section_box", "element_id": result["element_id"]}]
    if action == "metadata_changed":
        changed_ids: list[int] = result.get("changed_ids", [])
        event: dict = {
            "type": "metadata_changed",
            "changed_ids": changed_ids,
            "description": result.get("description", ""),
        }
        # Include rename info so the frontend can patch its tree in-place.
        if "new_name" in result and "element_id" in result:
            event["renamed"] = [{"id": result["element_id"], "new_name": result["new_name"]}]

        events: list[dict] = [event]

        # Compute dirty set via entity dependency graph and emit
        # entity_delta so fragment loaders can update only affected geometry.
        if changed_ids:
            try:
                from app.services.entity_dependency_graph import get_graph
                graph = get_graph()
                if graph.node_count > 0:
                    dirty = graph.compute_dirty_set(changed_ids, max_depth=1)
                    dirty_extra = sorted(dirty - set(changed_ids))
                    if dirty_extra:
                        events.append({
                            "type": "entity_delta",
                            "changed_ids": changed_ids,
                            "dirty_ids": list(dirty),
                            "delta_type": "metadata",
                        })
            except Exception:
                pass

        return events
    return []


def _build_messages_openai(
    message: str,
    history: list[ChatMessage],
    attachments: list[ChatAttachment],
) -> list[dict]:
    messages = []
    for msg in history[-20:]:
        # History rows only carry plain text; attachments are sent on the
        # current turn only to keep context small.
        messages.append({"role": msg.role, "content": msg.content})
    messages.append({
        "role": "user",
        "content": _openai_user_content(message, attachments),
    })
    return messages


def _build_messages_anthropic(
    message: str,
    history: list[ChatMessage],
    attachments: list[ChatAttachment],
) -> list[dict]:
    messages = []
    for msg in history[-20:]:
        messages.append({"role": msg.role, "content": msg.content})
    messages.append({
        "role": "user",
        "content": _anthropic_user_content(message, attachments),
    })
    return messages


# Maximum number of tool-call rounds to prevent infinite loops
MAX_TOOL_ROUNDS = 5
ToolExecutor = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


# ---------------------------------------------------------------------------
# Sampling kwargs - Model Registry → provider API (see provider_params.py)
# ---------------------------------------------------------------------------
# The direct streamers below are FALLBACKS (they run only when the LangGraph
# path can't build a graph - no tools / missing key). They receive the same
# resolved ``SamplingParams`` so a graph failure that falls back here does not
# re-send the bad temperature/top_p combination that the mapper guards against.

def _openai_call_kwargs(
    sampling: Any,
    temperature: Optional[float],
    model: Optional[str] = None,
    *,
    openrouter: bool = False,
) -> dict:
    from app.services.provider_params import (
        SamplingParams,
        openai_create_kwargs,
        openrouter_create_kwargs,
    )
    if sampling is None:
        # Legacy path (no registry entry): same defaults as before, but routed
        # through the mapper so model-specific wire rules still apply.
        sampling = SamplingParams(
            temperature=temperature if temperature is not None else 0.3
        )
    if openrouter:
        return openrouter_create_kwargs(sampling, model)
    return openai_create_kwargs(sampling, model)


def _pop_unsupported_param(e: Exception, call_kwargs: dict) -> bool:
    """Self-heal an OpenAI-format 400 that names a parameter we sent.

    Providers reject parameters in model-specific ways we cannot fully predict
    (``unsupported_parameter`` for e.g. ``max_tokens`` on newer models,
    ``unsupported_value`` for locked temperature, and ``code: None`` cases like
    ``reasoning_effort`` + function tools on gpt-5.5). When the error names a
    param present in ``call_kwargs`` (or its ``extra_body``), drop it and report
    True so the caller retries - the model then runs with its own default
    instead of failing the whole chat turn. Only our optional sampling params
    live in ``call_kwargs``, so required arguments (model/messages/tools) can
    never be stripped.
    """
    body = getattr(e, "body", None)
    err = body.get("error") if isinstance(body, dict) else None
    if not isinstance(err, dict):
        err = body if isinstance(body, dict) else {}
    param = err.get("param")
    if not isinstance(param, str) or not param:
        return False
    if param in call_kwargs:
        call_kwargs.pop(param)
    elif param in (call_kwargs.get("extra_body") or {}):
        call_kwargs["extra_body"].pop(param)
        if not call_kwargs["extra_body"]:
            call_kwargs.pop("extra_body")
    else:
        return False
    logger.warning("Model rejected parameter %r - retrying without it.", param)
    return True


def _anthropic_call_kwargs(sampling: Any, temperature: Optional[float]) -> dict:
    if sampling is not None:
        from app.services.provider_params import anthropic_stream_kwargs
        return anthropic_stream_kwargs(sampling)
    return {
        "temperature": temperature if temperature is not None else 0.3,
        "max_tokens": 4096,
    }


async def stream_openai(
    message: str,
    history: list[ChatMessage],
    model: Optional[str] = None,
    temperature: Optional[float] = None,
    tool_executor: Optional[ToolExecutor] = None,
    system_prompt: Optional[str] = None,
    allowed_tools: Optional[frozenset[str]] = None,
    attachments: Optional[list[ChatAttachment]] = None,
    sampling: Any = None,
) -> AsyncGenerator[dict, None]:
    """
    Stream OpenAI responses with tool calling.
    Yields dicts: {"type": "chunk"|"tool_call"|"tool_result"|"highlight", ...}
    """
    import openai

    client = openai.AsyncOpenAI(api_key=get_api_key("openai"))
    model = model or "gpt-4o"
    tools = _filter_tools(get_openai_tools(), allowed_tools, key="function")

    system = system_prompt or SYSTEM_PROMPT
    messages = [{"role": "system", "content": system}] + _build_messages_openai(
        message, history, attachments or []
    )
    _call_kwargs = _openai_call_kwargs(sampling, temperature, model)

    _total_input = 0
    _total_output = 0

    for _round in range(MAX_TOOL_ROUNDS):
        while True:
            try:
                stream = await client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=tools,
                    stream=True,
                    stream_options={"include_usage": True},
                    **_call_kwargs,
                )
                break
            except openai.BadRequestError as e:
                # Self-heal model-specific param rejections (mutates _call_kwargs
                # so later rounds skip the param too); anything else re-raises.
                if not _pop_unsupported_param(e, _call_kwargs):
                    raise

        # Accumulate tool calls and text content from the streamed response
        tool_calls: dict[int, dict] = {}  # index -> {id, name, arguments}
        text_content = ""

        async for chunk in stream:
            # Final usage-only chunk has no choices
            if not chunk.choices:
                raw_usage = getattr(chunk, "usage", None)
                if raw_usage is not None:
                    _total_input += getattr(raw_usage, "prompt_tokens", 0)
                    _total_output += getattr(raw_usage, "completion_tokens", 0)
                continue

            delta = chunk.choices[0].delta

            # Stream text content
            if delta.content:
                text_content += delta.content
                yield {"type": "chunk", "content": delta.content}

            # Accumulate tool call deltas
            if delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index
                    if idx not in tool_calls:
                        tool_calls[idx] = {
                            "id": tc.id or "",
                            "name": tc.function.name or "" if tc.function else "",
                            "arguments": "",
                        }
                    if tc.id:
                        tool_calls[idx]["id"] = tc.id
                    if tc.function:
                        if tc.function.name:
                            tool_calls[idx]["name"] = tc.function.name
                        if tc.function.arguments:
                            tool_calls[idx]["arguments"] += tc.function.arguments

        # If no tool calls, we're done
        if not tool_calls:
            break

        # Build the assistant message with tool calls for the conversation
        assistant_msg: dict = {"role": "assistant", "content": text_content or None}
        assistant_msg["tool_calls"] = [
            {
                "id": tc["id"],
                "type": "function",
                "function": {
                    "name": tc["name"],
                    "arguments": tc["arguments"],
                },
            }
            for tc in tool_calls.values()
        ]
        messages.append(assistant_msg)

        # Execute each tool call and add results
        for tc in tool_calls.values():
            name = tc["name"]
            try:
                args = json.loads(tc["arguments"]) if tc["arguments"] else {}
            except json.JSONDecodeError:
                args = {}

            yield {"type": "tool_call", "name": name, "arguments": args}

            if tool_executor is not None:
                result = await tool_executor(name, args)
            else:
                result = await execute_tool_off_loop(name, args)
            if not isinstance(result, dict):
                result = {"result": result}

            # Forward UI-action events to the frontend
            if not result.get("_executed_on_client"):
                for ev in _ui_action_events(result):
                    yield ev

            executed_on = "client" if result.get("_executed_on_client") else "server"
            result_for_text = {k: v for k, v in result.items() if k != "_executed_on_client"}

            result_text = format_tool_result(result_for_text)
            yield {
                "type": "tool_result",
                "name": name,
                "result": result_text,
                "executed_on": executed_on,
            }

            messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": result_text,
            })

        # Continue the loop so the model can process tool results
    else:
        yield {"type": "chunk", "content": "\n\n(Reached maximum tool call depth)"}

    if _total_input or _total_output:
        yield _usage_event(model, "openai", _total_input, _total_output)


async def stream_anthropic(
    message: str,
    history: list[ChatMessage],
    model: Optional[str] = None,
    temperature: Optional[float] = None,
    tool_executor: Optional[ToolExecutor] = None,
    system_prompt: Optional[str] = None,
    allowed_tools: Optional[frozenset[str]] = None,
    attachments: Optional[list[ChatAttachment]] = None,
    sampling: Any = None,
) -> AsyncGenerator[dict, None]:
    """
    Stream Anthropic responses with tool calling.

    Uses the Anthropic SDK's native streaming API (client.messages.stream)
    so text deltas reach the UI as they are generated, matching the OpenAI
    path. The previous non-streaming client.messages.create() implementation
    caused assistant replies to appear all-at-once after a long wait, which
    felt broken compared to the OpenAI provider.

    Yields dicts: {"type": "chunk"|"tool_call"|"tool_result"|...}
    """
    import anthropic

    client = anthropic.AsyncAnthropic(api_key=get_api_key("anthropic"))
    model = model or "claude-sonnet-4-20250514"
    raw_tools = _filter_tools(get_anthropic_tools(), allowed_tools, key="name")
    tools = _anthropic_tools_with_cache(raw_tools)

    system_str = system_prompt or SYSTEM_PROMPT
    system = _anthropic_system_with_cache(system_str)
    messages = _build_messages_anthropic(message, history, attachments or [])
    _call_kwargs = _anthropic_call_kwargs(sampling, temperature)

    _total_input = 0
    _total_output = 0
    _total_cache_read = 0
    _total_cache_creation = 0
    # Per-turn tool-result memo: (name, args_key) -> result_text
    _tool_memo: dict[tuple[str, str], str] = {}

    for _round in range(MAX_TOOL_ROUNDS):
        async with client.messages.stream(
            model=model,
            system=system,
            messages=messages,
            tools=tools,
            **_call_kwargs,
        ) as stream:
            # Stream text deltas to the UI as they arrive
            async for text_delta in stream.text_stream:
                if text_delta:
                    yield {"type": "chunk", "content": text_delta}

            # Once the stream completes we have a final Message with the
            # fully-assembled content blocks (text + tool_use). Use these
            # for the tool-calling loop so the turn's message history is
            # preserved exactly as the model produced it.
            final_message = await stream.get_final_message()

        raw_usage = getattr(final_message, "usage", None)
        if raw_usage is not None:
            _total_input += getattr(raw_usage, "input_tokens", 0)
            _total_output += getattr(raw_usage, "output_tokens", 0)
            _total_cache_read += getattr(raw_usage, "cache_read_input_tokens", 0) or 0
            _total_cache_creation += getattr(raw_usage, "cache_creation_input_tokens", 0) or 0

        assistant_content = list(final_message.content)
        has_tool_use = False
        tool_result_cache: dict[str, str] = {}  # tool_use_id -> result_text

        for block in assistant_content:
            if block.type == "tool_use":
                has_tool_use = True

                name = block.name
                args = block.input if isinstance(block.input, dict) else {}

                yield {"type": "tool_call", "name": name, "arguments": args}

                # Tool-result memoization: skip re-execution for identical read-only calls
                _memo_key = (name, json.dumps(args, sort_keys=True)) if name in _MEMOIZABLE_TOOLS else None
                if _memo_key and _memo_key in _tool_memo:
                    result_text = _tool_memo[_memo_key]
                    result = {"_memo_hit": True}
                    executed_on = "server"
                    yield {
                        "type": "tool_result",
                        "name": name,
                        "result": result_text,
                        "executed_on": executed_on,
                    }
                    tool_result_cache[block.id] = result_text
                    continue

                if tool_executor is not None:
                    result = await tool_executor(name, args)
                else:
                    result = await execute_tool_off_loop(name, args)
                if not isinstance(result, dict):
                    result = {"result": result}

                if not result.get("_executed_on_client"):
                    for ev in _ui_action_events(result):
                        yield ev

                executed_on = "client" if result.get("_executed_on_client") else "server"
                result_for_text = {k: v for k, v in result.items() if k != "_executed_on_client"}

                result_text = format_tool_result(result_for_text)
                # Store in per-turn memo so duplicate read-only calls are short-circuited
                if _memo_key:
                    _tool_memo[_memo_key] = result_text
                tool_result_cache[block.id] = result_text
                yield {
                    "type": "tool_result",
                    "name": name,
                    "result": result_text,
                    "executed_on": executed_on,
                }

        # Add assistant message with all content blocks
        messages.append({"role": "assistant", "content": assistant_content})

        if not has_tool_use:
            break

        # Add cached tool results for each tool_use block
        tool_results = []
        for block in assistant_content:
            if block.type == "tool_use":
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": tool_result_cache[block.id],
                })

        messages.append({"role": "user", "content": tool_results})
    else:
        yield {"type": "chunk", "content": "\n\n(Reached maximum tool call depth)"}

    if _total_input or _total_output:
        yield _usage_event(
            model, "anthropic", _total_input, _total_output,
            cache_read_tokens=_total_cache_read,
            cache_creation_tokens=_total_cache_creation,
        )


async def stream_openrouter(
    message: str,
    history: list[ChatMessage],
    model: Optional[str] = None,
    temperature: Optional[float] = None,
    tool_executor: Optional[ToolExecutor] = None,
    system_prompt: Optional[str] = None,
    allowed_tools: Optional[frozenset[str]] = None,
    attachments: Optional[list[ChatAttachment]] = None,
    sampling: Any = None,
) -> AsyncGenerator[dict, None]:
    """Stream OpenRouter responses via the OpenAI-compatible API.

    OpenRouter exposes the same wire format as OpenAI Chat Completions.
    We point the AsyncOpenAI client at the OpenRouter base URL and pass
    OPENROUTER_API_KEY.  Streaming, tool calling, and message history work
    identically to stream_openai - the only difference is the endpoint and
    key.

    Default model: ``anthropic/claude-sonnet-4-20250514`` (best quality/cost
    ratio on OpenRouter as of 2026-05).  Callers can override with any
    OpenRouter model slug.
    """
    import openai

    client = openai.AsyncOpenAI(
        api_key=get_api_key("openrouter"),
        base_url=OPENROUTER_BASE_URL,
        default_headers={
            "HTTP-Referer": "https://nbharathik.github.io/ifc-atlas/",
            "X-Title": "IFC Atlas",
        },
    )
    model = model or "anthropic/claude-sonnet-4-20250514"
    tools = _filter_tools(get_openai_tools(), allowed_tools, key="function")

    system = system_prompt or SYSTEM_PROMPT
    messages = [{"role": "system", "content": system}] + _build_messages_openai(
        message, history, attachments or []
    )
    _call_kwargs = _openai_call_kwargs(sampling, temperature, model, openrouter=True)

    _total_input = 0
    _total_output = 0

    for _round in range(MAX_TOOL_ROUNDS):
        while True:
            try:
                stream = await client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=tools,
                    stream=True,
                    stream_options={"include_usage": True},
                    **_call_kwargs,
                )
                break
            except openai.BadRequestError as e:
                if not _pop_unsupported_param(e, _call_kwargs):
                    raise

        tool_calls: dict[int, dict] = {}
        text_content = ""

        async for chunk in stream:
            if not chunk.choices:
                raw_usage = getattr(chunk, "usage", None)
                if raw_usage is not None:
                    _total_input += getattr(raw_usage, "prompt_tokens", 0)
                    _total_output += getattr(raw_usage, "completion_tokens", 0)
                continue

            delta = chunk.choices[0].delta

            if delta.content:
                text_content += delta.content
                yield {"type": "chunk", "content": delta.content}

            if delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index
                    if idx not in tool_calls:
                        tool_calls[idx] = {
                            "id": tc.id or "",
                            "name": tc.function.name or "" if tc.function else "",
                            "arguments": "",
                        }
                    if tc.id:
                        tool_calls[idx]["id"] = tc.id
                    if tc.function:
                        if tc.function.name:
                            tool_calls[idx]["name"] = tc.function.name
                        if tc.function.arguments:
                            tool_calls[idx]["arguments"] += tc.function.arguments

        if not tool_calls:
            break

        assistant_msg: dict = {"role": "assistant", "content": text_content or None}
        assistant_msg["tool_calls"] = [
            {
                "id": tc["id"],
                "type": "function",
                "function": {"name": tc["name"], "arguments": tc["arguments"]},
            }
            for tc in tool_calls.values()
        ]
        messages.append(assistant_msg)

        for tc in tool_calls.values():
            name = tc["name"]
            try:
                args = json.loads(tc["arguments"]) if tc["arguments"] else {}
            except json.JSONDecodeError:
                args = {}

            yield {"type": "tool_call", "name": name, "arguments": args}

            if tool_executor is not None:
                result = await tool_executor(name, args)
            else:
                result = await execute_tool_off_loop(name, args)
            if not isinstance(result, dict):
                result = {"result": result}

            if not result.get("_executed_on_client"):
                for ev in _ui_action_events(result):
                    yield ev

            executed_on = "client" if result.get("_executed_on_client") else "server"
            result_for_text = {k: v for k, v in result.items() if k != "_executed_on_client"}

            result_text = format_tool_result(result_for_text)
            yield {
                "type": "tool_result",
                "name": name,
                "result": result_text,
                "executed_on": executed_on,
            }

            messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": result_text,
            })
    else:
        yield {"type": "chunk", "content": "\n\n(Reached maximum tool call depth)"}

    if _total_input or _total_output:
        yield _usage_event(model, "openrouter", _total_input, _total_output)


# ---------------------------------------------------------------------------
# Provider error classification
# ---------------------------------------------------------------------------

_PROVIDER_LABELS = {
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "openrouter": "OpenRouter",
}

# One automatic retry for transient stream failures, after this backoff.
_STREAM_RETRY_BACKOFF_S = 1.5

# Notice streamed (as a normal chunk, which chat_routes already forwards)
# when a retry restarts a stream that had already sent content, so the user
# understands why the answer starts over instead of seeing a dead turn.
_RETRY_NOTICE = (
    "\n\n(Connection to the model was interrupted - retrying; "
    "the answer restarts below.)\n\n"
)


def _exc_line(exc: Exception) -> str:
    """First line of an exception message, bounded, for one-line logging."""
    return (str(exc) or type(exc).__name__).splitlines()[0][:200]


def _is_transient_stream_error(exc: Exception) -> bool:
    """True when a provider stream failure is worth one automatic retry.

    Covers connection resets/aborts, provider 5xx (including Anthropic's
    529 overloaded), timeouts, and incomplete/interrupted streams. Quota,
    auth, and rate-limit (429) errors are deliberately excluded - retrying
    those either cannot succeed or makes them worse, and
    ``_friendly_provider_error`` already gives them clean messages.
    """
    status = getattr(exc, "status_code", None)
    if isinstance(status, int) and status >= 500:
        return True
    cls = type(exc).__name__.lower()
    if any(n in cls for n in (
        "apiconnectionerror",
        "connectionerror",
        "connectionreset",
        "internalservererror",
        "remoteprotocolerror",
        "incompleteread",
        "timeout",
    )):
        return True
    text = (str(exc) or "").lower()
    return any(n in text for n in (
        "connection reset",
        "connection aborted",
        "connection error",
        "server disconnected",
        "incomplete chunked read",
        "incomplete stream",
        "peer closed connection",
        "timed out",
        "temporarily unavailable",
        "overloaded",
        "internal server error",
        "bad gateway",
        "service unavailable",
        "gateway timeout",
    ))


def _friendly_provider_error(provider: str, exc: Exception) -> Optional[str]:
    """Map a provider SDK exception to a short, user-facing message - or None.

    Returns a clean sentence for *expected operational* failures (out of
    credit/quota, bad/missing key, transient rate limit, connectivity). These
    are normal account/network conditions the user must resolve, NOT code bugs,
    so callers log them as a single WARNING line instead of dumping a full
    stack trace into the console.

    Detection is import-free on purpose: it reads ``status_code``/``code`` plus
    the message text, so the one helper covers both the OpenAI and Anthropic
    exception hierarchies (which are imported lazily inside the streamers).
    Returns None for anything unrecognised, so the caller can keep the full
    traceback for genuine bugs.
    """
    label = _PROVIDER_LABELS.get(provider, provider.title() or provider)
    status = getattr(exc, "status_code", None)
    code = str(getattr(exc, "code", "") or "")
    cls = type(exc).__name__.lower()
    text = (str(exc) or "").lower()

    def has(*needles: str) -> bool:
        return any(n in text for n in needles)

    # Out of money / quota - not recoverable by retrying; needs user action.
    if code == "insufficient_quota" or has(
        "insufficient_quota",
        "credit balance is too low",
        "exceeded your current quota",
        "plans & billing",
        "billing details",
    ):
        return (
            f"{label} rejected the request because the account is out of "
            f"credit or quota. Add billing/credits in your {label} account, "
            f"or switch the provider/model in Settings - AI, then try again."
        )

    # Bad or missing API key.
    if status == 401 or "authenticationerror" in cls or has(
        "invalid api key",
        "incorrect api key",
        "no api key",
        "invalid x-api-key",
    ):
        return (
            f"{label} could not authenticate the request. Check the {label} "
            f"API key in Settings - AI, then try again."
        )

    # Unknown / retired / not-yet-available model id. Registry entries are
    # user-editable data, so a stale ``model_id`` is an expected condition -
    # surface it cleanly instead of a raw 404 blob (registry revalidation).
    if code == "model_not_found" or has(
        "model_not_found",
        "does not exist or you do not have access",
        "unknown model",
        "no such model",
        "is not a valid model id",
    ) or (status == 404 and "model" in text):
        return (
            f"{label} does not recognise the requested model id. The selected "
            f"Model Registry entry is likely stale (the model may be renamed, "
            f"retired, or not yet available on your account). Pick a different "
            f"model in the chat dropdown or update the entry in Chat Manager - "
            f"Models, then try again."
        )

    # Transient rate limit (429 that is NOT an exhausted quota).
    if status == 429 or "ratelimiterror" in cls or has(
        "rate limit", "too many requests"
    ):
        return (
            f"{label} is rate-limiting requests right now. Wait a few seconds "
            f"and try again."
        )

    # Connectivity / upstream outage.
    if "connectionerror" in cls or "timeout" in cls or has(
        "connection error", "timed out", "temporarily unavailable", "overloaded"
    ):
        return (
            f"Could not reach {label} (connection problem or upstream outage). "
            f"Check your internet connection and try again."
        )

    return None


def _log_provider_failure(where: str, provider: str, exc: Exception) -> str:
    """Log a provider failure at the right level and return the message to show.

    Recognised operational errors (quota/billing/auth/rate-limit/connectivity)
    get a single WARNING line - no stack trace, because the traceback is just
    noise for a condition the user resolves in their own account. Unrecognised
    errors keep the full ``logger.exception`` traceback for debugging.
    """
    friendly = _friendly_provider_error(provider, exc)
    if friendly:
        logger.warning("%s (provider=%s): %s [%s]", where, provider, friendly, type(exc).__name__)
        return friendly
    logger.exception("%s for provider=%s", where, provider)
    detail = (str(exc) or type(exc).__name__).splitlines()[0][:300]
    return f"The {provider} request failed: {detail}"


async def stream_via_langgraph(
    message: str,
    history: list[ChatMessage],
    provider: str,
    model: str,
    temperature: float,
    tool_executor: Optional[ToolExecutor],
    system_prompt: str,
    allowed_tools: Optional[frozenset[str]],
    attachments: Optional[list[ChatAttachment]],
    sampling: Any = None,
) -> AsyncGenerator[dict, None]:
    """Stream via LangGraph astream_events (the native-streaming hot path).

    Maps LangGraph event types to the same WS event schema used by
    stream_openai / stream_anthropic:
      on_chat_model_stream  → {"type": "chunk", "content": ...}
      on_tool_start         → {"type": "tool_call", "name": ..., "arguments": ...}
      on_tool_end           → {"type": "tool_result", ...} + UI-action events
    Falls back to the provider-specific streaming functions when the graph
    cannot be built (missing API key, unsupported provider, etc.).
    """
    from app.services.agent_graph_nodes import make_langchain_tools
    from app.services.agent_graph import build_streaming_agent
    from langchain_core.messages import HumanMessage, AIMessage
    from langgraph.errors import GraphRecursionError

    lc_tools = make_langchain_tools(allowed_tools, tool_executor)
    graph = build_streaming_agent(
        provider, model, lc_tools, system_prompt, temperature, sampling=sampling
    )

    async def _fallback_stream() -> AsyncGenerator[dict, None]:
        """Run the provider's raw streamer, converting an unrecoverable
        provider failure (non-param 400, 429, auth, network) into a clean
        in-band error event instead of letting the raw exception blob escape
        to the WS envelope and replace the whole turn client-side.

        Transient failures (connection reset / provider 5xx / incomplete
        stream) get ONE automatic retry with a short backoff, re-running the
        streamer with the same inputs; a second failure takes the in-band
        error path."""
        def _make_gen() -> Optional[AsyncGenerator[dict, None]]:
            if provider == "openai":
                return stream_openai(
                    message, history, model, temperature, tool_executor,
                    system_prompt, allowed_tools, attachments, sampling=sampling,
                )
            if provider == "anthropic":
                return stream_anthropic(
                    message, history, model, temperature, tool_executor,
                    system_prompt, allowed_tools, attachments, sampling=sampling,
                )
            if provider == "openrouter":
                return stream_openrouter(
                    message, history, model, temperature, tool_executor,
                    system_prompt, allowed_tools, attachments, sampling=sampling,
                )
            return None

        gen = _make_gen()
        if gen is None:
            yield {"type": "chunk", "content": f"Unknown provider: {provider}"}
            return

        _fb_yielded = False
        _fb_retried = False
        while True:
            try:
                async for ev in gen:
                    _fb_yielded = True
                    yield ev
                return
            except Exception as fb_exc:  # noqa: BLE001 - last line of defence per turn
                if not _fb_retried and _is_transient_stream_error(fb_exc):
                    _fb_retried = True
                    logger.warning(
                        "fallback streamer transient failure (provider=%s) - "
                        "retrying once after %.1fs: %s",
                        provider, _STREAM_RETRY_BACKOFF_S, _exc_line(fb_exc),
                    )
                    if _fb_yielded:
                        yield {"type": "chunk", "content": _RETRY_NOTICE}
                    await asyncio.sleep(_STREAM_RETRY_BACKOFF_S)
                    gen = _make_gen()
                    continue
                message_out = _log_provider_failure("fallback streamer failed", provider, fb_exc)
                yield {"type": "error", "message": message_out}
                return

    if graph is None:
        # Fall back to manual streaming paths
        async for ev in _fallback_stream():
            yield ev
        return

    # Build LangChain message list from history + current user message
    lc_messages: list = []
    for msg in history[-20:]:
        if msg.role == "user":
            lc_messages.append(HumanMessage(content=msg.content))
        elif msg.role == "assistant":
            lc_messages.append(AIMessage(content=msg.content))

    # Build current user message (with attachments inlined as text)
    if attachments:
        user_content = _openai_user_content(message, attachments)
        if isinstance(user_content, str):
            lc_messages.append(HumanMessage(content=user_content))
        else:
            # Mixed content (text + images) - pass as list of content blocks
            lc_messages.append(HumanMessage(content=user_content))
    else:
        lc_messages.append(HumanMessage(content=message))

    # Track whether we've already streamed content.  A transient failure gets
    # ONE automatic retry (same messages); the retry re-runs the turn from the
    # top, so when content was already sent we emit an in-band notice chunk
    # first so the user understands why the answer restarts. Non-transient
    # failures keep the previous behaviour: in-band error event (mid-stream)
    # or the raw provider fallback (pre-stream).
    _yielded_any = False
    _retried = False

    # Token usage accumulated across every model round in the turn (a ReAct
    # turn is many model calls). Emitted as ONE usage event before every exit
    # path so the ChatUsageChip and budget enforcement see graph-path turns —
    # without this only the fallback streamers reported usage, i.e. budget caps
    # silently never accrued on the primary path. Accumulators deliberately
    # survive the transient retry below: the failed attempt's tokens were still
    # billed.
    _usage_in = 0
    _usage_out = 0
    _cache_read = 0
    _cache_creation = 0

    def _accumulate_usage(ev_data: dict) -> None:
        nonlocal _usage_in, _usage_out, _cache_read, _cache_creation
        out_msg = ev_data.get("output")
        usage = getattr(out_msg, "usage_metadata", None)
        if not isinstance(usage, dict):
            return
        try:
            _usage_in += int(usage.get("input_tokens") or 0)
            _usage_out += int(usage.get("output_tokens") or 0)
            details = usage.get("input_token_details") or {}
            _cache_read += int(details.get("cache_read") or 0)
            _cache_creation += int(details.get("cache_creation") or 0)
        except (TypeError, ValueError):  # pragma: no cover - malformed provider data
            pass

    def _final_usage_event() -> Optional[dict]:
        if _usage_in or _usage_out:
            return _usage_event(
                model, provider, _usage_in, _usage_out, _cache_read, _cache_creation
            )
        return None

    while True:
        try:
            # LangGraph's default recursion_limit is 25 supersteps (~12 tool
            # rounds). High-effort reasoning models (gpt-5.x, o-series) routinely
            # chain more tool calls than that on broad model questions, and the
            # resulting GraphRecursionError used to kill the turn mid-stream.
            async for event in graph.astream_events(
                {"messages": lc_messages},
                version="v2",
                config={"recursion_limit": 50},
            ):
                ev_name: str = event.get("event", "")
                ev_data: dict = event.get("data", {})

                if ev_name == "on_chat_model_stream":
                    chunk = ev_data.get("chunk")
                    if chunk is None:
                        continue
                    content_raw = getattr(chunk, "content", None)
                    if not content_raw:
                        continue
                    # OpenAI → str; Anthropic → list of content blocks
                    if isinstance(content_raw, str):
                        if content_raw:
                            _yielded_any = True
                            yield {"type": "chunk", "content": content_raw}
                    elif isinstance(content_raw, list):
                        for block in content_raw:
                            if isinstance(block, dict) and block.get("type") == "text":
                                text = block.get("text", "")
                                if text:
                                    _yielded_any = True
                                    yield {"type": "chunk", "content": text}
                            elif isinstance(block, str) and block:
                                _yielded_any = True
                                yield {"type": "chunk", "content": block}

                elif ev_name == "on_tool_start":
                    tool_name: str = event.get("name", "")
                    # data.input is the args dict passed to the tool
                    args = ev_data.get("input", {})
                    if isinstance(args, dict):
                        _yielded_any = True
                        yield {"type": "tool_call", "name": tool_name, "arguments": args}

                elif ev_name == "on_tool_end":
                    tool_name = event.get("name", "")
                    output = ev_data.get("output")
                    # LangChain 1.x's ToolNode wraps the tool's return in a
                    # ToolMessage whose `.content` holds the JSON string our tool
                    # coroutines produce; older stacks hand back a raw str/dict/None.
                    # Extract `.content` first so json.dumps never sees a
                    # non-serialisable ToolMessage (which raised TypeError and
                    # silently dropped every tool result on this path).
                    content = getattr(output, "content", output)
                    if isinstance(content, str):
                        result_str = content
                    elif content is None:
                        result_str = "{}"
                    else:
                        result_str = json.dumps(content)
                    try:
                        result_dict = json.loads(result_str)
                    except (json.JSONDecodeError, TypeError):
                        result_dict = {}
                    if not isinstance(result_dict, dict):
                        result_dict = {}

                    # Forward UI-action events (highlight, select, isolate, show_all)
                    if not result_dict.get("_executed_on_client"):
                        for ui_ev in _ui_action_events(result_dict):
                            yield ui_ev

                    executed_on = "client" if result_dict.get("_executed_on_client") else "server"
                    result_for_ws = {k: v for k, v in result_dict.items() if k != "_executed_on_client"}
                    _yielded_any = True
                    yield {
                        "type": "tool_result",
                        "name": tool_name,
                        "result": format_tool_result(result_for_ws),
                        "executed_on": executed_on,
                    }

                elif ev_name == "on_chat_model_end":
                    # Each model round reports usage on its final AIMessage.
                    _accumulate_usage(ev_data)

            usage_ev = _final_usage_event()
            if usage_ev is not None:
                yield usage_ev
            return  # turn completed

        except Exception as exc:
            if not _retried and _is_transient_stream_error(exc):
                # Transient provider hiccup (connection reset / 5xx /
                # incomplete stream): retry once with the same messages
                # after a short backoff. Read-only tool calls re-served
                # from the per-turn memo cache stay cheap on the rerun.
                _retried = True
                logger.warning(
                    "transient stream failure (provider=%s) - retrying once "
                    "after %.1fs: %s",
                    provider, _STREAM_RETRY_BACKOFF_S, _exc_line(exc),
                )
                if _yielded_any:
                    yield {"type": "chunk", "content": _RETRY_NOTICE}
                await asyncio.sleep(_STREAM_RETRY_BACKOFF_S)
                continue

            friendly = _friendly_provider_error(provider, exc)
            if _yielded_any:
                # Content already sent - restarting provider streaming would duplicate it.
                # Emit an error marker so the client can show a truncation notice.
                if isinstance(exc, GraphRecursionError):
                    logger.warning("agent hit per-turn tool-call limit mid-stream (provider=%s)", provider)
                    yield {
                        "type": "error",
                        "message": (
                            "The agent hit its per-turn tool-call limit before it could "
                            "finish. The answer above is incomplete - try a narrower question."
                        ),
                    }
                elif friendly:
                    logger.warning(
                        "stream_via_langgraph mid-stream (provider=%s): %s [%s]",
                        provider, friendly, type(exc).__name__,
                    )
                    yield {"type": "error", "message": friendly}
                else:
                    logger.exception("stream_via_langgraph error for provider=%s", provider)
                    yield {"type": "error", "message": "Agent stream interrupted; response may be incomplete."}
                # Tokens consumed before the failure were still billed.
                usage_ev = _final_usage_event()
                if usage_ev is not None:
                    yield usage_ev
                return
            if friendly:
                # Recognised provider error (quota/billing/auth/rate-limit) with
                # nothing streamed yet. The raw fallback path would hit the exact
                # same wall - skip it (no duplicate request, no second traceback)
                # and surface the clean message directly.
                logger.warning(
                    "stream_via_langgraph (provider=%s): %s [%s]",
                    provider, friendly, type(exc).__name__,
                )
                yield {"type": "error", "message": friendly}
                usage_ev = _final_usage_event()
                if usage_ev is not None:
                    yield usage_ev
                return
            # Unrecognised failure with nothing sent yet - the graph itself may have
            # been the problem, so fall back to the provider-specific path (which
            # logs its own traceback if it also fails). One concise line here.
            logger.warning(
                "stream_via_langgraph failed pre-stream (provider=%s); trying raw path: %s",
                provider, _exc_line(exc),
            )
            # Report any tokens the aborted graph attempt burned before handing
            # over; the fallback streamers emit their own usage events and the
            # consumer sums all usage events in a turn.
            usage_ev = _final_usage_event()
            if usage_ev is not None:
                yield usage_ev
            async for ev in _fallback_stream():
                yield ev
            return


async def stream_chat(
    message: str,
    history: list[ChatMessage],
    provider: str = "openai",
    model: Optional[str] = None,
    temperature: Optional[float] = None,
    tool_executor: Optional[ToolExecutor] = None,
    agent_id: Optional[str] = None,
    attachments: Optional[list[ChatAttachment]] = None,
    context_block: str = "",
    tool_set_id: Optional[str] = None,
    prompt_id: Optional[str] = None,
    model_registry_id: Optional[str] = None,
) -> AsyncGenerator[dict, None]:
    """
    Main entry point for streaming chat with tool calling.

    Agent preset resolution order (high→low): explicit call args override
    preset defaults. That is, a user who picks the Quantity-Surveyor preset
    but also selects GPT-4o-mini in the embedded model dropdown gets
    gpt-4o-mini with the Surveyor's system prompt.

    context_block: compact markdown describing the loaded IFC model, built by
    ModelContextInjector.  Prepended to the agent system prompt so agents know
    model metadata without a cold-start tool call.

    Yields structured events that the WebSocket handler forwards to the frontend.
    """
    from app.services.model_context_injector import model_context_injector

    # Flush the per-turn memo cache so stale read results don't leak between turns.
    tool_memo_cache.new_turn()

    agent: AgentPreset = get_agent(agent_id)

    effective_provider = provider or agent.provider
    effective_model = model or agent.model
    effective_temp = temperature if temperature is not None else agent.temperature

    # Model Registry: when the request carries a registry entry id, that entry is
    # authoritative for provider + model + sampling. ``sampling`` (None when no
    # entry) is threaded through to build_streaming_agent + the fallback streamers,
    # which apply the per-provider reasoning/temperature compatibility rules. An
    # explicit per-turn ``temperature`` still overrides the entry's default.
    from app.services.model_registry import model_registry
    from app.services.provider_params import resolve_sampling
    model_entry = model_registry.get(model_registry_id)

    # Registry revalidation: a selection can go stale between the
    # moment the UI loaded the catalogue and the moment the request arrives
    # (entry deleted or disabled in Chat Manager - Models). Never substitute
    # silently - surface a notice chunk (an event type the WS loop already
    # forwards) describing exactly what runs instead.
    _missing_registry_id: Optional[str] = (
        model_registry_id if (model_registry_id and model_entry is None) else None
    )
    _registry_notice: Optional[str] = None
    if model_entry is not None and not model_entry.enabled:
        _replacement = next(
            (m for m in model_registry.enabled() if m.provider == model_entry.provider),
            None,
        )
        if _replacement is not None:
            _registry_notice = (
                f"Note: the selected model '{model_entry.display_name}' is disabled "
                f"in the Model Registry. Using '{_replacement.display_name}' "
                f"({_replacement.provider}/{_replacement.model_id}) instead - "
                "re-enable the entry or pick another model in Chat Manager - "
                "Models to clear this notice.\n\n"
            )
            model_entry = _replacement
        else:
            _registry_notice = (
                f"Note: the selected model '{model_entry.display_name}' is disabled "
                "in the Model Registry and no other enabled entry exists for "
                f"provider '{model_entry.provider}'. Proceeding with it anyway - "
                "re-enable or add a model in Chat Manager - Models.\n\n"
            )

    if model_entry is not None:
        effective_provider = model_entry.provider
        effective_model = model_entry.model_id
        effective_temp = (
            temperature if temperature is not None else model_entry.temperature
        )
    sampling = resolve_sampling(model_entry, temperature_override=temperature)

    # Optional system-prompt override from prompt library.
    base_prompt = agent.system_prompt
    if prompt_id:
        from app.services.prompt_library import prompt_library
        entry = prompt_library.get(prompt_id)
        if entry is not None and entry.content:
            base_prompt = entry.content
    system_prompt = model_context_injector.inject(base_prompt, context_block)

    # Tool-set override: intersect agent.allowed_tools with the named set.
    # Empty `tools` tuple in a set means "all tools" (no filter).
    allowed_tools = agent.allowed_tools
    if tool_set_id:
        from app.services.tool_sets import tool_set_registry
        ts = tool_set_registry.get(tool_set_id)
        if ts is not None and not ts.is_all_tools:
            set_tools = frozenset(ts.tools)
            allowed_tools = (
                set_tools if allowed_tools is None
                else frozenset(allowed_tools).intersection(set_tools)
            )

    # v1 Edit gate - when the Edit surface is disabled, strip every
    # write_edit-tier (mutating) tool from the allowlist so no agent can stage
    # a write. This covers the read-only Ask agent (``allowed_tools=None`` → all
    # tools) and the ``/agent edit-assistant`` escape hatch in one symmetric
    # place. Backend wiring stays; flip ``EDIT_MODE_ENABLED`` (env) + the
    # frontend flag to re-enable. See app.core.config.EDIT_MODE_ENABLED.
    if not EDIT_MODE_ENABLED:
        from app.services.tools import all_tool_names, write_edit_tool_names
        base = all_tool_names() if allowed_tools is None else frozenset(allowed_tools)
        allowed_tools = base - write_edit_tool_names()

    # Default model IDs per provider.
    _default_model: dict[str, str] = {
        "openai": "gpt-4o",
        "anthropic": "claude-sonnet-4-20250514",
        "openrouter": "anthropic/claude-sonnet-4-20250514",
    }

    # Budget guardrails.
    # Resolve the effective model (before possible fallback swap).
    _resolved_model = effective_model or _default_model.get(effective_provider, "gpt-4o")

    # Registry revalidation notices (built above; the missing-entry text needs
    # the resolved fallback model, so it is composed here).
    if _missing_registry_id:
        _registry_notice = (
            f"Note: the selected model entry '{_missing_registry_id}' no longer "
            "exists in the Model Registry (it may have been deleted). Using "
            f"{effective_provider}/{_resolved_model} instead - pick a model from "
            "the chat dropdown or Chat Manager - Models to clear this notice.\n\n"
        )
    if _registry_notice:
        logger.warning("model registry revalidation: %s", _registry_notice.strip())
        yield {"type": "chunk", "content": _registry_notice}

    if agent.monthly_budget_usd:
        _pre_status = budget_tracker.check_budget(agent.id, agent.monthly_budget_usd)
        if _pre_status["status"] == "over_cap":
            if agent.fallback_model:
                yield {
                    "type": "model_fallback",
                    "original_model": _resolved_model,
                    "fallback_model": agent.fallback_model,
                    "reason": "budget_cap",
                    "used_usd": _pre_status["used_usd"],
                    "budget_usd": agent.monthly_budget_usd,
                }
                _resolved_model = agent.fallback_model
            else:
                yield {
                    "type": "chunk",
                    "content": (
                        f"⚠️ Monthly budget of ${agent.monthly_budget_usd:.2f} exhausted "
                        f"(used ${_pre_status['used_usd']:.4f}). "
                        "No fallback model configured - please increase the budget or set a fallback."
                    ),
                }
                yield {"type": "done"}
                return

    if effective_provider in ("openai", "anthropic", "openrouter"):
        # Route through LangGraph for openai/anthropic (native streaming).
        # OpenRouter uses the OpenAI-compatible path via the fallback in
        # stream_via_langgraph (LangGraph ChatOpenAI points at its base URL;
        # when unavailable the graph returns None → direct fallback fires).
        async for event in stream_via_langgraph(
            message,
            history,
            effective_provider,
            _resolved_model,
            effective_temp if effective_temp is not None else 0.3,
            tool_executor,
            system_prompt=system_prompt,
            allowed_tools=allowed_tools,
            attachments=attachments,
            sampling=sampling,
        ):
            yield event
            # Budget post-turn: record cost from usage event, then emit warning if near/over.
            if event.get("type") == "usage" and agent.monthly_budget_usd:
                _turn_cost = event.get("cost_usd") or 0
                if _turn_cost > 0:
                    budget_tracker.record(agent.id, _turn_cost)
                    _post_status = budget_tracker.check_budget(agent.id, agent.monthly_budget_usd)
                    if _post_status["status"] in ("near_cap", "over_cap"):
                        yield {
                            "type": "budget_warning",
                            "used_usd": _post_status["used_usd"],
                            "budget_usd": agent.monthly_budget_usd,
                            "ratio": _post_status["ratio"],
                            "agent_id": agent.id,
                            "at_cap": _post_status["status"] == "over_cap",
                        }
    else:
        yield {
            "type": "chunk",
            "content": f"Unknown provider: {effective_provider}. Supported: openai, anthropic, openrouter",
        }
