"""Unit tests for :mod:`app.services.bsdd_service`.

These tests never touch the network. They exercise the module two ways:

* **Thin-seam monkeypatch** - replace ``_http_get_json`` with a stub to drive
  normalisation, the TTL cache (call counting), and the raise-path of graceful
  degradation.
* **httpx.MockTransport** - inject a fake transport (ships with httpx; ``respx``
  is not a dependency) so the *real* request code path runs offline: header
  emission, query construction, status handling, and JSON decoding.

Payloads below are hand-built to plausibly mirror the live bSDD shapes; parsing
is deliberately defensive, so exact live field names are not asserted against.
"""

from __future__ import annotations

import httpx
import pytest

from app.services import bsdd_service as bsdd


# --------------------------------------------------------------------------- #
# Realistic (constructed) bSDD payloads
# --------------------------------------------------------------------------- #

_IFC = "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3"

SEARCH_PAYLOAD = {
    "numberOfClassesFound": 1,
    "numberOfPropertiesFound": 1,
    "dictionaries": [
        {
            "uri": _IFC,
            "name": "IFC",
            "version": "4.3",
            "organizationNameOwner": "buildingSMART",
            "classes": [
                {
                    "uri": f"{_IFC}/class/IfcWall",
                    "name": "Wall",
                    "referenceCode": "IfcWall",
                    "definition": "A wall is a vertical construction that bounds "
                    "or subdivides spaces.",
                }
            ],
            "properties": [
                {
                    "uri": f"{_IFC}/prop/FireRating",
                    "name": "FireRating",
                    "definition": "Fire rating of the element.",
                }
            ],
        }
    ],
}

CLASS_PAYLOAD = {
    "uri": f"{_IFC}/class/IfcWall",
    "name": "Wall",
    "code": "IfcWall",
    "classType": "Class",
    "definition": "A wall is a vertical construction ...",
    "dictionaryName": "IFC",
    "parentClassReference": {
        "uri": f"{_IFC}/class/IfcBuiltElement",
        "name": "Built Element",
    },
    "classProperties": [
        {
            "uri": f"{_IFC}/class/IfcWall/prop/IsExternal",
            "propertyUri": f"{_IFC}/prop/IsExternal",
            "name": "IsExternal",
            "dataType": "Boolean",
            "propertySet": "Pset_WallCommon",
            "definition": "Indication whether the element is designed for use "
            "in the exterior.",
        }
    ],
}

CLASS_PROPS_OBJECT = {
    "classProperties": [
        {
            "uri": f"{_IFC}/class/IfcWall/prop/IsExternal",
            "propertyUri": f"{_IFC}/prop/IsExternal",
            "name": "IsExternal",
            "dataType": "Boolean",
            "propertySet": "Pset_WallCommon",
        },
        {
            "uri": f"{_IFC}/class/IfcWall/prop/LoadBearing",
            "propertyUri": f"{_IFC}/prop/LoadBearing",
            "name": "LoadBearing",
            "dataType": "Boolean",
            "propertySet": "Pset_WallCommon",
        },
    ]
}

# Same endpoint, but a deployment that returns a bare JSON array.
CLASS_PROPS_LIST = [
    {
        "uri": f"{_IFC}/class/IfcWall/prop/ThermalTransmittance",
        "propertyUri": f"{_IFC}/prop/ThermalTransmittance",
        "name": "ThermalTransmittance",
        "dataType": "Real",
        "propertySet": "Pset_WallCommon",
    }
]

PROPERTY_PAYLOAD = {
    "uri": f"{_IFC}/prop/FireRating",
    "name": "FireRating",
    "code": "FireRating",
    "definition": "Fire rating of the element, given according to a national "
    "fire safety classification.",
    "dataType": "String",
    "dictionaryName": "IFC",
    "units": ["hour"],
    "physicalQuantity": "Time",
}

DICTIONARIES_PAYLOAD = {
    "count": 2,
    "dictionaries": [
        {
            "uri": _IFC,
            "name": "IFC",
            "version": "4.3",
            "organizationNameOwner": "buildingSMART",
            "status": "Active",
        },
        {
            "uri": "https://identifier.buildingsmart.org/uri/nbs/uniclass",
            "name": "Uniclass 2015",
            "version": "2015",
            # No organizationNameOwner -> exercises the code-owner fallback.
            "organizationCodeOwner": "nbs",
            "status": "Active",
        },
    ],
}


# --------------------------------------------------------------------------- #
# Fixtures / helpers
# --------------------------------------------------------------------------- #

@pytest.fixture(autouse=True)
def _isolate_cache():
    """Each test starts and ends with an empty module cache."""
    bsdd.clear_cache()
    yield
    bsdd.clear_cache()


def _stub_json(monkeypatch, payload, counter: dict | None = None):
    """Monkeypatch the thin network seam to return ``payload`` for any call."""

    async def _fake(endpoint: str, params: dict):
        if counter is not None:
            counter["n"] += 1
        return payload

    monkeypatch.setattr(bsdd, "_http_get_json", _fake)


