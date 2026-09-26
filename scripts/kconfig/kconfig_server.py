#!/usr/bin/env python3
"""Long-running Kconfig server for the Zephyr Workbench "Kconfig Manager".

Wraps a single kconfiglib ``Kconfig`` instance and speaks newline-delimited JSON-RPC
over stdio, so a VS Code webview can present a modern GUI with full menuconfig/guiconfig
feature parity (tree, toggling, value editing with range checks, search, symbol info,
save / save-as / save-minimal / load, undo/redo, dirty tracking).

The process is launched with the *exact* environment Zephyr uses for its ``menuconfig``
custom command (reproduced from build.ninja by the TypeScript side), with the working
directory set to ``<build>/zephyr/kconfig`` and ``KCONFIG_CONFIG`` pointing at the build's
merged ``.config``. It never re-merges fragments: like menuconfig, it edits the already
merged ``.config`` directly.

Protocol (one JSON object per line, UTF-8):
  <-  {"event": "ready", "protocol": 1}                       (emitted once at startup)
  ->  {"id": "1", "method": "init", "params": {}}
  <-  {"id": "1", "result": {...}, "dirty": false, "warnings": []}
  <-  {"id": "1", "error": {"message": "...", "code": "..."}, "dirty": ..., "warnings": [...]}

stdlib only; targets Python 3.8+.
"""

import sys
import os
import json
import time


# --- Protocol integrity -----------------------------------------------------
# kconfigfunctions._warn() and edtlib print to stdout at import/eval time; that would
# corrupt the NDJSON stream. Claim the real stdout as our private channel and redirect
# everything else to stderr BEFORE importing kconfiglib (which imports kconfigfunctions).
_OUT = sys.stdout
sys.stdout = sys.stderr


def _fatal(message, code="startup-error"):
    try:
        _OUT.write(json.dumps({"event": "fatal", "error": {"message": message, "code": code}}) + "\n")
        _OUT.flush()
    except Exception:
        pass
    sys.exit(1)


def _parse_argv(argv):
    zephyr_base = None
    kconfig_root = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--zephyr-base":
            i += 1
            zephyr_base = argv[i] if i < len(argv) else None
        elif a == "--kconfig-root":
            i += 1
            kconfig_root = argv[i] if i < len(argv) else None
        i += 1
    return zephyr_base, kconfig_root


ZEPHYR_BASE, KCONFIG_ROOT = _parse_argv(sys.argv[1:])
if not ZEPHYR_BASE:
    ZEPHYR_BASE = os.environ.get("ZEPHYR_BASE") or os.environ.get("srctree")
if not ZEPHYR_BASE:
    _fatal("Missing --zephyr-base (and no ZEPHYR_BASE/srctree in env)")
if not KCONFIG_ROOT:
    KCONFIG_ROOT = os.path.join(ZEPHYR_BASE, "Kconfig")

# kconfiglib lives next to this repo's Zephyr; kconfigfunctions is auto-discovered from
# the same directory by name (KCONFIG_FUNCTIONS defaults to "kconfigfunctions").
sys.path.insert(0, os.path.join(ZEPHYR_BASE, "scripts", "kconfig"))

try:
    import kconfiglib
    from kconfiglib import (
        Symbol, Choice, MENU, COMMENT,
        BOOL, TRISTATE, STRING, INT, HEX, UNKNOWN,
        AND, OR, NOT,
        EQUAL, UNEQUAL, LESS, LESS_EQUAL, GREATER, GREATER_EQUAL,
        TYPE_TO_STR, TRI_TO_STR,
        expr_value, split_expr, standard_sc_expr_str,
    )
except Exception as e:  # pragma: no cover - exercised only on broken installs
    _fatal("Failed to import kconfiglib from {}: {}".format(
        os.path.join(ZEPHYR_BASE, "scripts", "kconfig"), e), code="no-kconfiglib")


_REL_STR = {
    EQUAL: "=", UNEQUAL: "!=",
    LESS: "<", LESS_EQUAL: "<=",
    GREATER: ">", GREATER_EQUAL: ">=",
}


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------

class Session:
    def __init__(self):
        self.kconf = None
        self.nodes = []            # id -> MenuNode
        self.id_of = {}            # id(MenuNode) -> node id
        self.first_node_id = {}    # symbol/choice name -> first node id (for links)
        self.generation = 0
        self.dirty = False
        self._warn_cursor = 0
        self._warn_seen = set()    # dedupe: kconfiglib re-emits on re-evaluation
        # Edit journal for undo/redo and change review.
        self.journal = []         # list of {"name","kind","prev","new"}
        self.cursor = 0           # number of applied ops
        self.baseline = {}        # symbol name -> str_value at first mutation (session)
        # str_value at first mutation, rebased on save: drives the dirty flag so that
        # un-modifying (or saving) clears the modified state.
        self.saved_baseline = {}
        self.load_needs_save = False

    # -- lifecycle ----------------------------------------------------------

    def load(self):
        # suppress_traceback=False so we can catch and report parse errors as data.
        self.kconf = kconfiglib.Kconfig(KCONFIG_ROOT, warn=True, warn_to_stderr=False)
        load_msg = self.kconf.load_config()
        self.generation += 1
        self.journal = []
        self.cursor = 0
        self.baseline = {}
        self.saved_baseline = {}
        self._index_tree()
        # Deliver genuine load-time warnings (malformed .config entries) once, then turn
        # kconfiglib warnings off: expression re-evaluation (tree serialization, diffs)
        # re-emits the same advisory warnings on every pass and would flood the UI.
        self._warn_cursor = 0
        self._warn_seen = set()
        self.kconf.warn = False
        self.load_needs_save = self._needs_save()
        self.dirty = self.load_needs_save
        return load_msg

    def _index_tree(self):
        self.nodes = []
        self.id_of = {}
        self.first_node_id = {}
        # Iterative DFS preserving (list, then next) order.
        top = self.kconf.top_node
        stack = [top.list] if top.list else []
        # We assign ids in strict tree order via recursion helper.
        self._next_id = 0

        def visit(node):
            while node:
                nid = self._next_id
                self._next_id += 1
                self.id_of[id(node)] = nid
                self.nodes.append(node)
                item = node.item
                if isinstance(item, (Symbol, Choice)) and item.name:
                    self.first_node_id.setdefault(item.name, nid)
                if node.list:
                    visit(node.list)
                node = node.next

        # Python's default recursion limit is fine for Kconfig depth, but be safe.
        old_limit = sys.getrecursionlimit()
        sys.setrecursionlimit(max(old_limit, 20000))
        try:
            if top.list:
                visit(top.list)
        finally:
            sys.setrecursionlimit(old_limit)

    # -- warnings & dirty ---------------------------------------------------

    def take_warnings(self):
        fresh = self.kconf.warnings[self._warn_cursor:]
        self._warn_cursor = len(self.kconf.warnings)
        out = []
        for w in fresh:
            if w not in self._warn_seen:
                self._warn_seen.add(w)
                out.append(w)
        return out

    def has_effective_changes(self):
        # True when any touched symbol's effective value differs from the last saved
        # state; toggling something back to its original value clears the dirty flag.
        for name, base in self.saved_baseline.items():
            sym = self.kconf.syms.get(name)
            if sym is not None and sym.str_value != base:
                return True
        return False

    def recompute_dirty(self):
        self.dirty = self.load_needs_save or self.has_effective_changes()

    def _needs_save(self):
        # Port of menuconfig._needs_save(): the on-disk .config is out of date if any
        # assignment was dropped, or a symbol would be written differently than loaded.
        kconf = self.kconf
        if kconf.missing_syms:
            return True
        for sym in kconf.unique_defined_syms:
            if sym.user_value is None:
                if sym.config_string:
                    return True
            elif sym.orig_type in (BOOL, TRISTATE):
                if sym.tri_value != sym.user_value:
                    return True
            elif sym.user_value != sym.str_value:
                return True
        return False

    # -- node lookup --------------------------------------------------------

    def node(self, nid):
        if nid < 0 or nid >= len(self.nodes):
            raise KeyError("Unknown node id {}".format(nid))
        return self.nodes[nid]

    # -- keys (stable across reloads) --------------------------------------

    def node_key(self, node):
        item = node.item
        if item is MENU:
            return "menu:{}:{}".format(node.filename, node.linenr)
        if item is COMMENT:
            return "comment:{}:{}".format(node.filename, node.linenr)
        if isinstance(item, Choice):
            name = item.name or "@{}:{}".format(node.filename, node.linenr)
            return "choice:{}".format(name)
        # Symbol: disambiguate multiple definition locations by index.
        idx = 0
        try:
            idx = item.nodes.index(node)
        except ValueError:
            idx = 0
        return "sym:{}#{}".format(item.name, idx)


