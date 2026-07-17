"""bSDD (buildingSMART Data Dictionary) knowledge service.

Thin async client over the free, public bSDD REST API
(``https://api.bsdd.buildingsmart.org``). It gives the LLM tool layer a
reference desk for IFC *classification* and *property* knowledge: what a class
means, which properties/psets belong to it, allowed value types, and the
canonical URIs that tie a model back to an authoritative dictionary (IFC 4.3,
Uniclass, ...).

Why this module exists / design choices:

* **No auth, but be a good citizen.** All read endpoints are anonymous;
  buildingSMART only asks callers to identify themselves, so every request
  carries an identifying ``User-Agent`` (and mirrored ``X-User-Agent``).
* **Never raise into the tool layer.** These functions are called by LLM tools
  that must always receive usable JSON. Any network/timeout/HTTP/parse failure
  is logged at WARNING and turned into a structured ``{"error":
  "bsdd_unavailable", "detail": ...}`` result carrying the empty equivalent of
  the normal shape. Callers can branch on the ``error`` key.
* **Defensive normalisation.** bSDD response field names drift across endpoint
  versions, so parsing uses ``.get(...)`` with fallbacks and flattens the live
  shapes into small, stable dicts the tool schemas can rely on. We never assume
  a field is present.
* **Aggressive in-process caching.** Dictionary/class/property knowledge is
  effectively static within a session, so a dependency-free TTL cache (keyed by
  endpoint + params, ~6 h) collapses repeated lookups to a single network hit,
  cutting both latency and load on the public service.

The public surface is module-level ``async`` functions (the backend is
async/FastAPI); there is no per-request state beyond the shared cache.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

BSDD_BASE_URL = "https://api.bsdd.buildingsmart.org"

# buildingSMART requests an identifying User-Agent on every call. We send it as
# the standard header AND mirror it in X-User-Agent (some gateways strip/rewrite
# the former), exactly as the bSDD guidance asks.
_USER_AGENT = "IFC-Atlas/1.0 (github.com/nbharathik/ifc-atlas)"
_HEADERS: dict[str, str] = {
    "User-Agent": _USER_AGENT,
    "X-User-Agent": _USER_AGENT,
    "Accept": "application/json",
}

# 15 s connect + read. bSDD is usually fast, but this bounds worst-case tool
# latency instead of hanging a chat turn on a slow network.
_TIMEOUT = httpx.Timeout(15.0, connect=15.0)

# Knowledge is static within a session; 6 h keeps a working set warm without
# risking staleness that matters for a reference lookup.
_CACHE_TTL_S = 6 * 60 * 60

# Module-level TTL cache: key -> (monotonic_expiry, payload). We use
# time.monotonic() (not wall-clock) so the TTL is immune to system clock jumps.
_cache: dict[tuple[Any, ...], tuple[float, Any]] = {}


class _BsddHTTPError(Exception):
    """A non-2xx response from bSDD, carrying a short detail string."""


# --------------------------------------------------------------------------- #
# Cache + HTTP core
# --------------------------------------------------------------------------- #

def clear_cache() -> None:
    """Drop every cached bSDD response.

    Used as a manual "refresh" hook and to isolate unit tests from each other.
    """
    _cache.clear()


def _cache_key(endpoint: str, params: dict[str, Any]) -> tuple[Any, ...]:
    """Stable, hashable cache key from an endpoint + its query params."""
    return (endpoint, frozenset(params.items()))


async def _http_get_json(endpoint: str, params: dict[str, Any]) -> Any:
    """Perform the actual bSDD GET and return parsed JSON.

    This is the single, thin network seam: it opens an ``httpx.AsyncClient``
    with the identifying headers, issues the request, and returns the decoded
    JSON body (dict or list). It RAISES on failure:

    * ``_BsddHTTPError`` for any non-200 status,
    * ``httpx.HTTPError`` for transport/timeout failures,
    * ``ValueError`` (``json.JSONDecodeError``) for an unparseable body.

    ``_get`` wraps this with caching and turns every exception into the
    structured error result. Keeping the raising logic isolated here makes the
    layer trivially mockable in tests (monkeypatch this fn, or inject an
    ``httpx.MockTransport``).
    """
    url = f"{BSDD_BASE_URL}{endpoint}"
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_HEADERS) as client:
        resp = await client.get(url, params=params)
    if resp.status_code != 200:
        raise _BsddHTTPError(f"HTTP {resp.status_code}: {resp.text[:120]}")
    return resp.json()


async def _get(endpoint: str, params: dict[str, Any]) -> Any:
    """TTL-cached GET returning parsed JSON, or a structured error dict.

    On a cache hit within the TTL window the payload is returned without a
    network call. On a miss the request is made; only *successful* payloads are
    cached (a transient outage must not be pinned for 6 h). Any failure is
    logged and reported as ``{"error": "bsdd_unavailable", "detail": ...}`` -
    this function never raises.
    """
    key = _cache_key(endpoint, params)
    now = time.monotonic()
    cached = _cache.get(key)
    if cached is not None and cached[0] > now:
        return cached[1]

    try:
        data = await _http_get_json(endpoint, params)
    except Exception as exc:  # noqa: BLE001 - must never propagate to LLM tools
        logger.warning(
            "bSDD request failed: %s params=%s -> %s: %s",
            endpoint,
            params,
            type(exc).__name__,
            exc,
        )
        return {
            "error": "bsdd_unavailable",
            "detail": f"{type(exc).__name__}: {exc}"[:200],
        }

    _cache[key] = (now + _CACHE_TTL_S, data)
    return data


# --------------------------------------------------------------------------- #
# Small parsing helpers (defensive by construction)
# --------------------------------------------------------------------------- #

def _is_error(data: Any) -> bool:
    """True when ``_get`` returned our structured unavailability marker."""
    return isinstance(data, dict) and data.get("error") == "bsdd_unavailable"


def _error_fields(data: dict[str, Any]) -> dict[str, str]:
    """Extract the ``error``/``detail`` pair to merge into a shaped result."""
    return {
        "error": str(data.get("error", "bsdd_unavailable")),
        "detail": str(data.get("detail", "")),
    }


def _as_list(value: Any) -> list[Any]:
    """Coerce to a list: pass lists through, treat anything else as empty.

    bSDD list-valued fields are occasionally absent (``None``) rather than an
    empty array; this keeps every iteration site a one-liner.
    """
    return value if isinstance(value, list) else []


def _first(item: dict[str, Any], *keys: str, default: str = "") -> str:
    """Return the first present, truthy value among ``keys`` as a string.

    Absorbs field-name drift between bSDD endpoint versions (e.g. a definition
    living under ``definition`` on one endpoint and ``description`` on another).
    """
    for key in keys:
        value = item.get(key)
        if value:
            return str(value)
    return default


def _normalise_property(prop: dict[str, Any]) -> dict[str, Any]:
    """Flatten a bSDD class-property / property node into a stable shape.

    Class-property objects carry both their own ``uri`` and the underlying
    property-definition ``propertyUri`` (what you pass to :func:`get_property`),
    so we expose both rather than guessing which the caller wants.
    """
    return {
        "uri": _first(prop, "uri"),
        "property_uri": _first(prop, "propertyUri", "uri"),
        "name": _first(prop, "name"),
        "code": _first(prop, "code", "propertyCode"),
        "definition": _first(prop, "definition", "description"),
        "data_type": _first(prop, "dataType", "valueDataType"),
        "property_set": _first(prop, "propertySet", "propertySetName"),
    }


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #

async def search(
    text: str,
    *,
    dictionary_uri: str | None = None,
    type_filter: str = "All",
    limit: int = 20,
) -> dict[str, Any]:
    """Free-text search across bSDD classes and properties.

    Wraps ``GET /api/TextSearch/v2``. The live response groups matches under a
    ``dictionaries`` array (each with ``classes`` / ``properties`` sub-lists);
    we flatten that into a single ranked list.

    Returns::

        {"query": text,
         "results": [{"uri", "name", "type": "class"|"property",
                      "dictionary", "definition"?}],
         "count": <len(results)>}

    On failure the same shape is returned with empty ``results`` plus
    ``error``/``detail`` keys.
    """
    params: dict[str, Any] = {
        "SearchText": text,
        "TypeFilter": type_filter,
        # Forwarded as a hint; we also truncate client-side so the contract
        # holds regardless of whether this endpoint honours it.
        "Limit": limit,
    }
    if dictionary_uri:
        params["DictionaryUris"] = dictionary_uri

    data = await _get("/api/TextSearch/v2", params)
    if _is_error(data):
        return {"query": text, "results": [], "count": 0, **_error_fields(data)}

    results: list[dict[str, Any]] = []
    dictionaries = _as_list(data.get("dictionaries")) if isinstance(data, dict) else []
    if dictionaries:
        for entry in dictionaries:
            if not isinstance(entry, dict):
                continue
            dict_name = _first(entry, "name", "uri")
            _collect_search_items(entry, results, dict_name)
    elif isinstance(data, dict):
        # Fallback: some responses expose classes/properties at the top level.
        _collect_search_items(data, results, "")

    results = results[:limit]
    return {"query": text, "results": results, "count": len(results)}


def _collect_search_items(
    node: dict[str, Any],
    out: list[dict[str, Any]],
    dict_name: str,
) -> None:
    """Append normalised ``classes`` and ``properties`` from a search node."""
    for cls in _as_list(node.get("classes")):
        if isinstance(cls, dict):
            out.append(_search_item(cls, "class", dict_name))
    for prop in _as_list(node.get("properties")):
        if isinstance(prop, dict):
            out.append(_search_item(prop, "property", dict_name))


def _search_item(item: dict[str, Any], item_type: str, dict_name: str) -> dict[str, Any]:
    """Normalise a single search hit; ``definition`` is included only if given."""
    entry: dict[str, Any] = {
        "uri": _first(item, "uri"),
        "name": _first(item, "name"),
        "type": item_type,
        "dictionary": _first(item, "dictionaryName") or dict_name,
    }
    definition = _first(item, "definition", "description")
    if definition:
        entry["definition"] = definition
    return entry


async def get_class(uri: str) -> dict[str, Any]:
    """Full detail for a single bSDD class, including its properties.

    Wraps ``GET /api/Class/v1`` with ``IncludeClassProperties=true`` and
    ``IncludeChildClassReferences=false``.

    Returns::

        {"uri", "name", "code", "type", "definition", "dictionary",
         "parent_class_uri", "properties": [<normalised property>, ...]}

    On failure: ``{"uri": uri, "properties": [], "error", "detail"}``.
    """
    params = {
        "Uri": uri,
        "IncludeClassProperties": "true",
        "IncludeChildClassReferences": "false",
    }
    data = await _get("/api/Class/v1", params)
    if _is_error(data) or not isinstance(data, dict):
        detail = _error_fields(data) if _is_error(data) else {
            "error": "bsdd_unavailable",
            "detail": "unexpected response shape",
        }
        return {"uri": uri, "properties": [], **detail}

    parent = data.get("parentClassReference")
    parent_uri = _first(parent, "uri") if isinstance(parent, dict) else _first(data, "parentClassUri")

    return {
        "uri": _first(data, "uri") or uri,
        "name": _first(data, "name"),
        "code": _first(data, "code", "referenceCode"),
        "type": _first(data, "classType"),
        "definition": _first(data, "definition", "description"),
        "dictionary": _first(data, "dictionaryName", "dictionaryUri"),
        "parent_class_uri": parent_uri,
        "properties": [
            _normalise_property(p)
            for p in _as_list(data.get("classProperties"))
            if isinstance(p, dict)
        ],
    }


async def get_class_properties(uri: str) -> dict[str, Any]:
    """Properties of a class (leaner than :func:`get_class`).

    Wraps ``GET /api/Class/Properties/v1``. The payload may be a bare list, a
    ``{"classProperties": [...]}`` object, or a ``{"properties": [...]}``
    object depending on API version - all three are handled.

    Returns ``{"class_uri": uri, "properties": [...], "count": N}``; on failure
    ``{"class_uri": uri, "properties": [], "error", "detail"}``.
    """
    data = await _get("/api/Class/Properties/v1", {"ClassUri": uri})
    if _is_error(data):
        return {"class_uri": uri, "properties": [], **_error_fields(data)}

    if isinstance(data, list):
        raw = data
    elif isinstance(data, dict):
        raw = data.get("classProperties")
        if raw is None:
            raw = data.get("properties")
    else:
        raw = None

    props = [_normalise_property(p) for p in _as_list(raw) if isinstance(p, dict)]
    return {"class_uri": uri, "properties": props, "count": len(props)}


async def get_property(uri: str) -> dict[str, Any]:
    """Full detail for a single bSDD property definition.

    Wraps ``GET /api/Property/v4``.

    Returns::

        {"uri", "name", "code", "definition", "data_type", "dictionary",
         "units": [...], "physical_quantity"}

    On failure: ``{"uri": uri, "error", "detail"}``.
    """
    data = await _get("/api/Property/v4", {"Uri": uri})
    if _is_error(data) or not isinstance(data, dict):
        detail = _error_fields(data) if _is_error(data) else {
            "error": "bsdd_unavailable",
            "detail": "unexpected response shape",
        }
        return {"uri": uri, **detail}

    return {
        "uri": _first(data, "uri") or uri,
        "name": _first(data, "name"),
        "code": _first(data, "code", "propertyCode"),
        "definition": _first(data, "definition", "description"),
        "data_type": _first(data, "dataType", "valueDataType"),
        "dictionary": _first(data, "dictionaryName", "dictionaryUri"),
        "units": _as_list(data.get("units")),
        "physical_quantity": _first(data, "physicalQuantity"),
    }


async def list_dictionaries(*, limit: int = 50) -> dict[str, Any]:
    """List available bSDD dictionaries (IFC, Uniclass, ...).

    Wraps ``GET /api/Dictionary/v1`` (paged via ``Offset``/``Limit``).

    Returns::

        {"dictionaries": [{"uri", "name", "version", "organization",
                           "status"}], "count": <len>}

    On failure: ``{"dictionaries": [], "count": 0, "error", "detail"}``.
    """
    data = await _get("/api/Dictionary/v1", {"Offset": 0, "Limit": limit})
    if _is_error(data) or not isinstance(data, dict):
        return {"dictionaries": [], "count": 0, **(
            _error_fields(data) if _is_error(data)
            else {"error": "bsdd_unavailable", "detail": "unexpected response shape"}
        )}

    out: list[dict[str, Any]] = []
    for entry in _as_list(data.get("dictionaries")):
        if not isinstance(entry, dict):
            continue
        out.append(
            {
                "uri": _first(entry, "uri"),
                "name": _first(entry, "name"),
                "version": _first(entry, "version"),
                "organization": _first(
                    entry, "organizationNameOwner", "organizationCodeOwner"
                ),
                "status": _first(entry, "status"),
            }
        )

    out = out[:limit]
    return {"dictionaries": out, "count": len(out)}
