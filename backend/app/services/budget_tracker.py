"""
Per-agent monthly budget tracker.

Accumulates USD spend per agent ID within the current calendar month.
Persists state to ``DATA_DIR/budget_state.json`` (``~/.ifc-atlas/data/``)
so restarts don't lose counters.

Month boundary (UTC) is checked on every call; spend resets automatically.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Optional

from app.core.config import DATA_DIR

logger = logging.getLogger(__name__)

_DATA_DIR = DATA_DIR
_STATE_FILE = _DATA_DIR / "budget_state.json"

# Status constants
STATUS_OK = "ok"
STATUS_NEAR_CAP = "near_cap"   # >= 80 % of budget
STATUS_OVER_CAP = "over_cap"   # >= 100 % of budget

_NEAR_CAP_RATIO = 0.80


class BudgetTracker:
    """Thread-safe (GIL-protected) in-process monthly budget tracker."""

    def __init__(self) -> None:
        self._month_key: str = self._current_month()
        self._spent: dict[str, float] = {}
        self._load()

    # ── helpers ───────────────────────────────────────────────────────────

    @staticmethod
    def _current_month() -> str:
        now = datetime.now(timezone.utc)
        return f"{now.year}-{now.month:02d}"

    def _maybe_reset(self) -> None:
        current = self._current_month()
        if current != self._month_key:
            logger.info("budget_tracker: new month %s - resetting spend counters", current)
            self._month_key = current
            self._spent = {}

    def _load(self) -> None:
        try:
            if _STATE_FILE.exists():
                data = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
                if data.get("month") == self._month_key:
                    self._spent = {k: float(v) for k, v in data.get("spent", {}).items()}
        except Exception as exc:
            logger.warning("budget_tracker: load failed: %s", exc)

    def _save(self) -> None:
        try:
            _DATA_DIR.mkdir(parents=True, exist_ok=True)
            _STATE_FILE.write_text(
                json.dumps({"month": self._month_key, "spent": self._spent}),
                encoding="utf-8",
            )
        except Exception as exc:
            logger.warning("budget_tracker: save failed: %s", exc)

    # ── public API ────────────────────────────────────────────────────────

    def record(self, agent_id: str, cost_usd: float) -> None:
        """Add cost_usd to agent's monthly spend. No-op for zero or negative costs."""
        if cost_usd <= 0:
            return
        self._maybe_reset()
        self._spent[agent_id] = self._spent.get(agent_id, 0.0) + cost_usd
        self._save()

    def get_spent(self, agent_id: str) -> float:
        self._maybe_reset()
        return self._spent.get(agent_id, 0.0)

    def get_all_spent(self) -> dict[str, float]:
        """Return a snapshot of all per-agent spend for the current month."""
        self._maybe_reset()
        return dict(self._spent)

    def reset_agent(self, agent_id: str) -> None:
        """Reset spend for a single agent (e.g. for testing)."""
        self._spent.pop(agent_id, None)
        self._save()

    def check_budget(
        self,
        agent_id: str,
        budget_usd: Optional[float],
    ) -> dict:
        """
        Returns:
            {
                "status":     "ok" | "near_cap" | "over_cap",
                "used_usd":   float,
                "budget_usd": float | None,
                "ratio":      float | None,
            }
        """
        used = self.get_spent(agent_id)
        if not budget_usd:
            return {"status": STATUS_OK, "used_usd": used, "budget_usd": None, "ratio": None}

        ratio = used / budget_usd
        if ratio >= 1.0:
            status = STATUS_OVER_CAP
        elif ratio >= _NEAR_CAP_RATIO:
            status = STATUS_NEAR_CAP
        else:
            status = STATUS_OK

        return {
            "status": status,
            "used_usd": round(used, 6),
            "budget_usd": budget_usd,
            "ratio": round(ratio, 3),
        }


budget_tracker = BudgetTracker()