SESSION = Session()


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------

def _node_kind(node):
    item = node.item
    if item is MENU:
        return "menu"
    if item is COMMENT:
        return "comment"
    if isinstance(item, Choice):
        return "choice"
    return "symbol"


def _active_range(sym):
    # First range whose condition currently holds (mirrors Symbol._str_value range use).
    for low, high, cond, _loc in sym.ranges:
        if expr_value(cond):
            return {"low": low.str_value, "high": high.str_value}
    return None


def node_static(node, nid):
    item = node.item
    kind = _node_kind(node)
    d = {
        "id": nid,
        "key": SESSION.node_key(node),
        "kind": kind,
        "type": TYPE_TO_STR[item.orig_type] if isinstance(item, (Symbol, Choice)) else "unknown",
        "isMenuconfig": bool(node.is_menuconfig),
        "parent": SESSION.id_of.get(id(node.parent)) if node.parent is not None else None,
        "children": [],
        "defLocation": {"file": node.filename or "", "line": node.linenr or 0},
    }
    if isinstance(item, (Symbol, Choice)) and item.name:
        d["name"] = item.name
    if node.prompt:
        d["prompt"] = node.prompt[0]
    # children in list/next order
    child = node.list
    kids = []
    while child:
        cid = SESSION.id_of.get(id(child))
        if cid is not None:
            kids.append(cid)
        child = child.next
    d["children"] = kids
    return d


def _prompt_visible(node):
    return bool(node.prompt) and expr_value(node.prompt[1]) > 0


def _visible(node):
    # menuconfig._visible(): prompt visible, and for menus also `visible if`.
    if not node.prompt:
        return False
    if expr_value(node.prompt[1]) == 0:
        return False
    if node.item is MENU and expr_value(node.visibility) == 0:
        return False
    return True


def node_dynamic(node):
    item = node.item
    prompt_vis = _prompt_visible(node)
    d = {
        "visible": _visible(node),
        "promptVisible": prompt_vis,
        "strValue": "",
        "triValue": 0,
        "assignable": [],
        "userValueSet": True,
        "isYModeChoiceSym": False,
        "choiceSelected": False,
        "selectionPrompt": None,
        "range": None,
    }
    if isinstance(item, Symbol):
        d["strValue"] = item.str_value
        d["triValue"] = item.tri_value
        d["assignable"] = list(item.assignable)
        is_choice_sym = item.choice is not None and item.choice.tri_value == 2
        d["isYModeChoiceSym"] = is_choice_sym
        if is_choice_sym:
            d["choiceSelected"] = item.choice.selection is item
        show_new = (item.user_value is None
                    and not is_choice_sym
                    and item.orig_type != UNKNOWN)
        d["userValueSet"] = not show_new
        if item.orig_type in (INT, HEX):
            d["range"] = _active_range(item)
    elif isinstance(item, Choice):
        d["strValue"] = item.str_value
        d["triValue"] = item.tri_value
        d["assignable"] = list(item.assignable)
        if item.tri_value == 2 and item.selection is not None:
            sel = item.selection
            d["selectionPrompt"] = sel.nodes[0].prompt[0] if (sel.nodes and sel.nodes[0].prompt) else sel.name
    return d


def serialize_node(node, nid):
    d = node_static(node, nid)
    d.update(node_dynamic(node))
    return d


def _search_order():
    syms, choices, menus, comments = [], [], [], []
    for nid, node in enumerate(SESSION.nodes):
        k = _node_kind(node)
        if k == "symbol":
            syms.append(nid)
        elif k == "choice":
            choices.append(nid)
        elif k == "menu":
            menus.append(nid)
        else:
            comments.append(nid)

    def sort_key_named(nid):
        node = SESSION.nodes[nid]
        name = node.item.name or ""
        prompt = node.prompt[0] if node.prompt else ""
        return (name.lower(), prompt.lower())

    def sort_key_prompt(nid):
        node = SESSION.nodes[nid]
        return (node.prompt[0].lower() if node.prompt else "")

    syms.sort(key=sort_key_named)
    choices.sort(key=sort_key_named)
    menus.sort(key=sort_key_prompt)
    comments.sort(key=sort_key_prompt)
    return {"syms": syms, "choices": choices, "menus": menus, "comments": comments}


def tree_init():
    top = SESSION.kconf.top_node
    # The `mainmenu` prompt is the title menuconfig shows at the very top of its screen.
    mainmenu = top.prompt[0] if top.prompt else "Configuration"
    root_children = []
    child = top.list
    while child:
        cid = SESSION.id_of.get(id(child))
        if cid is not None:
            root_children.append(cid)
        child = child.next
    nodes = [serialize_node(node, nid) for nid, node in enumerate(SESSION.nodes)]
    return {
        "generation": SESSION.generation,
        "mainmenu": mainmenu,
        "rootChildren": root_children,
        "nodes": nodes,
        "searchOrder": _search_order(),
        "configPath": SESSION.kconf.config_filename if hasattr(SESSION.kconf, "config_filename") else os.environ.get("KCONFIG_CONFIG", ".config"),
        "minconfigPath": os.environ.get("KCONFIG_CONFIG", ".config"),
        "dirty": SESSION.dirty,
        "warnings": [],
        "envSource": os.environ.get("KCONFIG_SERVER_ENV_SOURCE", "ninja"),
    }


# ---------------------------------------------------------------------------
# Diff (snapshot compare)
# ---------------------------------------------------------------------------

def snapshot_dynamic():
    # id -> tuple of the dynamic fields that can change on an edit.
    snap = {}
    for nid, node in enumerate(SESSION.nodes):
        d = node_dynamic(node)
        snap[nid] = (
            d["visible"], d["promptVisible"], d["strValue"], d["triValue"],
            tuple(d["assignable"]), d["userValueSet"], d["isYModeChoiceSym"],
            d["choiceSelected"], d["selectionPrompt"],
            (d["range"]["low"], d["range"]["high"]) if d["range"] else None,
        )
    return snap


def diff_against(prev_snap):
    changes = []
    for nid, node in enumerate(SESSION.nodes):
        d = node_dynamic(node)
        cur = (
            d["visible"], d["promptVisible"], d["strValue"], d["triValue"],
            tuple(d["assignable"]), d["userValueSet"], d["isYModeChoiceSym"],
            d["choiceSelected"], d["selectionPrompt"],
            (d["range"]["low"], d["range"]["high"]) if d["range"] else None,
        )
        if prev_snap.get(nid) != cur:
            d["id"] = nid
            changes.append(d)
    return changes


# ---------------------------------------------------------------------------
# Info pane (structured, with clickable symbol/location tokens)
# ---------------------------------------------------------------------------