def _stub_raise(monkeypatch, exc: Exception, counter: dict | None = None):
    """Monkeypatch the thin network seam to raise ``exc``."""

    async def _fake(endpoint: str, params: dict):
        if counter is not None:
            counter["n"] += 1
        raise exc

    monkeypatch.setattr(bsdd, "_http_get_json", _fake)


def _install_transport(monkeypatch, handler):
    """Route every ``httpx.AsyncClient`` in the module through a MockTransport.

    Captures the genuine class first so the injecting factory does not recurse
    into itself once the module attribute is patched.
    """
    real_cls = httpx.AsyncClient
    transport = httpx.MockTransport(handler)

    def _factory(*args, **kwargs):
        kwargs.setdefault("transport", transport)
        return real_cls(*args, **kwargs)

    monkeypatch.setattr(bsdd.httpx, "AsyncClient", _factory)


# --------------------------------------------------------------------------- #
# search()
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_search_normalises_classes_and_properties(monkeypatch):
    _stub_json(monkeypatch, SEARCH_PAYLOAD)
    res = await bsdd.search("wall")

    assert res["query"] == "wall"
    assert res["count"] == 2
    assert len(res["results"]) == 2

    by_type = {r["type"]: r for r in res["results"]}
    assert set(by_type) == {"class", "property"}

    cls = by_type["class"]
    assert cls["name"] == "Wall"
    assert cls["uri"].endswith("/class/IfcWall")
    assert cls["dictionary"] == "IFC"
    assert "vertical construction" in cls["definition"]

    prop = by_type["property"]
    assert prop["name"] == "FireRating"
    assert prop["dictionary"] == "IFC"


@pytest.mark.asyncio
async def test_search_respects_limit(monkeypatch):
    _stub_json(monkeypatch, SEARCH_PAYLOAD)
    res = await bsdd.search("wall", limit=1)
    assert res["count"] == 1
    assert len(res["results"]) == 1


@pytest.mark.asyncio
async def test_search_handles_empty_dictionaries(monkeypatch):
    _stub_json(monkeypatch, {"dictionaries": []})
    res = await bsdd.search("nothing-matches")
    assert res == {"query": "nothing-matches", "results": [], "count": 0}


@pytest.mark.asyncio
async def test_search_end_to_end_via_mock_transport(monkeypatch):
    """Full real path: request build + headers + status + JSON + normalise."""
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["search_text"] = request.url.params.get("SearchText")
        seen["type_filter"] = request.url.params.get("TypeFilter")
        seen["dict_uris"] = request.url.params.get("DictionaryUris")
        seen["user_agent"] = request.headers.get("user-agent")
        seen["x_user_agent"] = request.headers.get("x-user-agent")
        return httpx.Response(200, json=SEARCH_PAYLOAD)

    _install_transport(monkeypatch, handler)
    res = await bsdd.search("wall", dictionary_uri=_IFC)

    assert res["count"] == 2
    assert seen["path"] == "/api/TextSearch/v2"
    assert seen["search_text"] == "wall"
    assert seen["type_filter"] == "All"
    assert seen["dict_uris"] == _IFC
    # buildingSMART asks for an identifying UA on both header spellings.
    assert seen["user_agent"] == "IFC-Atlas/1.0 (github.com/nbharathik/ifc-atlas)"
    assert seen["x_user_agent"] == seen["user_agent"]


# --------------------------------------------------------------------------- #
# get_class()
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_get_class_normalisation(monkeypatch):
    _stub_json(monkeypatch, CLASS_PAYLOAD)
    res = await bsdd.get_class(f"{_IFC}/class/IfcWall")

    assert res["name"] == "Wall"
    assert res["code"] == "IfcWall"
    assert res["type"] == "Class"
    assert res["dictionary"] == "IFC"
    assert res["parent_class_uri"].endswith("/class/IfcBuiltElement")

    assert len(res["properties"]) == 1
    prop = res["properties"][0]
    # Class-property URI and the underlying property-definition URI differ.
    assert prop["uri"].endswith("/class/IfcWall/prop/IsExternal")
    assert prop["property_uri"].endswith("/prop/IsExternal")
    assert prop["name"] == "IsExternal"
    assert prop["data_type"] == "Boolean"
    assert prop["property_set"] == "Pset_WallCommon"


# --------------------------------------------------------------------------- #
# get_class_properties()
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_get_class_properties_object_shape(monkeypatch):
    _stub_json(monkeypatch, CLASS_PROPS_OBJECT)
    uri = f"{_IFC}/class/IfcWall"
    res = await bsdd.get_class_properties(uri)

    assert res["class_uri"] == uri
    assert res["count"] == 2
    names = {p["name"] for p in res["properties"]}
    assert names == {"IsExternal", "LoadBearing"}


@pytest.mark.asyncio
async def test_get_class_properties_bare_list_shape(monkeypatch):
    """The endpoint may return a bare JSON array; it must still normalise."""
    _stub_json(monkeypatch, CLASS_PROPS_LIST)
    res = await bsdd.get_class_properties(f"{_IFC}/class/IfcWall")

    assert res["count"] == 1
    assert res["properties"][0]["name"] == "ThermalTransmittance"
    assert res["properties"][0]["data_type"] == "Real"


