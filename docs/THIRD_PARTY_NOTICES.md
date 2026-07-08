# Third-Party Notices

IFC Atlas is distributed under the [Mozilla Public License 2.0](../LICENSE). It
incorporates the third-party components listed below. Each component is used
under its own license; this file collects the notices and attributions those
licenses require.

Documentation under `docs/` is additionally licensed **CC-BY-4.0**: attribution
required, commercial use allowed.

If you redistribute IFC Atlas (source or binary), this file must be
included unchanged. The canonical copy lives in the repository at
`docs/THIRD_PARTY_NOTICES.md`; binary distributions link back to it.

---

## Summary table

| Component | License | Used where | Obligation |
|---|---|---|---|
| [React](https://github.com/facebook/react) | MIT | frontend | retain notice |
| [three.js](https://github.com/mrdoob/three.js) | MIT | frontend | retain notice |
| [@thatopen/components](https://github.com/ThatOpen/engine_components) | MIT | frontend + Node sidecar | retain notice |
| [@thatopen/fragments](https://github.com/ThatOpen/engine_fragments) | MIT | frontend + Node sidecar | retain notice |
| [web-ifc](https://github.com/ThatOpen/engine_web-ifc) | MPL-2.0 | frontend (demo fallback + cloud) | file-level source disclosure if modified |
| [web-ifc-node](https://www.npmjs.com/package/web-ifc) | MPL-2.0 | Node sidecar | file-level source disclosure if modified |
| [FastAPI](https://github.com/tiangolo/fastapi) | MIT | backend | retain notice |
| [Pydantic](https://github.com/pydantic/pydantic) | MIT | backend | retain notice |
| [Starlette](https://github.com/encode/starlette) | BSD-3-Clause | backend | retain notice |
| [Uvicorn](https://github.com/encode/uvicorn) | BSD-3-Clause | backend | retain notice |
| [IfcOpenShell](https://github.com/IfcOpenShell/IfcOpenShell) | **LGPL-3.0** | backend | **dynamically linked, replaceable (see note below)** |
| [OpenAI Python SDK](https://github.com/openai/openai-python) | Apache-2.0 | backend | retain notice |
| [Anthropic Python SDK](https://github.com/anthropics/anthropic-sdk-python) | MIT | backend | retain notice |
| [Tauri](https://github.com/tauri-apps/tauri) | Apache-2.0 / MIT | desktop shell | retain notice |
| [Vite](https://github.com/vitejs/vite) | MIT | build tool | retain notice |
| [Zustand](https://github.com/pmndrs/zustand) | MIT | frontend state | retain notice |

The authoritative dependency tree lives in `frontend/package.json`,
`frontend/package-lock.json`, and `backend/requirements.txt`; full license
texts ([MIT](https://opensource.org/license/mit),
[BSD-3-Clause](https://opensource.org/license/bsd-3-clause),
[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0),
[MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/),
[LGPL-3.0](https://www.gnu.org/licenses/lgpl-3.0.html),
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)) ship inside each
dependency's package distribution.

**IfcOpenShell (LGPL-3.0):** linked dynamically; you may swap in your own
build. Cloud: rebuild the open-source backend against it. Desktop: overwrite
the bundled `ifcopenshell_wrapper.{pyd,so}` under the install directory's
`.../site-packages/ifcopenshell/` and restart the app. The browser demo does
not ship IfcOpenShell. web-ifc (MPL-2.0) is used unmodified, so no source
disclosure applies.

**Sample data:** the `BasicHouse.ifc` sample (via `scripts/fetch-sample.*`) is
for demonstration only and is not covered by this repository's license.