def _sym_token(sc):
    # A Symbol or Choice leaf -> a clickable token when it names something defined.
    if isinstance(sc, Symbol):
        if sc.is_constant or not sc.name:
            return {"t": "text", "text": '"{}"'.format(sc.name) if sc.is_constant and sc.orig_type == STRING else (sc.name or "")}
        tok = {"t": "sym", "name": sc.name, "value": sc.str_value}
        tid = SESSION.first_node_id.get(sc.name)
        if tid is not None:
            tok["targetId"] = tid
        return tok
    if isinstance(sc, Choice):
        name = sc.name or "<choice>"
        tok = {"t": "sym", "name": name, "value": TRI_TO_STR[sc.tri_value]}
        tid = SESSION.first_node_id.get(sc.name) if sc.name else None
        if tid is not None:
            tok["targetId"] = tid
        return tok
    return {"t": "text", "text": standard_sc_expr_str(sc)}


def _expr_tokens(expr, parent_op=None):
    # Render a kconfiglib expression into a flat token list, roughly matching expr_str.
    if expr.__class__ is not tuple:
        return [_sym_token(expr)]

    op = expr[0]
    if op is NOT:
        return [{"t": "op", "text": "!"}] + _expr_tokens(expr[1], NOT)
    if op in (AND, OR):
        sep = " && " if op is AND else " || "
        toks = []
        parts = split_expr(expr, op)
        for i, part in enumerate(parts):
            if i:
                toks.append({"t": "op", "text": sep})
            need_paren = part.__class__ is tuple and part[0] in (AND, OR) and part[0] is not op
            if need_paren:
                toks.append({"t": "op", "text": "("})
            toks += _expr_tokens(part, op)
            if need_paren:
                toks.append({"t": "op", "text": ")"})
        # Parenthesize an AND nested directly inside an OR for clarity.
        if parent_op is OR and op is AND:
            return [{"t": "op", "text": "("}] + toks + [{"t": "op", "text": ")"}]
        return toks
    # Relational operator.
    rel = _REL_STR.get(op, "?")
    return _expr_tokens(expr[1]) + [{"t": "op", "text": " {} ".format(rel)}] + _expr_tokens(expr[2])


def _expr_line(expr, prefix=""):
    return {
        "prefix": prefix,
        "tokens": _expr_tokens(expr),
        "valueHint": TRI_TO_STR[expr_value(expr)],
    }


def _dep_lines(expr):
    # One line per top-level AND term (menuconfig _split_expr_info style).
    lines = []
    for term in split_expr(expr, AND):
        lines.append({
            "prefix": "",
            "tokens": _expr_tokens(term),
            "valueHint": TRI_TO_STR[expr_value(term)],
        })
    return lines


def _false_dep_lines(expr):
    # Blockers: the AND terms that currently evaluate to n (why a symbol is unmet).
    lines = []
    for term in split_expr(expr, AND):
        if expr_value(term) == 0:
            lines.append({
                "prefix": "",
                "tokens": _expr_tokens(term),
                "valueHint": "n",
            })
    return lines


def _menu_path(node):
    segs = []
    cur = node.parent
    while cur is not None and cur is not SESSION.kconf.top_node:
        label = cur.prompt[0] if cur.prompt else (
            cur.item.name if isinstance(cur.item, (Symbol, Choice)) and cur.item.name else "")
        seg = {"label": label or "(unnamed)"}
        tid = SESSION.id_of.get(id(cur))
        if tid is not None:
            seg["targetId"] = tid
        segs.append(seg)
        cur = cur.parent
    segs.append({"label": "(Top)"})
    segs.reverse()
    return segs


def build_info(nid):
    node = SESSION.node(nid)
    item = node.item

    info = {
        "id": nid,
        "prompts": [],
        "typeStr": TYPE_TO_STR[item.orig_type] if isinstance(item, (Symbol, Choice)) else "",
        "helps": [],
        "defaults": [],
        "selectImply": [],
        "definitions": [],
        "blockers": None,
    }

    if isinstance(item, (Symbol, Choice)) and item.name:
        info["name"] = item.name

    # Prompts across all definition locations.
    nodes = item.nodes if isinstance(item, (Symbol, Choice)) else [node]
    for n in nodes:
        if n.prompt:
            info["prompts"].append(n.prompt[0])
        if n.help:
            info["helps"].append(n.help)

    if isinstance(item, Symbol):
        info["valueStr"] = '"{}"'.format(item.str_value) if item.orig_type == STRING else item.str_value
        if item.direct_dep is not SESSION.kconf.y:
            info["directDep"] = {
                "value": TRI_TO_STR[expr_value(item.direct_dep)],
                "lines": _dep_lines(item.direct_dep),
            }
            # Blockers only when the symbol can't currently be changed.
            if not item.assignable and expr_value(item.direct_dep) == 0:
                blk = _false_dep_lines(item.direct_dep)
                if blk:
                    info["blockers"] = blk
        # orig_defaults are 2-tuples (value, cond) — the orig_* variants drop the location.
        for default_expr, cond in item.orig_defaults:
            entry = {"value": _expr_line(default_expr)}
            if cond is not SESSION.kconf.y:
                entry["condition"] = {
                    "value": TRI_TO_STR[expr_value(cond)],
                    "lines": _dep_lines(cond),
                }
            info["defaults"].append(entry)
        _add_select_imply(info, item)
    elif isinstance(item, Choice):
        info["choiceMode"] = TRI_TO_STR[item.tri_value]
        info["choiceSyms"] = []
        for sym in item.syms:
            entry = {"name": sym.name, "selected": item.selection is sym}
            tid = SESSION.first_node_id.get(sym.name)
            if tid is not None:
                entry["targetId"] = tid
            info["choiceSyms"].append(entry)

    # Definition blocks.
    for n in nodes:
        block = {
            "file": n.filename or "",
            "line": n.linenr or 0,
            "includePath": [{"file": f, "line": l} for (f, l) in (n.include_path or ())],
            "menuPath": _menu_path(n),
            "kconfigSrc": n.custom_str(standard_sc_expr_str),
        }
        info["definitions"].append(block)

    return info


def _sym_ref_list(expr):
    # Flatten an OR-expression of "selecting/implying" symbols into clickable entries.
    out = []
    seen = set()
    for sub in split_expr(expr, OR):
        # Each sub is typically `SYM` or `SYM && cond`; grab the leading symbol.
        target = sub
        if sub.__class__ is tuple and sub[0] is AND:
            target = split_expr(sub, AND)[0]
        if isinstance(target, Symbol) and target.name and target.name not in seen:
            seen.add(target.name)
            e = {"name": target.name}
            tid = SESSION.first_node_id.get(target.name)
            if tid is not None:
                e["targetId"] = tid
            out.append(e)
    return out


def _add_select_imply(info, sym):
    groups = []
    y = SESSION.kconf.y
    n = SESSION.kconf.n
    if sym.rev_dep is not n:
        entries = _sym_ref_list(sym.rev_dep)
        if entries:
            groups.append({"title": "Symbols currently selecting this symbol", "syms": entries})
    if sym.weak_rev_dep is not n:
        entries = _sym_ref_list(sym.weak_rev_dep)
        if entries:
            groups.append({"title": "Symbols currently implying this symbol", "syms": entries})
    # Forward: what this symbol selects/implies.
    fwd_sel = [t for (t, _c, _loc) in sym.selects]
    if fwd_sel:
        entries = []
        for t in fwd_sel:
            e = {"name": t.name}
            tid = SESSION.first_node_id.get(t.name)
            if tid is not None:
                e["targetId"] = tid
            entries.append(e)
        groups.append({"title": "Symbols selected by this symbol", "syms": entries})
    fwd_imp = [t for (t, _c, _loc) in sym.implies]
    if fwd_imp:
        entries = []
        for t in fwd_imp:
            e = {"name": t.name}
            tid = SESSION.first_node_id.get(t.name)
            if tid is not None:
                e["targetId"] = tid
            entries.append(e)
        groups.append({"title": "Symbols implied by this symbol", "syms": entries})
    info["selectImply"] = groups


