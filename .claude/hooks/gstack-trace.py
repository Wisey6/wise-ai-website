#!/usr/bin/env python3
"""
GStack live tracer.

PreToolUse hook: every time Claude Code fires a tool, print a branded
one-liner so you can watch the WiseAI "GStack" work in real time, e.g.

    🔶 GStack › Stripe · create payment link
    🔶 GStack › Notion · create pages
    🔶 GStack › GitHub · push files

It maps each connected MCP server (by its server id) to a friendly agent
name, and labels the built-in local tools too. Reads the hook payload as
JSON on stdin and returns {"systemMessage": ...} so the line shows in the UI.
"""
import json
import sys

# MCP server id  ->  GStack agent name
MCP_AGENTS = {
    "34488e11-aee0-4e61-ac0b-a5dc9ad1a749": "Gamma",
    "54fb9074-86b9-415c-99e2-4b0e6ec982f4": "ClickUp",
    "61b39c02-afd2-47df-93cf-a62ff3a0ea45": "Vercel",
    "82bac2da-ccb6-4091-b9e8-8d6d2b6e215e": "Supabase",
    "9219992e-7436-4422-bbae-4bc571592bbb": "Notion",
    "9b5d500c-3e7a-490f-b671-e7117da542b3": "Google Drive",
    "cfa4662a-dee6-4d19-8e11-406c96e0c462": "Gmail",
    "e2ecb073-56f5-4993-93f7-1d2461d644b1": "Calendar",
    "e91c06c0-e404-4d22-9511-46da46daf8c1": "Higgsfield",
    "f2e27723-d2e3-4dea-82e2-694ff7df9fa3": "Stripe",
    "github": "GitHub",
    "claude-code-remote": "Claude Code Remote",
}

# Built-in (local) tools -> friendly grouping
LOCAL_AGENTS = {
    "Bash": "Shell",
    "Read": "Codebase",
    "Edit": "Codebase",
    "Write": "Codebase",
    "NotebookEdit": "Codebase",
    "Glob": "Search",
    "Grep": "Search",
    "WebFetch": "Web",
    "WebSearch": "Web",
    "Agent": "Sub-agent",
    "Task": "Sub-agent",
    "Skill": "Skill",
    "ToolSearch": "Tool search",
    "TodoWrite": "Planning",
    "AskUserQuestion": "Ask you",
}


def describe(tool_name: str):
    """Return (agent, action) for a tool name."""
    if tool_name.startswith("mcp__"):
        parts = tool_name.split("__")
        server = parts[1] if len(parts) > 1 else ""
        action = "__".join(parts[2:]) if len(parts) > 2 else ""
        # strip a redundant server-name prefix on the action (e.g. "notion-create-pages")
        agent = MCP_AGENTS.get(server, "MCP")
        pretty = action.replace("_", " ").replace("-", " ").strip()
        for low in (agent.lower(), agent.lower().replace(" ", "")):
            if pretty.startswith(low + " "):
                pretty = pretty[len(low) + 1:]
        return agent, pretty or "call"
    agent = LOCAL_AGENTS.get(tool_name, "Local")
    return agent, tool_name


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    tool_name = data.get("tool_name", "")
    if not tool_name:
        sys.exit(0)
    agent, action = describe(tool_name)
    print(json.dumps({
        "systemMessage": f"🔶 GStack › {agent} · {action}",
        "suppressOutput": True,
    }))


if __name__ == "__main__":
    main()