# --------------------------------------------------------------------------- #
# get_property()
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_get_property_normalisation(monkeypatch):
    _stub_json(monkeypatch, PROPERTY_PAYLOAD)
    res = await bsdd.get_property(f"{_IFC}/prop/FireRating")

    assert res["name"] == "FireRating"
    assert res["code"] == "FireRating"
    assert res["data_type"] == "String"
    assert res["dictionary"] == "IFC"
    assert res["units"] == ["hour"]
    assert res["physical_quantity"] == "Time"
    assert "fire safety" in res["definition"].lower()


# --------------------------------------------------------------------------- #
# list_dictionaries()
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_list_dictionaries_normalisation(monkeypatch):
    _stub_json(monkeypatch, DICTIONARIES_PAYLOAD)
    res = await bsdd.list_dictionaries()

    assert res["count"] == 2
    ifc, uniclass = res["dictionaries"]
    assert ifc["name"] == "IFC"
    assert ifc["organization"] == "buildingSMART"
    # Second entry has no organizationNameOwner -> falls back to code owner.
    assert uniclass["organization"] == "nbs"
    assert uniclass["version"] == "2015"


@pytest.mark.asyncio
async def test_list_dictionaries_respects_limit(monkeypatch):
    _stub_json(monkeypatch, DICTIONARIES_PAYLOAD)
    res = await bsdd.list_dictionaries(limit=1)
    assert res["count"] == 1
    assert len(res["dictionaries"]) == 1


# --------------------------------------------------------------------------- #
# TTL cache
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_cache_collapses_repeat_calls(monkeypatch):
    counter = {"n": 0}
    _stub_json(monkeypatch, SEARCH_PAYLOAD, counter)

    first = await bsdd.search("wall")
    second = await bsdd.search("wall")

    assert counter["n"] == 1, "identical calls must hit the network only once"
    assert first == second


@pytest.mark.asyncio
async def test_cache_keys_on_params(monkeypatch):
    counter = {"n": 0}
    _stub_json(monkeypatch, SEARCH_PAYLOAD, counter)

    await bsdd.search("wall")
    await bsdd.search("wall")          # cache hit
    await bsdd.search("slab")          # different args -> new fetch

    assert counter["n"] == 2


@pytest.mark.asyncio
async def test_clear_cache_forces_refetch(monkeypatch):
    counter = {"n": 0}
    _stub_json(monkeypatch, SEARCH_PAYLOAD, counter)

    await bsdd.search("wall")
    bsdd.clear_cache()
    await bsdd.search("wall")

    assert counter["n"] == 2


# --------------------------------------------------------------------------- #
# Graceful degradation
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_transport_error_returns_structured_shape(monkeypatch):
    _stub_raise(monkeypatch, httpx.ConnectError("connection refused"))
    res = await bsdd.search("wall")

    assert res["error"] == "bsdd_unavailable"
    assert res["results"] == []
    assert res["count"] == 0
    assert res["query"] == "wall"
    assert "ConnectError" in res["detail"]


@pytest.mark.asyncio
async def test_timeout_error_returns_structured_shape(monkeypatch):
    _stub_raise(monkeypatch, httpx.ReadTimeout("timed out"))
    res = await bsdd.get_class(f"{_IFC}/class/IfcWall")

    assert res["error"] == "bsdd_unavailable"
    assert res["properties"] == []
    assert res["uri"].endswith("/class/IfcWall")


@pytest.mark.asyncio
async def test_non_200_returns_structured_shape(monkeypatch):
    """A non-200 response is mapped to the error shape via the real client."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="upstream unavailable")

    _install_transport(monkeypatch, handler)
    res = await bsdd.list_dictionaries()

    assert res["error"] == "bsdd_unavailable"
    assert res["dictionaries"] == []
    assert res["count"] == 0
    assert "503" in res["detail"]


@pytest.mark.asyncio
async def test_errors_are_not_cached(monkeypatch):
    """A failure must not be pinned for the TTL - the next call retries."""
    counter = {"n": 0}
    _stub_raise(monkeypatch, httpx.ConnectError("down"), counter)

    first = await bsdd.search("wall")
    second = await bsdd.search("wall")

    assert first["error"] == "bsdd_unavailable"
    assert second["error"] == "bsdd_unavailable"
    assert counter["n"] == 2, "errors must not be served from cache"


@pytest.mark.asyncio
async def test_all_functions_survive_error(monkeypatch):
    """Every public function returns JSON (never raises) on failure."""
    _stub_raise(monkeypatch, httpx.ConnectError("down"))

    assert (await bsdd.search("x"))["error"] == "bsdd_unavailable"
    assert (await bsdd.get_class("u"))["error"] == "bsdd_unavailable"
    assert (await bsdd.get_class_properties("u"))["error"] == "bsdd_unavailable"
    assert (await bsdd.get_property("u"))["error"] == "bsdd_unavailable"
    assert (await bsdd.list_dictionaries())["error"] == "bsdd_unavailable"