# ---------------------------------------------------------------------------
# Mutation helpers
# ---------------------------------------------------------------------------

def _raw_user_value(sym):
    # A string suitable for set_value() to reproduce the current user assignment, or None.
    uv = sym.user_value
    if uv is None:
        return None
    if sym.orig_type in (BOOL, TRISTATE):
        return TRI_TO_STR[uv]
    return uv


def _apply_raw(sym, raw):
    if raw is None:
        sym.unset_value()
        return True
    return bool(sym.set_value(raw))


def _record_baseline(name, sym):
    if name not in SESSION.baseline:
        SESSION.baseline[name] = sym.str_value
    if name not in SESSION.saved_baseline:
        SESSION.saved_baseline[name] = sym.str_value


def _validate_range(sym, value):
    # menuconfig-style range check for int/hex; returns an error string or None.
    if sym.orig_type not in (INT, HEX):
        return None
    base = 16 if sym.orig_type == HEX else 10
    s = value.strip()
    if sym.orig_type == HEX and not s.lower().startswith("0x"):
        s = "0x" + s
    try:
        num = int(s, base)
    except ValueError:
        return "'{}' is a malformed {} value".format(value, TYPE_TO_STR[sym.orig_type])
    rng = _active_range(sym)
    if rng:
        low = int(rng["low"], 0)
        high = int(rng["high"], 0)
        if not (low <= num <= high):
            return "{} is outside the range {}-{}".format(value, rng["low"], rng["high"])
    return None


# ---------------------------------------------------------------------------
# RPC methods
# ---------------------------------------------------------------------------

def m_init(params):
    load_msg = SESSION.load()
    return {
        "loadMessage": load_msg,
        "needsSave": SESSION.dirty,
        "nodeCount": len(SESSION.nodes),
        "symbolCount": len(SESSION.kconf.unique_defined_syms),
        "kconfigRoot": KCONFIG_ROOT,
        "configPath": os.environ.get("KCONFIG_CONFIG", ".config"),
    }


def m_get_tree(params):
    return tree_init()


def _mutate_and_diff(mutator):
    prev = snapshot_dynamic()
    result = mutator()
    changes = diff_against(prev)
    # Recompute rather than latch: un-modifying back to the saved state clears dirty.
    SESSION.recompute_dirty()
    return result, {"generation": SESSION.generation, "changes": changes, "dirty": SESSION.dirty}


def m_set_value(params):
    nid = params["id"]
    value = params["value"]
    node = SESSION.node(nid)
    item = node.item
    if not isinstance(item, Symbol):
        return {"ok": False, "error": "Node is not a symbol"}

    err = _validate_range(item, value) if isinstance(value, str) else None
    if err:
        return {"ok": False, "error": err}

    name = item.name
    prev_raw = _raw_user_value(item)
    _record_baseline(name, item)

    def do():
        ok = item.set_value(value)
        return ok

    ok, delta = _mutate_and_diff(do)
    if not ok:
        return {"ok": False, "error": "Value '{}' is not assignable".format(value)}
    # Journal (truncate any redo tail).
    del SESSION.journal[SESSION.cursor:]
    SESSION.journal.append({"name": name, "prev": prev_raw, "new": _raw_user_value(item)})
    SESSION.cursor = len(SESSION.journal)
    out = {"ok": True}
    out.update(delta)
    return out


def m_unset_value(params):
    nid = params["id"]
    node = SESSION.node(nid)
    item = node.item
    if not isinstance(item, Symbol):
        return {"ok": False, "error": "Node is not a symbol"}
    name = item.name
    prev_raw = _raw_user_value(item)
    _record_baseline(name, item)

    def do():
        item.unset_value()
        return True

    _, delta = _mutate_and_diff(do)
    del SESSION.journal[SESSION.cursor:]
    SESSION.journal.append({"name": name, "prev": prev_raw, "new": None})
    SESSION.cursor = len(SESSION.journal)
    out = {"ok": True}
    out.update(delta)
    return out


def m_undo(params):
    if SESSION.cursor <= 0:
        return {"ok": False, "error": "Nothing to undo"}
    op = SESSION.journal[SESSION.cursor - 1]
    sym = SESSION.kconf.syms.get(op["name"])

    def do():
        return _apply_raw(sym, op["prev"]) if sym else False

    _, delta = _mutate_and_diff(do)
    SESSION.cursor -= 1
    out = {"ok": True}
    out.update(delta)
    return out


def m_redo(params):
    if SESSION.cursor >= len(SESSION.journal):
        return {"ok": False, "error": "Nothing to redo"}
    op = SESSION.journal[SESSION.cursor]
    sym = SESSION.kconf.syms.get(op["name"])

    def do():
        return _apply_raw(sym, op["new"]) if sym else False

    _, delta = _mutate_and_diff(do)
    SESSION.cursor += 1
    out = {"ok": True}
    out.update(delta)
    return out


def m_get_changes(params):
    changes = []
    seen = set()
    for op in SESSION.journal[:SESSION.cursor]:
        name = op["name"]
        if name in seen:
            continue
        seen.add(name)
        sym = SESSION.kconf.syms.get(name)
        if not sym:
            continue
        baseline = SESSION.baseline.get(name)
        current = sym.str_value
        if baseline == current:
            continue  # value returned to baseline; not a real change
        tid = SESSION.first_node_id.get(name)
        changes.append({
            "name": name,
            "baseline": baseline,
            "current": current,
            "configString": sym.config_string.rstrip("\n") if sym.config_string else "",
            "targetId": tid,
        })
    return {"changes": changes}


def m_revert(params):
    # Revert one symbol to the user value it had when this session first touched it.
    name = params["name"]
    sym = SESSION.kconf.syms.get(name)
    if not sym:
        return {"ok": False, "error": "Unknown symbol '{}'".format(name)}
    first_prev = None
    found = False
    for op in SESSION.journal[:SESSION.cursor]:
        if op["name"] == name:
            first_prev = op["prev"]
            found = True
            break
    if not found:
        return {"ok": False, "error": "No changes recorded for '{}'".format(name)}
    prev_raw = _raw_user_value(sym)

    def do():
        return _apply_raw(sym, first_prev)

    _, delta = _mutate_and_diff(do)
    # The revert is itself an undoable operation.
    del SESSION.journal[SESSION.cursor:]
    SESSION.journal.append({"name": name, "prev": prev_raw, "new": first_prev})
    SESSION.cursor = len(SESSION.journal)
    out = {"ok": True}
    out.update(delta)
    return out


