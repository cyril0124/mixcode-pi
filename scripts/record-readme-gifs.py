#!/usr/bin/env python3
"""Record MixCode README showcase GIFs using asciinema + agg.

Usage:
  ./scripts/record-readme-gifs.py                 # record all 7 shots
  ./scripts/record-readme-gifs.py vim             # record a single shot
  ./scripts/record-readme-gifs.py vim skill       # record selected shots

Shots run concurrently (fast). PARALLEL=0 runs sequentially: compact GIFs,
since busy-indicator redraws from concurrent TUIs inflate frame counts.

Model configuration: scripts/record-readme-gifs.config.md.
Optional override: MIXCODE_GIF_PROVIDER / MIXCODE_GIF_MODEL /
MIXCODE_GIF_SOURCE_AGENT_DIR / PARALLEL

Each shot below documents what the GIF demonstrates and how it is recorded:
- multi-tab: workspace tabs + Tab Jump (Ctrl+T) quick navigation
- vim: history browsing in [VIM] mode
- zen: zen mode hiding the tab bar
- command-palette: Ctrl+P palette with fuzzy filter
- right-widget: extension right panel widget (pi-tasks)
- inline-widget: extension inline widget in the message flow
- skill: $ skill-name autocomplete popup + skill run
"""

from __future__ import annotations

import concurrent.futures
from contextlib import contextmanager, ExitStack
import io
import json
import os
import pathlib
import re
import shutil
import signal
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import uuid

REPO = pathlib.Path(__file__).resolve().parent.parent
ASSETS = REPO / "assets"
OUT_DIR = ASSETS
DEMO_SRC = REPO / "demo" / "readme-todo"
DIST_ENTRY = REPO / "dist" / "cli" / "main.js"
COLS = 120
ROWS = 36

CONFIG_PATH = pathlib.Path(__file__).with_suffix(".local.json")


def load_model_config(config_path: pathlib.Path) -> tuple[str, str]:
    """Read optional local JSON; environment overrides each field. Invalid config raises ValueError."""
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        # The local file is optional when both environment variables are supplied.
        config = {}
    if not isinstance(config, dict) or set(config) - {"provider", "model"}:
        raise ValueError(f"Error: {config_path} must be an object with only provider and model keys")
    for key, value in config.items():
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"Error: {config_path}: {key} must be a non-empty string")
    values = []
    for key in ("provider", "model"):
        env_name = f"MIXCODE_GIF_{key.upper()}"
        value = os.environ.get(env_name, config.get(key))
        if value is None or not value.strip():
            raise ValueError(f"Error: Set {env_name} or {key} in {config_path}")
        values.append(value)
    return values[0], values[1]


SOURCE_AGENT = pathlib.Path(
    os.environ.get("MIXCODE_GIF_SOURCE_AGENT_DIR", "~/.pi/agent")
).expanduser().resolve()
PARALLEL = os.environ.get("PARALLEL", "1") == "1"

SHOTS = sys.argv[1:] or ["multi-tab", "vim", "zen", "command-palette", "right-widget", "inline-widget", "skill"]

AGG_THEME = ("000000,d4d4d4,000000,cd3131,0dbc79,e5e510,2472c8,bc3fbc,11a8cd,"
             "e5e5e5,666666,f14c4c,23d18b,f5f543,3b8eea,d670d6,29b8db,ffffff")

CANCELLED = threading.Event()


def check_cancelled() -> None:
    if CANCELLED.is_set():
        raise InterruptedError("Recording cancelled")


@contextmanager
def managed_process(command: list[str], **kwargs):
    """Own a child process group; stop and reap it on normal exit or exceptions."""
    check_cancelled()
    process = subprocess.Popen(command, start_new_session=True, **kwargs)
    try:
        yield process
    finally:
        # The recorder can leave a tmux client behind even after its leader exits.
        try:
            os.killpg(process.pid, signal.SIGINT)
        except ProcessLookupError:
            pass  # The process group has already exited.
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass  # Escalate to SIGKILL below, including surviving descendants.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass  # There are no remaining members of this owned process group.
        process.wait(timeout=3)


def wait_process(process: subprocess.Popen) -> int:
    """Wait cooperatively so SIGINT/SIGTERM can cancel parallel recordings."""
    while True:
        check_cancelled()
        try:
            return process.wait(timeout=0.25)
        except subprocess.TimeoutExpired:
            continue


