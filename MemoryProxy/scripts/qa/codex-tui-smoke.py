#!/usr/bin/env python3
"""
codex-tui-smoke.py - use a pexpect PTY to start a real Codex TUI, simulating real user interaction,
walk through the session-init 5-step form and capture the first assistant reply visible to the user.

Key purpose: verify P1-1 - after the form completes, whether the model hallucinates an explanation of the last
form output (e.g. "we need to understand what the user meant by \"No, not this time\"").
The real CLI replays input[] in full, so upstream sees the complete tool loop and in theory should not hallucinate;
but the TUI must actually be run to assert it.

Dependency: pexpect
Usage:
    python3 codex-tui-smoke.py                      # full init flow
    python3 codex-tui-smoke.py --bypass             # choose "No" in asset_confirm
    python3 codex-tui-smoke.py --prompt "1+1=?"     # override the first user message
"""
import argparse
import os
import re
import sys
import time

import pexpect


def strip_ansi(data):
    """Strip ANSI escapes to make the log readable"""
    try:
        txt = data.decode(errors="ignore") if isinstance(data, bytes) else data
    except Exception:
        return ""
    txt = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", txt)
    txt = re.sub(r"\x1b\][^\x07]*\x07", "", txt)
    txt = re.sub(r"\x1b[=>]", "", txt)
    return txt


class Sink:
    """pexpect logfile_read hook - write to file + print to screen (stripped)"""

    def __init__(self, path):
        self.f = open(path, "wb")

    def write(self, data):
        self.f.write(data)
        self.f.flush()
        sys.stdout.write(strip_ansi(data))
        sys.stdout.flush()

    def flush(self):
        self.f.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bypass", action="store_true", help="choose 'No' in asset_confirm to take the bypass path")
    ap.add_argument("--prompt", default="1+1=?", help="first user message")
    ap.add_argument("--cwd", default="/tmp", help="startup directory (must already be trusted)")
    ap.add_argument("--log", default="/tmp/codex-tui-smoke.log")
    args = ap.parse_args()

    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    env["CODEX_DISABLE_UPDATE_CHECK"] = "1"

    child = pexpect.spawn(
        "codex",
        args=[],
        cwd=args.cwd,
        env=env,
        dimensions=(50, 180),
        encoding=None,
        timeout=45,
    )
    child.logfile_read = Sink(args.log)

    # Wait for the TUI to be ready
    try:
        child.expect(rb"directory:", timeout=20)
    except pexpect.TIMEOUT:
        print("\n[FAIL] TUI not ready", file=sys.stderr)
        return 1

    time.sleep(1.5)

    # -- First user message ------------------------------------------------------------
    # Depends on features.default_mode_request_user_input = true in ~/.codex/config.toml
    # so that Default mode can also pop up the request_user_input form (equivalent to triggering it in Plan mode).
    #
    # codex TUI composer: type -> then press Enter separately to submit. The \n in sendline goes into the input box
    # together with the text but does not trigger submission, so split into two steps (send text -> sleep -> Enter alone).
    print(f"\n=== [STEP 1] send the first message: {args.prompt} ===")
    child.send(args.prompt)
    time.sleep(1.5)
    child.send("\r")  # Enter to submit

    # Wait for the asset_confirm form - match "link team assets" or the form keywords
    try:
        child.expect(
            rb"[Ll]ink team assets|asset_confirm|Question",
            timeout=45,
        )
        print("\n=== [STEP 2] asset_confirm form appeared ✓ ===")
    except pexpect.TIMEOUT:
        print("\n[FAIL] asset_confirm form not seen on the first frame (45s)", file=sys.stderr)
        child.terminate(force=True)
        return 1

    time.sleep(1.5)

    # -- Choose asset_confirm ---------------------------------------------------------
    # The first choice of every codex form is item 1 (yes/link); Down once to item 2 (no/bypass).
    # Submit with \r rather than sendline, to avoid \n being interpreted as an extra Down.
    if args.bypass:
        print("\n=== [STEP 3] choose 'No, not this time' -> Down + Enter ===")
        child.send("\x1b[B")  # Down to item 2
        time.sleep(0.8)
        child.send("\r")      # Enter to submit
    else:
        print("\n=== [STEP 3] choose 'Yes, link team assets' -> Enter ===")
        time.sleep(0.8)
        child.send("\r")

    # -- Subsequent steps (non-bypass) - each step presses Enter to choose the first item -----------------
    if not args.bypass:
        for step in range(6):
            try:
                i = child.expect(
                    [
                        rb"Question|Select",
                        rb"tokens used|response\.completed|assistant",
                    ],
                    timeout=60,
                )
                if i == 1:
                    print(f"\n=== [STEP {4 + step}] reached the first assistant reply ===")
                    break
                print(f"\n=== [STEP {4 + step}] next form -> Enter ===")
                time.sleep(1)
                child.send("\r")
            except pexpect.TIMEOUT:
                print(f"\n[TIMEOUT step {4 + step}]")
                break

    # -- Capture the full first assistant reply -----------------------------------------
    print("\n=== [FINAL] wait for the assistant to finish (tokens used appears) ===")
    try:
        child.expect(rb"tokens used", timeout=90)
        print("\n[DONE] assistant finished replying ✓")
    except pexpect.TIMEOUT:
        print("\n[WARN] tokens used not seen within 90s", file=sys.stderr)

    time.sleep(2)
    child.sendcontrol("c")
    time.sleep(0.5)
    child.sendcontrol("c")
    child.close(force=True)

    print(f"\n\n=== full log written to {args.log} ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