def m_get_drift(params):
    # "Temporary" configuration = whatever differs between the current state and the
    # baseline the project's config fragments would produce. Computed statelessly on the
    # live instance: save state to a temp file, merge the fragments exactly like
    # scripts/kconfig/kconfig.py does, snapshot, restore. kconfiglib invalidates and
    # lazily recomputes values on every load, and requests are strictly sequential, so
    # nothing can observe the intermediate baseline state.
    import tempfile

    fragments = params.get("fragments") or []
    existing = [f for f in fragments if os.path.isfile(f)]
    missing = [f for f in fragments if not os.path.isfile(f)]
    if not existing:
        return {"ok": False, "error": "None of the configuration fragments exist on disk"}

    kconf = SESSION.kconf
    pre = snapshot_dynamic()

    # Exact user-value snapshot: write_config omits currently-invisible symbols, so the
    # temp-file reload alone would drop their user values (and could re-pick a choice's
    # historical selection). Captured here, patched back after the reload.
    pre_raw = {}
    for sym in kconf.unique_defined_syms:
        rv = _raw_user_value(sym)
        if rv is not None:
            pre_raw[sym.name] = rv
    pre_selections = []
    for ch in kconf.unique_choices:
        sel = ch.user_selection
        if sel is not None:
            pre_selections.append(sel.name)

    fd, tmp_path = tempfile.mkstemp(prefix="kconfig-state-", suffix=".config")
    os.close(fd)
    kconf.write_config(tmp_path)
    baseline = {}
    try:
        kconf.unset_values()
        kconf.load_config(existing[0], replace=True)
        for frag in existing[1:]:
            kconf.load_config(frag, replace=False)

        for sym in kconf.unique_defined_syms:
            baseline[sym.name] = sym.str_value
    finally:
        # The restore MUST run even when a fragment fails to load half-way, or the live
        # state would silently remain the fragment merge (and a later save would write
        # it). Restore from the temp snapshot, then patch the raw user values that
        # write_config cannot represent (currently-invisible symbols), then re-pin
        # choice selections (set_value order determines user_selection).
        try:
            kconf.load_config(tmp_path, replace=True)
            for sym in kconf.unique_defined_syms:
                want = pre_raw.get(sym.name)
                if _raw_user_value(sym) != want:
                    _apply_raw(sym, want)
            for name in pre_selections:
                sel_sym = kconf.syms.get(name)
                if sel_sym is not None:
                    sel_sym.set_value(2)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    # The restore must be exact; anything else means the state was disturbed and the
    # export must not proceed. The delta lets the webview resync in that case.
    residue = diff_against(pre)
    if residue:
        print("get_drift: state restore left {} residue entries".format(len(residue)), file=sys.stderr)
        return {
            "ok": False,
            "error": "Internal state check failed while computing the export; nothing was written",
            "generation": SESSION.generation,
            "changes": residue,
            "dirty": SESSION.dirty,
        }

    drift = []
    for sym in kconf.unique_defined_syms:
        cur = sym.str_value
        base = baseline.get(sym.name)
        if cur == base:
            continue
        # Fragments may only assign symbols that have a prompt (kconfig.py errors on
        # promptless assignments).
        if not any(n.prompt for n in sym.nodes):
            continue
        # The remaining skips mirror kconfiglib's write_min_config (savedefconfig)
        # exactly: unchangeable symbols, values matching their default in the current
        # context (drops cascaded dependents), and default choice selections.
        if not sym.choice and sym.visibility <= expr_value(sym.rev_dep):
            continue
        try:
            if cur == sym._str_default():
                continue
        except Exception:
            pass  # private API moved: keep the symbol (over-pinning is safe)
        try:
            if (sym.choice is not None
                    and not sym.choice.is_optional
                    and sym.choice._selection_from_defaults() is sym
                    and sym.orig_type is BOOL
                    and sym.tri_value == 2):
                continue
        except Exception:
            pass
        cfg_line = sym.config_string.rstrip("\n")
        if not cfg_line:
            continue
        drift.append({
            "name": sym.name,
            "baseline": base,
            "current": cur,
            "configString": cfg_line,
            "targetId": SESSION.first_node_id.get(sym.name),
        })

    managed = params.get("managed")
    if managed:
        drift.extend(_managed_drift(kconf, managed, existing, baseline, {d["name"] for d in drift}))

    drift.sort(key=lambda d: d["name"])
    return {"ok": True, "drift": drift, "missingFragments": missing}


def _managed_value(line):
    # (name, value) a managed line assigns, the value spelled as str_value spells it.
    import re
    m = re.match(r"^\s*CONFIG_([A-Za-z0-9_]+)\s*=(.*)$", line)
    if m:
        value = m.group(2).strip()
        if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
            value = re.sub(r'\\(.)', r"\1", value[1:-1])
        return m.group(1), value
    m = re.match(r"^\s*#\s*CONFIG_([A-Za-z0-9_]+)\s+is not set\s*$", line)
    if m:
        return m.group(1), "n"
    return None, None


def _same_file(a, b):
    try:
        return os.path.samefile(a, b)
    except OSError:
        return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def _managed_drift(kconf, managed, fragments, baseline, listed):
    # The export target's managed region pins values from earlier exports (and from
    # set_kconfig). The drift above follows savedefconfig, so it leaves out a symbol set
    # back to its default, or one that can no longer be assigned; the export then kept
    # the old pinned line and the next build brought the old value back. Here each
    # pinned symbol whose line no longer gives the current value is reported: with the
    # line that gives it, or for removal when a configuration file cannot assign it any
    # more (the line would only make every build warn).
    #
    # Values are compared, not line text. With the target in the fragment list, the
    # baseline already includes its region, and one a later fragment overrides already
    # gives the current value, so nothing is rewritten for it. A target outside the list
    # is compared with the value its line assigns.
    path = managed.get("path") or ""
    in_build = bool(path) and os.path.isfile(path) and any(_same_file(f, path) for f in fragments)
    out = []
    for line in managed.get("lines") or []:
        name, value = _managed_value(line)
        if not name or name in listed:
            continue
        sym = kconf.syms.get(name)
        if sym is None or not sym.nodes:
            continue  # not defined in this tree: the line is the user's to fix
        cur = sym.str_value
        if cur == (baseline.get(name) if in_build else value):
            continue
        listed.add(name)
        assignable = (any(n.prompt for n in sym.nodes)
                      and (sym.choice is not None or sym.visibility > expr_value(sym.rev_dep)))
        cfg_line = sym.config_string.rstrip("\n")
        update = assignable and bool(cfg_line)
        out.append({
            "name": name,
            "baseline": value,
            "current": cur,
            # An explicit value rather than dropping the line: a fragment merged before
            # the target may assign the symbol too, and would win again without it.
            "configString": cfg_line if update else "",
            "managedLine": "update" if update else "remove",
            "targetId": SESSION.first_node_id.get(name),
        })
    return out


def m_info(params):
    return build_info(params["id"])


# ---------------------------------------------------------------------------
# Agent methods: find, explain, check_merge
#
# Used by the MCP server, which runs its own session with no editor attached.
# None of them touch the edit journal, the baselines or the dirty flag, and
# check_merge restores the live state exactly (checked by a residue diff), so
# the loaded .config is what every call starts from.
# ---------------------------------------------------------------------------

def _defined_names():
    kconf = SESSION.kconf
    names = [sym.name for sym in kconf.unique_defined_syms]
    names.extend(choice.name for choice in kconf.unique_choices if choice.name)
    return names


def _suggest(name, limit=8):
    # Close spellings first, then names that contain the text: an agent that
    # guessed SERIAL_CONSOLE should hear about UART_CONSOLE and CONSOLE.
    import difflib
    wanted = name.upper()
    names = _defined_names()
    close = difflib.get_close_matches(wanted, names, n=5, cutoff=0.75)
    containing = sorted((n for n in names if wanted in n),
                        key=lambda n: (not n.startswith(wanted), len(n), n))
    out = []
    for candidate in close + containing:
        if candidate not in out:
            out.append(candidate)
        if len(out) >= limit:
            break
    return out


def _has_prompt(item):
    return any(node.prompt for node in item.nodes)


