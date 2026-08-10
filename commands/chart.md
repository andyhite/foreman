---
description: Chart a foggy idea or resolve the next decision on a map
argument-hint: "<map-issue-number | idea-or-issue>"
---

Chart the argument given:

$ARGUMENTS

Read `skill://charting` and `skill://tracker`, then choose the matching
mode. A map issue number means **work the map**: load its frontier, claim one
decision ticket by assigning it before any work, resolve it by type, record
the answer in the ticket, close it, and update the map. A bare idea or idea
issue means **chart it**: name the destination with the operator, map the
frontier breadth-first, create the map and its decision tickets, wire native
dependency edges in a second pass, dispatch ready research tickets, then
stop.

Refer to every map and ticket by its linked name, never a bare issue number.
Resolve at most one non-research ticket in this session. Charting produces
decisions, never product code; if the session finds itself implementing, it
has left the skill and must stop.

When the frontier is empty and the destination is reachable, hand off rather
than build: make the map a normal epic or supersede it with one, then run the
breakdown from `skill://grooming` so the subtasks come from resolved
decisions.