def need(tool: str) -> None:
    if shutil.which(tool) is None:
        print(f"missing: {tool}", file=sys.stderr)
        sys.exit(1)


def ensure_build() -> None:
    """Rebuild dist when missing or stale (mirrors bash find -newer check)."""
    if DIST_ENTRY.exists():
        dist_mtime = DIST_ENTRY.stat().st_mtime
        stale = False
        for root, _dirs, files in os.walk(REPO / "src"):
            for f in files:
                if (pathlib.Path(root) / f).stat().st_mtime > dist_mtime:
                    stale = True
                    break
            if stale:
                break
        if not stale and (REPO / "package.json").stat().st_mtime <= dist_mtime:
            return
    with managed_process(["bun", "run", "build"], cwd=REPO) as process:
        result = wait_process(process)
        if result:
            raise subprocess.CalledProcessError(result, process.args)


# --- tmux helpers -----------------------------------------------------------

def tmux(label: str, *args: str) -> subprocess.CompletedProcess[str]:
    check_cancelled()
    return subprocess.run(["tmux", "-L", label, *args],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          text=True)


def send_l(label: str, session: str, text: str) -> None:
    check_cancelled()
    subprocess.run(["tmux", "-L", label, "send-keys", "-l", "-t", session, text],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def send_k(label: str, session: str, key: str) -> None:
    check_cancelled()
    subprocess.run(["tmux", "-L", label, "send-keys", "-t", session, key],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def capture(label: str, session: str) -> str:
    return tmux(label, "capture-pane", "-p", "-t", session).stdout or ""


def wait_pane(label: str, session: str, pattern: str, timeout_s: float = 40.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if re.search(pattern, capture(label, session), re.IGNORECASE):
            return True
        time.sleep(0.25)
    print(f"==> wait_pane timeout ({timeout_s} s) pattern={pattern}", file=sys.stderr)
    print(capture(label, session), file=sys.stderr, end="")
    raise TimeoutError(f"Expected pane pattern: {pattern}")


def wait_ready(label: str, session: str, timeout_s: float = 60.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        pane = capture(label, session)
        if re.search(r"\[idle\]", pane, re.IGNORECASE) and not re.search(
                r"\[Not Ready\]", pane, re.IGNORECASE):
            return True
        time.sleep(0.25)
    print(f"==> MixCode not idle after {timeout_s}s", file=sys.stderr)
    print(capture(label, session), file=sys.stderr, end="")
    return False


def focus_agent(label: str, session: str) -> None:
    send_k(label, session, "Tab")
    time.sleep(1.0)
    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        pane = capture(label, session)
        if re.search(r"\[idle\]|Send message to Agent", pane, re.IGNORECASE) and not re.search(
                r"\[Not Ready\]|Error", pane, re.IGNORECASE):
            break
        time.sleep(0.25)
    else:
        raise TimeoutError("Expected ready agent after Tab\n" + pane)
    time.sleep(0.5)


def clear_editor(label: str, session: str) -> None:
    # C-c only. Escape opens tree/stop overlays and pollutes the GIF.
    send_k(label, session, "C-c")
    time.sleep(0.15)
    send_k(label, session, "C-c")
    time.sleep(0.15)


def submit_line(label: str, session: str, line: str) -> None:
    clear_editor(label, session)
    send_l(label, session, line)
    time.sleep(0.25)
    send_k(label, session, "Enter")
    time.sleep(0.5)


def arm_response(response_dir: pathlib.Path) -> str:
    """Assign the next UI submission a fresh ID before Enter can start the agent."""
    request_id = uuid.uuid4().hex
    (response_dir / "request-id").write_text(request_id, encoding="utf-8")
    return request_id


def wait_response(response_dir: pathlib.Path, request_id: str,
                  timeout_s: float = 120.0) -> str:
    """Wait for the observer's settled response; reject failures and stale IDs.

    The observer atomically replaces response.json after Pi settles, including
    retries. User echo, streaming text and previous answers cannot satisfy this.
    """
    response_file = response_dir / "response.json"
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        check_cancelled()
        try:
            content = response_file.read_text(encoding="utf-8")
        except FileNotFoundError:
            # The observer has not settled its first request yet.
            time.sleep(0.25)
            continue
        response = json.loads(content)
        fields = {"requestId", "stopReason", "text"}
        if (not isinstance(response, dict) or set(response) != fields
                or any(not isinstance(value, str) for value in response.values())):
            raise ValueError("Error: Invalid recorder response completion")
        if response["requestId"] == request_id:
            if response["stopReason"] != "stop":
                raise RuntimeError(f"Error: Agent response ended with {response['stopReason']}")
            if not response["text"].strip():
                raise RuntimeError("Error: Agent returned an empty answer")
            return response["text"]
        time.sleep(0.25)
    raise TimeoutError(f"Error: Agent response did not complete within {timeout_s}s")


def seed_chat(label: str, session: str, response_dir: pathlib.Path) -> None:
    focus_agent(label, session)
    for word in ("alpha", "beta", "gamma"):
        request_id = arm_response(response_dir)
        submit_line(label, session, f"Say only: {word}")
        answer = wait_response(response_dir, request_id)
        if answer.strip().lower() != word:
            raise RuntimeError("Error: Seed response did not match the requested word")
    time.sleep(0.5)
    clear_editor(label, session)


def seed_tasks_file(workdir: pathlib.Path) -> pathlib.Path:
    tasks_dir = workdir / ".pi" / "tasks"
    tasks_dir.mkdir(parents=True, exist_ok=True)
    path = tasks_dir / "tasks.json"
    now = int(time.time() * 1000)
    tasks = []
    for i, (subject, status) in enumerate(
            [("Add delete command", "completed"),
             ("Add due dates", "in_progress"),
             ("Add unit tests", "pending")],
            start=1):
        tasks.append({
            "id": str(i),
            "subject": subject,
            "description": "",
            "status": status,
            "activeForm": "Working on it" if status == "in_progress" else None,
            "owner": None,
            "metadata": {},
            "blocks": [],
            "blockedBy": [],
            "createdAt": now - (4 - i) * 1000,
            "updatedAt": now,
        })
    path.write_text(json.dumps({"nextId": 4, "tasks": tasks}, indent=2) + "\n", encoding="utf-8")
    return path


# --- Shot drivers -----------------------------------------------------------

# Shot workflow overview:
# 1. run_shot_isolated boots MixCode in a tmux session, configures the demo
#    workdir (git repo with docs/skills/todos), and waits for [idle].
# 2. Each driver below is executed while asciinema records the tmux pane.
#    Every send_k/send_l/heavy wait is what shows up in the final GIF.
# 3. Drivers must only use the recorded, deterministic phase; boot/seed
#    (message seeding, tab creation, task files) happens off-camera before
#    asciinema starts.

def drive_multi_tab(label: str, session: str) -> None:
    """Multi-tab workspace + Tab Jump.

    Shows: 5 agent tabs (Agent-01 default + Backend/Frontend/Docs/Review),
    one renamed to API-Gateway, concurrent `!sleep 45` jobs with rotating
    Working indicators, then Ctrl+T Tab Jump filtered to "API" (1/6 tabs)
    and Enter to jump to the API-Gateway tab (footer switches to it).

    Recording: 4x `/new-session <name>` -> rename -> 3x `!sleep 45` + Tab
    -> 6x S-Tab back -> C-t -> type "API" -> wait "1/6 tabs" -> Enter.
    """
    time.sleep(1.5)
    for title in ("Backend", "Frontend", "Docs", "Review"):
        clear_editor(label, session)
        send_l(label, session, f"/new-session {title}")
        time.sleep(0.3)
        send_k(label, session, "Enter")
        wait_pane(label, session, title, 20.0)
        time.sleep(0.6)
    send_k(label, session, "Tab")
    time.sleep(0.8)
    clear_editor(label, session)
    send_l(label, session, "/rename API-Gateway")
    time.sleep(0.3)
    send_k(label, session, "Enter")
    wait_pane(label, session, "API-Gateway", 20.0)
    time.sleep(0.8)
    for _ in range(3):
        clear_editor(label, session)
        send_l(label, session, "!sleep 45")
        time.sleep(0.2)
        send_k(label, session, "Enter")
        time.sleep(0.6)
        send_k(label, session, "Tab")
        time.sleep(0.6)
    for _ in range(6):
        send_k(label, session, "S-Tab")
        time.sleep(0.3)
    time.sleep(1.5)
    send_k(label, session, "C-t")
    wait_pane(label, session, "Tab Jump", 6.0)
    time.sleep(1.6)
    send_l(label, session, "API")
    wait_pane(label, session, "1/6 tabs", 6.0)
    time.sleep(0.8)
    send_k(label, session, "Enter")
    wait_pane(label, session, "Send message to API-Gateway", 8.0)
    time.sleep(1.5)


def drive_vim(label: str, session: str) -> None:
    """History browsing in [VIM] mode.

    Shows: seeded chat (alpha/beta/gamma replies) then /vim opens the
    read-only history pager with the [VIM] status line (Vim:/find modes,
    j/k scroll, q exit). Arrow keys scroll older/newer messages.

    Recording: /vim -> Enter -> S-Right, S-Right, Right, Right with 1s
    pauses so each scroll step lands as its own GIF frame.
    """
    time.sleep(1.0)
    clear_editor(label, session)
    send_l(label, session, "/vim")
    time.sleep(0.4)
    send_k(label, session, "Enter")
    wait_pane(label, session, r"Vim:|widgets/status hidden|\[VIM\]", 8.0)
    time.sleep(1.2)
    send_k(label, session, "S-Right")
    time.sleep(1.0)
    send_k(label, session, "S-Right")
    time.sleep(1.0)
    send_k(label, session, "Right")
    time.sleep(1.0)
    send_k(label, session, "Right")
    time.sleep(2.5)


def drive_zen(label: str, session: str) -> None:
    """Zen mode hiding the tab bar.

    Shows: /toggle-zen-mode hides tab names (● done dot replaces them),
    Ctrl+T still opens Tab Jump overlay, Enter jumps, then zen mode toggles
    back off to end the GIF on the normal chrome.

    Recording: /toggle-zen-mode -> Enter -> wait [ZEN]/zen + ● -> C-t ->
    wait "Tab Jump" -> Enter -> /toggle-zen-mode -> Enter.
    """
    time.sleep(1.0)
    send_l(label, session, "/toggle-zen-mode")
    time.sleep(0.3)
    send_k(label, session, "Enter")
    wait_pane(label, session, r"\[ZEN\]|zen", 8.0)
    time.sleep(1.5)
    wait_pane(label, session, "●", 8.0)
    time.sleep(1.5)
    send_k(label, session, "C-t")
    wait_pane(label, session, "Tab Jump", 6.0)
    time.sleep(1.6)
    send_k(label, session, "Enter")
    time.sleep(1.2)
    send_l(label, session, "/toggle-zen-mode")
    time.sleep(0.3)
    send_k(label, session, "Enter")
    time.sleep(2.5)


def drive_command_palette(label: str, session: str) -> None:
    """Ctrl+P command palette with fuzzy filter.

    Shows: C-p opens the Command Palette overlay, typing "zen" filters to
    the Toggle Zen Mode entry (slash command), Escape closes it.

    Recording: C-p -> wait "Command Palette" -> type "zen" -> Escape.
    """
    time.sleep(0.8)
    send_k(label, session, "C-p")
    wait_pane(label, session, "Command Palette", 8.0)
    time.sleep(0.8)
    send_l(label, session, "zen")
    time.sleep(1.4)
    send_k(label, session, "Escape")
    time.sleep(1.6)


def drive_right_widget(label: str, session: str) -> None:
    """Extension right panel widget (pi-tasks).

    Shows: Right opens the right side panel with pi-tasks tri-state list
    (1 done: Add delete command, 1 in progress: Add due dates, 1 open:
    Add unit tests), with a task count summary line.

    Recording: Right -> wait task list text -> 3s hold.
    """
    time.sleep(0.8)
    send_k(label, session, "Right")
    wait_pane(label, session, "Add delete command|Add due dates", 8.0)
    time.sleep(3.0)


def drive_inline_widget(label: str, session: str) -> None:
    """Extension inline widget in the message flow.

    Shows: /toggle-inline-widgets enables the [INL] marker line; the
    pi-tasks summary block renders inside the chat at the end of the
    seeded alpha/beta/gamma conversation. PPage/NPage scroll the history
    so the widget moves with the flow.

    Recording: /toggle-inline-widgets -> Enter -> wait [INL] ->
    PPage x2 -> NPage x2.
    """
    time.sleep(0.8)
    clear_editor(label, session)
    send_l(label, session, "/toggle-inline-widgets")
    time.sleep(0.3)
    send_k(label, session, "Enter")
    wait_pane(label, session, r"\[INL\]", 8.0)
    wait_pane(label, session, "Add delete command|Add due dates", 8.0)
    time.sleep(1.4)
    send_k(label, session, "PPage")
    time.sleep(1.2)
    send_k(label, session, "PPage")
    time.sleep(1.0)
    send_k(label, session, "NPage")
    time.sleep(1.0)
    send_k(label, session, "NPage")
    time.sleep(2.0)


def drive_skill(label: str, session: str, response_dir: pathlib.Path) -> None:
    """$ skill-name autocomplete popup + skill run.

    Shows: typing "Please check $" opens the $ autocomplete popup with
    `$list-open-todos` highlighted and its description line; Tab completes
    it, Enter submits, and the model runs the list-open-todos skill and
    prints the todo summary (priority order).

    Recording: "Please check " -> "$" -> wait popup -> "list-open" ->
    Tab -> " and summarize priority" -> Enter.
    """
    time.sleep(0.8)
    send_l(label, session, "Please check ")
    time.sleep(0.6)
    send_l(label, session, "$")
    # Popup label is "$list-open-todos"; chrome Skills list has no leading $.
    wait_pane(label, session, r"\$list-open-todos", 10.0)
    time.sleep(1.6)
    send_l(label, session, "list-open")
    time.sleep(1.0)
    send_k(label, session, "Tab")
    time.sleep(0.8)
    send_l(label, session, " and summarize priority")
    time.sleep(1.0)
    request_id = arm_response(response_dir)
    send_k(label, session, "Enter")
    answer = wait_response(response_dir, request_id)
    normalized = " ".join(answer.lower().split())
    if not all(item in normalized for item in ("add delete command", "write a short readme")):
        raise RuntimeError("Error: Skill response did not list the open demo todos")
    time.sleep(3.0)


DRIVERS = {
    "multi-tab": drive_multi_tab,
    "vim": drive_vim,
    "zen": drive_zen,
    "command-palette": drive_command_palette,
    "right-widget": drive_right_widget,
    "inline-widget": drive_inline_widget,
    "skill": drive_skill,
}


# --- cast trim --------------------------------------------------------------

def trim_cast(cast_path: pathlib.Path, shot_name: str, drive_start: float) -> None:
    """Cut the boot/seed prefix and stop tokens from a cast, rebase times to 0."""
    with open(cast_path) as f:
        lines = f.readlines()
    if not lines:
        raise SystemExit(f"empty cast: {shot_name}")

    header_line = lines[0]
    header = json.loads(header_line)
    rec_start = float(header.get("timestamp") or 0)
    cutoff = max(0.0, drive_start - rec_start - 0.5)
    skip_boot = ("Not Ready", "Extension loading failed", "EACCES", "permission denied")
    stop = ("Quit MixCode", "Are you sure you want to quit", "detached (from session", "[detached")
    events = []
    for line in lines[1:]:
        if not line.strip():
            continue
        try:
            data = json.loads(line)
        except Exception:
            continue
        if not (isinstance(data, list) and len(data) >= 3 and data[1] == "o"):
            continue
        if any(token in data[2] for token in stop):
            break
        if any(token in data[2] for token in skip_boot):
            continue
        events.append(data)

    text = "".join(e[2] for e in events)
    if "MixCode" not in text:
        raise SystemExit(f"cast has no MixCode UI: {shot_name}")

    anchor = 0
    for i, e in enumerate(events):
        if "MixCode" in e[2] and len(e[2]) > 400 and e[0] <= cutoff:
            anchor = i
    events = events[anchor:]

    base_time = events[0][0]
    out_lines = [header_line if header_line.endswith("\n") else header_line + "\n"]
    for e in events:
        e[0] = max(0.0, round(e[0] - base_time, 6))
        out_lines.append(json.dumps(e) + "\n")
    with open(cast_path, "w") as f:
        f.writelines(out_lines)


# --- single shot ------------------------------------------------------------

def run_shot_isolated(name: str, provider: str, model: str) -> tuple[bool, str]:
    """Run one full shot: env setup -> tmux boot -> off-camera seed -> record
    -> drive -> trim cast -> agg render.

    Returns (ok, log_text) so the caller can stream or dump the log per shot.
    """
    log = io.StringIO()

    def say(msg: str) -> None:
        print(msg, file=log)

    try:
        # LIFO teardown closes the owned tmux server before removing credential
        # links, sessions and casts. Unique labels keep simultaneous runs apart.
        with ExitStack() as stack:
            shot_tmp = pathlib.Path(stack.enter_context(
                tempfile.TemporaryDirectory(prefix=f"mixcode-readme-gif-{name}-")))
            label = shot_tmp.name
            stack.callback(subprocess.run, ["tmux", "-L", label, "kill-server"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=10)
            ok = _run_shot_isolated(name, say, shot_tmp, label, provider, model)
    except Exception as exc:
        say(f"==> [{name}] ERROR: {exc}")
        ok = False
    return ok, log.getvalue()


def _run_shot_isolated(name: str, say, shot_tmp: pathlib.Path, label: str,
                       provider: str, model: str) -> bool:
    check_cancelled()
    session = f"shot_{name.replace('-', '_')}"
    gif = OUT_DIR / f"readme-{name}.gif"

    workdir = shot_tmp / "workdir"
    agent_dir = shot_tmp / "agent_dir"
    cast_file = shot_tmp / "record.cast"
    workdir.mkdir(parents=True, exist_ok=True)
    agent_dir.mkdir(parents=True, exist_ok=True)

    say(f"==> [{name}] Initializing workdir and agent config...")
    shutil.copytree(DEMO_SRC, workdir, dirs_exist_ok=True)
    git(workdir, "init", "-q", "-b", "main")
    git(workdir, "config", "user.name", "demo")
    git(workdir, "config", "user.email", "demo@example.com")
    git(workdir, "add", ".")
    git(workdir, "commit", "-q", "-m", "Initial commit")

    (agent_dir / "sessions").mkdir(parents=True, exist_ok=True)
    (agent_dir / "extensions").mkdir(parents=True, exist_ok=True)
    for item in ("auth.json", "keys", "models.json"):
        src = SOURCE_AGENT / item
        if src.exists() and not (agent_dir / item).exists():
            link(agent_dir / item, src)
    write_settings(agent_dir / "settings.json", provider, model)

    extra_env = ""
    response_dir = shot_tmp / "responses"
    if name in ("vim", "inline-widget", "skill"):
        response_dir.mkdir()
        # These scenarios use one agent. Discover its observer only in this
        # private agent directory; model completions never depend on UI text.
        shutil.copy2(REPO / "scripts" / "readme-recorder-observer.ts",
                     agent_dir / "extensions" / "readme-recorder-observer.ts")
        extra_env = (f"MIXCODE_GIF_RESPONSE_DIR={shlex.quote(str(response_dir))} "
                     "MIXCODE_BUILTIN_EXTENSIONS_ONLY=0")
    if name in ("right-widget", "inline-widget"):
        tasks_file = seed_tasks_file(workdir)
        extra_env += f" PI_TASKS={shlex.quote(str(tasks_file))} MIXCODE_BUILTIN_EXTENSIONS_ONLY=0"
        for item in ("npm", "node_modules"):
            src = SOURCE_AGENT / item
            if src.exists() and not (agent_dir / item).exists():
                link(agent_dir / item, src)
        add_package(agent_dir / "settings.json", "npm:@tintinweb/pi-tasks")

    cmd = env_command(agent_dir, workdir, extra_env)
    subprocess.run(["tmux", "-L", label, "-f", "/dev/null", "new-session",
                    "-d", "-s", session, "-x", str(COLS), "-y", str(ROWS),
                    "-c", str(REPO), cmd],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    tmux(label, "set-option", "-g", "default-terminal", "tmux-256color")
    tmux(label, "set-option", "-ga", "terminal-overrides", ",*:RGB")
    tmux(label, "set-option", "-ga", "terminal-features", ",*:RGB")
    tmux(label, "set-option", "-t", session, "status", "off")

    if not wait_ready(label, session, 60.0):
        return False
    time.sleep(1.0)

    say(f"==> [{name}] Driving scenario...")
    if name == "multi-tab":
        pass
    elif name in ("vim", "inline-widget"):
        seed_chat(label, session, response_dir)
        clear_editor(label, session)
    elif name == "command-palette":
        focus_agent(label, session)
    elif name == "zen":
        focus_agent(label, session)
        for title in ("Worker-A", "Worker-B"):
            clear_editor(label, session)
            send_l(label, session, f"/new-session {title}")
            time.sleep(0.2)
            send_k(label, session, "Enter")
            time.sleep(0.8)
        for _ in range(2):
            clear_editor(label, session)
            send_l(label, session, "!sleep 4")
            time.sleep(0.15)
            send_k(label, session, "Enter")
            time.sleep(0.4)
            send_k(label, session, "Tab")
            time.sleep(0.4)
        clear_editor(label, session)
        time.sleep(0.5)
    elif name == "right-widget":
        focus_agent(label, session)
        time.sleep(1.0)
    elif name == "skill":
        focus_agent(label, session)
    else:
        say(f"unknown shot {name}")
        return False

    # Record after setup so seed/boot stay off-camera. Resize forces a full TUI
    # redraw into the cast.
    with managed_process(
        ["asciinema", "rec", "--cols", str(COLS), "--rows", str(ROWS), "-q",
         "-c", shlex.join(["tmux", "-L", label, "attach-session", "-t", session]), str(cast_file)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ) as recorder:
        time.sleep(0.5)
        tmux(label, "resize-window", "-t", session, "-x", str(COLS - 1), "-y", str(ROWS))
        time.sleep(0.2)
        tmux(label, "resize-window", "-t", session, "-x", str(COLS), "-y", str(ROWS))
        time.sleep(0.5)

        drive_start = time.time()
        if name == "skill":
            drive_skill(label, session, response_dir)
        else:
            DRIVERS[name](label, session)
        time.sleep(1.6)
        if recorder.poll() is not None:
            raise RuntimeError(
                f"Error: Recorder exited before scenario completion: {recorder.returncode}"
            )
    # Stop the recorder first so the GIF never includes tmux detach / alt-screen pop.
    tmux(label, "detach-client")
    tmux(label, "kill-server")
    time.sleep(1.0)

    try:
        trim_cast(cast_file, name, drive_start)
    except SystemExit as exc:
        say(str(exc))
        return False

    say(f"==> [{name}] Rendering GIF with agg...")
    # Pure black background theme: background=000000, foreground=d4d4d4 + 16 ANSI colors
    # A file avoids a full stderr pipe blocking agg while cancellation is checked.
    with tempfile.TemporaryFile(mode="w+") as errors:
        with managed_process(
            ["agg", "--cols", str(COLS), "--rows", str(ROWS),
             "--font-size", "16", "--line-height", "1.4",
             "--theme", AGG_THEME, "--speed", "1.5", "--idle-time-limit", "2",
             str(cast_file), str(gif)],
            stdout=subprocess.DEVNULL, stderr=errors,
        ) as process:
            result = wait_process(process)
        if result != 0:
            errors.seek(0)
            say(errors.read())
            return False
    say(f"==> [{name}] Done -> {gif}")
    return True


def git(cwd: pathlib.Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(cwd), *args],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)


def link(dest: pathlib.Path, src: pathlib.Path) -> None:
    os.symlink(src, dest)


def write_settings(path: pathlib.Path, provider: str, model: str) -> None:
    data = {
        "defaultThinkingLevel": "off",
        "hideThinkingBlock": True,
        "enableSkillCommands": True,
        "theme": "mixcode-dark",
    }
    if provider:
        data["defaultProvider"] = provider
    if model:
        data["defaultModel"] = model
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def add_package(path: pathlib.Path, pkg: str) -> None:
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    data["packages"] = list(dict.fromkeys((data.get("packages") or []) + [pkg]))
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def env_command(agent_dir: pathlib.Path, workdir: pathlib.Path, extra_env: str) -> str:
    unset = " ".join(f"-u {p}" for p in
                     ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
                      "ALL_PROXY", "all_proxy", "ftp_proxy", "FTP_PROXY"))
    return ("env " + unset +
            f" PI_CODING_AGENT_DIR={shlex.quote(str(agent_dir))} MIXCODE_DISPLAY_MODEL='demo/model' "
            f"MIXCODE_DISPLAY_THINKING='Off' MIXCODE_DISPLAY_WORKDIR='/demo/todo' "
            f"MIXCODE_BUILTIN_EXTENSIONS_ONLY=1 MIXCODE_PROJECT_SKILLS_ONLY=1 "
            f"COLORTERM=truecolor TERM=xterm-256color {extra_env} "
            f"bun {shlex.quote(str(DIST_ENTRY))} --workdir {shlex.quote(str(workdir))}")


# --- stamp ------------------------------------------------------------------

def stamp_record_meta() -> None:
    commit = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True).stdout.strip() or "unknown"
    dirty = "yes" if subprocess.run(["git", "-C", str(REPO), "status", "--porcelain"],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    text=True).stdout.strip() else "no"
    date_utc = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    shots_csv = " ".join(SHOTS)

    (OUT_DIR / ".readme-gif-stamp").write_text(
        f"commit={commit}\ndirty={dirty}\ndate={date_utc}\nshots={shots_csv}\n",
        encoding="utf-8")
    print(f"stamped commit={commit} dirty={dirty} shots={shots_csv}")

    docs = ASSETS / "README-GIFS.md"
    if docs.exists():
        text = docs.read_text(encoding="utf-8")
        section = (
            "## Last successful record\n\n"
            f"- **commit:** `{commit}`\n"
            f"- **dirty working tree:** {dirty}\n"
            f"- **date (UTC):** {date_utc}\n"
            f"- **shots:** {shots_csv}\n"
            "\nRe-record when this commit is no longer what you want the README GIFs to show "
            "(UI/chrome/behavior changes), or when `dirty` was `yes` and those local edits matter.\n"
        )
        pat = re.compile(r"## Last successful record\n.*?(?=\n## |\Z)", re.S)
        if pat.search(text):
            text = pat.sub(section.rstrip() + "\n\n", text, count=1)
        else:
            text = text.replace("# README GIF shot list\n",
                                "# README GIF shot list\n\n" + section, 1)
        docs.write_text(text, encoding="utf-8")


# --- main -------------------------------------------------------------------

def record_shots(provider: str, model: str) -> int:
    for name in SHOTS:
        if name not in DRIVERS:
            raise ValueError(f"Error: Unknown shot: {name}")
    if len(set(SHOTS)) != len(SHOTS):
        raise ValueError("Error: Shot names must be unique")
    for tool in ("tmux", "asciinema", "agg", "python3", "bun", "git"):
        need(tool)
    ensure_build()

    mode = "parallel" if PARALLEL else "sequential"
    print(f"Recording shots {mode} (asciinema + agg): {' '.join(SHOTS)}")

    if PARALLEL:
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(SHOTS)) as pool:
            futures = {name: pool.submit(run_shot_isolated, name, provider, model) for name in SHOTS}
            outcomes = {name: future.result() for name, future in futures.items()}
    else:
        outcomes = {}
        for name in SHOTS:
            ok, log_text = run_shot_isolated(name, provider, model)
            print(log_text, end="")
            outcomes[name] = (ok, log_text)

    fail_count = 0
    for name in SHOTS:
        ok, log_text = outcomes[name]
        if ok:
            print(f"Shot [{name}] completed successfully.")
        else:
            print(f"Shot [{name}] FAILED!", file=sys.stderr)
            if PARALLEL:
                print("--- log for failed shot ---", file=sys.stderr)
                print(log_text, file=sys.stderr, end="")
            fail_count += 1

    if fail_count > 0:
        print(f"Error: {fail_count} shots failed.", file=sys.stderr)
        return 1

    check_cancelled()
    stamp_record_meta()
    print(f"All shots done -> {OUT_DIR}/readme-*.gif")
    return 0


def main() -> int:
    provider, model = load_model_config(CONFIG_PATH)
    CANCELLED.clear()
    interrupted_by = None

    def cancel(signum, _frame):
        nonlocal interrupted_by
        interrupted_by = signum
        CANCELLED.set()

    previous_handlers = {sig: signal.signal(sig, cancel)
                         for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        try:
            result = record_shots(provider, model)
        except InterruptedError:
            result = 130
        return 128 + interrupted_by if interrupted_by is not None else result
    finally:
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    sys.exit(main())