def _find_entry(name):
    kconf = SESSION.kconf
    sym = kconf.syms.get(name)
    # kconf.syms also holds names that are only referenced, never defined;
    # Zephyr rejects an assignment to those, so they count as unknown.
    if sym is not None and sym.nodes:
        return {
            "kind": "symbol",
            "id": SESSION.first_node_id.get(name),
            "type": TYPE_TO_STR[sym.orig_type],
            "hasPrompt": _has_prompt(sym),
            "choice": (sym.choice.name or "<choice>") if sym.choice is not None else None,
            "value": sym.str_value,
            "nodeIds": [SESSION.id_of.get(id(node)) for node in sym.nodes],
        }
    choice = kconf.named_choices.get(name)
    if choice is not None:
        return {
            "kind": "choice",
            "id": SESSION.first_node_id.get(name),
            "type": TYPE_TO_STR[choice.orig_type],
            "hasPrompt": _has_prompt(choice),
            "choice": None,
            "value": choice.str_value,
            "nodeIds": [SESSION.id_of.get(id(node)) for node in choice.nodes],
        }
    return None


def m_find(params):
    # Name to node lookup without get_tree, which serializes the whole tree.
    found = {}
    unknown = {}
    for name in params.get("names") or []:
        entry = _find_entry(name)
        if entry is None:
            unknown[name] = _suggest(name)
        else:
            found[name] = entry
    out = {"found": found, "unknown": unknown}
    pattern = (params.get("pattern") or "").upper()
    if pattern:
        limit = int(params.get("limit") or 50)
        matches = sorted(n for n in _defined_names() if pattern in n)
        out["matches"] = matches[:limit]
        out["totalMatches"] = len(matches)
    return out


def _unique(items):
    # A symbol defined in several places often repeats the same prompt or help.
    out = []
    for item in items:
        if item not in out:
            out.append(item)
    return out


def _annotated_sc(sc):
    # Every defined symbol carries its current value, as menuconfig shows it.
    # An undefined one (a bare `0`, a symbol from a module that is not there)
    # has no value worth showing.
    if isinstance(sc, Symbol) and sc.name and not sc.is_constant and sc.nodes:
        return "{} [={}]".format(sc.name, sc.str_value)
    if isinstance(sc, Choice):
        return "{} [={}]".format(sc.name or "<choice>", TRI_TO_STR[sc.tri_value])
    return standard_sc_expr_str(sc)


def _expr_text(expr):
    return kconfiglib.expr_str(expr, _annotated_sc)


def _terms(expr, skip=None):
    # `skip` drops a term that says nothing, such as the choice a choice symbol
    # always depends on.
    return [{"expr": _expr_text(term), "value": TRI_TO_STR[expr_value(term)]}
            for term in split_expr(expr, AND) if skip is None or term is not skip]


def _false_terms(expr):
    return [{"expr": _expr_text(term), "value": TRI_TO_STR[expr_value(term)]}
            for term in split_expr(expr, AND) if expr_value(term) == 0]


def _reverse_deps(expr, limit=None):
    # One entry per selecting (or implying) symbol. Each OR term is `SEL` or
    # `SEL && <condition>`, and only the terms that currently evaluate to
    # non-n actually force a value. Common symbols such as GPIO have hundreds
    # of selectors, so with a limit every active one is kept and only the
    # inactive ones are cut; the caller gets the total alongside.
    if expr is SESSION.kconf.n:
        return [], 0
    active, inactive = [], []
    subs = split_expr(expr, OR)
    for sub in subs:
        lead = split_expr(sub, AND)[0] if (sub.__class__ is tuple and sub[0] is AND) else sub
        entry = {"expr": _expr_text(sub), "active": expr_value(sub) > 0}
        if isinstance(lead, Symbol) and lead.name:
            entry["name"] = lead.name
            entry["value"] = lead.str_value
        (active if entry["active"] else inactive).append(entry)
    if limit is not None:
        inactive = inactive[:max(0, limit - len(active))]
    return active + inactive, len(subs)


def _forward_refs(sym, pairs):
    # A select or imply only acts while the symbol itself is on and its own
    # `if` condition holds. The conditions come from orig_selects/orig_implies
    # where available, which leave out the dependencies kconfiglib propagates
    # from `depends on` and enclosing menus: those are listed once already.
    out = []
    for target, cond, *_rest in pairs:
        entry = {"name": target.name, "active": sym.tri_value > 0 and expr_value(cond) > 0}
        if cond is not SESSION.kconf.y:
            entry["condition"] = _expr_text(cond)
        out.append(entry)
    return out


def _definitions(item):
    # `active` says whether the enclosing `if`/`depends on` of that definition
    # holds: a symbol such as MAIN_STACK_SIZE is defined again in the defconfig
    # of every SoC, and only the definitions of this board's SoC apply.
    out = []
    for node in item.nodes:
        path_labels = [seg["label"] for seg in _menu_path(node)]
        out.append({
            "file": node.filename or "",
            "line": node.linenr or 0,
            "menuPath": " > ".join(path_labels),
            "active": expr_value(node.dep) > 0,
        })
    return out


def _defaults(sym, limit=15):
    # The defaults whose condition holds, in the order kconfiglib tries them:
    # the first one is the value the symbol takes when nothing assigns it.
    # sym.defaults carries the propagated `depends on` and `if` conditions,
    # which is what decides whether a default applies on this board.
    out = []
    for value, cond, *rest in sym.defaults:
        cond_value = expr_value(cond)
        if cond_value == 0:
            continue
        entry = {"value": _expr_text(value), "used": not out}
        if cond is not SESSION.kconf.y:
            entry["condition"] = _expr_text(cond)
            entry["conditionValue"] = TRI_TO_STR[cond_value]
        loc = rest[0] if rest else None
        if isinstance(loc, tuple) and len(loc) >= 2:
            entry["file"] = loc[0] or ""
            entry["line"] = loc[1] or 0
        out.append(entry)
        if len(out) >= limit:
            break
    return out, len(sym.defaults)


def _choice_summary(choice):
    return {
        "name": choice.name or "<choice>",
        "prompt": next((node.prompt[0] for node in choice.nodes if node.prompt), None),
        "mode": TRI_TO_STR[choice.tri_value],
        "selected": choice.selection.name if choice.selection is not None else None,
        "members": [{"name": sym.name, "value": sym.str_value} for sym in choice.syms],
        "optional": bool(getattr(choice, "is_optional", False)),
    }


def _missing_deps(sym):
    # Port of missing_deps() in Zephyr's scripts/kconfig/kconfig.py: the
    # 'depends on' terms below the assigned value, which is what the build
    # prints when an assignment does not take.
    deps = split_expr(sym.direct_dep, AND)
    if sym.orig_type in (BOOL, TRISTATE):
        wanted = sym.user_value if sym.user_value is not None else 2
        return [{"expr": _expr_text(dep), "value": TRI_TO_STR[expr_value(dep)]}
                for dep in deps if expr_value(dep) < wanted]
    return [{"expr": _expr_text(dep), "value": TRI_TO_STR[expr_value(dep)]}
            for dep in deps if expr_value(dep) == 0]


