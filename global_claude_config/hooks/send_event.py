#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.8"
# dependencies = [
#     "anthropic",
#     "python-dotenv",
# ]
# ///

"""
Multi-Agent Observability Hook Script
Sends Claude Code hook events to the lightweight observability server.

Supported event types (12 total):
  SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse,
  PostToolUseFailure, PermissionRequest, Notification, SubagentStart,
  SubagentStop, Stop, PreCompact
"""

import json
import sys
import os
import argparse
from datetime import datetime
from utils.summarizer import generate_event_summary
from utils.model_extractor import get_model_from_transcript
from utils.observability_client import send_event as post_event


def main():
    # Parse command line arguments
    parser = argparse.ArgumentParser(description='Send Claude Code hook events to observability server')
    parser.add_argument('--source-app', required=True, help='Source application name')
    parser.add_argument('--event-type', required=True, help='Hook event type (PreToolUse, PostToolUse, etc.)')
    parser.add_argument('--add-chat', action='store_true', help='(Ignored) Previously included chat transcript')
    parser.add_argument('--summarize', action='store_true', help='Generate AI summary of the event')

    args = parser.parse_args()

    try:
        # Read hook data from stdin
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"Failed to parse JSON input: {e}", file=sys.stderr)
        sys.exit(1)

    # Extract common fields
    session_id = input_data.get('session_id', 'unknown')
    source_app = args.source_app
    event_type = args.event_type

    # Extract model name from transcript (with caching)
    transcript_path = input_data.get('transcript_path', '')
    model_name = ''
    if transcript_path:
        model_name = get_model_from_transcript(session_id, transcript_path)

    try:
        if event_type == 'SessionStart':
            post_event(
                event_type="SessionStart",
                session_id=session_id,
                source_app=source_app,
                name=f"session:{input_data.get('source', '')}",
                metadata={
                    'source': input_data.get('source', ''),
                    'agent_type': input_data.get('agent_type', ''),
                    'model': model_name or input_data.get('model', ''),
                },
            )

        elif event_type == 'SessionEnd':
            post_event(
                event_type="SessionEnd",
                session_id=session_id,
                source_app=source_app,
                metadata={
                    'reason': input_data.get('reason', ''),
                },
            )

        elif event_type == 'PreToolUse':
            tool_name = input_data.get('tool_name', 'unknown')
            tool_use_id = input_data.get('tool_use_id', '')
            post_event(
                event_type="PreToolUse",
                session_id=session_id,
                source_app=source_app,
                name=tool_name,
                span_id=tool_use_id,
                input_data=input_data.get('tool_input', {}),
            )

        elif event_type == 'PostToolUse':
            tool_use_id = input_data.get('tool_use_id', '')
            post_event(
                event_type="PostToolUse",
                session_id=session_id,
                source_app=source_app,
                span_id=tool_use_id,
                output_data=input_data.get('tool_response', {}),
            )

        elif event_type == 'PostToolUseFailure':
            tool_use_id = input_data.get('tool_use_id', '')
            post_event(
                event_type="PostToolUseFailure",
                session_id=session_id,
                source_app=source_app,
                span_id=tool_use_id,
                output_data=input_data.get('tool_response', {}),
                level="ERROR",
                metadata={
                    'error': input_data.get('error', 'Tool use failed'),
                },
            )

        elif event_type == 'SubagentStart':
            agent_id = input_data.get('agent_id', '')
            agent_type = input_data.get('agent_type', '')
            post_event(
                event_type="SubagentStart",
                session_id=session_id,
                source_app=source_app,
                name=f"subagent:{agent_type}" if agent_type else "subagent",
                span_id=agent_id,
                metadata={
                    'agent_type': agent_type,
                },
            )

        elif event_type == 'SubagentStop':
            agent_id = input_data.get('agent_id', '')
            post_event(
                event_type="SubagentStop",
                session_id=session_id,
                source_app=source_app,
                span_id=agent_id,
                metadata={
                    'agent_type': input_data.get('agent_type', ''),
                    'stop_hook_active': input_data.get('stop_hook_active', False),
                },
            )

        elif event_type == 'UserPromptSubmit':
            post_event(
                event_type="UserPromptSubmit",
                session_id=session_id,
                source_app=source_app,
                input_data={
                    'prompt': input_data.get('prompt', ''),
                },
            )

        elif event_type == 'Notification':
            post_event(
                event_type="Notification",
                session_id=session_id,
                source_app=source_app,
                name=input_data.get('title', ''),
                metadata={
                    'notification_type': input_data.get('notification_type', ''),
                    'message': input_data.get('message', ''),
                    'title': input_data.get('title', ''),
                },
            )

        elif event_type == 'PermissionRequest':
            post_event(
                event_type="PermissionRequest",
                session_id=session_id,
                source_app=source_app,
                name=input_data.get('tool_name', ''),
                input_data=input_data.get('tool_input', {}),
                metadata={
                    'permission_suggestions': input_data.get('permission_suggestions', ''),
                },
            )

        elif event_type == 'Stop':
            post_event(
                event_type="Stop",
                session_id=session_id,
                source_app=source_app,
                metadata={
                    'stop_hook_active': input_data.get('stop_hook_active', False),
                },
            )

        elif event_type == 'PreCompact':
            post_event(
                event_type="PreCompact",
                session_id=session_id,
                source_app=source_app,
                metadata={
                    'trigger': input_data.get('trigger', ''),
                    'custom_instructions': input_data.get('custom_instructions', ''),
                },
            )

        else:
            # Unknown event type -- log as generic event
            post_event(
                event_type=event_type,
                session_id=session_id,
                source_app=source_app,
                input_data=input_data,
            )

    except Exception as e:
        print(f"Failed to send event: {e}", file=sys.stderr)

    # Always exit with 0 to not block Claude Code operations
    sys.exit(0)


if __name__ == '__main__':
    main()
