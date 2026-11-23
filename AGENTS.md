# Agent rules

## Python

- Run every Python tool and script through uv: `uv run --frozen --project tools <command>` or `uvx <tool>`.
- Never run `python`, `python3`, `pip`, or `pipx` directly.
- Never use an interpreter outside uv, such as a notebook kernel or an `eval` Python cell.
- Change dependencies only with `uv add` or `uv remove`. Commit `tools/uv.lock` with the change.
- uv MUST be 0.13.4 or newer. Older versions are affected by GHSA-hq85-5cpj-mr62.
- Use JavaScript (`bun`) or bash for throwaway scripts that do not need the `tools` environment.