def _explain_symbol(sym):
    kconf = SESSION.kconf
    prompts, helps, prompt_conditions = [], [], []
    for node in sym.nodes:
        if node.prompt:
            prompts.append(node.prompt[0])
            cond = node.prompt[1]
            # 'visible if' on an enclosing menu is folded into this condition
            # by kconfiglib, so it covers both 'prompt ... if' and 'visible if'.
            if cond is not kconf.y:
                prompt_conditions.append({
                    "prompt": node.prompt[0],
                    "value": TRI_TO_STR[expr_value(cond)],
                    "terms": _terms(cond, skip=sym.choice),
                })
        if node.help:
            helps.append(node.help)

    dep_value = expr_value(sym.direct_dep)
    blocked_by = []
    if dep_value == 0:
        blocked_by.extend(dict(term, kind="depends_on") for term in _false_terms(sym.direct_dep))
    elif sym.visibility == 0 and prompts:
        for pc in prompt_conditions:
            blocked_by.extend(dict(term, kind="visibility") for term in pc["terms"] if term["value"] == "n")

    ranges = []
    for low, high, cond, *_rest in sym.ranges:
        ranges.append({
            "low": low.str_value,
            "high": high.str_value,
            "condition": _expr_text(cond) if cond is not kconf.y else None,
            "active": expr_value(cond) > 0,
        })

    defaults, defaults_total = _defaults(sym)
    selected_by, selected_by_total = _reverse_deps(sym.rev_dep, limit=25)
    implied_by, implied_by_total = _reverse_deps(sym.weak_rev_dep, limit=25)
    dep_terms = _terms(sym.direct_dep, skip=sym.choice) if sym.direct_dep is not kconf.y else []

    return {
        "kind": "symbol",
        "name": sym.name,
        "type": TYPE_TO_STR[sym.orig_type],
        "value": sym.str_value,
        "userValue": _raw_user_value(sym),
        "assignable": [TRI_TO_STR[v] for v in sym.assignable],
        "visibility": TRI_TO_STR[sym.visibility],
        "promptless": not prompts,
        "prompts": _unique(prompts),
        "helps": _unique(helps),
        "dependsOn": {
            "value": TRI_TO_STR[dep_value],
            "terms": dep_terms,
        },
        "promptConditions": _unique(prompt_conditions),
        "blockedBy": _unique(blocked_by),
        "selectedBy": selected_by,
        "selectedByTotal": selected_by_total,
        "impliedBy": implied_by,
        "impliedByTotal": implied_by_total,
        "selects": _forward_refs(sym, getattr(sym, "orig_selects", sym.selects)),
        "implies": _forward_refs(sym, getattr(sym, "orig_implies", sym.implies)),
        "defaults": defaults,
        "defaultsTotal": defaults_total,
        "ranges": ranges,
        "activeRange": _active_range(sym) if sym.orig_type in (INT, HEX) else None,
        "choice": _choice_summary(sym.choice) if sym.choice is not None else None,
        "definitions": _definitions(sym),
        "configString": sym.config_string.rstrip("\n"),
    }


def _explain_choice(choice):
    kconf = SESSION.kconf
    dep_value = expr_value(choice.direct_dep)
    out = _choice_summary(choice)
    out.update({
        "kind": "choice",
        "type": TYPE_TO_STR[choice.orig_type],
        "value": choice.str_value,
        "visibility": TRI_TO_STR[choice.visibility],
        "prompts": _unique(node.prompt[0] for node in choice.nodes if node.prompt),
        "helps": _unique(node.help for node in choice.nodes if node.help),
        "dependsOn": {
            "value": TRI_TO_STR[dep_value],
            "terms": _terms(choice.direct_dep) if choice.direct_dep is not kconf.y else [],
        },
        "blockedBy": [dict(term, kind="depends_on") for term in _false_terms(choice.direct_dep)]
        if dep_value == 0 else [],
        "definitions": _definitions(choice),
    })
    return out


def m_explain(params):
    kconf = SESSION.kconf
    symbols = []
    unknown = {}
    for name in params.get("names") or []:
        sym = kconf.syms.get(name)
        if sym is not None and sym.nodes:
            symbols.append(_explain_symbol(sym))
            continue
        choice = kconf.named_choices.get(name)
        if choice is not None:
            symbols.append(_explain_choice(choice))
            continue
        unknown[name] = _suggest(name)
    return {"symbols": symbols, "unknown": unknown}


def _capture_state():
    # Everything needed to put the live state back exactly: see m_get_drift for
    # why the raw user values and choice selections are kept besides the file.
    import tempfile
    kconf = SESSION.kconf
    raw = {}
    for sym in kconf.unique_defined_syms:
        value = _raw_user_value(sym)
        if value is not None:
            raw[sym.name] = value
    selections = [choice.user_selection.name for choice in kconf.unique_choices
                  if choice.user_selection is not None]
    fd, tmp_path = tempfile.mkstemp(prefix="kconfig-state-", suffix=".config")
    os.close(fd)
    # save_old=False: the empty temp file must not be kept as a .old backup.
    kconf.write_config(tmp_path, save_old=False)
    return {"raw": raw, "selections": selections, "path": tmp_path}


def _restore_state(state):
    kconf = SESSION.kconf
    try:
        kconf.load_config(state["path"], replace=True)
        for sym in kconf.unique_defined_syms:
            want = state["raw"].get(sym.name)
            if _raw_user_value(sym) != want:
                _apply_raw(sym, want)
        for name in state["selections"]:
            sel_sym = kconf.syms.get(name)
            if sel_sym is not None:
                sel_sym.set_value(2)
    finally:
        try:
            os.unlink(state["path"])
        except OSError:
            pass


def _merge_failures(kconf):
    # What Zephyr's kconfig.py refuses once handwritten fragments are merged:
    # an assignment to a promptless symbol (check_no_promptless_assign), a value
    # that did not take (check_assigned_sym_values), and a choice symbol set to
    # y that did not end up selected (check_assigned_choice_values).
    out = {}
    for sym in kconf.unique_defined_syms:
        if sym.user_value is None:
            continue
        if not _has_prompt(sym):
            out[sym.name] = "has no prompt, so a configuration file cannot assign it"
            continue
        if sym.choice is not None:
            continue
        assigned = TRI_TO_STR[sym.user_value] if sym.orig_type in (BOOL, TRISTATE) else sym.user_value
        if assigned != sym.str_value:
            out[sym.name] = "was assigned {} but got {}".format(assigned, sym.str_value)
    for choice in kconf.unique_choices:
        sel = choice.user_selection
        if sel is not None and sel is not choice.selection:
            out[sel.name] = "was selected in its choice, but {} ended up selected".format(
                choice.selection.name if choice.selection is not None else "no symbol")
    return out


def _merge_run(fragments, names):
    # Merge the fragments exactly like kconfig.py does for handwritten input,
    # with its warning settings, and record what the build would see.
    kconf = SESSION.kconf
    saved = (kconf.warn, kconf.warn_assign_undef, kconf.warn_assign_override, kconf.warn_assign_redun)
    start = len(kconf.warnings)
    try:
        kconf.warn = True
        kconf.warn_assign_undef = True
        kconf.warn_assign_override = False
        kconf.warn_assign_redun = False
        kconf.load_config(fragments[0], replace=True)
        for fragment in fragments[1:]:
            kconf.load_config(fragment, replace=False)
        # kconfig.py writes to os.devnull first to force every value, so
        # warnings raised while evaluating show up before it decides.
        for sym in kconf.unique_defined_syms:
            _ = sym.str_value
        for choice in kconf.unique_choices:
            _ = choice.selection
        warnings = list(kconf.warnings[start:])
        values = {sym.name: sym.str_value for sym in kconf.unique_defined_syms}
        failures = _merge_failures(kconf)
        details = {}
        for name in names:
            sym = kconf.syms.get(name)
            if sym is None or not sym.nodes:
                continue
            loc = getattr(sym, "user_loc", None)
            requested = sym.user_value
            if sym.choice is not None and requested is not None:
                took = TRI_TO_STR[requested] == sym.str_value
            else:
                took = name not in failures
            details[name] = {
                "userValue": _raw_user_value(sym),
                "value": sym.str_value,
                "took": took,
                "failure": failures.get(name),
                "promptless": not _has_prompt(sym),
                "assignedAt": {"file": loc[0], "line": loc[1]} if loc else None,
                "missingDeps": _missing_deps(sym) if sym.user_value is not None else [],
                "activeSelectors": [e["name"] for e in _reverse_deps(sym.rev_dep)[0]
                                    if e["active"] and e.get("name")],
                "activeRange": _active_range(sym) if sym.orig_type in (INT, HEX) else None,
                "choice": _choice_summary(sym.choice) if sym.choice is not None else None,
            }
        return {"values": values, "failures": failures, "warnings": warnings, "details": details}
    finally:
        kconf.warn, kconf.warn_assign_undef, kconf.warn_assign_override, kconf.warn_assign_redun = saved
        # Reported in the result instead, never as session warnings.
        del kconf.warnings[start:]
        SESSION._warn_cursor = min(SESSION._warn_cursor, len(kconf.warnings))


