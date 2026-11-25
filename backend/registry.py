"""Unified local usage sources; each returns Codex-compatible rows."""
from __future__ import annotations
import hashlib
import json
import threading
from .engine import Engine, QueryError
from .providers import antigravity, claude

SOURCES=('codex','claude','antigravity')
PROVIDER_LABELS={'codex':'Codex','claude':'Claude Code','antigravity':'Anti Gravity'}


class RefreshFailed(RuntimeError):
    """Some sources could not be read; every other source was refreshed.

    ``failures`` maps each unreadable source to its reason. A source that
    failed keeps the rows it last returned.
    """
    def __init__(self,failures):
        self.failures=dict(failures)
        super().__init__('；'.join(f'{PROVIDER_LABELS.get(name,name)} 的日志读取失败（{reason}）' for name,reason in failures.items()))


class ProviderRegistry:
    """Every local source behind one index identity.

    The page re-reads its rows when ``generation`` changes, so that value must
    reflect any source: a Codex-only identity left the others stale.
    """
    def __init__(self, codex_root, database, claude_root=None, antigravity_root=None):
        self.lock=threading.RLock()
        self.engines={'codex':Engine(codex_root,database),'claude':claude.Provider(claude_root),'antigravity':antigravity.Provider(antigravity_root)}

    def engine(self,name):
        if name not in self.engines:raise QueryError('不支持这个智能体数据源。')
        return self.engines[name]

    def refresh(self):
        # Callers serialize scans (LogSync holds its own lock). This lock stays
        # free during the refresh so status remains readable while sources are read.
        statuses={};failures={}
        for name,engine in self.engines.items():
            try:statuses[name]=engine.refresh()
            except Exception as exc:
                # One unreadable source must not stop the others from refreshing.
                failures[name]=str(exc)
        # The refreshed sources keep their new rows; the page names the failed ones.
        if failures:raise RefreshFailed(failures)
        return statuses

    @property
    def generation(self):
        return 'r-'+hashlib.sha256(json.dumps({name:engine.generation for name,engine in self.engines.items()},sort_keys=True).encode()).hexdigest()[:16]

    @property
    def status(self):
        """Codex status, which existing readers expect, under the combined identity."""
        return {**self.engines['codex'].status,'generation':self.generation,
                'providers':{name:engine.status.copy() for name,engine in self.engines.items()}}