def _strip_location(warning):
    # "path:12: warning: ..." -> "warning: ...": line numbers move when a
    # fragment is edited, so warnings are compared without them.
    marker = "warning: "
    at = warning.find(marker)
    return warning[at:] if at >= 0 else warning


def m_check_merge(params):
    # Would the build accept these fragments? `fragments` is the proposed merge
    # list (with a temporary copy standing in for the file about to change),
    # `compare` the list the build uses today. Both are merged on the live
    # instance, the results are compared, and the live state is restored.
    fragments = params.get("fragments") or []
    compare = params.get("compare") or []
    names = params.get("names") or []
    existing = [f for f in fragments if os.path.isfile(f)]
    missing = [f for f in fragments if not os.path.isfile(f)]
    compare_existing = [f for f in compare if os.path.isfile(f)]
    if not existing:
        return {"ok": False, "error": "None of the configuration fragments exist on disk"}

    kconf = SESSION.kconf
    pre = snapshot_dynamic()
    current = {sym.name: sym.str_value for sym in kconf.unique_defined_syms}
    state = _capture_state()
    before = None
    after = None
    try:
        if compare_existing:
            before = _merge_run(compare_existing, names)
        after = _merge_run(existing, names)
    finally:
        _restore_state(state)

    residue = diff_against(pre)
    if residue:
        print("check_merge: state restore left {} residue entries".format(len(residue)), file=sys.stderr)
        return {"ok": False, "error": "Internal state check failed after the merge check"}

    wanted = set(names)
    base_values = before["values"] if before else current
    base_failures = before["failures"] if before else {}
    base_warnings = set(_strip_location(w) for w in before["warnings"]) if before else set()

    new_failures = {name: why for name, why in after["failures"].items()
                    if name not in wanted and base_failures.get(name) != why}
    existing_failures = {name: why for name, why in after["failures"].items()
                         if name not in wanted and base_failures.get(name) == why}
    new_warnings = [w for w in after["warnings"] if _strip_location(w) not in base_warnings]

    def prompted(name):
        sym = kconf.syms.get(name)
        return sym is not None and _has_prompt(sym)

    # Only symbols with a prompt are listed: enabling one option routinely
    # moves dozens of hidden helper symbols, which the totals still count.
    side_effects = []
    side_effects_total = 0
    for name, to in after["values"].items():
        if name in wanted:
            continue
        frm = base_values.get(name)
        if frm != to:
            side_effects_total += 1
            if prompted(name):
                side_effects.append({"name": name, "from": frm, "to": to})
    side_effects.sort(key=lambda e: e["name"])

    discarded = []
    if before:
        for name, cur in current.items():
            if name in wanted or not prompted(name):
                continue
            merged = before["values"].get(name)
            if merged != cur:
                discarded.append({"name": name, "current": cur, "afterMerge": merged})
        discarded.sort(key=lambda e: e["name"])

    limit = int(params.get("limit") or 40)
    return {
        "ok": True,
        "symbols": after["details"],
        "current": {name: current.get(name) for name in names},
        "before": {name: base_values.get(name) for name in names},
        "newFailures": new_failures,
        "existingFailures": dict(sorted(existing_failures.items())[:limit]),
        "existingFailuresTotal": len(existing_failures),
        "newWarnings": new_warnings[:limit],
        "sideEffects": side_effects[:limit],
        "sideEffectsTotal": side_effects_total,
        "discarded": discarded[:limit],
        "discardedTotal": len(discarded),
        "missingFragments": missing,
    }


def m_write_config(params):
    path = params.get("path")
    kconf = SESSION.kconf
    if path:
        msg = kconf.write_config(os.path.expanduser(path))
    else:
        msg = kconf.write_config()  # KCONFIG_CONFIG (the primary .config)
        # The on-disk state now matches memory: rebase the dirty baseline to the
        # current values (the session change list for prj.conf persistence is kept).
        for name in SESSION.saved_baseline:
            sym = kconf.syms.get(name)
            if sym is not None:
                SESSION.saved_baseline[name] = sym.str_value
        SESSION.load_needs_save = False
        SESSION.dirty = False
    return {"message": msg}


def m_write_min_config(params):
    path = os.path.expanduser(params["path"])
    msg = SESSION.kconf.write_min_config(path)
    return {"message": msg}


def m_load_config(params):
    path = os.path.expanduser(params["path"])
    replace = params.get("replace", True)
    prev = snapshot_dynamic()
    msg = SESSION.kconf.load_config(path, replace=replace)
    changes = diff_against(prev)
    # A load starts a fresh editing session: the journal and baselines refer to the
    # previous state and no longer apply.
    SESSION.journal = []
    SESSION.cursor = 0
    SESSION.baseline = {}
    SESSION.saved_baseline = {}
    SESSION.load_needs_save = SESSION._needs_save()
    SESSION.dirty = SESSION.load_needs_save
    return {
        "message": msg,
        "needsSave": SESSION.dirty,
        "generation": SESSION.generation,
        "changes": changes,
        "dirty": SESSION.dirty,
    }


def m_get_state(params):
    return {"needsSave": SESSION._needs_save()}


def m_shutdown(params):
    _respond(params.get("__id"), {})
    sys.exit(0)


METHODS = {
    "init": m_init,
    "get_tree": m_get_tree,
    "set_value": m_set_value,
    "unset_value": m_unset_value,
    "undo": m_undo,
    "redo": m_redo,
    "get_changes": m_get_changes,
    "get_drift": m_get_drift,
    "revert": m_revert,
    "info": m_info,
    "write_config": m_write_config,
    "write_min_config": m_write_min_config,
    "load_config": m_load_config,
    "get_state": m_get_state,
    "shutdown": m_shutdown,
    "find": m_find,
    "explain": m_explain,
    "check_merge": m_check_merge,
}


# ---------------------------------------------------------------------------
# JSON-RPC loop
# ---------------------------------------------------------------------------

def _write(obj):
    _OUT.write(json.dumps(obj, separators=(",", ":")) + "\n")
    _OUT.flush()


def _respond(req_id, result):
    msg = {"id": req_id, "result": result, "dirty": SESSION.dirty, "warnings": SESSION.take_warnings()}
    _write(msg)


def _respond_error(req_id, message, code="error"):
    msg = {"id": req_id, "error": {"message": message, "code": code},
           "dirty": SESSION.dirty, "warnings": SESSION.take_warnings() if SESSION.kconf else []}
    _write(msg)


def main():
    _write({"event": "ready", "protocol": 1})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            _respond_error(None, "Malformed request: {}".format(e), code="bad-json")
            continue
        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}
        handler = METHODS.get(method)
        if not handler:
            _respond_error(req_id, "Unknown method '{}'".format(method), code="unknown-method")
            continue
        if method == "shutdown":
            params["__id"] = req_id
        started = time.monotonic()
        try:
            result = handler(params)
        except SystemExit:
            raise
        except Exception as e:
            import traceback
            traceback.print_exc()  # goes to stderr
            _respond_error(req_id, "{}: {}".format(type(e).__name__, e), code="exception")
            continue
        elapsed_ms = int((time.monotonic() - started) * 1000)
        if elapsed_ms > 1000:
            print("kconfig-server: slow request '{}' took {} ms".format(method, elapsed_ms), file=sys.stderr)
        _respond(req_id, result)


if __name__ == "__main__":
    main()
